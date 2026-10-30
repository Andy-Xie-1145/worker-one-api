import type { Env } from '../types';

/**
 * 中继失败事件的记录器。
 *
 * ## 为什么需要它
 *
 * 在这个文件出现之前，**一次失败的中继请求在任何地方都不留痕迹**：postConsume
 * 只在成功计费时往 logs 写行，失败路径连一行 console.log 都没有。于是「字幕客户端选
 * Gemini 翻不出字幕」这种问题只能靠 `wrangler tail` 蹲现场——蹲到了也只看得到
 * 状态码，看不到请求体里那个模型名到底是什么。
 *
 * 实测过一次：93 个真实响应里 67 个 503，全程零记录。
 *
 * ## 约定：可观测性绝不影响请求
 *
 * 这里的每个写入都吞掉自己的异常（同 lib/cooldown.ts 的做法）。记不下来最多是
 * 少一条运维数据，绝不能让用户的翻译因此失败。调用方一律用 waitUntil，不 await。
 */

/** relay_events 的一行。除 stage 外都可省，省掉的走 DDL 里的 DEFAULT。 */
export interface RelayEvent {
  /** `pricing` = 查不到价/费率求值失败被跳过的渠道（严格计费的可见性）。 */
  stage: 'no_channel' | 'build' | 'network' | 'upstream' | 'stream' | 'quota' | 'deny403' | 'pricing';
  outcome?: string;
  modelName?: string;
  upstreamModel?: string;
  groupName?: string;
  channelId?: number;
  channelType?: string;
  status?: number;
  attempt?: number;
  /** 1 = 这条就是返回给用户的那次失败。统计失败率只认 final=1，重试的中间态不进分母。 */
  final?: boolean;
  elapsedMs?: number;
  userId?: number;
  errorCode?: string;
  errorText?: string;
}

/**
 * 密钥形状的片段一律抹掉再落库。
 *
 * 上游的 4xx 报文经常把请求头原样回显，BYOK 场景下那就是用户自己的 key。
 * 宁可把一段报文抹成 [redacted] 看不懂，也不能让密钥进数据库。
 */
export function sanitize(text: string): string {
  if (!text) return '';
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, 'AIza[redacted]')
    .replace(/(['"]?(?:api[_-]?key|key|access[_-]?token)['"]?\s*[:=]\s*['"]?)[A-Za-z0-9_.-]{8,}/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .slice(0, 300);
}

/**
 * 一次请求的所有失败事件一起写。
 *
 * 批量而不是每个分支各写一次：一个用满重试的请求会产生 3~4 条事件，逐条写就是
 * 逐条往 D1 打一个往返。调用方把它们攒在一个数组里，退出前 flush 一次。
 */
export async function recordRelayEvents(env: Env, events: RelayEvent[]): Promise<void> {
  if (!events.length) return;

  try {
    const now = Math.floor(Date.now() / 1000);
    const stmts = events.map((e) =>
      env.DB.prepare(
        `INSERT INTO relay_events
           (created_at, outcome, stage, model_name, upstream_model, group_name,
            channel_id, channel_type, status, attempt, final, elapsed_ms,
            user_id, error_code, error_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        now,
        e.outcome ?? 'error',
        e.stage,
        e.modelName ?? '',
        e.upstreamModel ?? '',
        e.groupName ?? '',
        e.channelId ?? 0,
        e.channelType ?? '',
        e.status ?? 0,
        e.attempt ?? 0,
        e.final ? 1 : 0,
        e.elapsedMs ?? 0,
        e.userId ?? 0,
        e.errorCode ?? '',
        sanitize(e.errorText ?? ''),
      ),
    );
    await env.DB.batch(stmts);
  } catch (error) {
    // 记不下来就算了，绝不让它影响请求本身
    console.error('[health] 失败事件写入失败：', error);
  }
}

// ---------------------------------------------------------------- 冷却状态

export interface CoolingInfo {
  cooling: boolean;
  secondsLeft: number;
  strike: number;
}

/**
 * 读出所有渠道当前的冷却状态。
 *
 * lib/cooldown.ts 的 getCooling 只回答「在不在冷却中」，因为选路只需要这一位。
 * 状态页要显示「还剩多久」，那个数字在 KV 的 expiration 元数据里——list() 会带
 * 回来，不用改冷却本身的存储格式。
 */
export async function listCooling(env: Env): Promise<Map<number, CoolingInfo>> {
  const out = new Map<number, CoolingInfo>();
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const [cool, strikes] = await Promise.all([
      env.CACHE.list({ prefix: 'cooldown:ch:' }),
      env.CACHE.list({ prefix: 'cooldown:strike:' }),
    ]);

    for (const key of cool.keys) {
      const id = Number(key.name.slice('cooldown:ch:'.length));
      if (!Number.isFinite(id)) continue;
      out.set(id, {
        cooling: true,
        secondsLeft: key.expiration ? Math.max(0, key.expiration - nowSec) : 0,
        strike: 0,
      });
    }
    for (const key of strikes.keys) {
      const id = Number(key.name.slice('cooldown:strike:'.length));
      if (!Number.isFinite(id)) continue;
      const entry = out.get(id) ?? { cooling: false, secondsLeft: 0, strike: 0 };
      // strike 计数比冷却活得久（TTL 是冷却上限的若干倍），所以可能只有它在
      entry.strike = Number((await env.CACHE.get(key.name)) ?? 0) || 0;
      out.set(id, entry);
    }
  } catch (error) {
    // 读不到就当没有冷却信息，页面显示空白好过整页 500
    console.error('[health] 冷却状态读取失败：', error);
  }
  return out;
}

// ---------------------------------------------------------------- 状态判定

export type HealthState = 'ok' | 'degraded' | 'down' | 'unknown';

/** 样本少于这个数就不下结论。3 次里错 1 次不是故障，是巧合。 */
export const MIN_SAMPLES = 5;

export interface StateInput {
  successes: number;
  /** 只数 final=1 的失败：重试的中间态不进分母，否则一次请求会被算成三次失败。 */
  failures: number;
  p50Ms?: number;
  /** 成功但耗时逼近超时的比例。全成功却全都慢到用户等不及，也是降级。 */
  nearTimeoutRate?: number;
  disabled?: boolean;
  cooling?: boolean;
  slowMs?: number;
}

/**
 * 正常 / 降级 / 故障 的唯一口径，两个 worker 共用。
 *
 * 两条设计原则：
 * - **样本不足永远不判故障**。半夜只有 3 个请求、错了 1 个就挂红灯，这种状态页
 *   没人会信，信了也会被训练成无视它。
 * - **延迟只降级，不判故障**。慢和坏是两回事：gemini 22–45s 全部成功，但字幕
 *   45s 就 abort，用户体感是"不能用"——所以必须显示出来，但它毕竟不是故障。
 */
export function deriveState(input: StateInput): HealthState {
  if (input.disabled) return 'down';

  const samples = input.successes + input.failures;
  if (samples < MIN_SAMPLES) return input.cooling ? 'degraded' : 'unknown';

  const failRate = input.failures / samples;
  let state: HealthState = failRate >= 0.35 ? 'down' : failRate >= 0.05 ? 'degraded' : 'ok';

  if (state === 'ok') {
    const slow = input.slowMs && input.p50Ms ? input.p50Ms > input.slowMs : false;
    if (slow || (input.nearTimeoutRate ?? 0) > 0.2 || input.cooling) state = 'degraded';
  }
  return state;
}

// ---------------------------------------------------------------- 引擎归类

/**
 * 模型串 → 面向用户的「引擎」。
 *
 * 按**模型名**归类而不是按渠道 type：channels.type 是适配器协议，`openai` 那一
 * 类里同时装着 DeepSeek、智谱、OpenRouter，对用户毫无意义。用户在客户端里选的
 * 是「Gemini」「DeepSeek」，公开状态页就该按这个说话。
 *
 * 另外，「没有可用渠道」的失败压根没有渠道可查，只有模型名——那恰恰是最需要显示
 * 在状态页上的一类故障。
 */
const ENGINE_RULES: Array<[RegExp, string, string]> = [
  [/^gemini/i, 'gemini', 'Google Gemini'],
  [/^(gpt|o\d|chatgpt|text-embedding)/i, 'openai', 'ChatGPT'],
  [/^deepseek/i, 'deepseek', 'DeepSeek'],
  [/^glm/i, 'zhipu', 'GLM'],
  [/claude/i, 'anthropic', 'Claude'],
  [/qwen/i, 'qwen', 'Qwen'],
];

export function engineOf(model: string): { id: string; label: string } {
  for (const [re, id, label] of ENGINE_RULES) {
    if (re.test(model)) return { id, label };
  }
  return { id: 'other', label: 'Other' };
}

/** 取窗口内的样本在 JS 里算分位数。D1 没有 percentile()，而两次 OFFSET 查询更贵。 */
export function percentiles(values: number[]): { p50: number; p95: number } {
  if (!values.length) return { p50: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p95: at(0.95) };
}

/**
 * 清掉过期的失败事件。
 *
 * 一次最多删 5000 行：D1 单次操作的写入行数有上限，而且这是在定时任务里跑的，
 * 慢慢删几天也无所谓——重要的是永远不会因为积压太多而一次撑爆。
 */
export async function pruneRelayEvents(env: Env, days = 14): Promise<number> {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const result = await env.DB.prepare(
      'DELETE FROM relay_events WHERE id IN (SELECT id FROM relay_events WHERE created_at < ? LIMIT 5000)',
    )
      .bind(cutoff)
      .run();
    return result.meta?.changes ?? 0;
  } catch (error) {
    console.error('[health] 失败事件清理失败：', error);
    return 0;
  }
}
