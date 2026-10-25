import type { Env } from '../types';

/**
 * 429 冷却：把刚被限流的渠道**临时**移出选路，而不是永久禁用。
 *
 * ## 为什么需要它
 *
 * relay 的重试循环遇到 429 会换下一个渠道，但**不会把它标记成不可用**。当一批
 * 免费 key 同时耗尽日额度时，每个请求都会依次撞上它们，撞满 `RetryTimes` 次就
 * 结束——**永远轮不到优先级更低的付费渠道**。用户看到的是"上游渠道全部失败"，
 * 而付费渠道其实好好的。
 *
 * 加了冷却之后，第一个撞上 429 的请求把该渠道按住一段时间，后续请求直接跳过它，
 * 于是自然落到付费渠道。这就是"先用免费、不够用切官方收费"真正成立的地方。
 *
 * ## 为什么是递增退避而不是固定时长
 *
 * Gemini 免费额度的 429 有两副面孔：每分钟限流（几十秒就恢复）和每日额度耗尽
 * （要等到第二天）。固定时长必须二选一：取短了，日额度耗尽时每分钟都要白撞一次；
 * 取长了，偶发的分钟级限流会让渠道闲置几十分钟。
 *
 * 递增退避不用预先区分：分钟级限流第一次冷却完就恢复成功、计数清零；日额度耗尽则
 * 连续失败，冷却时长翻着倍涨到封顶，自然收敛到"每半小时试一次"。
 *
 * ## 失败一律吞掉
 *
 * KV 读写出问题时**不能影响请求本身**。读失败当作没有冷却（照旧选它，最坏是撞一次
 * 429），写失败就当没冷却过（退化成加这个模块之前的行为）。冷却是优化，不是正确性
 * 依赖，绝不能因为它挂了而让翻译不可用。
 */

const COOLDOWN_PREFIX = 'cooldown:ch:';
const STRIKE_PREFIX = 'cooldown:strike:';

/** 连续第 n 次 429 的冷却秒数。n 从 1 开始。 */
export function backoffSeconds(strike: number, baseSec: number, maxSec: number): number {
  const n = Math.max(1, strike);
  // 2^(n-1) 倍，封顶。指数先夹一下，避免 strike 很大时 Math.pow 溢出成 Infinity。
  const factor = Math.pow(2, Math.min(n - 1, 20));
  return Math.min(maxSec, Math.round(baseSec * factor));
}

/** 冷却中的渠道 id 集合。KV 出问题时返回空集合（当作都没冷却）。 */
export async function getCooling(env: Env, channelIds: number[]): Promise<Set<number>> {
  if (!channelIds.length) return new Set();
  const cooling = new Set<number>();
  await Promise.all(
    channelIds.map(async (id) => {
      try {
        if (await env.CACHE.get(`${COOLDOWN_PREFIX}${id}`)) cooling.add(id);
      } catch {
        // 读不到就当没冷却：宁可多撞一次 429，也不能因为 KV 抖动把渠道全判成可用之外的状态
      }
    }),
  );
  return cooling;
}

/**
 * 记一次 429 并按退避时长把渠道按住。
 *
 * strike 计数的 TTL 取冷却上限的若干倍：既能让连续失败累积起来，又不会让一次
 * 偶发限流被永远记着，导致几小时后的第一次 429 直接跳到最长冷却。
 */
export async function markRateLimited(
  env: Env,
  channelId: number,
  baseSec: number,
  maxSec: number,
): Promise<number> {
  try {
    const strikeKey = `${STRIKE_PREFIX}${channelId}`;
    const prev = Number((await env.CACHE.get(strikeKey)) ?? 0);
    const strike = (Number.isFinite(prev) ? prev : 0) + 1;
    const seconds = backoffSeconds(strike, baseSec, maxSec);

    await Promise.all([
      // KV 的最小 TTL 是 60 秒，比这更短的冷却写不进去
      env.CACHE.put(`${COOLDOWN_PREFIX}${channelId}`, '1', { expirationTtl: Math.max(60, seconds) }),
      env.CACHE.put(strikeKey, String(strike), { expirationTtl: Math.max(60, maxSec * 4) }),
    ]);
    return seconds;
  } catch {
    return 0;
  }
}

/**
 * 一次成功即清零。
 *
 * 不清的话，一个偶尔限流的渠道会一直踩着上次的退避档位，下次 429 直接跳到更长的
 * 冷却，最终被无限期边缘化。
 */
export async function clearRateLimit(env: Env, channelId: number): Promise<void> {
  try {
    await env.CACHE.delete(`${STRIKE_PREFIX}${channelId}`);
  } catch {
    // 清不掉最多让下次退避长一档，不值得因此让请求失败
  }
}
