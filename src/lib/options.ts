import type { Env } from '../types';
import type { Price, PriceSpec } from './pricing/llm';

const KV_KEY = 'options:all';
const KV_TTL = 60;

export interface Options {
  SystemName: string;
  PreConsumedQuota: number;
  RetryTimes: number;
  /**
   * 渠道返回 429 后的冷却基数（秒）与上限（秒）。递增退避见 lib/cooldown.ts。
   * 冷却把限流的渠道临时移出选路，好让请求落到优先级更低的渠道——
   * 「先用免费、耗尽切付费」就靠这个成立。
   */
  ChannelCooldownBaseSec: number;
  ChannelCooldownMaxSec: number;
  /**
   * 是否把中继失败写进 relay_events（见 lib/health.ts）。
   *
   * 留这个开关是因为它是纯运维数据：真遇上「某个扫描器把失败刷爆了」这类情况，
   * 要能在设置页一键停掉，而不是等一次部署。默认开——关了这张表就是空的。
   */
  HealthEventsEnabled: boolean;
  /**
   * 全局模型价格覆盖：`模型名 → PriceSpec`（常量或费率表达式），美元 / 百万 tokens。
   * 查价优先级：**渠道覆盖（channels.price_config）> 全局覆盖 > 内置价格表 > 默认价**。
   * 编辑入口：后台「价格」页（PUT /api/pricing/overrides，带校验）。
   */
  ModelPriceOverride: Record<string, PriceSpec>;
  /**
   * 未知模型的兜底价（美元 / 百万 tokens），**同时是严格计费的开关**：
   *
   * - 设了（默认 $1/$3）：查不到价的模型按它记账（宽松模式，宁可收错方向保守也不白送；
   *   费率表达式求值失败时的回退价也是它）；
   * - **显式 null**：严格计费——查不到价的请求直接 503 model_price_not_configured，
   *   不调上游、不预扣。价格数据核对完之后清掉兜底价即启用。
   *
   * 只支持常量（清空与否必须是静态事实）；模型级价格才允许费率表达式。
   */
  DefaultPrice: Price | null;
  /**
   * 追加的 decision-only 模型名（见 lib/capability.ts）。
   *
   * 内置规则已经覆盖 jev；这里是给"上游又出了一个只走 Decisions 的模型"留的口子，
   * 不用发版就能把它从 /v1/models 里摘掉、并挡在 chat/completions 之外。
   * **只增不减**：内置规则不能靠它关掉，否则一条配置就能把 Jev 放回聊天路上。
   */
  DecisionOnlyModels: string[];
  /**
   * 模型别名组（轻量分组，无倍率语义）：`[["deepseek-v4.1-flash","deepseek-v4-flash"], …]`。
   * 并查集语义：组内名字视为同一个模型；跨组重名自动联通。
   * 用途：路由按块匹配渠道、上游名翻译为渠道拥有的成员、令牌 models 拥有块内
   * 任一名字即拥有全块。编辑入口：后台「模型别名」页。
   */
  AliasGroups: string[][];
  /**
   * 上游超时三段式（2026-11-13：废除 120s 一刀切——45 万 token 的正常长流会被
   * 拦腰截断，健康与否只能看"有没有动静"，不能看"总共跑了多久"）。
   *
   * - UpstreamHeadersTimeoutSec：等响应头的上限。HPD 这类排队型上游死不给头时，
   *   快速失败让重试循环换下一个渠道；
   * - UpstreamBodyIdleTimeoutSec：流式 body 的空闲上限——连续这么多秒一个字节
   *   都没有才判死（连接假死）。**健康的生成每秒都在吐字，永远不会触发**；
   *   没有流式总时长上限：长流跑多久都行，网关绝不主动切。
   * - UpstreamBodyTimeoutSec：非流式响应体的整体读取上限（非流式没有"空闲"概念）。
   */
  UpstreamHeadersTimeoutSec: number;
  UpstreamBodyIdleTimeoutSec: number;
  UpstreamBodyTimeoutSec: number;
}

export const DEFAULT_OPTIONS: Options = {
  SystemName: 'One API on Workers',
  PreConsumedQuota: 500,
  RetryTimes: 3,
  ChannelCooldownBaseSec: 60,
  ChannelCooldownMaxSec: 1800,
  HealthEventsEnabled: true,
  ModelPriceOverride: {},
  DefaultPrice: { in: 1, out: 3 },
  DecisionOnlyModels: [],
  AliasGroups: [],
  UpstreamHeadersTimeoutSec: 60,
  UpstreamBodyIdleTimeoutSec: 300,
  UpstreamBodyTimeoutSec: 600,
};

/** Options are read on nearly every request, so they are KV-cached for KV_TTL seconds.
 *  KV 故障时降级到 D1 直读/放弃缓存写——配置读取不允许因缓存层故障而失败。 */
export async function getOptions(env: Env): Promise<Options> {
  let cached: Options | null = null;
  try {
    cached = (await env.CACHE.get(KV_KEY, 'json')) as Options | null;
  } catch {
    // 读失败 → 走 D1。
  }
  if (cached) return { ...DEFAULT_OPTIONS, ...(cached as Partial<Options>) };
  const rows = await env.DB.prepare('SELECT key, value FROM options').all<{ key: string; value: string }>();
  const stored: Record<string, unknown> = {};
  for (const row of rows.results ?? []) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      stored[row.key] = row.value;
    }
  }
  const merged = { ...DEFAULT_OPTIONS, ...stored } as Options;
  try {
    await env.CACHE.put(KV_KEY, JSON.stringify(stored), { expirationTtl: KV_TTL });
  } catch {
    // 写失败不影响本次请求（下一条请求重读 D1）。
  }
  return merged;
}

export async function setOptions(env: Env, patch: Record<string, unknown>): Promise<void> {
  const stmts = Object.entries(patch).map(([key, value]) =>
    env.DB.prepare('INSERT INTO options (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(
      key,
      JSON.stringify(value),
    ),
  );
  if (stmts.length) await env.DB.batch(stmts);
  try {
    await env.CACHE.delete(KV_KEY);
  } catch {
    // 缓存删除失败：KV_TTL 内的旧配置会被 TTL 兜底冲掉。
  }
}
