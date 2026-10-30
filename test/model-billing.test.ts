/**
 * 「模型计费」页的数据源（lib/model-billing.ts）——纯聚合逻辑的单测，不碰 D1。
 *
 * 钉死：声明 ∪ 日志的模型全集、渠道展开（model_mapping）、来源标签
 * （内置表/别名/映射/覆盖/Key/兜底）、部分配置、跨渠道价格不一致、
 * 缓存未知（billing_meta 缺失 = null 不是 0）、表达式字段的 expr_fields。
 *
 * Run: npm run test:model-billing
 */
import assert from 'node:assert/strict';
import {
  buildModelBilling, priceRules, resolvePriceView, usageSQL, usageView, CHANNELS_SQL,
  type ModelBillingInput, type UsageRow,
} from '../src/lib/model-billing';
import type { Options } from '../src/lib/options';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const emptyUsage = (model: string, channel_id: number): UsageRow => ({
  model_name: model, channel_id, requests: 0, prompt_tokens: 0, completion_tokens: 0, quota: 0, last_at: null,
  meta_requests: 0, meta_prompt_tokens: 0, cached_tokens: 0, meta_last_at: null, pricing_version: null, billing_model: null,
});

const channel = (over: Partial<any> = {}) => ({
  id: 1, name: 'ch-1', type: 'openai', status: 1, models: '', model_mapping: '', priority: 0, ...over,
});

const options = (over: Record<string, unknown> = {}): Options =>
  ({ ModelPriceOverride: {}, DefaultPrice: null, ...over } as unknown as Options);

function build(channels: any[], usage: UsageRow[], opts: Options, now = 1_700_000_000) {
  return buildModelBilling({ channels, usage, options: opts, now, billingMetaAvailable: true } satisfies ModelBillingInput);
}

test('声明 + 日志构成模型全集；未定价排最前', () => {
  const report = build(
    [channel({ models: 'glm-5.2, mystery' })],
    [ { ...emptyUsage('logged-only', 0), requests: 2, quota: 100 } ],
    options(),
  );
  assert.equal(report.totals.models, 3);
  assert.deepEqual(report.models.map((m) => m.model), ['logged-only', 'mystery', 'glm-5.2']);
  assert.equal(report.models[0].active, false, '只在日志里出现');
  assert.equal(report.models[1].active, true);
  assert.equal(report.models[1].configured, false);
  assert.equal(report.totals.unconfigured, 2);
});

test('来源标签：内置表 / 别名 / 渠道映射 / 全局覆盖 / Key 不在此层', () => {
  const opts = options({ ModelPriceOverride: { 'override-m': { in: 9, out: 9 } } });
  const report = build(
    [
      channel({ id: 1, models: 'glm-5.2, openai/gpt-4o, alias-a, override-m', model_mapping: '{"alias-a":"glm-5.2"}' }),
    ],
    [],
    opts,
  );
  const byModel = Object.fromEntries(report.models.map((m) => [m.model, m]));
  assert.deepEqual(byModel['glm-5.2'].sources, ['table']);
  assert.deepEqual(byModel['openai/gpt-4o'].sources, ['alias']);
  assert.deepEqual(byModel['alias-a'].sources, ['mapping']);
  assert.equal(byModel['alias-a'].price?.in, 1.4, '映射指到 glm-5.2 的价');
  assert.deepEqual(byModel['override-m'].sources, ['override']);
});

test('严格/宽松开关与兜底价进报表', () => {
  const strict = build([channel({ models: 'mystery' })], [], options({ DefaultPrice: null }));
  assert.equal(strict.strict_billing, true);
  assert.equal(strict.fallback_price, null);
  assert.equal(strict.models[0].configured, false);

  const loose = build([channel({ models: 'mystery' })], [], options({ DefaultPrice: { in: 2, out: 4 } }));
  assert.equal(loose.strict_billing, false);
  assert.deepEqual(loose.fallback_price, { in: 2, out: 4 });
  assert.equal(loose.models[0].configured, true, '有兜底价就算已配置');
  assert.deepEqual(loose.models[0].sources, ['default']);
});

test('部分配置与跨渠道价格不一致', () => {
  const report = build(
    [
      channel({ id: 1, name: '映射救了的', models: 'm', model_mapping: '{"m":"glm-5.2"}' }),
      channel({ id: 2, name: '没映射的', models: 'm' }),
    ],
    [],
    options({ ModelPriceOverride: {} }),
  );
  const row = report.models[0];
  assert.equal(row.partially_configured, true);
  assert.equal(row.configured, false);
  assert.equal(row.channels.length, 2);
  // 行级价格取「真会被路由到」的渠道里第一个有价的
  assert.equal(row.price?.in, 1.4, '来自映射命中的 glm-5.2');

  const varying = build(
    [
      // 两个渠道都靠映射才有价，且指向不同价目的上游 → 行级"价格不一致"
      channel({ id: 1, models: 'm', model_mapping: '{"m":"glm-5.2"}' }),
      channel({ id: 2, models: 'm', model_mapping: '{"m":"deepseek-flash"}' }),
    ],
    [],
    options(),
  );
  assert.equal(varying.models[0].price_varies, true, '两条映射指向了不同价目的上游');
  assert.equal(varying.models[0].price?.in, 1.4);
});

test('用量聚合：跨渠道合并；缓存未知 = null 不是 0', () => {
  const usage: UsageRow[] = [
    { ...emptyUsage('glm-5.2', 1), requests: 3, prompt_tokens: 1000, completion_tokens: 100, quota: 500, meta_requests: 2, meta_prompt_tokens: 800, cached_tokens: 400 },
    { ...emptyUsage('glm-5.2', 2), requests: 1, prompt_tokens: 10, completion_tokens: 1, quota: 5 },
  ];
  const report = build([channel({ id: 1, models: 'glm-5.2' }), channel({ id: 2, models: 'glm-5.2' })], usage, options());
  const row = report.models[0];
  assert.equal(row.usage.requests, 4);
  assert.equal(row.usage.quota, 505);
  // 合并行有 meta 请求（渠道 1 的两条）→ 缓存按已知部分展示；命中率只在这部分上算
  assert.equal(row.usage.cached_tokens, 400);
  assert.equal(row.usage.cache_hit_rate, 0.5);
  assert.equal(row.channels[0].usage.cache_hit_rate, 0.5, '有 meta 的渠道可算命中率');
  assert.equal(row.channels[1].usage.cached_tokens, null, '没有任何 meta 的渠道 → 未知');
});

test('表达式字段的 expr_fields 与特殊规则', () => {
  const report = build(
    [channel({ models: 'm' })],
    [],
    options({ ModelPriceOverride: { m: { in: '4 * (context > 272k ? 2 : 1)', out: 0 } } }),
  );
  const row = report.models[0];
  assert.deepEqual(row.price?.expr_fields, ['in']);
  assert.ok(row.rules.some((r) => r.includes('in：费率表达式')), JSON.stringify(row.rules));
  assert.ok(row.rules.some((r) => r.includes('输出不计费')));
  assert.ok(priceRules({ in: 0, out: 0 }).includes('免费'));
  assert.ok(priceRules({ in: 1, out: 0 }).includes('输出不计费'));
});

test('usageSQL：带/不带 billing_meta 两版；CHANNELS_SQL 不取 key/base_url/渠道config', () => {
  assert.ok(usageSQL(true).includes('json_valid(billing_meta)'));
  assert.ok(!usageSQL(false).includes('billing_meta'));
  // price_config 是渠道价格覆盖（计费要用的白名单字段），不算泄露；
  // key / base_url / config（渠道密钥配置）一个字都不许取。
  assert.ok(!/key|base_url|config/i.test(CHANNELS_SQL.replace(/model_mapping|price_config/g, '')));
});

test('resolvePriceView：未配置视图的形状', () => {
  const v = resolvePriceView('mystery', 'mystery', options({ DefaultPrice: null }));
  assert.equal(v.configured, false);
  assert.equal(v.price, null);
  assert.equal(v.source, null);
});

// ---------------------------------------------------------------- runner

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(error);
  }
}
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log(`\nmodel-billing: ${tests.length} passed`);
