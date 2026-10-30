import { type Env, type TokenRow, type UserRow, LogTypeConsume, TokenStatusExhausted } from '../types';
import { invalidateTokenCache, parseTokenPriceConfig } from './auth';
import { calcQuotaDetailed, quotaFromRates, quotaToUSD } from './pricing';
import type { RateSet, PriceSource } from './pricing/llm';
import type { ExprTrace } from './pricing/expr';
import { applyCreditGated, applyCredit } from './ledger';
import type { Options } from './options';
import type { PriceSpec } from './pricing/llm';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  /** Subset of prompt_tokens served from the vendor's prompt cache, when reported. */
  cached_tokens?: number;
  /** 5 分钟 TTL 缓存写入 token（Anthropic cache_creation.ephemeral_5m_input_tokens）。 */
  cache_write_5m_tokens?: number;
  /** 1 小时 TTL 缓存写入 token（Anthropic cache_creation.ephemeral_1h_input_tokens）。 */
  cache_write_1h_tokens?: number;
}

/**
 * Reserves an estimated charge before the upstream call.
 *
 * The reservation is what makes concurrency safe: 预扣是一条**原子链**
 * （applyCreditGated：账本行先行，账户余额守卫和 Key 硬上限守卫都长在同一个
 * WHERE 上），N 个并发请求不可能各自通过检查、各花各的——任何一个守卫失败，
 * 整条链一个字节都不写。
 *
 * `tokens.remain_quota` 是这把 Key 的**硬消费上限**：不限额令牌（unlimited）
 * 完全不受约束；限额令牌在预扣那一刻就被守卫挡住，并发下也不许越过 0。
 * 结算（postConsume）仍允许找平时把 Key 扣成负数——服务已交付，钱必须入账。
 */
export async function preConsume(
  env: Env,
  token: TokenRow,
  user: UserRow,
  amount: number,
  /**
   * 这笔预留的账本标识（`pre:<tokenId>:<uuid>`）。
   *
   * 它不是为了幂等——uuid 按构造不会重复——而是为了**事后能找回没结算的预留**：
   * 客户端半路断开时整个请求会被运行时拆掉，postConsume 和 refund 都没机会跑，
   * 那笔预扣就永远挂在账上。有了这个 ref，回收器才能把它认出来退回去
   * （lib/watchdog.ts 的 reclaimAbandonedReservations）。
   */
  ref?: string,
): Promise<{ ok: boolean; message?: string }> {
  if (amount <= 0) return { ok: true };

  // Cheap early rejection off the (possibly stale) cached token row. The
  // authoritative check is the guarded chain below; this only avoids the
  // round trip for tokens that are obviously exhausted.
  if (!token.unlimited_quota && token.remain_quota < amount) {
    return { ok: false, message: '令牌额度不足' };
  }

  /*
   * 原子预扣：账本行（INSERT ... SELECT，带全部守卫）先行，余额/计数/Key 扣减
   * 全部 EXISTS 门控在它身上——前缀提交不产生任何效果。
   *
   * 守卫（guardSql 里的 ? 依次为 guardBinds）：
   *   u.quota + delta >= 0            账户余额不许扣穿
   *   unlimited = 1                   不限额令牌跳过 Key 守卫
   *   t.remain_quota >= amount        Key 硬上限：并发下同样不许越过
   */
  const unlimited = token.unlimited_quota ? 1 : 0;
  const result = await applyCreditGated(env, {
    userId: user.id,
    delta: -amount,
    reason: 'consume',
    ref: ref ?? '',
    guardSql: 'u.quota + ? >= 0 AND (? = 1 OR (SELECT t.remain_quota FROM tokens t WHERE t.id = ?) >= ?)',
    guardBinds: [-amount, unlimited, token.id, amount],
    also: [
      { sql: 'UPDATE users SET request_count = request_count + 1 WHERE id = ?', binds: [user.id] },
      {
        sql: 'UPDATE tokens SET remain_quota = remain_quota - ? WHERE id = ? AND unlimited_quota = ? AND remain_quota >= ?',
        binds: [amount, token.id, unlimited, amount],
      },
    ],
  });
  await invalidateTokenCache(env, token.key);

  if (!result.applied) {
    if (result.duplicate) return { ok: true }; // uuid ref 不可能重复；防御性放行
    // 守卫失败：查一眼是谁拦的，错误信息点名责任方。
    const tk = !token.unlimited_quota
      ? await env.DB.prepare('SELECT remain_quota FROM tokens WHERE id = ?').bind(token.id).first<{ remain_quota: number }>()
      : null;
    if (tk && tk.remain_quota < amount) return { ok: false, message: '令牌额度不足' };
    const fresh = await env.DB.prepare('SELECT quota FROM users WHERE id = ?').bind(user.id).first<{ quota: number }>();
    if ((fresh?.quota ?? 0) < amount) return { ok: false, message: '用户额度不足' };
    return { ok: false, message: '用户不存在' };
  }
  return { ok: true };
}

/** Settles the difference between the reservation and real usage, and writes the log row. */
export async function postConsume(
  env: Env,
  args: {
    token: TokenRow;
    user: UserRow;
    channelId: number;
    modelName: string;
    /** model_mapping 之后的真实模型名。请求名没定价时按它查价，见 pricing/llm.ts 的 resolvePrice。 */
    upstreamModel?: string;
    usage: Usage;
    preConsumed: number;
    options: Options;
    /** 这个 Key 的按模型价格配置（tokens.price_config 解析结果），结算必须和预扣用同一份。 */
    keyOverrides?: Record<string, PriceSpec>;
    elapsedMs: number;
    content?: string;
    /**
     * 结算标识（`fin:<tokenId>:<uuid>`，与预留的 ref 同一个后缀）。
     *
     * `credits.ref` 上的唯一索引让它同时成为**互斥令牌**：结算和回收器的退款抢同
     * 一个 ref，谁先写谁赢，晚到的被当成重复跳过。所以一笔预留不可能既被退掉又被
     * 扣掉——这正是回收器敢在 15 分钟后无条件退款的前提。
     */
    settleRef?: string;
    /**
     * 预扣时钉住的计费身份产物（费率 + 来源 + trace）。传入就**直接用它结算**，
     * 不再重新查价——两次解析之间配置/时间函数可能变化，前后不一致会让找平出错。
     * 缺省时回退到重新解析（老调用方/测试的兼容路径）。
     */
    billing?: { rates: RateSet; source: PriceSource; via?: 'requested' | 'upstream'; trace?: ExprTrace };
  },
): Promise<number> {
  const { token, user, channelId, modelName, usage, preConsumed, options, elapsedMs } = args;
  const detail = args.billing
    ? { quota: quotaFromRates(args.billing.rates, usage), source: args.billing.source, trace: args.billing.trace }
    : calcQuotaDetailed(modelName, usage, options, args.upstreamModel, args.keyOverrides);
  const quota = detail.quota;
  const delta = quota - preConsumed;
  const now = Math.floor(Date.now() / 1000);

  const pricePart = detail.trace?.matchedTier ? `，计费档「${detail.trace.matchedTier}」` : '';
  const cachePart =
    usage.cache_write_5m_tokens || usage.cache_write_1h_tokens
      ? `，缓存写入 ${usage.cache_write_5m_tokens ?? 0}/${usage.cache_write_1h_tokens ?? 0}`
      : '';
  const content =
    args.content ??
    `输入 ${usage.prompt_tokens} tokens${usage.cached_tokens ? `（缓存命中 ${usage.cached_tokens}）` : ''}${cachePart}，` +
      `输出 ${usage.completion_tokens} tokens${pricePart}，消耗 $${quotaToUSD(quota).toFixed(6)}`;

  const also: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE users SET used_quota = used_quota + ? WHERE id = ?').bind(quota, user.id),
    env.DB.prepare('UPDATE tokens SET used_quota = used_quota + ?, accessed_time = ? WHERE id = ?').bind(quota, now, token.id),
    env.DB.prepare('UPDATE channels SET used_quota = used_quota + ? WHERE id = ?').bind(quota, channelId),
    env.DB.prepare(
      `INSERT INTO logs (user_id, created_at, type, content, username, token_name, model_name, quota, prompt_tokens, completion_tokens, channel_id, elapsed_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(user.id, now, LogTypeConsume, content, user.username, token.name, modelName, quota, usage.prompt_tokens, usage.completion_tokens, channelId, elapsedMs),
  ];
  if (delta !== 0 && !token.unlimited_quota) {
    also.push(env.DB.prepare('UPDATE tokens SET remain_quota = remain_quota - ? WHERE id = ?').bind(delta, token.id));
  }

  // Unguarded on purpose: the response was already delivered, so the charge has
  // to land even when the real usage overran the reservation and overdraws the
  // balance. Blocking here would mean giving the call away for free.
  const settled = await applyCredit(env, { userId: user.id, delta: -delta, reason: 'consume', guard: false, also, ref: args.settleRef });
  // 回收器已经把这笔预留退掉了（迟到的结算）。钱和日志都不再写，否则会双重记账。
  if ('duplicate' in settled && settled.duplicate) return 0;
  await invalidateTokenCache(env, token.key);

  if (!token.unlimited_quota) {
    await env.DB.prepare('UPDATE tokens SET status = ? WHERE id = ? AND remain_quota <= 0').bind(TokenStatusExhausted, token.id).run();
  }
  return quota;
}

/** Returns a reservation when the upstream call failed outright. */
export async function refund(env: Env, token: TokenRow, user: UserRow, amount: number, ref?: string): Promise<void> {
  if (amount <= 0) return;
  const also = token.unlimited_quota
    ? []
    : [env.DB.prepare('UPDATE tokens SET remain_quota = remain_quota + ? WHERE id = ?').bind(amount, token.id)];
  // 用结算 ref 退款：和 postConsume 抢同一个唯一键，退过就扣不成、扣过就退不了。
  await applyCredit(env, { userId: user.id, delta: amount, reason: 'refund', also, ref });
  await invalidateTokenCache(env, token.key);
}
