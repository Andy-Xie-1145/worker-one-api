/**
 * 计费表达式引擎 v2（src/lib/pricing/expr.ts）的单测。
 *
 * v2 语义：按字段的「绝对费率」表达式——结果就是 USD/1M tokens 的费率，token 数
 * 由计费引擎按字段套用。变量只有 context（别名 len）/ n；请求探针 param/header
 * 缺失时为 null；k/m 数字后缀；三目/&&/|| 短路；`/` 永远浮点；编译期拒绝未知
 * 变量/函数与非法字面量。
 *
 * Run: npm run test:expr
 */
import assert from 'node:assert/strict';
import { compileBillingExpr, evaluateRate, type ProbeContext } from '../src/lib/pricing/expr';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** 探针全缺失（保存时冒烟的环境）。 */
const NONE: ProbeContext = { header: () => null, param: () => null };

const evalRaw = (
  src: string,
  opts: { context?: number; n?: number; probes?: ProbeContext; now?: Date } = {},
) => {
  const compiled = compileBillingExpr(src);
  assert.ok(compiled.ok, `编译失败：${!compiled.ok && compiled.error}`);
  return evaluateRate(compiled.program, {
    params: { context: opts.context ?? 100_000, n: opts.n ?? 1 },
    probes: opts.probes ?? NONE,
    now: opts.now,
  });
};
const run = (src: string, opts?: Parameters<typeof evalRaw>[1]) => {
  const r = evalRaw(src, opts);
  assert.ok(r.ok, `求值失败：${!r.ok && r.error}`);
  return r;
};
const rate = (src: string, opts?: Parameters<typeof evalRaw>[1]) => run(src, opts).rate;
/** 断言求值失败并返回错误信息。 */
const fail = (src: string, opts: Parameters<typeof evalRaw>[1] = {}) => {
  const r = evalRaw(src, opts);
  assert.ok(!r.ok, `应当失败却成功了：${src}`);
  return r.ok ? '' : r.error;
};
const compileFail = (src: string) => {
  const r = compileBillingExpr(src);
  assert.ok(!r.ok, `应当编译失败却成功了：${src}`);
  return r.ok ? '' : r.error;
};

// ---------------------------------------------------------------- 算术与优先级

test('基础算术与优先级', () => {
  assert.equal(rate('2 + 3 * 4'), 14);
  assert.equal(rate('4 * (1 + 0.5)'), 6);
  assert.equal(rate('-2 * 0.001'), -0.002, '一元负号');
  assert.equal(rate('1e3 * 0.5 + .5'), 500.5, '指数与小数字面量');
  assert.equal(rate('(2 + 3) * 4'), 20);
});

test('k/m 数字后缀：272k = 272000，1.5m = 1500000，大小写不敏感', () => {
  assert.equal(rate('272k'), 272_000);
  assert.equal(rate('1.5m'), 1_500_000);
  assert.equal(rate('2K + 3M'), 3_002_000);
  assert.equal(rate('context > 272k ? 2 : 4', { context: 300_000 }), 2);
  assert.equal(rate('context > 272k ? 2 : 4', { context: 100_000 }), 4);
  // 后缀后面跟标识符字符就不是后缀（272kilo 不能静默切成 272k + ilo）
  assert.match(compileFail('272kilo'), /多余内容|未知变量|意外/);
});

test('除法永远浮点、取模为实数余、除零报错', () => {
  assert.equal(rate('7 / 2'), 3.5, '没有整除');
  assert.equal(rate('7 % 3'), 1);
  assert.equal(rate('7.5 % 2'), 1.5, 'v2 允许实数取模');
  assert.match(fail('5 / 0'), /除零/);
  assert.match(fail('5 % 0'), /对 0 取模/);
});

// ---------------------------------------------------------------- 变量

test('context 与 len 别名同值，n 默认 1', () => {
  assert.equal(rate('context', { context: 123_456 }), 123_456);
  assert.equal(rate('len', { context: 123_456 }), 123_456, 'len 是 context 的别名');
  assert.equal(rate('n', {}), 1);
  assert.equal(rate('n', { n: 5 }), 5);
  assert.equal(rate('context * n', { context: 1000, n: 3 }), 3000);
});

test('未知变量编译不过（v1 的 p/c/cr 已移除）', () => {
  assert.match(compileFail('p * 3'), /未知变量/);
  assert.match(compileFail('c * 15'), /未知变量/);
  assert.match(compileFail('cr * 0.3'), /未知变量/);
  assert.match(compileFail('x * 3'), /未知变量/);
  assert.ok(compileBillingExpr('context + len + n').ok, '全部已知变量都在');
});

// ---------------------------------------------------------------- 比较与逻辑

test('比较、相等、逻辑与三目', () => {
  assert.equal(rate('context <= 128000 ? 100 : 200', { context: 1000 }), 100);
  assert.equal(rate('context <= 128000 ? 100 : 200', { context: 1_000_000 }), 200);
  assert.equal(rate('n > 0 && context > 0 ? 5 : 1'), 5);
  assert.equal(rate('!(context > 0) ? 1 : 2'), 2);
  assert.equal(rate('1 == 1 ? 3 : 4'), 3);
  assert.equal(rate('"a" != "b" ? 3 : 4'), 3);
  // &&/|| 是严格布尔，不像 JS 有真值短路
  assert.match(fail('context && 1'), /&& 需要布尔/);
  // 短路：走不到的分支不执行（除零也不抛）
  assert.equal(rate('true ? 1 : 5 / 0'), 1);
  assert.equal(rate('false ? 5 / 0 : 2'), 2);
  // 三目右结合：a ? b : c ? d : e ⇒ a ? b : (c ? d : e)
  assert.equal(rate('false ? 1 : false ? 2 : 3'), 3);
  assert.equal(rate('context > 100 ? context > 1000 ? 3 : 2 : 1', { context: 5000 }), 3);
});

// ---------------------------------------------------------------- 请求探针

const PROBES: ProbeContext = {
  header: (key) => ({ 'anthropic-beta': 'fast-mode,other', 'x-empty': '' } as any)[key.toLowerCase()] ?? null,
  param: (path) => (path === 'service_tier' ? 'fast' : path === 'n' ? 4 : path === 'thinking' ? true : null),
};

test('header/param 读取请求，缺失为 null', () => {
  // 探针返回的字符串/数字要用在表达式里（费率结果必须是数字，所以走比较/算术）。
  assert.equal(rate(`header("anthropic-beta") == "fast-mode,other" ? 1 : 2`, { probes: PROBES }), 1);
  assert.equal(rate(`param("service_tier") == "fast" ? 6 : 1`, { probes: PROBES }), 6);
  assert.equal(rate(`param("n") + 1`, { probes: PROBES }), 5);
  assert.equal(rate(`header("nope") == nil ? 1 : 2`, { probes: PROBES }), 1);
  // 缺失探针求值为 null；null 不能直接当费率（结果必须是数字）
  const missing = evalRaw('header("nope")');
  assert.ok(!missing.ok && /必须是数字/.test(missing.error));
});

test('null 的比较语义：== 非 null 为 false，!= 为 true，不报错', () => {
  assert.equal(rate(`header("nope") == "fast" ? 6 : 1`), 1, '缺失头比较安全');
  assert.equal(rate(`header("nope") != "fast" ? 6 : 1`), 6);
  assert.equal(rate(`param("nope") == "fast" ? 6 : 1`), 1);
});

test('has：子串判断；null 恒 false；非字符串报错', () => {
  assert.equal(rate(`has(header("anthropic-beta"), "fast-mode") ? 6 : 1`, { probes: PROBES }), 6);
  assert.equal(rate(`has(header("nope"), "fast-mode") ? 6 : 1`, { probes: PROBES }), 1, '缺失头 has 恒 false');
  assert.equal(rate(`has(header("x-empty"), "") ? 1 : 0`, { probes: PROBES }), 1);
  assert.match(fail(`has(param("n"), "x") ? 1 : 0`, { probes: PROBES }), /必须是字符串/);
});

test('探针返回值参与算术：数字 OK，null 报错，非标量报错', () => {
  assert.equal(rate('param("n") * 2', { probes: PROBES }), 8);
  assert.match(fail('header("nope") + 1'), /需要数字操作数/);
  const OBJ: ProbeContext = { header: () => null, param: () => ({ a: 1 }) };
  assert.match(fail('param("obj") + 1', { probes: OBJ }), /非标量/);
});

test('探针的键必须是编译期字符串字面量', () => {
  assert.match(compileFail('param(context)'), /字符串字面量/);
  assert.match(compileFail('header(1)'), /字符串字面量/);
  assert.match(compileFail('param("a", "b")'), /1 个参数/);
  assert.match(compileFail('header()'), /1 个参数/);
});

// ---------------------------------------------------------------- tier

test('tier 记录命中的档名并原样返回值；短路分支不记档', () => {
  const compiled = compileBillingExpr(`tier("short", 2)`);
  assert.ok(compiled.ok);
  const r = evaluateRate(compiled.program, { params: { context: 1000, n: 1 }, probes: NONE });
  assert.ok(r.ok);
  assert.equal(r.trace.matchedTier, 'short');
  assert.equal(r.rate, 2);

  const cond = compileBillingExpr(`context > 272k ? tier("long", 2) : tier("short", 4)`);
  assert.ok(cond.ok);
  const long = evaluateRate(cond.program, { params: { context: 300_000, n: 1 }, probes: NONE });
  const short = evaluateRate(cond.program, { params: { context: 100_000, n: 1 }, probes: NONE });
  assert.equal(long.ok && long.trace.matchedTier, 'long');
  assert.equal(short.ok && short.trace.matchedTier, 'short');
});

test('fixed() 已随 v1 移除，旧整笔写法编译不过', () => {
  assert.match(compileFail('fixed(0.01)'), /未知函数/);
  assert.match(compileFail('p * 3 + fixed(0.02)'), /未知变量/);
});

// ---------------------------------------------------------------- 时间函数

test('时间函数支持时区，非法时区回退 UTC', () => {
  // 2026-07-01T16:30:00Z = 北京时间 00:30（次日）
  const at = new Date('2026-07-01T16:30:00Z');
  const opts = { now: at };
  assert.equal(rate('hour("Asia/Shanghai")', opts), 0);
  assert.equal(rate('minute("Asia/Shanghai")', opts), 30);
  assert.equal(rate('weekday("Asia/Shanghai")', opts), 4, '0=周日，周四是 4');
  assert.equal(rate('day("Asia/Shanghai")', opts), 2);
  assert.equal(rate('month("Asia/Shanghai")', opts), 7);
  assert.equal(rate('hour()', opts), 16, '缺省 UTC');
  assert.equal(rate('hour("Not/AZone")', opts), 16, '非法时区回退 UTC');
  // 谷时示例：北京时间 22 点后（含次日 6 点前）半价
  assert.equal(rate(`hour("Asia/Shanghai") >= 22 || hour("Asia/Shanghai") < 6 ? 0.15 : 0.3`, opts), 0.15);
});

// ---------------------------------------------------------------- 编译期检查

test('未知函数、残缺语法、非数字结果都编译/求值不过', () => {
  assert.match(compileFail('foo(1)'), /未知函数/);
  assert.match(compileFail('context *'), /期望|意外/);
  assert.match(compileFail('context 3'), /多余内容/);
  assert.match(compileFail('context > '), /意外结束/);
  assert.match(compileFail('"unterminated'), /未闭合/);
  assert.match(compileFail('context ; 3'), /无法识别的字符/);
  assert.match(compileFail('true ? 1'), /期望 "\:"/);
  // 结果必须是数字
  assert.match(fail('"str"'), /必须是数字/);
  assert.match(fail('context > 1'), /必须是数字/);
  assert.match(fail('nil'), /必须是数字/);
});

test('编译结果被缓存：同一表达式两次编译拿到同一个程序', () => {
  const a = compileBillingExpr('4 * (context > 272k ? 2 : 1)');
  const b = compileBillingExpr('4 * (context > 272k ? 2 : 1)');
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
