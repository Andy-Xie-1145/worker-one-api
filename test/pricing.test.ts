/**
 * 查价与计费的集成单测：四级优先（Key 覆盖 > 全局覆盖 > 内置表 > 默认价）、
 * 「Key × 模型」二维价格矩阵、表达式计费端到端、配置校验。
 *
 * Run: npm run test:pricing
 */
import assert from 'node:assert/strict';
import {
  calcQuota, calcQuotaDetailed, resolvePrice, findPrice, validatePriceSpec, DEFAULT_PRICE, stripAliasPrefix,
} from '../src/lib/pricing/llm';
import type { Options } from '../src/lib/options';
import type { PriceSpec } from '../src/lib/pricing/llm';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const opts = (overrides: Record<string, PriceSpec> = {}) => ({ ModelPriceOverride: overrides }) as unknown as Options;
const m = (p: number, c: number, cached = 0) => ({ prompt_tokens: p, completion_tokens: c, cached_tokens: cached });

// ---------------------------------------------------------------- 四级优先

test('四级优先：Key 覆盖 > 全局覆盖 > 内置表 > 默认价', () => {
  const key = { 'gpt-4o': { in: 9, out: 9 } };
  const global = opts({ 'gpt-4o': { in: 5, out: 5 }, 'my-model': { in: 1, out: 2 } });

  assert.deepEqual(resolvePrice('gpt-4o', global, undefined, key), { spec: { in: 9, out: 9 }, source: 'key' });
  assert.deepEqual(resolvePrice('gpt-4o', global).spec, { in: 5, out: 5 });
  assert.equal(resolvePrice('gpt-4o', global).source, 'global');
  assert.equal(resolvePrice('gpt-4o').source, 'builtin');
  assert.deepEqual(resolvePrice('totally-unknown').spec, DEFAULT_PRICE);
  assert.equal(resolvePrice('totally-unknown').source, 'default');
  // 只有 Key 覆盖里有的名字，全局没有，也照常命中
  assert.deepEqual(resolvePrice('my-model', global, undefined, key).spec, { in: 1, out: 2 });
});

test('别名剥前缀在每一级都生效', () => {
  const key = { 'glm-4.7': { in: 7, out: 7 } };
  const global = opts({ 'glm-5': { in: 5, out: 5 } });
  assert.deepEqual(resolvePrice('zai-coding-plan/glm-4.7', undefined, undefined, key).spec, { in: 7, out: 7 });
  assert.deepEqual(resolvePrice('zai/glm-5', global).spec, { in: 5, out: 5 });
  // 覆盖表只按写出的名字精确命中，不做前缀匹配
  assert.equal(resolvePrice('glm-4.7-flashx', opts({ 'glm-4.7': { in: 1, out: 1 } })).source, 'builtin');
  assert.equal(stripAliasPrefix('meta/llama-3'), 'meta/llama-3', '无关斜杠不被剥');
});

test('上游模型名兜底：请求名查不到时按 model_mapping 之后的真实名字查', () => {
  const global = opts({ 'gemini-3.1-flash-lite': { in: 0.25, out: 1.5 } });
  const r = resolvePrice('gemini-flash-lite-latest', global, 'gemini-3.1-flash-lite');
  assert.deepEqual(r.spec, { in: 0.25, out: 1.5 });
  // Key 级的覆盖同样参与上游名兜底
  const key = { 'gemini-3.1-flash-lite': { in: 0.01, out: 0.02 } };
  assert.deepEqual(resolvePrice('gemini-flash-lite-latest', undefined, 'gemini-3.1-flash-lite', key).spec, { in: 0.01, out: 0.02 });
});

// ---------------------------------------------------------------- Key × 模型 矩阵

test('同一 Key 的不同模型可以各配各价', () => {
  const key = { 'model-a': { in: 1, out: 2 }, 'model-b': { in: '10 * (context > 272k ? 2 : 1)', out: 0 } };
  assert.deepEqual(resolvePrice('model-a', undefined, undefined, key).spec, { in: 1, out: 2 });
  assert.deepEqual(resolvePrice('model-b', undefined, undefined, key).spec, { in: '10 * (context > 272k ? 2 : 1)', out: 0 });
  assert.equal(calcQuota('model-a', m(1_000_000, 1_000_000), undefined, undefined, key), 1_500_000);
  // model-b：100K 输入未过档，in=$10/1M → 1M×$10/1000 = $0.01？不——10 × 100_000 / 1_000_000 = $1 → 500_000 quota
  assert.equal(calcQuota('model-b', m(100_000, 0), undefined, undefined, key), 500_000);
  // 过档翻倍：300K 输入 in=$20 → $6 → 3_000_000 quota
  assert.equal(calcQuota('model-b', m(300_000, 0), undefined, undefined, key), 3_000_000);
});

test('不同 Key 的同一模型可以各配各价——这就是二维价格矩阵', () => {
  const keyA = { 'gpt-4o': { in: 1, out: 1 } };
  const keyB = { 'gpt-4o': { in: 4, out: 16 } };
  const usage = m(1_000_000, 500_000);
  // Key A：$1/M in + $1/M out = $1.50
  assert.equal(calcQuota('gpt-4o', usage, undefined, undefined, keyA), 750_000);
  // Key B：$4 in + $16 out = $4 + $8 = $12
  assert.equal(calcQuota('gpt-4o', usage, undefined, undefined, keyB), 6_000_000);
  // 没有 Key 覆盖的 Key C：内置表 $2.5/$10 = $2.5 + $5 = $7.50
  assert.equal(calcQuota('gpt-4o', usage), 3_750_000);
});

test('Key 覆盖可以把免费模型改成收费，反之亦然', () => {
  // glm-4.7-flash 内置 0/0
  assert.equal(calcQuota('glm-4.7-flash', m(1_000_000, 1_000_000)), 0);
  const key = { 'glm-4.7-flash': { in: 0.1, out: 0.2 } };
  assert.equal(calcQuota('glm-4.7-flash', m(1_000_000, 1_000_000), undefined, undefined, key), 150_000);
  const free = { 'gpt-4o': { in: 0, out: 0 } };
  assert.equal(calcQuota('gpt-4o', m(1_000_000, 1_000_000), undefined, undefined, free), 0);
});

// ---------------------------------------------------------------- 表达式计费端到端（v2 按字段费率）

test('费率表达式：字段表达式按请求求值，token 数由引擎套用', () => {
  const key = { 'm': { in: '3 * (context > 272k ? 2 : 1)', out: 15 } };
  // 100K 输入（未过档）＋ 100K 输出：in=3, out=15 → $1.8
  assert.equal(calcQuota('m', m(100_000, 100_000), undefined, undefined, key), 900_000);
  // 300K 输入（过档）：in=6 → $1.8 + $1.5 = $3.3
  assert.equal(calcQuota('m', m(300_000, 100_000), undefined, undefined, key), 1_650_000);
});

test('cached_in 省略 = 缓存命中按 in 费率计；配置了就单独计', () => {
  // 无 cached_in：1M prompt 全部命中缓存 → 全按 in=$3 计（宁可高估）
  const noCache = { 'm': { in: 3, out: 15 } };
  assert.equal(calcQuota('m', m(1_000_000, 0, 999_999), undefined, undefined, noCache), 1_500_000);
  // 有 cached_in=$0.3：800K fresh + 200K 命中 → $2.4 + $0.06 = $2.46
  const key = { 'm': { in: 3, out: 15, cached_in: 0.3 } };
  assert.equal(calcQuota('m', m(1_000_000, 0, 200_000), undefined, undefined, key), 1_230_000);
});

test('费率表达式支持时间函数（谷时半价）', () => {
  const key = { 'm': { in: `2 * (hour("Asia/Shanghai") >= 1 && hour("Asia/Shanghai") < 5 ? 0.5 : 1)`, out: 4 } };
  // 北京时间 02:00（UTC 18:00 前一天）→ 谷时 in=1：1M+1M = $5
  assert.equal(calcQuota('m', m(1_000_000, 1_000_000), undefined, undefined, key, new Date('2026-07-01T18:00:00Z')), 2_500_000);
  // 北京时间 12:00（UTC 04:00）→ 峰时 in=2：$6
  assert.equal(calcQuota('m', m(1_000_000, 1_000_000), undefined, undefined, key, new Date('2026-07-01T04:00:00Z')), 3_000_000);
});

test('结果按 ceil 换算 quota', () => {
  // 1.5M fresh × $2/1M = $3 → 1_500_000
  assert.equal(calcQuota('m', m(1_500_000, 0), undefined, undefined, { 'm': { in: 2, out: 0 } }), 1_500_000);
  // 除不尽时向上取整：1_000 tokens × $1/1M = $0.001 → 0.001 × 500_000 = 500
  assert.equal(calcQuota('m', m(1_000, 0), undefined, undefined, { 'm': { in: 1, out: 0 } }), 500);
  // 更小：1 token × $1/1M → 0.5 quota → ceil = 1
  assert.equal(calcQuota('m', m(1, 0), undefined, undefined, { 'm': { in: 1, out: 0 } }), 1);
});

test('字段费率解析失败（坏表达式）在计费时回退默认价而不是按 0 记账', () => {
  const broken = opts({ 'm': { in: 'context *' } as never });
  const r = calcQuotaDetailed('m', m(1000, 1000), broken);
  assert.equal(r.source, 'default');
  assert.equal(r.quota, calcQuota('m', m(1000, 1000)), '回退默认价 $1/$3');
});

test('缓存写入分量与 fresh 的扣减关系（Anthropic 口径）', () => {
  // prompt = input + cache_read + cache_write（归一化后），fresh = prompt − cached − cw5 − cw1
  // 1M fresh($3) + 0.5M cw5($3.75) + 0.5M cw1($6) = $3 + $1.875 + $3 = $7.875
  const key = { 'm': { in: 3, out: 0, cache_write_5m: 3.75, cache_write_1h: 6 } };
  assert.equal(
    calcQuota('m', { prompt_tokens: 2_000_000, completion_tokens: 0, cache_write_5m_tokens: 500_000, cache_write_1h_tokens: 500_000 }, undefined, undefined, key),
    3_937_500,
  );
  // cache_write 超过 prompt 的部分被钳掉（上游撒谎也不多收）：谎报 999_999 与
  // 实际最多 100 的结果一致
  const cwLie = { prompt_tokens: 100, completion_tokens: 0, cache_write_5m_tokens: 999_999 };
  assert.equal(
    calcQuota('m', cwLie, undefined, undefined, key),
    calcQuota('m', { prompt_tokens: 100, completion_tokens: 0, cache_write_5m_tokens: 100 }, undefined, undefined, key),
  );
});

// ---------------------------------------------------------------- 校验

test('validatePriceSpec：常量与按字段表达式的合法/非法形状', () => {
  assert.ok(validatePriceSpec({ in: 1, out: 2 }).ok);
  assert.ok(validatePriceSpec({ in: 1, out: 2, cached_in: 0.5 }).ok);
  assert.ok(validatePriceSpec({ in: 0, out: 0 }).ok, '免费模型合法');
  assert.ok(validatePriceSpec({ in: 1, out: 2, cache_write_5m: 1.25, cache_write_1h: 2 }).ok, '缓存写入字段合法');
  assert.ok(!validatePriceSpec({ in: -1, out: 2 }).ok);
  assert.ok(!validatePriceSpec({ in: Number.NaN, out: 2 }).ok);
  assert.ok(!validatePriceSpec({ out: 2 }).ok, 'in 必填');
  assert.ok(!validatePriceSpec('string').ok);
  assert.ok(!validatePriceSpec(null).ok);

  // 字段费率表达式：编译 + 冒烟
  assert.ok(validatePriceSpec({ in: '4 * (context > 272k ? 0.5 : 1)', out: 20 }).ok);
  assert.ok(validatePriceSpec({ in: `0.3 * (hour("Asia/Shanghai") < 5 ? 0.5 : 1)`, out: 'has(header("x"), "fast") ? 30 : 20' }).ok);
  const bad = validatePriceSpec({ in: 'context *', out: 2 });
  assert.ok(!bad.ok && /无法编译/.test(bad.error));
  // 冒烟：费率为负的表达式被拒
  const negative = validatePriceSpec({ in: '0 - context', out: 2 });
  assert.ok(!negative.ok && /冒烟/.test(negative.error));
  // 除零在冒烟期暴露（context=0 向量）
  const divZero = validatePriceSpec({ in: '1000 / context', out: 2 });
  assert.ok(!divZero.ok && /除零/.test(divZero.error));
  // 字段值类型不对
  assert.ok(!validatePriceSpec({ in: true, out: 2 }).ok);
  assert.ok(!validatePriceSpec({ in: '', out: 2 }).ok);

  // 旧版整笔 {expr} 明确拒绝并指路
  const legacy = validatePriceSpec({ expr: 'p * 3 + c * 15' });
  assert.ok(!legacy.ok && /已移除/.test(legacy.error));
});

test('findPrice 仍用于「未定价」检测：内置+全局，不含 Key、不含默认价', () => {
  assert.ok(findPrice('gpt-4o'));
  assert.equal(findPrice('totally-unknown'), null);
  assert.ok(findPrice('totally-unknown', opts({ 'totally-unknown': { in: 1, out: 1 } })));
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
console.log(`\npricing: ${tests.length} passed`);
