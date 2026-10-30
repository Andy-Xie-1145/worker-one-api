import type { Options } from '../options';
import {
  compileBillingExpr, evaluateRate, ABSENT_PROBES,
  type ProbeContext, type RateParams, type ExprTrace, type Program,
} from './expr';

/**
 * Quota unit matches upstream one-api: 500_000 quota == $1.
 * Prices below are USD per 1M tokens; overrides come from the options table.
 */
export const QUOTA_PER_USD = 500_000;

/**
 * 单个计费字段：数字常量（USD / 1M tokens）或**费率表达式**（v2，见 ./expr.ts）。
 *
 * 表达式在每次请求「选中渠道后、发上游前」求值一次，结果是该字段本次请求的
 * 费率（不是总价），例如：
 *   "in":  "4 * (context > 272k ? 0.5 : 1)"   // 长上下文档位
 *   "in":  "0.3 * (hour('Asia/Shanghai') < 5 ? 0.5 : 1)"  // 谷时
 * 字段省略时按 `in` 的费率计（cached_in 省略 = 缓存命中按输入价，宁可高估）。
 */
export type RateSpec = number | string;

export interface Price {
  /** 输入（未命中缓存的 fresh 部分）。 */
  in: RateSpec;
  /** 输出。 */
  out: RateSpec;
  /** 缓存命中（读）。省略 = 按 `in` 计。 */
  cached_in?: RateSpec;
  /** 缓存写入，5 分钟 TTL（Anthropic 官方 1.25× 输入价）。省略 = 按 `in` 计。 */
  cache_write_5m?: RateSpec;
  /** 缓存写入，1 小时 TTL（Anthropic 官方 2× 输入价）。省略 = 按 `in` 计。 */
  cache_write_1h?: RateSpec;
}

/** v2 起 PriceSpec 就是 Price：旧版整笔 `{expr}` 总价写法已移除。 */
export type PriceSpec = Price;

export const DEFAULT_PRICE: Price = { in: 1, out: 3 };

/**
 * 价格体系版本号：价格表/字段语义发生**影响计费结果**的变更时递增。
 * 它进消费日志的 billing_meta，审计时用它对齐「这笔账是按哪版价格记的」。
 */
export const LLM_PRICING_VERSION = 'v2-2026-10-31';

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

  // GPT-6 家族——官方 standard（短上下文 ≤272K 输入）档，2026-10 核对
  // https://developers.openai.com/api/docs/pricing 。长上下文（>272K 输入：
  // 输入 2 倍、输出 1.5 倍）用字段费率表达式表达，例如：
  //   {"in": "10 * (context > 272k ? 2 : 1)", "out": "50 * (context > 272k ? 1.5 : 1)"}
  'gpt-6-astra': { in: 10, out: 50, cached_in: 1 },
  'gpt-6.1-sol': { in: 2, out: 10, cached_in: 0.1 },
  'gpt-6-sol': { in: 2, out: 10, cached_in: 0.2 },
  'gpt-6-luna': { in: 0.1, out: 0.5, cached_in: 0.01 },

  'o4-mini': { in: 1.1, out: 4.4 },
  'o3-mini': { in: 1.1, out: 4.4 },
  o3: { in: 2, out: 8 },
  o1: { in: 15, out: 60 },
  'text-embedding-3-large': { in: 0.13, out: 0 },
  'text-embedding-3-small': { in: 0.02, out: 0 },

  // 生图模型——token 计费（Images API 响应自带 usage，按实际 token 结算）。
  // 官方：文本输入 $5 / 缓存 $1.25 / 图像输出 $30；图像输入（编辑/参考图）$8，
  // 混在 `in` 里按文本价 $5 计——重编辑工作流想要精确就用字段费率表达式。
  // gpt-image-1 已于 2026-10-23 退役，不收录。
  'gpt-image-2': { in: 5, out: 30, cached_in: 1.25 },
  'gpt-image-2.5-flare': { in: 5, out: 30, cached_in: 1.25 },
  'gpt-image-2.5-sunburst': { in: 5, out: 30, cached_in: 1.25 },

  // Anthropic
  // Claude 5.5 家族——官方定价页 2026-10 核对。Opus 5.5 缓存命中 $0.20（$4 的 5%）；
  // Sonnet 5.5 缓存命中 $0.10（官方表，较 Sonnet 5 减半）。
  // cache_write_5m / cache_write_1h 按官方口径 = 输入价 ×1.25 / ×2
  // （https://platform.claude.com/docs/en/about-claude/pricing）。
  'claude-opus-5-5': { in: 4, out: 20, cached_in: 0.2, cache_write_5m: 5, cache_write_1h: 8 },
  'claude-sonnet-5-5': { in: 2, out: 10, cached_in: 0.1, cache_write_5m: 2.5, cache_write_1h: 4 },
  'claude-3-haiku': { in: 0.25, out: 1.25, cache_write_5m: 0.3125, cache_write_1h: 0.5 },
  'claude-3-5-haiku': { in: 0.8, out: 4, cache_write_5m: 1, cache_write_1h: 1.6 },
  'claude-3-5-sonnet': { in: 3, out: 15, cache_write_5m: 3.75, cache_write_1h: 6 },
  'claude-3-7-sonnet': { in: 3, out: 15, cache_write_5m: 3.75, cache_write_1h: 6 },
  'claude-haiku-4': { in: 1, out: 5, cache_write_5m: 1.25, cache_write_1h: 2 },
  'claude-sonnet-4': { in: 3, out: 15, cache_write_5m: 3.75, cache_write_1h: 6 },
  'claude-opus-4': { in: 15, out: 75, cache_write_5m: 18.75, cache_write_1h: 30 },
  'claude-3-opus': { in: 15, out: 75, cache_write_5m: 18.75, cache_write_1h: 30 },

  // Google — 抄自 https://ai.google.dev/gemini-api/docs/pricing（2026-09-01 核对）
  //
  // 三处这张表表达不了、只能就低取的地方：
  //   - 音频输入另有更高的费率（3.1-flash-lite 文本 $0.25 / 音频 $0.50），这里按文本计；
  //   - 3.1-pro-preview 按上下文长度分档（≤200k $2/$12，>200k $4/$18），这里按 ≤200k 计，
  //     要分档就用字段费率表达式：{"in": "2 * (context > 200k ? 2 : 1)", ...}；
  //   - 3.6/3.7 Flash 的 $0.75/$3.75 是 2026-12-31 之前的促销价，**2027-01-01 起翻倍到
  //     $1.50/$7.50**，到期要回来改这两行。
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

  // DeepSeek — 官方公示价（$ / 1M tokens）。峰谷时段差异如需体现，用字段费率表达式：
  //   {"in": "0.3 * (hour('Asia/Shanghai') >= 1 && hour('Asia/Shanghai') < 5 ? 1 : 0.5)", ...}
  // Verified against https://api-docs.deepseek.com/quick_start/pricing
  //
  // V4.1 Flash（API 名 deepseek-flash，2026-09-10 起）：peak $0.30 / $1.20，
  // 缓存命中 $0.006；off-peak 全线减半。
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

// ---------------------------------------------------------------- 计费身份（严格计费）

/** 严格计费的错误码：查不到价的模型以 503 + 此 code 拒绝（不发上游、不预扣）。 */
export const MODEL_PRICE_NOT_CONFIGURED = 'model_price_not_configured';

/**
 * 严格计费是否生效：**DefaultPrice 未设置**即生效（fail-closed，查不到价直接拒绝）；
 * 设置了则按兜底价记账（旧行为，等价格数据核对完再清空启用严格模式）。
 */
export function strictBillingEnabled(options?: Options): boolean {
  return !options?.DefaultPrice;
}

/**
 * 计费身份：一个请求最终按**哪个名字、哪条配置、经由谁**计费。
 *
 * 在「选中渠道后、发上游前」解析一次并连同费率一起钉在预扣上；结算复用同一份，
 * 绝不重新解析——两次解析之间配置、时间函数都可能变，前后不一致会让找平出错。
 */
export interface BillingIdentity {
  /** 命中的名字（请求名，或 model_mapping 后的上游名）。 */
  billingModel: string;
  spec: PriceSpec;
  source: PriceSource;
  /** 价格是按请求名查到的，还是按映射后的上游名查到的。 */
  via: 'requested' | 'upstream';
}

/**
 * 解析计费身份，**查不到价时回 null**（严格计费的 fail-closed 入口）。
 *
 * 与 resolvePrice 的差别只有两点：多带 `via`/命中名（模型计费页与日志要展示），
 * 以及**兜底价在这里显式判定**——`options.DefaultPrice` 未设置时返回 null
 * （请求将被 503 model_price_not_configured 拒绝），设置了则给 default 身份。
 */
export function resolveBillableModel(
  requested: string,
  upstreamModel: string | undefined,
  options?: Options,
  keyOverrides?: OverrideTable,
): BillingIdentity | null {
  const direct = cascade(requested, options, keyOverrides);
  if (direct) return { billingModel: requested, spec: direct.spec, source: direct.source, via: 'requested' };
  if (upstreamModel && upstreamModel !== requested) {
    const mapped = cascade(upstreamModel, options, keyOverrides);
    if (mapped) return { billingModel: upstreamModel, spec: mapped.spec, source: mapped.source, via: 'upstream' };
  }
  if (options?.DefaultPrice) {
    return { billingModel: requested, spec: options.DefaultPrice, source: 'default', via: 'requested' };
  }
  return null;
}

/** 两个计费身份是否等价（换渠道时用来判断要不要重开一对 pre/fin ref）。 */
export function sameBillingIdentity(a: BillingIdentity, b: BillingIdentity): boolean {
  return (
    a.billingModel === b.billingModel &&
    a.source === b.source &&
    a.via === b.via &&
    JSON.stringify(a.spec) === JSON.stringify(b.spec)
  );
}

// ---------------------------------------------------------------- 计费用量

export interface Billable {
  prompt_tokens: number;
  completion_tokens: number;
  /** Subset of prompt_tokens that the vendor served from its prompt cache. */
  cached_tokens?: number;
  /** 5 分钟 TTL 缓存写入 token（Anthropic cache_creation.ephemeral_5m_input_tokens）。 */
  cache_write_5m_tokens?: number;
  /** 1 小时 TTL 缓存写入 token（Anthropic cache_creation.ephemeral_1h_input_tokens）。 */
  cache_write_1h_tokens?: number;
  /** 请求级数量（图像张数等），供费率表达式里的 `n` 使用，默认 1。 */
  n?: number;
}

/** 一组解析完的**数字**费率（USD / 1M tokens），每个计费字段一个。 */
export interface RateSet {
  in: number;
  out: number;
  cached_in: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

export interface RateResolution {
  rates: RateSet;
  source: PriceSource;
  trace: ExprTrace;
}

const RATE_FIELDS: Array<{ key: keyof Price & string; optional: boolean; label: string }> = [
  { key: 'in', optional: false, label: 'in' },
  { key: 'out', optional: false, label: 'out' },
  { key: 'cached_in', optional: true, label: 'cached_in' },
  { key: 'cache_write_5m', optional: true, label: 'cache_write_5m' },
  { key: 'cache_write_1h', optional: true, label: 'cache_write_1h' },
];

/**
 * 把一条 PriceSpec 解析成**数字费率集**。费率表达式在这里求值——调用方应当在
 * 「选中渠道后、发上游前」调用一次并把结果钉住，结算复用同一份，绝不重新求值
 * （两次求值之间时间函数/请求探针都可能变化，前后不一致会让找平出错）。
 *
 * 字段省略 → 继承 `in` 的费率；任何字段的表达式求值失败 → 整体失败（fail-closed），
 * 调用方决定跳过渠道还是回退兜底价。
 */
export function resolveRates(
  spec: PriceSpec,
  params: RateParams,
  probes?: ProbeContext,
  now?: Date,
): { ok: true; rates: RateSet; trace: ExprTrace } | { ok: false; error: string } {
  const rates: Partial<RateSet> = {};
  const trace: ExprTrace = {};
  let base: number | null = null;
  for (const field of RATE_FIELDS) {
    const raw = spec[field.key];
    let rate: number;
    if (raw === undefined || raw === '') {
      // 省略字段继承输入价：cached_in 省略 = 缓存命中按输入价（宁可高估）；
      // cache_write 省略 = 写缓存按输入价（低于官方 1.25×/2×，方向是少收）。
      rate = base ?? 0;
    } else if (typeof raw === 'number') {
      rate = raw;
    } else {
      const compiled = compileBillingExpr(raw);
      if (!compiled.ok) return { ok: false, error: `字段 ${field.label} 的表达式无法编译：${compiled.error}` };
      const evaluated = evaluateRate(compiled.program, { params, probes, now });
      if (!evaluated.ok) return { ok: false, error: `字段 ${field.label} 的表达式求值失败：${evaluated.error}` };
      rate = evaluated.rate;
      if (evaluated.trace.matchedTier) trace.matchedTier = evaluated.trace.matchedTier;
    }
    if (!Number.isFinite(rate) || rate < 0) {
      return { ok: false, error: `字段 ${field.label} 的费率不是有限的非负数字` };
    }
    rates[field.key as keyof RateSet] = rate;
    if (field.key === 'in') base = rate;
  }
  return { ok: true, rates: rates as RateSet, trace };
}

/**
 * 费率 × 用量 → quota。各分量互斥地归一化：
 *
 *   fresh = prompt − cached − cw5 − cw1（Anthropic 的 input_tokens 不含缓存，
 *   归一化后 prompt 是三者之和，所以 fresh 要同时减掉两项缓存）
 *
 * OpenAI/Gemini 没有写缓存概念，两个 cache_write 恒为 0，公式自然退化。
 */
export function quotaFromRates(rates: RateSet, usage: Billable): number {
  const prompt = Math.max(0, usage.prompt_tokens);
  const cached = Math.min(Math.max(0, usage.cached_tokens ?? 0), prompt);
  const cw5 = Math.min(Math.max(0, usage.cache_write_5m_tokens ?? 0), prompt - cached);
  const cw1 = Math.min(Math.max(0, usage.cache_write_1h_tokens ?? 0), prompt - cached - cw5);
  const fresh = prompt - cached - cw5 - cw1;
  const completion = Math.max(0, usage.completion_tokens);
  const usd =
    (fresh * rates.in +
      cached * rates.cached_in +
      cw5 * rates.cache_write_5m +
      cw1 * rates.cache_write_1h +
      completion * rates.out) /
    1_000_000;
  return Math.max(0, Math.ceil(usd * QUOTA_PER_USD));
}

export interface QuotaDetail {
  quota: number;
  source: PriceSource;
  /** 表达式计费的追踪信息（命中的 tier 档名），常量价时为空。 */
  trace?: ExprTrace;
}

/**
 * 计费 = 用量 × 费率，**没有任何倍率**。
 *
 * `probes` 供给请求探针（param/header）；预扣与结算必须传同一份探针取值结果——
 * 实践上是在预扣前求一次费率并钉住（relay 的计费身份），结算直接复用。
 * 只要数字时用 calcQuota()。
 */
export function calcQuotaDetailed(
  model: string,
  usage: Billable,
  options?: Options,
  upstreamModel?: string,
  keyOverrides?: OverrideTable,
  now?: Date,
  probes?: ProbeContext,
): QuotaDetail {
  const { spec, source } = resolvePrice(model, options, upstreamModel, keyOverrides);
  const params: RateParams = { context: Math.max(0, usage.prompt_tokens), n: usage.n ?? 1 };
  const resolved = resolveRates(spec, params, probes, now);
  if (resolved.ok) {
    return { quota: quotaFromRates(resolved.rates, usage), source, trace: resolved.trace };
  }
  console.error(`[pricing] 模型 ${model} 的价格解析失败，回退默认价：${resolved.error}`);
  // 覆盖配置坏了也不能按 0 记账：回退默认价（宁可收错方向保守，也不白送）。
  const fallback = fallbackQuota(DEFAULT_PRICE, usage, params, now, probes);
  return { quota: fallback.quota, source: 'default', trace: fallback.trace };
}

/** 对兜底价再走一遍解析；DEFAULT_PRICE 是常量所以不会失败，防御性兜住万一。 */
function fallbackQuota(spec: PriceSpec, usage: Billable, params: RateParams, now?: Date, probes?: ProbeContext): QuotaDetail {
  const resolved = resolveRates(spec, params, probes, now);
  if (resolved.ok) return { quota: quotaFromRates(resolved.rates, usage), source: 'default', trace: resolved.trace };
  // 理论不可达（DEFAULT_PRICE 是常量、保存时已校验）。真发生了就记 0 并大声报错，
  // 绝不静默编一个数字出来。
  console.error(`[pricing] 默认价解析失败，本次按 0 记账：${resolved.error}`);
  return { quota: 0, source: 'default' };
}

/** 只要数字的快捷版。 */
export function calcQuota(
  model: string,
  usage: Billable,
  options?: Options,
  upstreamModel?: string,
  keyOverrides?: OverrideTable,
  now?: Date,
  probes?: ProbeContext,
): number {
  return calcQuotaDetailed(model, usage, options, upstreamModel, keyOverrides, now, probes).quota;
}

export function quotaToUSD(quota: number): number {
  return quota / QUOTA_PER_USD;
}

// ---------------------------------------------------------------- 校验

const RATE_FIELDS_FOR_VALIDATE: Array<{ key: keyof Price & string; required: boolean; label: string }> = [
  { key: 'in', required: true, label: 'in' },
  { key: 'out', required: true, label: 'out' },
  { key: 'cached_in', required: false, label: 'cached_in' },
  { key: 'cache_write_5m', required: false, label: 'cache_write_5m' },
  { key: 'cache_write_1h', required: false, label: 'cache_write_1h' },
];

/**
 * 校验一条 PriceSpec（保存 Key 配置 / 全局覆盖 / 内置兜底价时调用）。
 *
 * 每个字段独立校验：非负有限数字，或**费率表达式**（编译 + 冒烟：拿几组典型
 * 输入长度、探针全缺失、三个时刻实跑，结果必须是有限、非负的数字）。
 * 旧版整笔 `{expr:"..."}` 已移除，遇到时明确报错并给出 v2 写法提示。
 */
export function validatePriceSpec(spec: unknown): { ok: true; spec: PriceSpec } | { ok: false; error: string } {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, error: '价格配置必须是对象' };
  const s = spec as Record<string, unknown>;

  if (s.expr !== undefined) {
    return {
      ok: false,
      error: '旧版整笔 {expr} 已移除：v2 按字段写费率表达式，如 {"in": "4 * (context > 272k ? 0.5 : 1)", "out": 20}',
    };
  }

  const out: Record<string, RateSpec> = {};
  for (const field of RATE_FIELDS_FOR_VALIDATE) {
    const raw = s[field.key];
    if (raw === undefined) {
      if (field.required) return { ok: false, error: `缺少字段 ${field.label}` };
      continue;
    }
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw) || raw < 0) {
        return { ok: false, error: `${field.label} 必须是 ≥ 0 的有限数字（美元 / 1M tokens）` };
      }
      out[field.key] = raw;
      continue;
    }
    if (typeof raw === 'string') {
      const expr = raw.trim();
      if (!expr) return { ok: false, error: `${field.label} 的表达式不能为空字符串` };
      // 纯数字（含 k/m 后缀）字符串归一化为常量数字——CLI/表单提交的都是文本，
      // "0.5" 应该存成数字，而不是一条求值结果相同的退化表达式。
      const numLike = /^(\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?([kKmM])?$/.exec(expr);
      if (numLike) {
        let v = Number(numLike[1]);
        if (numLike[2] === 'k' || numLike[2] === 'K') v *= 1_000;
        if (numLike[2] === 'm' || numLike[2] === 'M') v *= 1_000_000;
        if (!Number.isFinite(v) || v < 0) {
          return { ok: false, error: `${field.label} 必须是 ≥ 0 的有限数字（美元 / 1M tokens）` };
        }
        out[field.key] = v;
        continue;
      }
      const compiled = compileBillingExpr(expr);
      if (!compiled.ok) return { ok: false, error: `${field.label} 的表达式无法编译：${compiled.error}` };
      const smoke = smokeTestExpr(compiled.program);
      if (!smoke.ok) return { ok: false, error: `${field.label} 的表达式冒烟测试失败：${smoke.error}` };
      out[field.key] = expr;
      continue;
    }
    return { ok: false, error: `${field.label} 必须是数字或费率表达式字符串` };
  }
  return { ok: true, spec: out as unknown as PriceSpec };
}

/**
 * 冒烟向量：零/典型/长上下文边界（272k 两侧）/超大输入长度 × 探针全缺失 ×
 * 三个时刻（覆盖时间函数）。费率必须有限且非负——保存时拦住，运行期才不会
 * 因为除零这类问题把请求打成 5xx。
 */
function smokeTestExpr(program: Program): { ok: true } | { ok: false; error: string } {
  const contexts = [0, 1_000, 100_000, 272_000, 300_000, 5_000_000];
  const times = [undefined, new Date('2026-01-01T00:30:00Z'), new Date('2026-07-01T23:59:00Z')] as const;
  for (const context of contexts) {
    for (const n of [1, 3]) {
      for (const at of times) {
        const r = evaluateRate(program, { params: { context, n }, probes: ABSENT_PROBES, now: at });
        if (!r.ok) return { ok: false, error: r.error };
        if (!Number.isFinite(r.rate) || r.rate < 0) {
          return { ok: false, error: `费率为负或非有限（context=${context}, n=${n} 时得到 ${r.rate}）` };
        }
      }
    }
  }
  return { ok: true };
}
