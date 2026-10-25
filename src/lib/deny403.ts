import type { Env } from '../types';

/**
 * 403 软熔断：把「这个渠道不让你在这个机房调这个模型」记成一条短期 KV 记录，
 * 让后续请求选路时直接绕开，而不是每个请求都先去撞一次 403。
 *
 * ## 粒度为什么是 channel + model + colo
 *
 * 真实场景里 403 几乎总是组合级的：同一个 OpenRouter key，调 gpt-4 在 SJC 被
 * 地区规则拒、调别的模型没事，换个机房也没事。按渠道熔断会把一个地区的策略
 * 放大成全渠道停摆；按模型熔断会冤枉其他机房。所以三个维度一起编进 key。
 *
 * ## 熔断期内的两个保证
 *
 *   - 有未熔断候选 → 照常从里面选，被拒的渠道对本次请求完全透明；
 *   - 候选**全部**处于有效熔断 → 一个上游请求都不发，直接把缓存的 403 连同
 *     上次的错误 message 回给客户端（客户端靠这个 message 给用户提示）。
 *     熔断不是探测调度器：恢复探测只发生在记录自然过期（KV TTL / expiresAt）
 *     之后，期间绝不重复撞墙——这正是软熔断存在的意义。
 *
 * ## 和 429 冷却（lib/cooldown.ts）的关系
 *
 * 两套机制解决两个问题，**不共用 key、不共用语义**：
 *   - 429：渠道级短退避（秒到分钟），「这一阵不能用」，命中后宁可全冷却也照选；
 *   - 403：组合级软熔断（默认 30 分钟），「这个组合被拒」，命中后优先绕开，
 *     全部命中时 0 fetch 直接 403，绝不渲染成 no_channel。
 *
 * ## 生命周期
 *
 *   - 上游回 403 → markDenied403 写入/刷新（调用方 await，保证紧接着的请求
 *     一定看得见）；KV 写失败 fail-open，绝不影响正常路由；
 *   - 该组合上游回 200（含到期后的恢复探测成功）→ clearDenied403 清除；
 *   - KV 的 expirationTtl 兜底回收，即使清除路径全部失效也不会积累垃圾。
 */

const PREFIX = 'deny403:';

/** 软熔断时长（秒）。默认 30 分钟：长到挡住重复撞墙，短到上游策略变了能自愈。 */
export const DENY_403_TTL_SEC = 30 * 60;

/** 取不到 request.cf.colo 时的兜底值。所有取不到的请求共享同一个命名空间。 */
export const UNKNOWN_COLO = 'UNKNOWN';

/** 缓存 message 的长度上限：够客户端提示用，又不至于把 KV 值撑大。 */
const MESSAGE_MAX_LEN = 500;

/** 候选全部熔断、又没有任何缓存 message 时的中性文案。不猜测原因。 */
export const DENY_403_FALLBACK_MESSAGE = '上游渠道对该模型返回 403，已暂时跳过，请稍后重试';

/** 模型名可以带 / ~ 等字符（如 `~typesafe/jev-latest`），必须编码后才能进 key。 */
export function deny403Key(channelId: number, model: string, colo: string): string {
  return `${PREFIX}${channelId}:${encodeURIComponent(model ?? '')}:${encodeURIComponent(colo || UNKNOWN_COLO)}`;
}

interface Deny403Record {
  /** 到期时刻（epoch ms）。提前于 KV TTL 到期没有意义，两者保持一致。 */
  expiresAt: number;
  /** 最近一次触发熔断的上游状态码，目前恒为 403。留给排查：值在，问题就在。 */
  lastStatus: number;
  /**
   * 最近一次上游 403 的错误 message（截断过的）。只从上游响应体的
   * error.message 里提取——那里只有上游自己写的文案，不含请求体、key、
   * header 等任何敏感内容。全熔断直接回 403 时复用它，客户端才能认出
   * 「OpenRouter TOS 拒绝」这类可读原因。
   */
  message?: string;
}

/**
 * 从上游 403 的响应体里提取可安全缓存/复述的 message。
 *
 * 只认 OpenAI 形状的 `error.message`（string），其余一律返回 undefined——
 * 绝不把整个响应体存进 KV，那里可能有我们没扫过的字段。
 */
export function extractDeniedMessage(body: unknown): string | undefined {
  const message = (body as any)?.error?.message;
  if (typeof message !== 'string' || !message.trim()) return undefined;
  return message.slice(0, MESSAGE_MAX_LEN);
}

/** 记一次 403：写入或刷新该组合的软熔断。KV 写失败时静默吞掉（fail-open）。 */
export async function markDenied403(
  env: Env,
  channelId: number,
  model: string,
  colo: string,
  message?: string,
): Promise<void> {
  try {
    const ttl = Math.max(60, DENY_403_TTL_SEC); // KV 最小 TTL 是 60 秒
    const record: Deny403Record = {
      expiresAt: Date.now() + ttl * 1000,
      lastStatus: 403,
      ...(message ? { message: message.slice(0, MESSAGE_MAX_LEN) } : {}),
    };
    await env.CACHE.put(deny403Key(channelId, model, colo), JSON.stringify(record), { expirationTtl: ttl });
  } catch {
    // 写不进去就当没熔断过：最坏是每次多撞一次 403，选路本身不受影响
  }
}

/** 清除软熔断：该组合上游重新可用（探测成功或正常成功）时调用。 */
export async function clearDenied403(env: Env, channelId: number, model: string, colo: string): Promise<void> {
  try {
    await env.CACHE.delete(deny403Key(channelId, model, colo));
  } catch {
    // 同上：清除失败只会让渠道多被绕开一阵，TTL 到期自然恢复
  }
}

export interface Deny403Entry {
  channelId: number;
  expiresAt: number;
  message?: string;
}

/**
 * 一批候选渠道里，当前处于 403 软熔断的有哪些。
 *
 * 已过期的记录视同不存在（正常情况下 KV 的 TTL 已经把它们收走了，这里是双
 * 保险——比如 TTL 被写入时夹过最小值）。过期记录即「恢复探测资格」。
 */
export async function getDenied403(env: Env, channelIds: number[], model: string, colo: string): Promise<Map<number, Deny403Entry>> {
  const denied = new Map<number, Deny403Entry>();
  if (!channelIds.length) return denied;
  await Promise.all(
    channelIds.map(async (id) => {
      try {
        const raw = await env.CACHE.get(deny403Key(id, model, colo));
        if (!raw) return;
        const record = JSON.parse(raw) as Deny403Record;
        if (typeof record?.expiresAt === 'number' && record.expiresAt > Date.now()) {
          denied.set(id, { channelId: id, expiresAt: record.expiresAt, message: record.message });
        }
      } catch {
        // 单条读失败不影响其余候选的判定
      }
    }),
  );
  return denied;
}
