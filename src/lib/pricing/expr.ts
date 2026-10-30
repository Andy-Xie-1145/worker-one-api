/**
 * 计费表达式引擎 v2 —— 手写 lexer + 优先级爬升解析器 + AST 解释执行。
 *
 * **为什么不用 `new Function` / `eval`**：Cloudflare Workers 禁止动态代码求值，
 * 所以表达式被解析成 AST 后由解释器直接遍历求值。
 *
 * ## v2 语义：按字段的「绝对费率」表达式
 *
 * 价格对象的**每个字段**（in / cached_in / out / cache_write_5m / cache_write_1h）
 * 都可以是数字常量或一个表达式；表达式的求值结果 = **该字段本次请求的费率
 * （USD / 1M tokens）**。token 数由计费引擎按字段套用，表达式永远不碰 token 数：
 *
 *   "in":  "4 * (context > 272k ? 0.5 : 1)"        // GPT-6 长上下文档位
 *   "in":  "0.3 * (hour('Asia/Shanghai') >= 1 && hour('Asia/Shanghai') < 5 ? 0.5 : 1)"
 *                                                  // DeepSeek 谷时
 *   "out": "has(header('anthropic-beta'), 'fast-mode') ? 30 : 20"
 *
 * 变量只有 `context`（别名 `len`，完整输入 token 数）与 `n`（请求级数量，默认 1）；
 * 请求探针 `param(path)` / `header(key)` 读取本次请求，缺失时为 null
 * （`==` 比较为 false、`has(null, ·)` 为 false，算术作用于 null 才报错）。
 *
 * 设计参考 new-api（QuantumNous/new-api）`pkg/billingexpr/` 的函数面
 * （param/header/has/hour/minute/weekday/day/month/tier/min/max/abs/ceil/floor），
 * 但**语义不同**：new-api 是「一条表达式算总价」，v2 是「每字段一条费率表达式」——
 * 所以没有 p/c/cr 这类 token 数变量，也没有 `fixed()` 按次计费
 * （按次计费将来以独立字段形式支持，见图像轮设计）。
 *
 * 其余从 v1 沿用的性质：
 * - 三目 / && / || 短路：走不到的分支不产生 tier 副作用；
 * - `/` 永远是浮点除法；`%` 为实数取模（除数为 0 报错）；
 * - 编译期拒绝未知变量/函数、参数个数/字面量类型错误；坏配置在保存时就会被拦下。
 */

export interface RateParams {
  /** 本次请求的完整输入 token 数（含缓存命中部分）。阶梯条件用它。 */
  context: number;
  /** 请求级数量参数（图像张数等），默认 1。 */
  n: number;
}

/** 请求探针：从本次 HTTP 请求里取值；取不到返回 null。 */
export interface ProbeContext {
  header: (key: string) => string | null;
  param: (path: string) => unknown;
}

export interface ExprTrace {
  /** 最后一次 tier() 命中的档名。 */
  matchedTier?: string;
}

export type CompileResult = { ok: true; program: Program } | { ok: false; error: string };
export type EvalResult = { ok: true; rate: number; trace: ExprTrace } | { ok: false; error: string };

// ---------------------------------------------------------------- AST

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'nil' }
  | { kind: 'var'; name: string }
  | { kind: 'un'; op: '!' | 'u+' | 'u-'; arg: Node }
  | { kind: 'bin'; op: BinOp; l: Node; r: Node }
  | { kind: 'and'; l: Node; r: Node }
  | { kind: 'or'; l: Node; r: Node }
  | { kind: 'cond'; c: Node; t: Node; f: Node }
  | { kind: 'call'; name: string; args: Node[] };

type BinOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface Program {
  src: string;
  ast: Node;
}

const VARIABLES = new Set(['context', 'len', 'n']);
const FUNCTIONS = new Set([
  'min', 'max', 'abs', 'ceil', 'floor', 'tier',
  'param', 'header', 'has',
  'hour', 'minute', 'weekday', 'day', 'month',
]);

const MAX_SRC_LEN = 4096;
const CACHE_LIMIT = 256;

// ---------------------------------------------------------------- 词法

interface Token {
  t: 'num' | 'str' | 'ident' | 'op';
  v: string;
}

const TWO_CHAR_OPS = new Set(['&&', '||', '==', '!=', '<=', '>=']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '(', ')', '?', ':', '!', '<', '>', ',']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`非法数字（位置 ${i}）`);
      let text = m[0];
      i += text.length;
      // k/m 后缀：272k = 272000，1.5m = 1_500_000。后缀后面不能再跟标识符字符，
      // 否则 `272kilo` 会被静默切成 `272k` + `ilo`。
      const suf = src[i];
      if ((suf === 'k' || suf === 'K' || suf === 'm' || suf === 'M') && !/[A-Za-z0-9_]/.test(src[i + 1] ?? '')) {
        text += suf;
        i++;
      }
      tokens.push({ t: 'num', v: text });
      continue;
    }
    if (ch === '.' && src[i + 1] >= '0' && src[i + 1] <= '9') {
      const m = /^\.\d+([eE][+-]?\d+)?/.exec(src.slice(i))!;
      tokens.push({ t: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new ExprError('字符串字面量未闭合');
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ t: 'ident', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if (ONE_CHAR_OPS.has(ch)) { tokens.push({ t: 'op', v: ch }); i += 1; continue; }
    throw new ExprError(`无法识别的字符 "${ch}"（位置 ${i}）`);
  }
  return tokens;
}

class ExprError extends Error {}

// ---------------------------------------------------------------- 语法

const BIN_PREC: Record<string, number> = {
  '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
};

class Parser {
  private pos = 0;
  private nodes = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }
  private expectOp(op: string): void {
    const t = this.next();
    if (!t || t.t !== 'op' || t.v !== op) throw new ExprError(`期望 "${op}"`);
  }

  private add(): void {
    if (++this.nodes > 2048) throw new ExprError('表达式过于复杂（节点数超限）');
  }

  parse(): Node {
    const node = this.ternary();
    if (this.pos !== this.tokens.length) throw new ExprError('表达式末尾有多余内容');
    return node;
  }

  /** 三目最低优先级、右结合：a ? b : c ? d : e ⇒ a ? b : (c ? d : e)。 */
  private ternary(): Node {
    const c = this.binary(1);
    const t = this.peek();
    if (t && t.t === 'op' && t.v === '?') {
      this.next();
      const th = this.ternary();
      this.expectOp(':');
      const f = this.ternary();
      this.add();
      return { kind: 'cond', c, t: th, f };
    }
    return c;
  }

  private binary(minPrec: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== 'op') break;
      const prec = BIN_PREC[t.v];
      if (prec === undefined || prec < minPrec) break;
      const raw = this.next()!.v;
      const right = this.binary(prec + 1);
      this.add();
      left = raw === '&&' ? { kind: 'and', l: left, r: right }
        : raw === '||' ? { kind: 'or', l: left, r: right }
        : { kind: 'bin', op: raw as BinOp, l: left, r: right };
    }
    return left;
  }

  private unary(): Node {
    const t = this.peek();
    if (t && t.t === 'op' && (t.v === '!' || t.v === '-' || t.v === '+')) {
      this.next();
      this.add();
      const op = t.v === '-' ? 'u-' : t.v === '+' ? 'u+' : '!';
      return { kind: 'un', op, arg: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.next();
    if (!t) throw new ExprError('表达式意外结束');
    this.add();
    if (t.t === 'num') {
      // k/m 后缀在词法阶段已并入文本，这里统一求值（.5 这种前导点形式也合法）。
      const m = /^((?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)([kKmM])?$/.exec(t.v);
      if (!m) throw new ExprError(`非法数字：${t.v}`);
      let value = Number(m[1]);
      if (m[2] === 'k' || m[2] === 'K') value *= 1_000;
      if (m[2] === 'm' || m[2] === 'M') value *= 1_000_000;
      if (!Number.isFinite(value)) throw new ExprError(`数字字面量溢出：${t.v}`);
      return { kind: 'num', value };
    }
    if (t.t === 'str') return { kind: 'str', value: t.v };
    if (t.t === 'ident') {
      if (t.v === 'true') return { kind: 'bool', value: true };
      if (t.v === 'false') return { kind: 'bool', value: false };
      if (t.v === 'nil') return { kind: 'nil' };
      const nxt = this.peek();
      if (nxt && nxt.t === 'op' && nxt.v === '(') {
        if (!FUNCTIONS.has(t.v)) throw new ExprError(`未知函数 "${t.v}"`);
        this.next();
        const args: Node[] = [];
        const close = this.peek();
        if (close && close.t === 'op' && close.v === ')') {
          this.next();
        } else {
          for (;;) {
            args.push(this.ternary());
            const sep = this.next();
            if (!sep || sep.t !== 'op' || (sep.v !== ',' && sep.v !== ')')) throw new ExprError(`函数 ${t.v}() 参数列表格式错误`);
            if (sep.v === ')') break;
          }
        }
        checkCall(t.v, args);
        return { kind: 'call', name: t.v, args };
      }
      if (!VARIABLES.has(t.v)) throw new ExprError(`未知变量 "${t.v}"（可用：${[...VARIABLES].join(', ')}）`);
      return { kind: 'var', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      const inner = this.ternary();
      this.expectOp(')');
      return inner;
    }
    throw new ExprError(`意外的符号 "${t.v}"`);
  }
}

/** 编译期就能定死的函数约束；运行期只做类型校验。 */
function checkCall(name: string, args: Node[]): void {
  const arityError = (want: string) => new ExprError(`${name}() 需要 ${want} 个参数`);
  switch (name) {
    case 'min': case 'max': case 'has':
      if (args.length !== 2) throw arityError('2');
      break;
    case 'abs': case 'ceil': case 'floor': case 'param': case 'header':
      if (args.length !== 1) throw arityError('1');
      break;
    case 'param': break; // arity 已查；键必须是字符串字面量，见下
    case 'tier': {
      if (args.length !== 2) throw arityError('2');
      if (args[0].kind !== 'str') throw new ExprError('tier() 的第一个参数必须是字符串字面量档名');
      break;
    }
    case 'hour': case 'minute': case 'weekday': case 'day': case 'month':
      if (args.length > 1) throw arityError('0 或 1');
      if (args.length === 1 && args[0].kind !== 'str') throw new ExprError(`${name}() 的时区参数必须是字符串字面量`);
      break;
  }
  // 探针的键在编译期定死为字符串字面量：便于校验阶段理解表达式读了什么，
  // 也防止把动态字符串当路径用（路径应写死在配置里，而不是运行时拼出来）。
  if ((name === 'param' || name === 'header') && args[0]?.kind !== 'str') {
    throw new ExprError(`${name}() 的键必须是字符串字面量`);
  }
}

// ---------------------------------------------------------------- 编译缓存

const cache = new Map<string, CompileResult>();

/** 编译（带缓存）。语义错误的表达式永远编译不过，坏配置在保存时就会被拦下。 */
export function compileBillingExpr(src: string): CompileResult {
  const key = src;
  const hit = cache.get(key);
  if (hit) return hit;
  let result: CompileResult;
  try {
    if (src.length > MAX_SRC_LEN) throw new ExprError(`表达式过长（>${MAX_SRC_LEN} 字符）`);
    const ast = new Parser(tokenize(src)).parse();
    result = { ok: true, program: { src, ast } };
  } catch (e) {
    result = { ok: false, error: e instanceof ExprError ? e.message : `解析失败：${String(e)}` };
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}

// ---------------------------------------------------------------- 求值

type Value = number | string | boolean | null;

interface Ctx {
  params: RateParams;
  probes: ProbeContext;
  trace: ExprTrace;
  now: Date;
}

function evalNode(node: Node, ctx: Ctx): Value {
  switch (node.kind) {
    case 'num': return node.value;
    case 'str': return node.value;
    case 'bool': return node.value;
    case 'nil': return null;
    case 'var': {
      // `len` 是 `context` 的别名（v1 沿用下来的书写习惯）。
      if (node.name === 'len') return ctx.params.context;
      return ctx.params[node.name as keyof RateParams];
    }
    case 'un': {
      const v = evalNode(node.arg, ctx);
      if (node.op === '!') {
        if (typeof v !== 'boolean') throw new ExprError('! 需要布尔操作数');
        return !v;
      }
      if (typeof v !== 'number') throw new ExprError('一元 +/- 需要数字操作数');
      return node.op === 'u-' ? -v : v;
    }
    case 'and': {
      const l = evalNode(node.l, ctx);
      if (typeof l !== 'boolean') throw new ExprError('&& 需要布尔操作数');
      if (!l) return false;
      const r = evalNode(node.r, ctx);
      if (typeof r !== 'boolean') throw new ExprError('&& 需要布尔操作数');
      return r;
    }
    case 'or': {
      const l = evalNode(node.l, ctx);
      if (typeof l !== 'boolean') throw new ExprError('|| 需要布尔操作数');
      if (l) return true;
      const r = evalNode(node.r, ctx);
      if (typeof r !== 'boolean') throw new ExprError('|| 需要布尔操作数');
      return r;
    }
    case 'cond': {
      const c = evalNode(node.c, ctx);
      if (typeof c !== 'boolean') throw new ExprError('三目条件必须是布尔值');
      // 短路：走不到的分支不产生 tier 副作用。
      return evalNode(c ? node.t : node.f, ctx);
    }
    case 'bin': return evalBin(node.op, evalNode(node.l, ctx), evalNode(node.r, ctx));
    case 'call': return evalCall(node, ctx);
  }
}

function num(v: Value, what: string): number {
  if (typeof v !== 'number') throw new ExprError(`${what} 需要数字操作数`);
  return v;
}

/** 探针返回值只允许标量；对象/数组没有定价语义，直接报错（fail-closed）。 */
function scalar(v: unknown, what: string): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  throw new ExprError(`${what} 返回了非标量值（对象/数组不能参与定价运算）`);
}

function evalBin(op: BinOp, lv: Value, rv: Value): Value {
  switch (op) {
    case '+': case '-': case '*': case '/': case '%': {
      const a = num(lv, `"${op}"`);
      const b = num(rv, `"${op}"`);
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
          if (b === 0) throw new ExprError('除零');
          return a / b; // 永远是浮点除法
        case '%':
          if (b === 0) throw new ExprError('对 0 取模');
          return a % b; // 实数取余（JS 语义），正负号跟随被除数
      }
      break;
    }
    case '<': case '<=': case '>': case '>=': {
      if (typeof lv === 'number' && typeof rv === 'number') {
        return op === '<' ? lv < rv : op === '<=' ? lv <= rv : op === '>' ? lv > rv : lv >= rv;
      }
      if (typeof lv === 'string' && typeof rv === 'string') {
        return op === '<' ? lv < rv : op === '<=' ? lv <= rv : op === '>' ? lv > rv : lv >= rv;
      }
      throw new ExprError(`"${op}" 的两个操作数必须同为数字或同为字符串`);
    }
    case '==': case '!=': {
      const sameType =
        (typeof lv === 'number' && typeof rv === 'number') ||
        (typeof lv === 'string' && typeof rv === 'string') ||
        (typeof lv === 'boolean' && typeof rv === 'boolean') ||
        (lv === null && rv === null);
      if (!sameType) {
        // null 与非 null 的比较不报错、直接为「不等」：探针缺失时
        // `header('x') == 'fast'` 应当是 false 而不是一条 5xx。
        if (lv === null || rv === null) return op === '!=';
        throw new ExprError('"=="/"!=" 不能比较不同类型的值');
      }
      return op === '==' ? lv === rv : lv !== rv;
    }
  }
  throw new ExprError(`未知运算符 ${op}`);
}

function evalCall(node: Extract<Node, { kind: 'call' }>, ctx: Ctx): Value {
  const args = node.args;
  switch (node.name) {
    case 'min': return Math.min(num(evalNode(args[0], ctx), 'min()'), num(evalNode(args[1], ctx), 'min()'));
    case 'max': return Math.max(num(evalNode(args[0], ctx), 'max()'), num(evalNode(args[1], ctx), 'max()'));
    case 'abs': return Math.abs(num(evalNode(args[0], ctx), 'abs()'));
    case 'ceil': return Math.ceil(num(evalNode(args[0], ctx), 'ceil()'));
    case 'floor': return Math.floor(num(evalNode(args[0], ctx), 'floor()'));
    case 'tier': {
      const name = evalNode(args[0], ctx);
      const value = num(evalNode(args[1], ctx), 'tier()');
      if (typeof name !== 'string') throw new ExprError('tier() 的档名必须是字符串');
      ctx.trace.matchedTier = name;
      return value;
    }
    case 'param': {
      const path = evalNode(args[0], ctx) as string;
      return scalar(ctx.probes.param(path), `param("${path}")`);
    }
    case 'header': {
      const key = evalNode(args[0], ctx) as string;
      return scalar(ctx.probes.header(key), `header("${key}")`);
    }
    case 'has': {
      const src = evalNode(args[0], ctx);
      const sub = evalNode(args[1], ctx);
      // 缺失探针上的 has 恒为 false：`has(header('x'), 'y')` 在没有 x 头时安全。
      if (src === null) return false;
      if (typeof src !== 'string') throw new ExprError('has() 的第一个参数必须是字符串');
      if (typeof sub !== 'string') throw new ExprError('has() 的第二个参数必须是字符串');
      return src.includes(sub);
    }
    case 'hour': case 'minute': case 'weekday': case 'day': case 'month': {
      let tz: string | undefined;
      if (args.length === 1) {
        const v = evalNode(args[0], ctx);
        if (typeof v !== 'string') throw new ExprError(`${node.name}() 的时区必须是字符串`);
        tz = v;
      }
      const parts = timeParts(tz, ctx.now);
      switch (node.name) {
        case 'hour': return parts.hour;
        case 'minute': return parts.minute;
        // 与 Go time.Weekday() 对齐：0 = 周日。
        case 'weekday': return parts.weekday;
        case 'day': return parts.day;
        case 'month': return parts.month;
      }
      break;
    }
  }
  throw new ExprError(`未知函数 ${node.name}()`);
}

// ---------------------------------------------------------------- 时区时间

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz || 'UTC';
  const hit = fmtCache.get(key);
  if (hit) return hit;
  let fmt: Intl.DateTimeFormat;
  try {
    // tz 非法时这里抛 RangeError，回退 UTC（与 new-api 的 timeInZone 行为一致）。
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: key, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }
  if (fmtCache.size >= 64) fmtCache.clear();
  fmtCache.set(key, fmt);
  return fmt;
}

function timeParts(tz: string | undefined, now: Date): { hour: number; minute: number; weekday: number; day: number; month: number } {
  const parts = Object.fromEntries(formatter(tz).formatToParts(now).map((p) => [p.type, p.value]));
  return {
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday as string] ?? 0,
    day: Number(parts.day),
    month: Number(parts.month),
  };
}

// ---------------------------------------------------------------- 入口

/** 没有真实请求时的探针桩：所有探针返回 null（保存时的冒烟校验用它）。 */
export const ABSENT_PROBES: ProbeContext = {
  header: () => null,
  param: () => null,
};

export interface RateEnv {
  params: RateParams;
  probes?: ProbeContext;
  now?: Date;
}

/**
 * 求值一个费率表达式。结果是**该字段的 USD / 1M tokens 费率**（不是总价——
 * token 数由计费引擎按字段套用，见 llm.ts 的 quotaFromRates）。
 */
export function evaluateRate(program: Program, env: RateEnv): EvalResult {
  const trace: ExprTrace = {};
  try {
    const out = evalNode(program.ast, {
      params: env.params,
      probes: env.probes ?? ABSENT_PROBES,
      trace,
      now: env.now ?? new Date(),
    });
    if (typeof out !== 'number') throw new ExprError('表达式结果必须是数字（费率）');
    if (!Number.isFinite(out)) throw new ExprError('表达式结果不是有限数字');
    return { ok: true, rate: out, trace };
  } catch (e) {
    return { ok: false, error: e instanceof ExprError ? e.message : `求值失败：${String(e)}` };
  }
}
