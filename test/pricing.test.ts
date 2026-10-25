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
  const key = { 'model-a': { in: 1, out: 2 }, 'model-b': { expr: 'p * 10' } };
  assert.deepEqual(resolvePrice('model-a', undefined, undefined, key).spec, { in: 1, out: 2 });
  assert.deepEqual(resolvePrice('model-b', undefined, undefined, key).spec, { expr: 'p * 10' });
  assert.equal(calcQuota('model-a', m(1_000_000, 1_000_000), undefined, undefined, key), 1_500_000);
  assert.equal(calcQuota('model-b', m(1_000_000, 0), undefined, undefined, key), 5_000_000);
});

test('不同 Key 的同一模型可以各配各价——这就是二维价格矩阵', () => {
  const keyA = { 'gpt-4o': { in: 1, out: 1 } };
  const keyB = { 'gpt-4o': { expr: 'p * 4 + c * 16' } };
  const usage = m(1_000_000, 500_000);
  // Key A：$1/M in + $1/M out = $1.50
  assert.equal(calcQuota('gpt-4o', usage, undefined, undefined, keyA), 750_000);
  // Key B：表达式 $4 in + $16 out = $4 + $8 = $12
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

// ---------------------------------------------------------------- 表达式计费端到端

test('表达式：缓存命中自动从 p 中排除、由 cr 单独计价', () => {
  const key = { 'm': { expr: 'p * 3 + c * 15 + cr * 0.3' } };
  // prompt 1M 全新：p=1M, cr=0 → $3
  assert.equal(calcQuota('m', m(1_000_000, 0), undefined, undefined, key), 1_500_000);
  // prompt 1M 中 200K 缓存命中：p=800K, cr=200K → $2.4 + $0.06 = $2.46
  assert.equal(calcQuota('m', m(1_000_000, 0, 200_000), undefined, undefined, key), 1_230_000);
  // 表达式没引用 cr 时，缓存留在 p 里按基础价计（宁可高估不会低估）
  const noCache = { 'm': { expr: 'p * 3' } };
  assert.equal(calcQuota('m', m(1_000_000, 0, 999_999), undefined, undefined, noCache), 1_500_000);
});

test('表达式：len 是完整输入长度，阶梯条件请用它', () => {
  const key = { 'm': { expr: 'len <= 128000 ? fixed(0.002) : fixed(0.004)' } };
  // len = prompt_tokens（含缓存部分），不受 cr 排除影响
  assert.equal(calcQuota('m', m(100_000, 0, 90_000), undefined, undefined, key), 1_000);
  assert.equal(calcQuota('m', m(200_000, 0, 150_000), undefined, undefined, key), 2_000);
});

test('表达式：结果按 ceil 换算 quota，负值被钳到 0', () => {
  assert.equal(calcQuota('m', m(1_500_000, 0), undefined, undefined, { 'm': { expr: 'p * 2' } }), 1_500_000);
  // ceil((1.5e6 * 2 / 1e6) * 500000) = ceil(1_500_000) —— 3e6 微美元 = $3
  // 负结果钳 0
  assert.equal(calcQuota('m', m(1000, 0), undefined, undefined, { 'm': { expr: '0 - 5' } }), 0);
});

test('坏表达式在计费时回退默认价而不是按 0 记账', () => {
  const broken = opts({ 'm': { expr: 'p *' as never } });
  const r = calcQuotaDetailed('m', m(1000, 1000), broken);
  assert.equal(r.source, 'default');
  assert.equal(r.quota, calcQuota('m', m(1000, 1000)), '回退默认价 $1/$3');
});

// ---------------------------------------------------------------- 校验

test('validatePriceSpec：固定价与表达式的合法/非法形状', () => {
  assert.ok(validatePriceSpec({ in: 1, out: 2 }).ok);
  assert.ok(validatePriceSpec({ in: 1, out: 2, cached_in: 0.5 }).ok);
  assert.ok(validatePriceSpec({ in: 0, out: 0 }).ok, '免费模型合法');
  assert.ok(!validatePriceSpec({ in: -1, out: 2 }).ok);
  assert.ok(!validatePriceSpec({ in: 'x', out: 2 }).ok);
  assert.ok(!validatePriceSpec({ out: 2 }).ok);
  assert.ok(!validatePriceSpec('string').ok);
  assert.ok(!validatePriceSpec(null).ok);

  assert.ok(validatePriceSpec({ expr: 'p * 3 + c * 15 + cr * 0.3' }).ok);
  assert.ok(validatePriceSpec({ expr: 'tier("t", len <= 200000 ? p * 2 + c * 12 : p * 4 + c * 18)' }).ok);
  const bad = validatePriceSpec({ expr: 'p *' });
  assert.ok(!bad.ok && /无法编译/.test(bad.error));
  // 冒烟：结果为负的表达式被拒
  const negative = validatePriceSpec({ expr: '0 - p' });
  assert.ok(!negative.ok && /冒烟/.test(negative.error));
  // expr 不能与其他字段混用
  assert.ok(!validatePriceSpec({ expr: 'p * 3', in: 1 }).ok);
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
