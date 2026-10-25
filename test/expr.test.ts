/**
 * 计费表达式引擎（src/lib/pricing/expr.ts）的单测。
 *
 * 语义对齐 new-api 的 billingexpr：微美元结果、tier/fixed 追踪、三目是唯一短路点、
 * `%` 只许整数、`/` 永远浮点、`&&`/`||` 操作数必须是布尔、编译期拒绝未知变量/函数。
 *
 * Run: npm run test:expr
 */
import assert from 'node:assert/strict';
import { compileBillingExpr, evaluateProgram } from '../src/lib/pricing/expr';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const P = { p: 1_000_000, c: 100_000, cr: 0, len: 1_000_000 };
const evalRaw = (src: string, params: Partial<typeof P> = {}, now?: Date) => {
  const compiled = compileBillingExpr(src);
  assert.ok(compiled.ok, `编译失败：${!compiled.ok && compiled.error}`);
  return evaluateProgram(compiled.program, { ...P, ...params }, now);
};
const run = (src: string, params?: Partial<typeof P>, now?: Date) => {
  const r = evalRaw(src, params, now);
  assert.ok(r.ok, `求值失败：${!r.ok && r.error}`);
  return r;
};
const usd = (src: string, params?: Partial<typeof P>, now?: Date) => run(src, params, now).microUSD;
/** 断言求值失败并返回错误信息。 */
const fail = (src: string, params: Partial<typeof P> = {}) => {
  const r = evalRaw(src, params);
  assert.ok(!r.ok, `应当失败却成功了：${src}`);
  return r.ok ? '' : r.error;
};

// ---------------------------------------------------------------- 算术与优先级

test('基础算术与优先级', () => {
  assert.equal(usd('p * 3 + c * 15'), 1_000_000 * 3 + 100_000 * 15);
  assert.equal(usd('p * 2.5'), 2_500_000, '系数即 $/1M tokens：p=1M → $2.50');
  assert.equal(usd('(p + c) * 2'), (1_000_000 + 100_000) * 2);
  assert.equal(usd('2 + 3 * 4'), 14);
  assert.equal(usd('-p * 0.001'), -1000, '一元负号');
  assert.equal(usd('1e6 * 0.5 + .5'), 500_000.5, '指数与小数字面量');
});

test('除法永远浮点、取模只许整数', () => {
  assert.equal(usd('p / 1000'), 1000);
  assert.equal(usd('7 / 2'), 3.5, '没有整除');
  assert.equal(usd('7 % 3'), 1);
  assert.match(fail('7.5 % 2'), /% 只允许整数/);
  assert.match(fail('p / 0'), /除零/);
});

test('比较与逻辑', () => {
  assert.equal(usd('len <= 128000 ? 100 : 200', { len: 1000 }), 100);
  assert.equal(usd('len <= 128000 ? 100 : 200', { len: 1_000_000 }), 200);
  assert.equal(usd('p > 0 && c > 0 ? 5 : 1'), 5);
  assert.equal(usd('!(len > 0) ? 1 : 2'), 2);
  assert.equal(usd('1 == 1 ? 3 : 4'), 3);
  assert.equal(usd('"a" != "b" ? 3 : 4'), 3);
  // &&/|| 是严格布尔，不像 JS 有真值短路
  assert.match(fail('p && 1'), /&& 需要布尔/);
  // 三目是唯一短路点：走不到的分支不执行（除零也不抛）
  assert.equal(usd('true ? 1 : p / 0'), 1);
  assert.equal(usd('false ? p / 0 : 2'), 2);
});

test('三目右结合与嵌套括号', () => {
  // a ? b : c ? d : e ⇒ a ? b : (c ? d : e)
  assert.equal(usd('false ? 1 : false ? 2 : 3'), 3);
  assert.equal(usd('len > 100 ? len > 1000 ? 3 : 2 : 1', { len: 5000 }), 3);
  assert.equal(usd('((p)) * 1'), 1_000_000);
});

// ---------------------------------------------------------------- tier / fixed

test('tier 记录命中的档名并原样返回值', () => {
  const compiled = compileBillingExpr(`tier("standard", p * 2 + c * 10)`);
  assert.ok(compiled.ok);
  const r = evaluateProgram(compiled.program, P);
  assert.ok(r.ok);
  assert.equal(r.trace.matchedTier, 'standard');
  assert.equal(r.microUSD, 1_000_000 * 2 + 100_000 * 10);
});

test('fixed 是每次请求的美元固定价，放大 1e6 与 token 计费共用换算', () => {
  const r = run('fixed(0.01)');
  assert.ok(r.ok);
  assert.equal(r.microUSD, 10_000);
  assert.equal(r.trace.billingUnit, 'request');
  assert.equal(r.trace.fixedPrice, 0.01);
  // token 费 + 每请求固定费相加（本引擎的刻意放宽，语义仍是明确的）
  assert.equal(usd('p * 3 + fixed(0.02)'), 3_000_000 + 20_000);
  assert.equal(usd('tier("request", fixed(0.05))'), 50_000);
});

test('fixed 的金额必须是编译期数字字面量', () => {
  assert.ok(!compileBillingExpr('fixed(p)').ok, 'fixed(p) 必须被拒绝');
  assert.ok(!compileBillingExpr('fixed(0.01 + 0.02)').ok, '表达式金额必须被拒绝');
  assert.ok(!compileBillingExpr('fixed(-1)').ok, '负数金额必须被拒绝');
  assert.ok(compileBillingExpr('fixed(0)').ok, 'fixed(0) 合法（免费）');
  assert.ok(!compileBillingExpr('tier(1, 2)').ok, 'tier 档名必须是字符串字面量');
});

// ---------------------------------------------------------------- 时间函数

test('时间函数支持时区，非法时区回退 UTC', () => {
  // 2026-07-01T16:30:00Z = 北京时间 00:30（次日）
  const at = new Date('2026-07-01T16:30:00Z');
  assert.equal(usd('hour("Asia/Shanghai")', {}, at), 0);
  assert.equal(usd('minute("Asia/Shanghai")', {}, at), 30);
  assert.equal(usd('weekday("Asia/Shanghai")', {}, at), 4, '0=周日，周四是 4');
  assert.equal(usd('day("Asia/Shanghai")', {}, at), 2);
  assert.equal(usd('month("Asia/Shanghai")', {}, at), 7);
  assert.equal(usd('hour()', {}, at), 16, '缺省 UTC');
  assert.equal(usd('hour("Not/AZone")', {}, at), 16, '非法时区回退 UTC');
  // 分时折扣示例：22 点后（北京时间）半价
  assert.equal(usd(`hour("Asia/Shanghai") >= 22 || hour("Asia/Shanghai") < 6 ? p * 1 : p * 2`, {}, at), 1_000_000);
});

// ---------------------------------------------------------------- 编译期检查

test('未知变量、未知函数、残缺语法都编译不过', () => {
  const unknownVar = compileBillingExpr('x * 3');
  assert.ok(!unknownVar.ok && /未知变量/.test(unknownVar.error));
  assert.ok(!compileBillingExpr('foo(1)').ok);
  assert.ok(!compileBillingExpr('p *').ok);
  assert.ok(!compileBillingExpr('p 3').ok);
  assert.ok(!compileBillingExpr('p > ').ok);
  assert.ok(!compileBillingExpr('"unterminated').ok);
  assert.ok(!compileBillingExpr('p ; q').ok);
  assert.ok(!compileBillingExpr('true ? 1').ok);
  // 结果必须是数字
  assert.ok(!evalRaw('"str"').ok);
  assert.ok(!evalRaw('p > 1').ok);
  // 已知变量都在
  assert.ok(compileBillingExpr('p + c + cr + len').ok);
  assert.ok(compileBillingExpr('nil == nil ? 1 : 2').ok);
});

test('编译结果被缓存：同一表达式两次编译拿到同一个程序', () => {
  const a = compileBillingExpr('p * 3 + c * 15');
  const b = compileBillingExpr('p * 3 + c * 15');
  assert.equal(a.ok && b.ok ? a.program : null, b.ok ? b.program : null);
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
console.log(`\nexpr: ${tests.length} passed`);
