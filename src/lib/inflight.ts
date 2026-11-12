import type { Env } from '../types';

/**
 * 活跃请求登记（inflight_requests 表，migration 0021）。
 *
 * 请求通过鉴权进入中继即登记一行；响应完全送达后由 waitUntil 删除。监控设施绝不
 * 能打断中继，所以这里所有失败都只 console.error，不向上抛。
 *
 * 悬挂行：运行时强拆调用时（客户端半路断开的若干形态）删除回调不会执行，行会留在
 * 表里。读取端按 started_at 懒回收——阈值远大于任何合法请求的寿命即可，不依赖 cron。
 */

export interface InflightRegistration {
  requestId: string;
  tokenId: number;
  tokenName: string;
  userId: number;
  username: string;
  modelName: string;
  protocol: string;
  stream: boolean;
  startedAt: number;
}

export interface InflightPatch {
  phase?: 'route' | 'upstream' | 'stream';
  channelId?: number | null;
  channelName?: string | null;
}

export interface InflightRow {
  request_id: string;
  token_id: number;
  token_name: string;
  user_id: number;
  username: string;
  model_name: string;
  protocol: string;
  stream: number;
  phase: string;
  channel_id: number | null;
  channel_name: string | null;
  started_at: number;
}

export async function registerInflight(env: Env, row: InflightRegistration): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO inflight_requests
         (request_id, token_id, token_name, user_id, username, model_name, protocol, stream, phase, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'route', ?)`,
    ).bind(
      row.requestId, row.tokenId, row.tokenName, row.userId, row.username,
      row.modelName, row.protocol, row.stream ? 1 : 0, row.startedAt,
    ).run();
  } catch (error) {
    console.error('[inflight] 登记失败：', error);
  }
}

export async function updateInflight(env: Env, requestId: string, patch: InflightPatch): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.phase !== undefined) { sets.push('phase = ?'); binds.push(patch.phase); }
  if (patch.channelId !== undefined) { sets.push('channel_id = ?'); binds.push(patch.channelId); }
  if (patch.channelName !== undefined) { sets.push('channel_name = ?'); binds.push(patch.channelName); }
  if (!sets.length) return;
  try {
    await env.DB.prepare(`UPDATE inflight_requests SET ${sets.join(', ')} WHERE request_id = ?`)
      .bind(...binds, requestId).run();
  } catch (error) {
    console.error('[inflight] 阶段更新失败：', error);
  }
}

export async function deleteInflight(env: Env, requestId: string): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM inflight_requests WHERE request_id = ?').bind(requestId).run();
  } catch (error) {
    console.error('[inflight] 删除失败：', error);
  }
}

/** 懒回收阈值：流式行按最长合法寿命给（上游总时长上限 20min）；其余行 5 分钟必死。 */
export const INFLIGHT_STALE_SEC = 1800;
export const INFLIGHT_STALE_NONSTREAM_SEC = 300;

export async function listInflight(
  env: Env,
  staleSec = INFLIGHT_STALE_SEC,
): Promise<{ rows: InflightRow[]; now: number; reaped: number }> {
  const now = Math.floor(Date.now() / 1000);
  let reaped = 0;
  try {
    /*
     * 分层回收：
     *   - phase='stream' 的行按 staleSec（30min）回收——合法长流能活到 20min；
     *   - 其余行（非流式的 route/upstream、流式但从未进入 stream 阶段的失败行）
     *     按 5min 回收——它们的正常删除发生在结算/失败尾巴，只剩被强拆的残行。
     * 不依赖 cron：每次读面板时顺手清。
     */
    const gone = await env.DB.prepare(
      `DELETE FROM inflight_requests
        WHERE started_at < CASE WHEN stream = 1 AND phase = 'stream' THEN ?1 ELSE ?2 END`,
    ).bind(now - staleSec, now - INFLIGHT_STALE_NONSTREAM_SEC).run();
    reaped = Number((gone.meta as { changes?: number } | undefined)?.changes ?? 0);
  } catch (error) {
    console.error('[inflight] 悬挂行回收失败：', error);
  }
  let rows: { results?: InflightRow[] } = {};
  try {
    rows = await env.DB.prepare('SELECT * FROM inflight_requests ORDER BY started_at').all<InflightRow>();
  } catch (error) {
    console.error('[inflight] 活跃列表读取失败：', error);
  }
  return { rows: rows.results ?? [], now, reaped };
}
