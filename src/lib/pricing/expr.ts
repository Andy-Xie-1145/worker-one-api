/**
 * 计费表达式引擎 —— 手写 lexer + 优先级爬升解析器 + AST 解释执行。
 *
 * **为什么不用 `new Function` / `eval`**：Cloudflare Workers 禁止动态代码求值，
 * 所以表达式被解析成 AST 后由解释器直接遍历求值。
 *
 * 设计参考 new-api（QuantumNous/new-api）的 `pkg/billingexpr/`：
 *
 * - 「一条表达式就是全部计费逻辑」：没有隐藏倍率，系数就是供应商公示的 $/1M tokens，
 *   `p * 2.5` 表示每百万输入 token 收 $2.50；
 * - 求值结果的单位是**微美元**（美元 × 1e6）：`p * 2.5` 在 p=1,000,000 时得到
 *   2,500,000 微美元 = $2.50，调用方按 `quota = ceil(microUSD / 1e6 × QUOTA_PER_USD)`
 *   换算（换算在 llm.ts，这里只管求值）；
 * - `fixed(amount)` 表示「每次成功请求 $amount」，内部同样放大 1e6 与 token 计费共用换算；
 * - `tier(name, value)` 原样返回 value，并把命中的档位记进 trace，供日志展示；
 * - 三目是唯一的短路点：走不到的分支不产生 tier/fixed 副作用；
 * - `%` 只允许整数操作数，`/` 永远是浮点除法。
 *
 * 与 new-api 的差异（刻意从简，个人网关够用）：
 * - 变量只有 `p` / `c` / `cr` / `len`（本网关的 usage 只有这四个维度）；
 * - 没有 `param()` / `header()` / `u()` 请求探针——结算管道里拿不到原始请求体；
 * - 没有 `image_count` 与请求规则插桩（`_trace`）；
 * - `fixed()` 不强制包在 `tier()` 里、也允许与 token 项相加——语义仍是明确定义的
 *   「token 费 + 每请求固定费」，校验只要求金额是**非负数字字面量**（防 `fixed(p)`）。
 */

export interface ExprParams {
  /** 计价用输入 token（表达式引用 `cr` 时已自动扣掉缓存部分，见 llm.ts）。 */
  p: number;
  /** 输出 token。 */
  c: number;
  /** 缓存命中 token；表达式没引用它时为 0（那部分留在 p 里）。 */
  cr: number;
  /** 输入上下文总长度，只用于阶梯条件，**永不被自动排除**。 */
  len: number;
}

export interface ExprTrace {
  /** 最后一次 tier() 命中的档名。 */
  matchedTier?: string;
  /** 'token'（默认）或 'request'（表达式调用了 fixed()）。 */
  billingUnit: 'token' | 'request';
  /** fixed() 的美元价（未乘任何系数）。 */
  fixedPrice?: number;
}

export type CompileResult = { ok: true; program: Program } | { ok: false; error: string };
export type EvalResult = { ok: true; microUSD: number; trace: ExprTrace } | { ok: false; error: string };

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
  /** 表达式引用到的变量名（供 p/c 的自动排除判定）。 */
  usedVars: Set<string>;
  /** 是否调用了 fixed()（按次计费）。 */
  hasFixed: boolean;
}

const VARIABLES = new Set(['p', 'c', 'cr', 'len']);
const FUNCTIONS = new Set(['min', 'max', 'abs', 'ceil', 'floor', 'fixed', 'tier', 'hour', 'minute', 'weekday', 'day', 'month']);

const MAX_SRC_LEN = 4096;
const MAX_DEPTH = 128;
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
      tokens.push({ t: 'num', v: m[0] });
      i += m[0].length;
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
      const value = Number(t.v);
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
    case 'min': case 'max':
      if (args.length !== 2) throw arityError('2');
      break;
    case 'abs': case 'ceil': case 'floor':
      if (args.length !== 1) throw arityError('1');
      break;
    case 'fixed': {
      if (args.length !== 1) throw arityError('1');
      const arg = args[0];
      // 金额必须是**非负有限数字字面量**：fixed(p)、fixed(0.01+0.02) 这类会被拒绝，
      // 否则「按次收费」就能被请求方用 token 数操纵。
      if (arg.kind !== 'num') throw new ExprError('fixed() 的金额必须是非负数字字面量');
      if (!(arg.value >= 0) || !Number.isFinite(arg.value)) throw new ExprError('fixed() 的金额必须是非负有限数字');
      break;
    }
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
}

// ---------------------------------------------------------------- 编译缓存

const cache = new Map<string, CompileResult & { ok: true } | CompileResult & { ok: false }>();

/** 编译（带缓存）。语义错误的表达式永远编译不过，坏配置在保存时就会被拦下。 */
export function compileBillingExpr(src: string): CompileResult {
  const key = src;
  const hit = cache.get(key);
  if (hit) return hit;
  let result: CompileResult;
  try {
    if (src.length > MAX_SRC_LEN) throw new ExprError(`表达式过长（>${MAX_SRC_LEN} 字符）`);
    const ast = new Parser(tokenize(src)).parse();
    const usedVars = new Set<string>();
    let hasFixed = false;
    const walk = (n: Node): void => {
      switch (n.kind) {
        case 'var': usedVars.add(n.name); break;
        case 'call':
          if (n.name === 'fixed') hasFixed = true;
          n.args.forEach(walk);
          break;
        case 'un': walk(n.arg); break;
        case 'bin': walk(n.l); walk(n.r); break;
        case 'and': case 'or': walk(n.l); walk(n.r); break;
        case 'cond': walk(n.c); walk(n.t); walk(n.f); break;
        default: break;
      }
    };
    walk(ast);
    result = { ok: true, program: { src, ast, usedVars, hasFixed } };
  } catch (e) {
    result = { ok: false, error: e instanceof ExprError ? e.message : `解析失败：${String(e)}` };
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result as never);
  return result;
}

// ---------------------------------------------------------------- 求值

type Value = number | string | boolean | null;

interface Ctx {
  params: ExprParams;
  trace: ExprTrace;
  now: Date;
}

function evalNode(node: Node, ctx: Ctx): Value {
  switch (node.kind) {
    case 'num': return node.value;
    case 'str': return node.value;
    case 'bool': return node.value;
    case 'nil': return null;
    case 'var': return ctx.params[node.name as keyof ExprParams];
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
      // 唯一的短路点：走不到的分支不产生 tier/fixed 副作用（与 new-api 一致）。
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
          return a / b; // 永远是浮点除法（Go 语义，没有整除）
        case '%': {
          if (!Number.isInteger(a) || !Number.isInteger(b)) throw new ExprError('% 只允许整数操作数');
          if (b === 0) throw new ExprError('对 0 取模');
          return a % b;
        }
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
      if (!sameType) throw new ExprError('"=="/"!=" 不能比较不同类型的值');
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
    case 'fixed': {
      const amount = num(evalNode(args[0], ctx), 'fixed()');
      ctx.trace.billingUnit = 'request';
      ctx.trace.fixedPrice = amount;
      // 与 new-api 相同：放大 1e6，和 token 计费共用「微美元 → quota」换算。
      return amount * 1_000_000;
    }
    case 'tier': {
      const name = evalNode(args[0], ctx);
      const value = num(evalNode(args[1], ctx), 'tier()');
      if (typeof name !== 'string') throw new ExprError('tier() 的档名必须是字符串');
      ctx.trace.matchedTier = name;
      return value;
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

/** 求值。结果单位是微美元（美元 × 1e6）；`hasFixed` 时 trace.billingUnit === 'request'。 */
export function evaluateProgram(program: Program, params: ExprParams, now: Date = new Date()): EvalResult {
  const trace: ExprTrace = { billingUnit: 'token' };
  try {
    const out = evalNode(program.ast, { params, trace, now });
    if (typeof out !== 'number') throw new ExprError('表达式结果必须是数字');
    if (!Number.isFinite(out)) throw new ExprError('表达式结果不是有限数字');
    return { ok: true, microUSD: out, trace };
  } catch (e) {
    return { ok: false, error: e instanceof ExprError ? e.message : `求值失败：${String(e)}` };
  }
}
