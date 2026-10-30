import type { Env } from '../types';
import { applyCredit, reconcile } from './ledger';
import { pruneRelayEvents } from './health';
import { findPrice, strictBillingEnabled } from './pricing/llm';
import { listModels } from './channel';
import { getOptions } from './options';
import type { Options } from './options';
import { checkRouteGapRecovery } from './route-alert';

/**
 * 定时自检。
 *
 * 起因：这个 Worker 之前**没有任何定时任务**，于是 `GET /api/reconcile` 只能靠人想起来
 * 去点一下——而它检查的恰恰是「有没有写入绕过了 applyCredit()」这种不会自己冒头的问题。
 * 账本对不上不会让任何请求失败，只会让余额悄悄错下去。
 *
 * ## 没有偏差时不写日志
 *
 * 每天写一条「一切正常」会让 logs 表长出一堆噪音，而那张表本来是用来查消费的。所以：
 *
 *   有偏差 → 写一条 type=4 的系统日志（后台「日志」页看得到）+ 企业微信告警
 *   没偏差 → 只更新 KV 里的心跳
 *
 * 心跳是必须的：只靠「有问题才说话」的话，「一切正常」和「定时任务根本没在跑」是同一种
 * 沉默，而后者恰恰是最该被发现的那种故障。
 */

const HEARTBEAT_KEY = 'watchdog:last-run';

export interface WatchdogResult {
  at: number;
  driftCount: number;
  /** 最近 24h 用过、但价格表里查不到的模型 */
  unpricedModels?: { model: string; n: number; quota: number }[];
  /** 有偏差的用户，最多带前几条供告警用 */
  drifts: { user_id: number; username: string; drift: number }[];
  alerted: boolean;
}

export interface Heartbeat {
  at: number;
  driftCount: number;
}

export async function getHeartbeat(env: Env): Promise<Heartbeat | null> {
  return (await env.CACHE.get(HEARTBEAT_KEY, 'json')) as Heartbeat | null;
}

/**
 * 跑一次自检。cron 和管理员手动触发共用这一个函数——两条路走同一段代码，
 * 才不会出现「手动跑是好的、定时跑是坏的」这种只能靠运气发现的分歧。
 */
export async function runWatchdog(env: Env): Promise<WatchdogResult> {
  const at = Math.floor(Date.now() / 1000);
  const drifts = await reconcile(env);

  /*
   * 顺带清掉过期的失败事件（lib/health.ts）。搭这趟车而不是新开一条 cron：
   * 它没有时效要求，早一天晚一天都无所谓，不值得为它多一个定时入口。
   * 按本文件的约定，删了 0 行就什么都不记。
   */
  const pruned = await pruneRelayEvents(env);
  if (pruned) console.log(`[watchdog] 清理 ${pruned} 条过期失败事件`);

  /*
   * 同样搭这趟车：查不到价的模型。它和账本偏差是两种毛病，但共享同一条规矩——
   * 平时不说话，一开口就是「有个东西错了，而且它自己不会喊」。
   */
  const options = await getOptions(env);
  const unpriced = await detectUnpricedModels(env, options);

  const result: WatchdogResult = {
    at,
    driftCount: drifts.length,
    unpricedModels: unpriced,
    drifts: drifts.slice(0, 10).map((d) => ({ user_id: d.user_id, username: d.username, drift: d.drift })),
    alerted: false,
  };

  // 心跳先写。就算下面的告警挂了，也要能看出这次确实跑过。
  await env.CACHE.put(HEARTBEAT_KEY, JSON.stringify({ at, driftCount: drifts.length } satisfies Heartbeat))
    .catch((error) => console.error('[watchdog] 心跳写入失败：', error));

  if (unpriced.length) {
    const strict = strictBillingEnabled(options);
    const detail = unpriced
      .map((m) =>
        m.n > 0
          ? `${m.model}（近 24h ${m.n} 次${strict ? '' : `，按默认价记了 ${m.quota} quota`}）`
          : m.model,
      )
      .join('；');
    const text = strict
      ? `以下模型挂在启用渠道上但查不到价，请求会以 model_price_not_configured 拒绝：${detail}。` +
        '处理：在后台「价格」页配全局覆盖（常量或按字段费率表达式），或清空兜底价开关换宽松模式。'
      : `以下模型不在价格表里，正按默认价 $${options.DefaultPrice?.in ?? 1}/$${options.DefaultPrice?.out ?? 3} 记账：${detail}。` +
        '处理：在后台「价格」页配全局覆盖（常量或按字段费率表达式），或清空兜底价启用严格计费（未定价直接拒绝）。';
    console.error('[watchdog]', text);
    await env.DB.prepare('INSERT INTO logs (user_id, created_at, type, content) VALUES (0, ?, 4, ?)')
      .bind(at, text)
      .run()
      .catch((error) => console.error('[watchdog] 未定价模型日志写入失败：', error));
    result.alerted = (await notify(env, text)) || result.alerted;
  }

  if (drifts.length === 0) return result;

  /*
   * 有偏差。**偏差是症状，绕过 applyCredit() 的那次写入才是 bug**——所以日志里要带上
   * 具体是谁差了多少，好照着去翻那段时间的写入。
   */
  const lines = result.drifts
    .map((d) => `${d.username}(#${d.user_id}) 物化 - 账本 = ${d.drift}`)
    .join('；');
  const content = `账本对账发现 ${drifts.length} 个用户余额与账本不一致：${lines}`
    + (drifts.length > result.drifts.length ? `（另有 ${drifts.length - result.drifts.length} 个未列出）` : '')
    // 排查从哪儿开始：applyCredit 的余额 UPDATE 和 credits INSERT 不在同一个事务里，
    // 中间失败就会留下这种偏差。中继的预扣/结算是它最容易出现的地方（每请求两次），
    // 所以先去看 credits 里 ref 形如 pre:… / fin:… 的那几条。
    + '。排查方向：credits 里 ref 为 pre:*（无人认领的预扣）与 fin:*（结算/退款）的记录。';

  console.error('[watchdog]', content);

  await env.DB.prepare(
    'INSERT INTO logs (user_id, created_at, type, content) VALUES (0, ?, 4, ?)',
  )
    .bind(at, content)
    .run()
    .catch((error) => console.error('[watchdog] 系统日志写入失败：', error));

  result.alerted = await notify(env, content);
  return result;
}

/**
 * 回收器的 cron 表达式。index.ts 按它分派，wrangler.jsonc 里必须有同样的一条。
 *
 * 频率按「用户能忍多久」定：客户端半路断开时预扣没人认领，占住的是用户当下就想花的
 * 钱——一条流崩了，那笔预留要等这里才会还回去。
 */
export const SWEEP_CRON = '*/5 * * * *';

export interface SweepResult {
  at: number;
  /** 退回的无人认领中继预扣笔数 */
  returned: number;
  /** 发出恢复通知的路由缺口数（lib/route-alert.ts） */
  gapsRecovered: number;
}

/**
 * 退回没人认领的中继预扣 + 路由缺口恢复通知。
 *
 * 两件事放同一个 cron 里：都是分钟级的收尾活，不值得各占一条定时入口。
 * 不写心跳、不告警——这条路正常情况下每次都可能没有活干；
 * 真出问题会表现为账本漂移，由 runWatchdog 那条路报出来。
 */
export async function runSweeper(env: Env): Promise<SweepResult> {
  const at = Math.floor(Date.now() / 1000);
  const returned = await reclaimAbandonedReservations(env);
  if (returned) console.log(`[sweeper] 退回 ${returned} 笔无人认领的中继预扣`);
  /*
   * 路由缺口恢复通知搭这趟车：5 分钟一轮正好是「修好之后多久能在群里看到」的合理延迟，
   * 不值得为它单开一条 cron。没配 webhook 时它直接返回 0，不读 KV。
   */
  const gapsRecovered = await checkRouteGapRecovery(env);
  if (gapsRecovered) console.log(`[sweeper] 发出 ${gapsRecovered} 条路由缺口恢复通知`);
  return { at, returned, gapsRecovered };
}

/** 静置多久之后就认定这笔预留不会有人来结算了。 */
const RESERVATION_GRACE_SEC = 900;

/**
 * 退回没人认领的中继预扣。
 *
 * ## 为什么必须事后做
 *
 * `routes/relay.ts` 在调上游之前先扣一笔估算（并发安全全靠它）。正常结束走
 * postConsume 找平，明确失败走 refund 退回——但**客户端半路断开时两个都不会跑**：
 * 整个 Worker 请求被运行时拆掉，连 streamResponse 里那句 `cancel() { settle(); }`
 * 都没有执行的机会。实测过：字幕侧 45s 超时掐掉的 12 次尝试，网关的 logs 和
 * relay_events 里一行都没有。代码没机会跑的洞，只能靠对账补。
 *
 * ## 为什么敢无条件退
 *
 * 退款用的是**结算那一刻会用的同一个 ref**（`fin:<tokenId>:<uuid>`），而
 * `credits.ref` 上有唯一索引。于是退款和迟到的结算抢同一个键，谁先写谁赢，另一方被
 * 当成重复跳过——不可能既退又扣。加上 15 分钟静置期（上游超时 120s、客户端 120s，
 * 任何活着的请求都远在这之内），误退一笔正在跑的单在时间上也不成立。
 */
export async function reclaimAbandonedReservations(env: Env, limit = 100): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - RESERVATION_GRACE_SEC;
  let rows: { user_id: number; ref: string; delta: number }[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT user_id, ref, delta FROM credits
        WHERE reason = 'consume' AND ref LIKE 'pre:%' AND created_at < ?
          AND NOT EXISTS (SELECT 1 FROM credits f WHERE f.ref = 'fin:' || substr(credits.ref, 5))
        LIMIT ?`,
    )
      .bind(cutoff, limit)
      .all<{ user_id: number; ref: string; delta: number }>();
    rows = result.results ?? [];
  } catch (error) {
    console.error('[sweeper] 悬空预扣扫描失败：', error);
    return 0;
  }

  let returned = 0;
  for (const row of rows) {
    const amount = -row.delta; // 预扣是负数，退回来要正的
    if (amount <= 0) continue;
    const tokenId = Number(row.ref.split(':')[1] || 0);
    try {
      const result = await applyCredit(env, {
        userId: row.user_id,
        delta: amount,
        reason: 'refund',
        ref: `fin:${row.ref.slice(4)}`,
        // 令牌的消费上限也要还。unlimited_quota 的令牌不维护这个数，条件写进 SQL
        // 里就不必为此多读一行。
        also: tokenId
          ? [
              env.DB.prepare(
                'UPDATE tokens SET remain_quota = remain_quota + ? WHERE id = ? AND unlimited_quota = 0',
              ).bind(amount, tokenId),
            ]
          : [],
      });
      if (result.ok && !('duplicate' in result && result.duplicate)) returned += 1;
    } catch (error) {
      // 一笔退不掉不该让整轮停下——下一次 cron 还会再看到它
      console.error(`[sweeper] 退回预扣 ${row.ref} 失败：`, error);
    }
  }
  return returned;
}

/**
 * 找出**挂在启用渠道上、但价格表里查不到**的模型。
 *
 * 口径是「声明了就算」而不是「有人用过才算」：等第一笔请求踩进去才发现没定价，
 * 严格计费下用户已经吃了一次 503，宽松计费下已经按默认价记了一笔糊涂账——
 * 警报必须在第一次请求之前就响。
 *
 * 名字里带 `:` 的是语音（`asr:azure:speech-to-text` 这种），它们走独立的授权窗口
 * 结算，跟 LLM 价格表无关，必须排除，否则每天都会报一堆假警。
 */
export async function detectUnpricedModels(env: Env, options?: Options): Promise<{ model: string; n: number; quota: number }[]> {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const opts = options ?? (await getOptions(env));
  try {
    const declared = (await listModels(env)).filter((m) => m && !m.includes(':'));
    const unpriced = declared.filter((model) => !findPrice(model, opts));
    if (!unpriced.length) return [];
    // 近 24h 的用量做补充信息（没被用过的未定价模型 n=0——它还没造成损失，但马上会）。
    const placeholders = unpriced.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `SELECT model_name AS model, COUNT(*) AS n, COALESCE(SUM(quota),0) AS quota FROM logs
        WHERE type = 2 AND created_at > ? AND model_name IN (${placeholders})
        GROUP BY model_name`,
    )
      .bind(since, ...unpriced)
      .all<{ model: string; n: number; quota: number }>();
    const usage = new Map((result.results ?? []).map((r) => [r.model, r]));
    return unpriced.map((model) => ({ model, n: usage.get(model)?.n ?? 0, quota: usage.get(model)?.quota ?? 0 }));
  } catch (error) {
    console.error('[watchdog] 未定价模型扫描失败：', error);
    return [];
  }
}

/**
 * 企业微信群机器人。没配就跳过——本地和预览环境不配也不该报错。
 *
 * 报文格式与 store 的 lib/billing/wecom.ts 一致（markdown），这样两个服务的告警落在
 * 同一个群里长得一样。
 */
async function notify(env: Env, content: string): Promise<boolean> {
  const url = env.WECOM_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: `**网关账本告警**\n${content}` },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('[watchdog] 企业微信告警失败 HTTP %d', res.status);
      return false;
    }
    return true;
  } catch (error) {
    // 告警发不出去不该让自检本身算失败——日志和心跳已经落下了
    console.error('[watchdog] 企业微信告警异常：', error);
    return false;
  }
}
