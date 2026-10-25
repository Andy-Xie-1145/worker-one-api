import type { Env } from '../types';

/**
 * 路由缺口（503 no_channel）→ 企业微信群机器人告警。
 *
 * ## 为什么需要它
 *
 * 健康页的「路由缺口」表（routes/api.ts 的 /health/models 里 missing 那一段）已经能
 * 说清楚「哪个模型、为什么没渠道」，但它要有人去打开看。这类故障恰恰是
 * 一个配置失误就能让某个模型 100% 失败的那种——得有人主动被喊到。
 *
 * ## 三条规矩
 *
 * 1. **不拖慢请求**：调用方一律挂在 waitUntil 上。这里的函数永远不抛。
 * 2. **不刷屏**：同一 model 的持续故障，冷却期内只发一次。状态放 KV：
 *    - 先查本 isolate 的内存表，热路径上一个 503 洪峰连 KV 都不读；
 *    - 再查 KV（跨 isolate / 跨机房），发之前先写，把并发窗口压到最小。
 *    KV 是最终一致的，极端情况下不同机房可能各发一条——为此引入锁/DO 不值得，
 *    多一两条总好过漏报。
 * 3. **不泄露 webhook**：URL 里的 key 就是发消息的全部凭证，日志里只打状态码，
 *    异常信息也先抹掉 URL 再打。
 *
 * ## 恢复通知
 *
 * 告警时写下的 KV 状态就是「active」标记。*\/5 的清扫 cron 顺路检查这些标记
 * （checkRouteGapRecovery）：该 model 已经有**真正能选中**的渠道、且最近
 * 5 分钟没有新的 no_channel，就发一条恢复并删掉标记。
 *
 * 只有「能选中渠道」才算恢复——没人再请求这个模型不叫恢复，那种标记留着等 TTL
 * 自然过期，不发任何消息。
 */

const KEY_PREFIX = 'alert:routegap:';
/** active 标记的寿命。远长于冷却：冷却只管「多久能再发」，这个要撑到恢复被看见。 */
const STATE_TTL_SEC = 7 * 86400;
/** webhook 发送失败后多久允许再试一次。不按完整冷却算，否则一次网络抖动就漏报 30 分钟。 */
const RETRY_AFTER_FAIL_SEC = 60;
/** 最近这么久内还有 no_channel，就不算恢复。和清扫 cron 的周期对齐。 */
const RECOVERY_QUIET_SEC = 300;
const DEFAULT_COOLDOWN_MIN = 30;

export interface GapState {
  model: string;
  /** 这一轮故障第一次告警的时间（unix 秒）。恢复消息据此算持续时长。 */
  firstAt: number;
  /** 上一次**尝试**告警的时间，冷却从这里算。 */
  lastAlertAt: number;
}

export interface GapDiagnosis {
  /** abilities 里该 model 的行数 */
  declared: number;
  /** 其中 enabled=1 的 */
  enabled: number;
  /** 其中渠道本身也是启用状态的——selectChannel 真正能选中的 */
  live: number;
  /** 近 1 小时 final=1 的 no_channel 次数 */
  recent: number;
}

export type AlertOutcome = 'sent' | 'cooldown' | 'failed' | 'disabled';

export function gapKey(model: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(model)}`;
}

export function cooldownSec(env: Env): number {
  const minutes = Number(env.WECOM_HEALTH_ALERT_COOLDOWN_MIN);
  return Math.round((Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_COOLDOWN_MIN) * 60);
}

/** 本 isolate 内最近一次尝试告警的时间（毫秒）。只是 KV 前面的一层快速短路。 */
const lastTried = new Map<string, number>();

/** 仅供测试：清空内存去重表，模拟换了一个 isolate。 */
export function resetRouteAlertMemo(): void {
  lastTried.clear();
}

/**
 * 一次 no_channel 503 发生后调用。永不抛。
 */
export async function alertRouteGap(
  env: Env,
  gap: { model: string },
  nowMs = Date.now(),
): Promise<AlertOutcome> {
  const url = env.WECOM_HEALTH_WEBHOOK_URL;
  if (!url) return 'disabled';

  const key = gapKey(gap.model);
  const coolMs = cooldownSec(env) * 1000;
  const nowSec = Math.floor(nowMs / 1000);

  try {
    const memo = lastTried.get(key);
    if (memo !== undefined && nowMs - memo < coolMs) return 'cooldown';

    const prev = (await env.CACHE.get(key, 'json')) as GapState | null;
    if (prev && nowMs - prev.lastAlertAt * 1000 < coolMs) {
      lastTried.set(key, prev.lastAlertAt * 1000);
      return 'cooldown';
    }

    // 先占位再发：把「两个并发请求都看到没发过」的窗口压到最小
    const state: GapState = { model: gap.model, firstAt: prev?.firstAt ?? nowSec, lastAlertAt: nowSec };
    lastTried.set(key, nowMs);
    await env.CACHE.put(key, JSON.stringify(state), { expirationTtl: STATE_TTL_SEC });

    const diag = await diagnoseGap(env, gap.model, nowSec);
    const sent = await sendWecom(url, formatAlert(gap, diag, nowMs, !!prev));
    if (sent) return 'sent';

    // 发失败：把冷却起点往前挪，RETRY_AFTER_FAIL_SEC 后下一个 503 会再试
    const retryAt = nowSec - Math.floor(coolMs / 1000) + RETRY_AFTER_FAIL_SEC;
    lastTried.set(key, retryAt * 1000);
    await env.CACHE.put(key, JSON.stringify({ ...state, lastAlertAt: retryAt }), { expirationTtl: STATE_TTL_SEC });
    return 'failed';
  } catch (error) {
    console.error('[route-alert] 告警流程异常：', redact(error, url));
    return 'failed';
  }
}

/**
 * 与健康页「路由缺口」同一口径的诊断，外加 selectChannel 真正会用到的 channels.status。
 * 查不到就返回 null，告警照发，只是少了原因。
 */
export async function diagnoseGap(env: Env, model: string, nowSec: number): Promise<GapDiagnosis | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM abilities a WHERE a.model = ?1) AS declared,
         (SELECT COUNT(*) FROM abilities a WHERE a.model = ?1 AND a.enabled = 1) AS enabled,
         (SELECT COUNT(*) FROM abilities a JOIN channels c ON c.id = a.channel_id
           WHERE a.model = ?1 AND a.enabled = 1 AND c.status = 1) AS live,
         (SELECT COUNT(*) FROM relay_events e
           WHERE e.stage = 'no_channel' AND e.final = 1 AND e.model_name = ?1
             AND e.created_at >= ?2) AS recent`,
    )
      .bind(model, nowSec - 3600)
      .first<GapDiagnosis>();
    if (!row) return null;
    return {
      declared: Number(row.declared) || 0,
      enabled: Number(row.enabled) || 0,
      live: Number(row.live) || 0,
      recent: Number(row.recent) || 0,
    };
  } catch (error) {
    console.error('[route-alert] 诊断查询失败：', error);
    return null;
  }
}

export function describeReason(diag: GapDiagnosis | null): string {
  if (!diag) return '诊断查询失败，原因未知';
  if (diag.declared === 0) return 'declared=0：没有任何渠道声明此模型（未配置，或模型名拼写不一致）';
  if (diag.enabled === 0) return `declared=${diag.declared} but enabled=0：渠道声明了此模型，但全部被禁用`;
  if (diag.live === 0) {
    return `declared=${diag.declared}, enabled=${diag.enabled} but 渠道本身非启用：abilities 与 channels 状态不一致，重新保存对应渠道可修复`;
  }
  return `当前已有 ${diag.live} 个可用渠道（可能刚修复，或是瞬时状态）`;
}

function formatTime(ms: number): string {
  return `${new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`;
}

function formatAlert(gap: { model: string }, diag: GapDiagnosis | null, nowMs: number, ongoing: boolean): string {
  const lines = [
    `**One API 健康告警：路由缺口**${ongoing ? '（持续中）' : ''}`,
    `> 模型：<font color="warning">${gap.model}</font>`,
    '> 状态：HTTP 503 没有可用渠道',
    `> 原因：${describeReason(diag)}`,
  ];
  if (diag) lines.push(`> 近 1 小时：${diag.recent} 次`);
  lines.push(`> 时间：${formatTime(nowMs)}`);
  return lines.join('\n');
}

/**
 * 清扫 cron 顺路调用：给已经恢复的路由缺口发恢复通知。返回发出的条数。永不抛。
 */
export async function checkRouteGapRecovery(env: Env, nowMs = Date.now()): Promise<number> {
  const url = env.WECOM_HEALTH_WEBHOOK_URL;
  if (!url) return 0;

  let recovered = 0;
  try {
    const nowSec = Math.floor(nowMs / 1000);
    const list = await env.CACHE.list({ prefix: KEY_PREFIX });
    for (const { name } of list.keys) {
      const state = (await env.CACHE.get(name, 'json')) as GapState | null;
      if (!state) continue;

      const diag = await diagnoseGap(env, state.model, nowSec);
      if (!diag || diag.live === 0) continue;
      if (await hasRecentGap(env, state.model, nowSec - RECOVERY_QUIET_SEC)) continue;

      const minutes = Math.max(1, Math.round((nowSec - state.firstAt) / 60));
      const text = [
        '**One API 健康恢复：路由缺口已修复**',
        `> 模型：<font color="info">${state.model}</font>`,
        `> 现状：${diag.live} 个可用渠道`,
        `> 持续：约 ${minutes} 分钟（自首次告警起）`,
        `> 时间：${formatTime(nowMs)}`,
      ].join('\n');

      // 发不出去就留着标记，下一轮 cron 再试
      if (!(await sendWecom(url, text))) continue;
      await env.CACHE.delete(name);
      lastTried.delete(name);
      recovered++;
    }
  } catch (error) {
    console.error('[route-alert] 恢复检查异常：', redact(error, url));
  }
  return recovered;
}

async function hasRecentGap(env: Env, model: string, sinceSec: number): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM relay_events
        WHERE stage = 'no_channel' AND model_name = ? AND created_at >= ?`,
    )
      .bind(model, sinceSec)
      .first<{ n: number }>();
    return Number(row?.n) > 0;
  } catch {
    // 查不到就保守当作「还有」，宁可晚一轮发恢复也不误报
    return true;
  }
}

/**
 * 发一条 markdown。企业微信在 key 无效等情况下会回 HTTP 200 + errcode≠0，所以两层都要看。
 */
async function sendWecom(url: string, content: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('[route-alert] 企业微信发送失败 HTTP %d', res.status);
      return false;
    }
    const body = (await res.json().catch(() => null)) as { errcode?: number } | null;
    if (body && typeof body.errcode === 'number' && body.errcode !== 0) {
      console.error('[route-alert] 企业微信发送失败 errcode=%d', body.errcode);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[route-alert] 企业微信发送异常：', redact(error, url));
    return false;
  }
}

/** 错误信息里万一带着 URL（含 key），先抹掉再进日志。 */
function redact(error: unknown, url: string): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.split(url).join('[webhook]').replace(/key=[^&\s"']+/gi, 'key=[redacted]');
}
