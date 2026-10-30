/*
 * 后台「模型计费」页的数据源：每个模型怎么收费、近 7 天用了多少、缓存省了多少、有没有漏配价。
 *
 * **这里不定任何价格。** 价格一律从 lib/pricing 的统一入口查出来，这个文件只做三件事：
 *   1. 把启用渠道的 models 按 model_mapping 展开成 (模型, 渠道, 上游名)，逐个问 pricing 要计费身份；
 *   2. 把 logs 近 7 天按 (model_name, channel_id) 聚合成一条 SQL（不做 N+1）；
 *   3. 同名模型跨渠道聚合成一行，渠道明细放进 channels。
 *
 * 定价一律走 resolveBillableModel()（fail-closed）：映射后的上游名查不到价且没有兜底价
 * 就是「未配置」——和 relay 实际收费（严格计费 → 503 拒绝）同一套规则。
 * logs.billing_meta（0016）存在就用它算缓存命中 / 价格版本；列不存在或旧行为空时，
 * 缓存一律是「未知」（null），绝不当成 0。
 */
import {
  LLM_PRICING_VERSION, QUOTA_PER_USD, resolveBillableModel, strictBillingEnabled, stripAliasPrefix,
  type BillingIdentity, type Price, type RateSpec,
} from './pricing/llm';
import { csv, mapModel } from './channel';
import type { Options } from './options';
import type { ChannelRow } from '../types';

export const MODEL_BILLING_WINDOW_DAYS = 7;

/**
 * 价格来源，按页面上的说法：内置价格表 / 别名 / 渠道映射 / 全局覆盖 / Key 覆盖 / 兜底价。
 */
export type PriceSourceLabel = 'table' | 'alias' | 'mapping' | 'override' | 'key' | 'default';

/** 列表价视图：字段原样透传（数字或费率表达式），expr_fields 标出哪些是表达式。 */
export type PriceView = Price & { expr_fields: string[] };

export interface ResolvedView {
  configured: boolean;
  price: Price | null;
  /** 实际按价格表 / 覆盖里哪一行定价。 */
  billingModel: string | null;
  source: PriceSourceLabel | null;
  /** 价格是按请求名还是按映射后的上游名查到的。 */
  via: 'requested' | 'upstream' | null;
}

/** 请求名 + 上游名 → 价格视图。默认实现见 resolvePriceView，测试可以替换。 */
export type PriceResolver = (requested: string, upstream: string, options: Options) => ResolvedView;

const UNCONFIGURED: ResolvedView = { configured: false, price: null, billingModel: null, source: null, via: null };

function labelOf(identity: BillingIdentity, requested: string): PriceSourceLabel {
  if (identity.source === 'key') return 'key';
  if (identity.source === 'global') return 'override';
  if (identity.source === 'default') return 'default';
  // 内置表：按映射后的上游名命中 = 渠道映射在起作用；请求名剥过厂商前缀才命中 = 别名；其余 = 直接命中内置表。
  if (identity.via === 'upstream') return 'mapping';
  return identity.via === 'requested' && stripAliasPrefix(requested) !== requested ? 'alias' : 'table';
}

const EXPR_FIELDS: Array<{ key: keyof Price; label: string }> = [
  { key: 'in', label: 'in' },
  { key: 'out', label: 'out' },
  { key: 'cached_in', label: 'cached_in' },
  { key: 'cache_write_5m', label: 'cache_write_5m' },
  { key: 'cache_write_1h', label: 'cache_write_1h' },
];

/** 哪些字段是费率表达式（SPA 显示成表达式徽标而不是数字）。 */
function exprFieldsOf(price: Price): string[] {
  const rec = price as unknown as Record<string, unknown>;
  return EXPR_FIELDS.filter((f) => typeof rec[f.key as string] === 'string').map((f) => f.label);
}

export function resolvePriceView(requested: string, upstream: string, options: Options): ResolvedView {
  const identity = resolveBillableModel(requested, upstream, options);
  if (!identity) return UNCONFIGURED;
  return {
    configured: true,
    price: identity.spec,
    billingModel: identity.billingModel,
    source: labelOf(identity, requested),
    via: identity.via,
  };
}

function priceOut(p: Price | null): PriceView | null {
  if (!p) return null;
  return { ...p, expr_fields: exprFieldsOf(p) };
}

const rateOf = (p: Price | null, key: keyof Price): RateSpec | undefined =>
  p ? (p as unknown as Record<string, unknown>)[key as string] as RateSpec : undefined;

const samePrice = (a: Price | null, b: Price | null) => JSON.stringify(a) === JSON.stringify(b);

/** 每个模型行上的「特殊规则」一句话列表。 */
export function priceRules(price: Price | null): string[] {
  if (!price) return [];
  const rules: string[] = [];
  const inR = rateOf(price, 'in');
  const outR = rateOf(price, 'out');
  if (inR === 0 && outR === 0) rules.push('免费');
  else if (outR === 0) rules.push('输出不计费');
  for (const f of exprFieldsOf(price)) rules.push(`${f}：费率表达式`);
  if (price.cached_in === undefined) rules.push('缓存命中按输入价计（未单独配置）');
  if (price.cache_write_5m === undefined && price.cache_write_1h === undefined) {
    rules.push('缓存写入按输入价计（未配置 5m/1h 独立价）');
  }
  return rules;
}

// ------------------------------------------------------------------ 聚合

/** logs 按 (model_name, channel_id) 聚合后的一行。meta_* 只统计带 billing_meta 的行。 */
export interface UsageRow {
  model_name: string;
  channel_id: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  quota: number;
  last_at: number | null;
  meta_requests: number;
  meta_prompt_tokens: number;
  cached_tokens: number;
  meta_last_at: number | null;
  pricing_version: string | null;
  billing_model: string | null;
}

export interface UsageView {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** 缓存命中 token；没有任何带 billing_meta 的请求时为 null（未知），不是 0。 */
  cached_tokens: number | null;
  /** cached / prompt，只在有 billing_meta 的请求上算；未知为 null。 */
  cache_hit_rate: number | null;
  /** 有缓存数据的请求数（其余是旧日志，缓存未知）。 */
  cache_known_requests: number;
  quota: number;
  cost_usd: number;
  last_at: number | null;
}

export interface ChannelEntry {
  id: number;
  name: string;
  type: string;
  priority: number;
  enabled: boolean;
  /** 模型在渠道 models 里声明了（否则只是日志里出现过）。 */
  declared: boolean;
  upstream_model: string;
  configured: boolean;
  price: PriceView | null;
  source: PriceSourceLabel | null;
  billing_model: string | null;
  via: 'requested' | 'upstream' | null;
  usage: UsageView;
}

export interface ModelBillingRow {
  model: string;
  upstream_models: string[];
  /** 有启用渠道声明了这个模型。false = 只在近 7 天日志里出现。 */
  active: boolean;
  configured: boolean;
  /** 部分渠道有价、部分没有。 */
  partially_configured: boolean;
  price: PriceView | null;
  /** 各渠道的价格不一致（详情里看每个渠道）。 */
  price_varies: boolean;
  sources: PriceSourceLabel[];
  rules: string[];
  usage: UsageView;
  /** 最近一次写了 billing_meta 的结算时间（最近计费时间）。 */
  last_priced_at: number | null;
  pricing_version: string | null;
  logged_billing_model: string | null;
  channels: ChannelEntry[];
}

export interface ModelBillingReport {
  window_days: number;
  since: number;
  generated_at: number;
  /** 严格计费（未设兜底价）= 未定价模型的请求会被拒绝。 */
  strict_billing: boolean;
  fallback_price: Price | null;
  current_pricing_version: string | null;
  /** logs 表上有没有 billing_meta 列。 */
  billing_meta_available: boolean;
  totals: { models: number; unconfigured: number; requests: number; cost_usd: number; quota: number };
  models: ModelBillingRow[];
}

export interface ModelBillingInput {
  channels: Array<Pick<ChannelRow, 'id' | 'name' | 'type' | 'status' | 'models' | 'model_mapping' | 'priority'>>;
  usage: UsageRow[];
  options: Options;
  now: number;
  billingMetaAvailable: boolean;
  resolver?: PriceResolver;
}

const emptyUsage = (): UsageRow => ({
  model_name: '', channel_id: 0, requests: 0, prompt_tokens: 0, completion_tokens: 0, quota: 0, last_at: null,
  meta_requests: 0, meta_prompt_tokens: 0, cached_tokens: 0, meta_last_at: null, pricing_version: null, billing_model: null,
});

const maxOf = <T extends number | string>(a: T | null, b: T | null): T | null => (a === null ? b : b === null ? a : a > b ? a : b);

function addUsage(into: UsageRow, r: UsageRow): void {
  into.requests += Number(r.requests) || 0;
  into.prompt_tokens += Number(r.prompt_tokens) || 0;
  into.completion_tokens += Number(r.completion_tokens) || 0;
  into.quota += Number(r.quota) || 0;
  into.meta_requests += Number(r.meta_requests) || 0;
  into.meta_prompt_tokens += Number(r.meta_prompt_tokens) || 0;
  into.cached_tokens += Number(r.cached_tokens) || 0;
  into.last_at = maxOf(into.last_at, r.last_at ?? null);
  into.meta_last_at = maxOf(into.meta_last_at, r.meta_last_at ?? null);
  into.pricing_version = maxOf(into.pricing_version, r.pricing_version ?? null);
  into.billing_model = into.billing_model ?? r.billing_model ?? null;
}

export function usageView(u: UsageRow): UsageView {
  const known = u.meta_requests > 0;
  return {
    requests: u.requests,
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    cached_tokens: known ? u.cached_tokens : null,
    cache_hit_rate: known && u.meta_prompt_tokens > 0 ? u.cached_tokens / u.meta_prompt_tokens : null,
    cache_known_requests: u.meta_requests,
    quota: u.quota,
    cost_usd: u.quota / QUOTA_PER_USD,
    last_at: u.last_at,
  };
}

export function buildModelBilling(input: ModelBillingInput): ModelBillingReport {
  const resolve = input.resolver ?? resolvePriceView;
  const since = input.now - MODEL_BILLING_WINDOW_DAYS * 86400;
  const channelById = new Map(input.channels.map((ch) => [ch.id, ch]));

  // (model, channel) → 用量
  const usageBy = new Map<string, UsageRow>();
  const key = (model: string, channelId: number) => `${channelId}\u0000${model}`;
  for (const r of input.usage) {
    const k = key(r.model_name, Number(r.channel_id) || 0);
    const acc = usageBy.get(k) ?? { ...emptyUsage(), model_name: r.model_name, channel_id: Number(r.channel_id) || 0 };
    addUsage(acc, r);
    usageBy.set(k, acc);
  }

  // model → channel id → declared
  const byModel = new Map<string, Map<number, { declared: boolean }>>();
  const touch = (model: string, channelId: number, declared: boolean) => {
    const m = byModel.get(model) ?? new Map();
    const prev = m.get(channelId);
    m.set(channelId, { declared: declared || !!prev?.declared });
    byModel.set(model, m);
  };
  for (const ch of input.channels) {
    if (ch.status !== 1) continue;
    for (const model of new Set(csv(ch.models))) if (model) touch(model, ch.id, true);
  }
  for (const u of usageBy.values()) touch(u.model_name, u.channel_id, false);

  const models: ModelBillingRow[] = [];
  for (const [model, chans] of byModel) {
    const total = { ...emptyUsage(), model_name: model };
    const entries: ChannelEntry[] = [];
    const rawPrice = new Map<ChannelEntry, Price | null>();
    for (const [channelId, { declared }] of chans) {
      const ch = channelById.get(channelId);
      const upstream = ch ? mapModel(ch as ChannelRow, model) : model;
      const view = resolve(model, upstream, input.options);
      const u = usageBy.get(key(model, channelId)) ?? { ...emptyUsage(), model_name: model, channel_id: channelId };
      addUsage(total, u);
      const entry: ChannelEntry = {
        id: channelId,
        name: ch?.name ?? (channelId ? `#${channelId}（已删除）` : '（未知渠道）'),
        type: ch?.type ?? '',
        priority: ch?.priority ?? 0,
        enabled: ch?.status === 1,
        declared,
        upstream_model: upstream,
        configured: view.configured,
        price: priceOut(view.price),
        source: view.source,
        billing_model: view.billingModel,
        via: view.via,
        usage: usageView(u),
      };
      entries.push(entry);
      rawPrice.set(entry, view.price);
    }
    // 启用渠道排前面，其次按用量
    entries.sort((a, b) => Number(b.enabled && b.declared) - Number(a.enabled && a.declared) || b.usage.quota - a.usage.quota || a.id - b.id);

    // 行级价格只看「真会被路由到」的渠道；一个都没有（只在日志里出现）就看全部。
    const live = entries.filter((e) => e.enabled && e.declared);
    const basis = live.length ? live : entries;
    const priced = basis.filter((e) => e.configured);
    const unpriced = basis.length - priced.length;
    const firstPrice = priced.length ? rawPrice.get(priced[0]) ?? null : null;
    const varies = priced.some((e) => {
      const p = rawPrice.get(e);
      return !!p && !!firstPrice && !samePrice(p, firstPrice);
    });

    models.push({
      model,
      upstream_models: [...new Set(basis.map((e) => e.upstream_model))],
      active: live.length > 0,
      configured: unpriced === 0,
      partially_configured: unpriced > 0 && priced.length > 0,
      price: priceOut(firstPrice),
      price_varies: varies,
      sources: [...new Set(priced.map((e) => e.source!).filter(Boolean))],
      rules: priceRules(firstPrice),
      usage: usageView(total),
      last_priced_at: total.meta_last_at,
      pricing_version: total.pricing_version,
      logged_billing_model: total.billing_model,
      channels: entries,
    });
  }

  // 未配置的排最前（这页存在的理由），其次按 7 天花费
  models.sort((a, b) => Number(a.configured) - Number(b.configured) || Number(b.active) - Number(b.active ? 1 : 0) + Number(a.active ? 1 : 0) - Number(a.active ? 1 : 0) || b.usage.quota - a.usage.quota || a.model.localeCompare(b.model));

  const quota = models.reduce((n, m) => n + m.usage.quota, 0);
  return {
    window_days: MODEL_BILLING_WINDOW_DAYS,
    since,
    generated_at: input.now,
    strict_billing: strictBillingEnabled(input.options),
    fallback_price: input.options.DefaultPrice ?? null,
    current_pricing_version: LLM_PRICING_VERSION,
    billing_meta_available: input.billingMetaAvailable,
    totals: {
      models: models.length,
      unconfigured: models.filter((m) => !m.configured).length,
      requests: models.reduce((n, m) => n + m.usage.requests, 0),
      quota,
      cost_usd: quota / QUOTA_PER_USD,
    },
    models,
  };
}

// ------------------------------------------------------------------ D1

/** billing_meta 里取字段：先 json_valid，坏 JSON 不会让整条聚合报错。 */
const meta = (path: string) => `CASE WHEN json_valid(billing_meta) THEN json_extract(billing_meta, '$.${path}') END`;
const HAS_CACHE = `${meta('cached_tokens')} IS NOT NULL`;

/**
 * 近 N 天消费行按 (model_name, channel_id) 聚合。一次往返。
 */
export function usageSQL(withMeta: boolean): string {
  const metaCols = withMeta
    ? `SUM(CASE WHEN ${HAS_CACHE} THEN 1 ELSE 0 END) AS meta_requests,
       SUM(CASE WHEN ${HAS_CACHE} THEN prompt_tokens ELSE 0 END) AS meta_prompt_tokens,
       SUM(CASE WHEN ${HAS_CACHE} THEN ${meta('cached_tokens')} ELSE 0 END) AS cached_tokens,
       MAX(CASE WHEN ${HAS_CACHE} THEN created_at END) AS meta_last_at,
       MAX(${meta('pricing_version')}) AS pricing_version,
       MAX(${meta('billing_model')}) AS billing_model`
    : `0 AS meta_requests, 0 AS meta_prompt_tokens, 0 AS cached_tokens,
       NULL AS meta_last_at, NULL AS pricing_version, NULL AS billing_model`;
  return `SELECT model_name, channel_id, COUNT(*) AS requests,
       SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
       SUM(quota) AS quota, MAX(created_at) AS last_at,
       ${metaCols}
     FROM logs
     WHERE created_at >= ? AND type = 2 AND model_name != ''
     GROUP BY model_name, channel_id`;
}

/** 渠道只取计费页要的列，key / base_url / config 一个字节都不读。 */
export const CHANNELS_SQL = 'SELECT id, name, type, status, models, model_mapping, priority FROM channels';

export async function loadModelBilling(
  db: D1Database,
  options: Options,
  now = Math.floor(Date.now() / 1000),
): Promise<ModelBillingReport> {
  const since = now - MODEL_BILLING_WINDOW_DAYS * 86400;
  const channelsP = db.prepare(CHANNELS_SQL).all<ModelBillingInput['channels'][number]>();
  let billingMetaAvailable = true;
  let usage: UsageRow[];
  try {
    usage = (await db.prepare(usageSQL(true)).bind(since).all<UsageRow>()).results ?? [];
  } catch (error) {
    // 0016 还没跑：logs 没有 billing_meta 列。旧库照样出报表，缓存一律未知。
    if (!/no such column/i.test(String((error as Error)?.message ?? error))) throw error;
    billingMetaAvailable = false;
    usage = (await db.prepare(usageSQL(false)).bind(since).all<UsageRow>()).results ?? [];
  }
  const channels = (await channelsP).results ?? [];
  return buildModelBilling({ channels, usage, options, now, billingMetaAvailable });
}
