import type { Options } from '../options';
import { compileBillingExpr, evaluateProgram, type ExprParams, type ExprTrace, type Program } from './expr';

/**
 * Quota unit matches upstream one-api: 500_000 quota == $1.
 * Prices below are USD per 1M tokens; overrides come from the options table.
 */
export const QUOTA_PER_USD = 500_000;

/** 固定价：美元 / 百万 tokens。cached_in 省略 = 缓存命中按 `in` 计（宁可高估不会低估）。 */
export interface Price {
  in: number;
  out: number;
  cached_in?: number;
}

/**
 * 价格配置的两种形态：
 *   固定价      {"in": 3, "out": 15, "cached_in": 0.3}
 *   表达式      {"expr": "p * 3 + c * 15 + cr * 0.3"}   —— 结果单位微美元，见 ./expr.ts
 */
export type PriceSpec = Price | { expr: string };

export function isExprSpec(spec: PriceSpec): spec is { expr: string } {
  return typeof (spec as { expr?: unknown }).expr === 'string';
}

export const DEFAULT_PRICE: Price = { in: 1, out: 3 };

/** Longest-prefix match, so dated snapshots (gpt-4o-2024-11-20) inherit the base price. */
export const PRICE_TABLE: Record<string, Price> = {
  // OpenAI
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4-turbo': { in: 10, out: 30 },
  'gpt-4': { in: 30, out: 60 },
  'gpt-3.5-turbo': { in: 0.5, out: 1.5 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5': { in: 1.25, out: 10 },
  'o4-mini': { in: 1.1, out: 4.4 },
  'o3-mini': { in: 1.1, out: 4.4 },
  o3: { in: 2, out: 8 },
  o1: { in: 15, out: 60 },
  'text-embedding-3-large': { in: 0.13, out: 0 },
  'text-embedding-3-small': { in: 0.02, out: 0 },

  // Anthropic
  'claude-3-haiku': { in: 0.25, out: 1.25 },
  'claude-3-5-haiku': { in: 0.8, out: 4 },
  'claude-3-5-sonnet': { in: 3, out: 15 },
  'claude-3-7-sonnet': { in: 3, out: 15 },
  'claude-haiku-4': { in: 1, out: 5 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-opus-4': { in: 15, out: 75 },
  'claude-3-opus': { in: 15, out: 75 },

  // Google — 抄自 https://ai.google.dev/gemini-api/docs/pricing（2026-09-01 核对）
  //
  // 三处这张表表达不了、只能就低取的地方：
  //   - 音频输入另有更高的费率（3.1-flash-lite 文本 $0.25 / 音频 $0.50），这里按文本计；
  //   - 3.1-pro-preview 按上下文长度分档（≤200k $2/$12，>200k $4/$18），这里按 ≤200k 计；
  //   - 3.6/3.7 Flash 的 $0.75/$3.75 是 2026-12-31 之前的促销价，**2027-01-01 起翻倍到
  //     $1.50/$7.50**，到期要回来改这两行。
  // 想要更细的口径（分档、分时段）时，用表达式价格配置表达，而不是改表：
  //   {"expr": "len <= 200000 ? p * 2 + c * 12 : p * 4 + c * 18"}
  'gemini-1.5-flash': { in: 0.075, out: 0.3 },
  'gemini-1.5-pro': { in: 1.25, out: 5 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
  // -lite 必须单独成行：它比 'gemini-2.5-flash' 长，最长前缀匹配才会选中它，
  // 否则 flash-lite 会按 flash 的价收，贵 3 倍。下面 3.5 那对同理。
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },
  'gemini-3-flash-preview': { in: 0.75, out: 3.75 }, // 官方定价页已下架，暂按 3.6 Flash 同价，待核
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.5 },
  'gemini-3.1-pro': { in: 2, out: 12 },
  'gemini-3.5-flash-lite': { in: 0.3, out: 2.5 },
  'gemini-3.5-flash': { in: 1.5, out: 9 },
  'gemini-3.6-flash': { in: 0.75, out: 3.75 },
  'gemini-3.7-flash': { in: 0.75, out: 3.75 },

  // DeepSeek — 官方公示价（$ / 1M tokens）。峰谷时段差异如需体现，用表达式配置：
  //   {"expr": "tier('offpeak', p * 0.22 + c * 0.66 + cr * 0.007)"}
  // Verified against https://api-docs.deepseek.com/quick_start/pricing
  //
  // V4.1 Flash（API 名 deepseek-flash，2026-09-10 起）：peak $0.30 / $1.20，
  // 缓存命中 $0.006；off-peak 全线减半——要按谷时计费就用上面的表达式写法。
  'deepseek-v4.1-flash': { in: 0.3, out: 1.2, cached_in: 0.006 },
  'deepseek-flash': { in: 0.3, out: 1.2, cached_in: 0.006 },
  'deepseek-v4-flash-vision-exp': { in: 0.44, out: 1.32, cached_in: 0.014 },
  'deepseek-v4-flash': { in: 0.44, out: 1.32, cached_in: 0.014 },
  'deepseek-v4-pro': { in: 1.32, out: 3.96, cached_in: 0.044 },

  // Moonshot / Zhipu / Qwen (approx, RMB converted at 7:1)
  'moonshot-v1': { in: 1.7, out: 1.7 },
  'kimi-k2': { in: 0.6, out: 2.5 },
  // Z.AI / GLM. Verified against https://docs.z.ai/guides/overview/pricing
  //
  // NOTE: the upstream Z.AI channel is a flat-rate Coding Plan subscription —
  // its marginal cost per token is zero. These entries are therefore a
  // *rationing dial* expressed in the vendor's public per-token prices, not a
  // pass-through of what we actually pay. Keeping them at the public rates
  // makes glm comparable to genuinely metered models (DeepSeek et al.); the
  // subscription's cost is accounted for separately.
  //
  // Access control is NOT done here: models a tier may not use are excluded by
  // channel `group`, so price stays a cost proxy and grouping stays the gate.
  // That is why the genuinely-free models are priced 0 rather than fudged.
  'glm-4.7-flashx': { in: 0.07, out: 0.4 },
  'glm-4.7-flash': { in: 0, out: 0 },
  'glm-4.7': { in: 0.6, out: 2.2 },
  'glm-4.6': { in: 0.6, out: 2.2 },
  'glm-4.5-airx': { in: 1.1, out: 4.5 },
  'glm-4.5-air': { in: 0.2, out: 1.1 },
  'glm-4.5-flash': { in: 0, out: 0 },
  'glm-4.5-x': { in: 2.2, out: 8.9 },
  'glm-4.5': { in: 0.6, out: 2.2 },
  'glm-5.3': { in: 1.4, out: 4.4 },
  'glm-5.2': { in: 1.4, out: 4.4 },
  'glm-5.1': { in: 1.4, out: 4.4 },
  'glm-5-turbo': { in: 1.2, out: 4 },
  'glm-5': { in: 1, out: 3.2 },
  'glm-4-flash': { in: 0, out: 0 },
  'glm-4-air': { in: 0.14, out: 0.14 },
  'glm-4': { in: 1.4, out: 1.4 },
  'qwen-turbo': { in: 0.05, out: 0.2 },
  'qwen-plus': { in: 0.11, out: 0.28 },
  'qwen-max': { in: 0.34, out: 1.37 },
  'ernie-4.0': { in: 4.3, out: 4.3 },
  'ernie-speed': { in: 0, out: 0 },

  /*
   * Typesafe Jev（OpenRouter Decisions API，见 relay/decisions.ts）。
   *
   * $0.042 / 1M 输入 token，输出 **不计费**——Jev 的"输出"是一组决策结果，
   * OpenRouter 不按 completion token 收。这一行必须在：没有它，jev 会掉进
   * DEFAULT_PRICE（$1/$3），输入贵 24 倍、输出更是凭空多收一笔。
   *
   * 键是剥掉厂商前缀之后的名字，所以 `~typesafe/jev-latest`、`typesafe/jev-1.13`
   * 都命中这一条（ALIAS_PREFIXES 里有 `~typesafe/` 和 `typesafe/`）。
   */
  jev: { in: 0.042, out: 0 },
};

/**
 * Vendor-prefixed aliases that resolve to the same underlying model. The
 * legacy relay accepted these and the shipped launcher still defaults to
 * `zai-coding-plan/glm-4.7`, so they must price identically to the bare name.
 */
export const ALIAS_PREFIXES = [
  'zai-coding-plan/',
  'zai/',
  // OpenRouter 形状的厂商前缀。不剥的话 `anthropic/claude-haiku-4.5` 一条前缀都匹配
  // 不上，直接掉进 DEFAULT_PRICE——线上已经这么记过 3 次账。
  'anthropic/',
  'openai/',
  'google/',
  'deepseek/',
  // Typesafe / Jev。`~` 是 OpenRouter 的浮动版本别名前缀（~typesafe/jev-latest）。
  '~typesafe/',
  'typesafe/',
];

export function stripAliasPrefix(model: string): string {
  for (const prefix of ALIAS_PREFIXES) {
    if (model.startsWith(prefix)) return model.slice(prefix.length);
  }
  return model;
}

export type PriceSource = 'key' | 'global' | 'builtin' | 'default';

export interface PriceResolution {
  spec: PriceSpec;
  source: PriceSource;
}

type OverrideTable = Record<string, PriceSpec> | undefined;

/** 覆盖表只按**写出的名字**精确命中（含剥前缀后的裸名），不做前缀匹配。 */
function lookupOverride(table: OverrideTable, model: string): PriceSpec | undefined {
  if (!table) return undefined;
  const direct = table[model];
  if (direct) return direct;
  const stripped = stripAliasPrefix(model);
  if (stripped !== model) return table[stripped];
  return undefined;
}

/** 内置表：剥前缀后最长前缀匹配。 */
function lookupBuiltin(model: string): Price | null {
  const stripped = stripAliasPrefix(model);
  let best: Price | null = null;
  let bestLen = -1;
  for (const [prefix, price] of Object.entries(PRICE_TABLE)) {
    if (stripped.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

function cascade(model: string, options?: Options, keyOverrides?: OverrideTable): PriceResolution | null {
  const key = lookupOverride(keyOverrides, model);
  if (key) return { spec: key, source: 'key' };
  const global = lookupOverride(options?.ModelPriceOverride, model);
  if (global) return { spec: global, source: 'global' };
  const builtin = lookupBuiltin(model);
  if (builtin) return { spec: builtin, source: 'builtin' };
  return null;
}

/**
 * 查价，**查不到就回 null**（内置表 + 全局覆盖，不含 Key 级）。
 *
 * 和 resolvePrice 的区别只有兜底：resolvePrice 永远给得出一个价，于是"这个模型根本
 * 没定价"和"这个模型就是 $1/$3"在调用方看来一模一样。线上因此把 gemini-flash-lite-latest
 * 按默认价记了 49 次账，没有任何东西报过警。要能报警（watchdog 的未定价模型检测），
 * 就得先有人能问出这个问题。
 */
export function findPrice(model: string, options?: Options): PriceSpec | null {
  return cascade(model, options)?.spec ?? null;
}

/**
 * 查价，四级优先：**Key 覆盖 > 全局覆盖 > 内置表 > 默认价**。
 *
 * `upstreamModel` 是渠道 model_mapping 之后的真实模型名。**别名的含义在映射里，
 * 不在名字里**：请求名整条链查不到时，用上游名再走一遍同样的链，价格自动跟着映射走。
 * 顺序不能反：请求名优先，运维想给某个别名单独定价时才拦得住。
 *
 * 同一个模型名，不同的 Key（keyOverrides 来自 `tokens.price_config`）可以有不同的价格；
 * 同一个 Key 里，不同的模型也可以各配各的——这就是「Key × 模型」二维价格矩阵。
 */
export function resolvePrice(
  model: string,
  options?: Options,
  upstreamModel?: string,
  keyOverrides?: OverrideTable,
): PriceResolution {
  const direct = cascade(model, options, keyOverrides);
  if (direct) return direct;
  if (upstreamModel && upstreamModel !== model) {
    const mapped = cascade(upstreamModel, options, keyOverrides);
    if (mapped) return mapped;
  }
  return { spec: options?.DefaultPrice ?? DEFAULT_PRICE, source: 'default' };
}

export interface Billable {
  prompt_tokens: number;
  completion_tokens: number;
  /** Subset of prompt_tokens that the vendor served from its prompt cache. */
  cached_tokens?: number;
}

export interface QuotaDetail {
  quota: number;
  source: PriceSource;
  /** 表达式计费的追踪信息（命中的 tier 档名 / 按次计费单价），固定价时为空。 */
  trace?: ExprTrace;
}

/**
 * 表达式求值的输入参数。OpenAI 语义下 `prompt_tokens` **包含**缓存命中部分，所以：
 *
 * - `len` 永远是完整输入长度（阶梯条件请用它，别用 p）；
 * - 表达式引用了 `cr` 时，缓存部分从 `p` 中扣除、由 `cr` 单独计价；
 *   没引用时缓存留在 `p` 里按基础输入价计（宁可高估不会低估）。
 */
function buildExprParams(usage: Billable, usedVars: Set<string>): ExprParams {
  const prompt = Math.max(0, usage.prompt_tokens);
  const cached = Math.min(Math.max(0, usage.cached_tokens ?? 0), prompt);
  return {
    len: prompt,
    cr: usedVars.has('cr') ? cached : 0,
    p: usedVars.has('cr') ? prompt - cached : prompt,
    c: Math.max(0, usage.completion_tokens),
  };
}

function fixedQuota(price: Price, usage: Billable): number {
  const cached = Math.min(Math.max(0, usage.cached_tokens ?? 0), usage.prompt_tokens);
  const fresh = usage.prompt_tokens - cached;
  const usd = (fresh * price.in + cached * (price.cached_in ?? price.in) + usage.completion_tokens * price.out) / 1_000_000;
  return Math.max(0, Math.ceil(usd * QUOTA_PER_USD));
}

/**
 * 计费 = 用量 × 价格，**没有任何倍率**。
 *
 * 返回明细（来源层级 + 表达式 trace）供结算日志使用；只要数字时用 calcQuota()。
 */
export function calcQuotaDetailed(
  model: string,
  usage: Billable,
  options?: Options,
  upstreamModel?: string,
  keyOverrides?: OverrideTable,
  now?: Date,
): QuotaDetail {
  const { spec, source } = resolvePrice(model, options, upstreamModel, keyOverrides);

  if (isExprSpec(spec)) {
    const compiled = compileBillingExpr(spec.expr);
    if (compiled.ok) {
      const evaluated = evaluateProgram(compiled.program, buildExprParams(usage, compiled.program.usedVars), now);
      if (evaluated.ok) {
        // 微美元 → quota：microUSD / 1e6 × QUOTA_PER_USD，向上取整（与固定价同一取整口径）。
        const quota = Math.max(0, Math.ceil((evaluated.microUSD / 1_000_000) * QUOTA_PER_USD));
        return { quota, source, trace: evaluated.trace };
      }
      console.error(`[pricing] 模型 ${model} 的表达式计价失败，回退默认价：${evaluated.error}`);
    } else {
      console.error(`[pricing] 模型 ${model} 的表达式无法编译，回退默认价：${compiled.error}`);
    }
    // 覆盖配置坏了也不能按 0 记账：回退默认价（宁可收错方向保守，也不白送）。
    return { quota: fixedQuota(options?.DefaultPrice ?? DEFAULT_PRICE, usage), source: 'default' };
  }

  return { quota: fixedQuota(spec, usage), source };
}

/** 只要数字的快捷版。 */
export function calcQuota(
  model: string,
  usage: Billable,
  options?: Options,
  upstreamModel?: string,
  keyOverrides?: OverrideTable,
  now?: Date,
): number {
  return calcQuotaDetailed(model, usage, options, upstreamModel, keyOverrides, now).quota;
}

export function quotaToUSD(quota: number): number {
  return quota / QUOTA_PER_USD;
}

/**
 * 校验一条 PriceSpec（保存 Key 配置 / 全局覆盖时调用）。
 * 表达式会**编译 + 冒烟**：拿几组典型用量实跑，结果必须是有限、非负的数字。
 */
export function validatePriceSpec(spec: unknown): { ok: true; spec: PriceSpec } | { ok: false; error: string } {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, error: '价格配置必须是对象' };
  const s = spec as Record<string, unknown>;

  if (s.expr !== undefined) {
    if (typeof s.expr !== 'string' || !s.expr.trim()) return { ok: false, error: 'expr 必须是非空字符串' };
    if (Object.keys(s).length > 1) return { ok: false, error: 'expr 配置不能与其他字段混用' };
    const compiled = compileBillingExpr(s.expr);
    if (!compiled.ok) return { ok: false, error: `表达式无法编译：${compiled.error}` };
    const smoke = smokeTestExpr(compiled.program);
    if (!smoke.ok) return { ok: false, error: `表达式冒烟测试失败：${smoke.error}` };
    return { ok: true, spec: { expr: s.expr } };
  }

  const price: Price = { in: Number(s.in), out: Number(s.out) };
  if (!Number.isFinite(price.in) || price.in < 0) return { ok: false, error: 'in 必须是 ≥ 0 的数字（美元 / 1M 输入 tokens）' };
  if (!Number.isFinite(price.out) || price.out < 0) return { ok: false, error: 'out 必须是 ≥ 0 的数字（美元 / 1M 输出 tokens）' };
  if (s.cached_in !== undefined) {
    const ci = Number(s.cached_in);
    if (!Number.isFinite(ci) || ci < 0) return { ok: false, error: 'cached_in 必须是 ≥ 0 的数字' };
    price.cached_in = ci;
  }
  return { ok: true, spec: price };
}

/** 冒烟向量：零用量、典型用量、高缓存命中、超大用量；两个时刻覆盖时间函数。 */
function smokeTestExpr(program: Program): { ok: true } | { ok: false; error: string } {
  const vectors: ExprParams[] = [
    { p: 0, c: 0, cr: 0, len: 0 },
    { p: 1000, c: 100, cr: 50, len: 1050 },
    { p: 100_000, c: 100_000, cr: 900_000, len: 1_000_000 },
    { p: 5_000_000, c: 1_000_000, cr: 0, len: 5_000_000 },
  ];
  const times = [undefined, new Date('2026-01-01T00:30:00Z'), new Date('2026-07-01T23:59:00Z')] as const;
  for (const v of vectors) {
    for (const at of times) {
      const r = evaluateProgram(program, v, at);
      if (!r.ok) return { ok: false, error: r.error };
      if (r.microUSD < 0) return { ok: false, error: `结果为负（p=${v.p}, c=${v.c}, cr=${v.cr} 时得到 ${r.microUSD}）` };
    }
  }
  return { ok: true };
}
