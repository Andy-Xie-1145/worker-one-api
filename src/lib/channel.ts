import { type Env, type ChannelRow, ChannelStatusEnabled } from '../types';
import { getCooling } from './cooldown';
import { getDenied403, UNKNOWN_COLO, type Deny403Entry } from './deny403';
import type { PriceSpec } from './pricing/llm';

export function csv(value: string): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface TokenChannelAcl {
  mode: 'whitelist' | 'blacklist';
  channels: number[];
}

/**
 * 解析令牌的渠道 ACL（tokens.channel_acl，JSON 文本）。三种返回：
 *   - null          ：未配置（'' / null），所有启用渠道参与选路；
 *   - {mode,channels}：合法配置。语义：whitelist 只允许 channels 内的渠道（空数组 =
 *     禁止任何渠道，等价禁用）；blacklist 禁止 channels 内的渠道（空数组 = 全放）；
 *   - 损坏的 JSON   ：**宁可关不可开**——按「白名单且为空」（全禁）处理并喊日志。
 *     这是访问控制，坏配置静默放行等于ACL 失效；流量恢复靠管理员修好 JSON。
 */
export function parseTokenAcl(raw: string | null | undefined): TokenChannelAcl | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let p: any;
  try {
    p = JSON.parse(s);
  } catch {
    p = null;
  }
  if (!p || (p.mode !== 'whitelist' && p.mode !== 'blacklist') || !Array.isArray(p.channels)) {
    console.error(`[acl] 令牌 channel_acl 损坏，按全禁处理：${s.slice(0, 80)}`);
    return { mode: 'whitelist', channels: [] };
  }
  const rawIds = (Array.isArray(p.channels) ? p.channels : []) as unknown[];
  const channels = [...new Set(rawIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  return { mode: p.mode === 'whitelist' ? 'whitelist' : 'blacklist', channels };
}

/**
 * 管理入口（API/CLI）写入前的校验：接受 {mode, channels} 对象或 null（清除），
 * 返回规范化 JSON 文本。白名单/黑名单互斥由结构保证——一个对象只有一个 mode。
 * 已存储的 JSON 字符串原样回传时也能通过（重校验一遍，坏存储会被拦在门外）。
 */
export function validateTokenAclInput(value: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, json: '' };
  if (value === null) return { ok: true, json: '' };
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return { ok: true, json: '' };
    try {
      return validateTokenAclInput(JSON.parse(s));
    } catch {
      return { ok: false, error: 'channel_acl 需传对象 {mode, channels}、null（清除）或合法的 ACL JSON' };
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'channel_acl 需传对象 {mode, channels} 或 null（清除）' };
  const v = value as Record<string, unknown>;
  if (v.mode !== 'whitelist' && v.mode !== 'blacklist') return { ok: false, error: "channel_acl.mode 只能是 'whitelist' 或 'blacklist'（两模式互斥，由结构保证不能同时设置）" };
  if (!Array.isArray(v.channels)) return { ok: false, error: 'channel_acl.channels 必须是渠道 ID 数组（白名单可为空数组 = 全禁）' };
  const ids = [...new Set(v.channels.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  return { ok: true, json: JSON.stringify({ mode: v.mode, channels: ids }) };
}

/**
 * The abilities table is a denormalized model -> channel index so routing is a
 * single indexed lookup instead of scanning every channel's comma-separated
 * model list. Rebuilt whenever a channel is written.
 */
export async function rebuildAbilities(env: Env, channel: ChannelRow): Promise<void> {
  const stmts: D1PreparedStatement[] = [env.DB.prepare('DELETE FROM abilities WHERE channel_id = ?').bind(channel.id)];
  const enabled = channel.status === ChannelStatusEnabled ? 1 : 0;
  for (const model of csv(channel.models)) {
    stmts.push(
      env.DB.prepare(
        'INSERT OR REPLACE INTO abilities (model, channel_id, enabled, priority, weight) VALUES (?, ?, ?, ?, ?)',
      ).bind(model, channel.id, enabled, channel.priority ?? 0, Math.max(1, channel.weight ?? 1)),
    );
  }
  await env.DB.batch(stmts);
  await env.CACHE.delete('models:all');
}

export async function deleteAbilities(env: Env, channelId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM abilities WHERE channel_id = ?').bind(channelId).run();
  await env.CACHE.delete('models:all');
}

/**
 * selectChannel 的结果：选到了渠道、一个都没有（503 no_channel）、或候选全部
 * 处于**仍有效**的 403 软熔断。最后一种带着最早到期的记录回给调用方，由它
 * 0 fetch 直接回 403（复用缓存的错误 message）——熔断期内不发任何探测，
 * 恢复探测只发生在记录过期、渠道重新进入正常候选之后。
 */
export type ChannelSelection =
  | { kind: 'channel'; channel: ChannelRow }
  | { kind: 'all_denied_403'; earliest: Deny403Entry };

/**
 * Picks a channel for a model: highest priority tier first, then a weighted
 * random pick inside that tier. `exclude` carries channels already tried in
 * this request so retries land somewhere else. `colo` scopes the 403
 * soft-breaker (见 lib/deny403.ts)：同一渠道换个机房/模型不受另一处的熔断牵连。
 */
export async function selectChannel(
  env: Env,
  model: string,
  exclude: number[] = [],
  colo: string = UNKNOWN_COLO,
  acl?: TokenChannelAcl | null,
): Promise<ChannelSelection | null> {
  const rows = await env.DB.prepare(
    'SELECT channel_id, priority, weight FROM abilities WHERE model = ? AND enabled = 1',
  )
    .bind(model)
    .all<{ channel_id: number; priority: number; weight: number }>();

  let candidates = (rows.results ?? []).filter((r) => !exclude.includes(r.channel_id));
  if (!candidates.length) return null;

  /*
   * 令牌级渠道 ACL（白/黑名单），在冷却/熔断检查**之前**——不允许的渠道连冷却
   * 状态都不必查。白名单空 = 全禁（allowed.length === 0 → null → 503 no_channel）；
   * 黑名单空 = 全放（过滤后原样）。过滤发生在候选生成阶段，重试/failover 的每一轮
   * 都带同一份 ACL，被排除的渠道永远不会被选中。
   */
  if (acl) {
    const ids = acl.channels;
    const allowed = acl.mode === 'whitelist' ? candidates.filter((r) => ids.includes(r.channel_id)) : candidates.filter((r) => !ids.includes(r.channel_id));
    if (!allowed.length) return null;
    candidates = allowed;
  }

  /*
   * 再剔除正在 429 冷却中的渠道。
   *
   * 全部都在冷却时**不留空**，而是当作没有冷却继续选：宁可撞一次 429，也好过
   * 直接告诉用户"没有可用渠道"——后者是把一个临时状态渲染成了永久故障。
   */
  const cooling = await getCooling(env, candidates.map((c) => c.channel_id));
  if (cooling.size) {
    const warm = candidates.filter((c) => !cooling.has(c.channel_id));
    if (warm.length) candidates = warm;
  }

  /*
   * 再剔除 403 软熔断中的（channel+model+colo）组合，让请求直接落到别的渠道，
   * 而不是每个请求都先撞一次已知的 403。
   *
   * 候选全部处于**仍有效**的熔断时，一个上游请求都不发：把最早到期的记录交回
   * 调用方直接回 403。不在这里挑「最早到期者」探测——那等于熔断期内每个请求
   * 还是去撞一次墙，软熔断就白做了。恢复探测只发生在记录自然过期、渠道重新
   * 进入正常候选之后（上游 200 清熔断，仍 403 则重新熔断 30 分钟）。
   */
  const denied = await getDenied403(env, candidates.map((c) => c.channel_id), model, colo);
  if (denied.size) {
    const open = candidates.filter((c) => !denied.has(c.channel_id));
    if (open.length) candidates = open;
    else {
      const earliest = [...denied.values()].reduce((a, b) => (a.expiresAt <= b.expiresAt ? a : b));
      return { kind: 'all_denied_403', earliest };
    }
  }

  const topPriority = Math.max(...candidates.map((c) => c.priority));
  const tier = candidates.filter((c) => c.priority === topPriority);

  const totalWeight = tier.reduce((sum, c) => sum + Math.max(1, c.weight), 0);
  let roll = Math.random() * totalWeight;
  let picked = tier[0];
  for (const c of tier) {
    roll -= Math.max(1, c.weight);
    if (roll <= 0) {
      picked = c;
      break;
    }
  }

  const channel = await env.DB.prepare('SELECT * FROM channels WHERE id = ? AND status = ?')
    .bind(picked.channel_id, ChannelStatusEnabled)
    .first<ChannelRow>();
  return channel ? { kind: 'channel', channel } : null;
}

/** Applies the channel's model_mapping JSON, e.g. {"gpt-4":"gpt-4o"}. */
export function mapModel(channel: ChannelRow, model: string): string {
  if (!channel.model_mapping) return model;
  try {
    const mapping = JSON.parse(channel.model_mapping);
    const target = mapping?.[model];
    return typeof target === 'string' && target ? target : model;
  } catch {
    return model;
  }
}

export function parseConfig(channel: ChannelRow): Record<string, any> {
  if (!channel.config) return {};
  try {
    const parsed = JSON.parse(channel.config);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Distinct model names across all enabled channels. */
export async function listModels(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT DISTINCT model FROM abilities WHERE enabled = 1 ORDER BY model').all<{ model: string }>();
  return (rows.results ?? []).map((r) => r.model);
}

/**
 * 渠道测试用哪个模型。传了就必须是该渠道 models 里的一个——测试接口直连上游、
 * 带着渠道 key，不能让它变成「拿这把 key 调任意模型」的后门。没传时回退第一个，
 * 只为兼容旧调用；后台 UI 和 CLI 总是显式传。
 */
export function resolveTestModel(channel: Pick<ChannelRow, 'models'>, requested: unknown): { model: string } | { error: string } {
  const models = csv(channel.models);
  if (!models.length) return { error: '渠道未配置模型' };
  if (requested !== undefined && requested !== null && typeof requested !== 'string') return { error: 'model 必须是字符串' };
  const want = (requested ?? '').trim();
  if (!want) return { model: models[0] };
  if (!models.includes(want)) return { error: `模型 ${want} 不属于该渠道` };
  return { model: want };
}

/**
 * 解析渠道的按模型价格覆盖（`channels.price_config`，JSON 文本）。
 *
 * 坏 JSON / 非对象一律回空表并打日志——渠道价格是**可选**的成本真相，坏了不该
 * 拖垮请求（后续按全局链解析）；但要让日志喊出来，不能静默。
 * 存量合法性由保存入口（API/CLI 的 validatePriceSpec）保证，这里只防御。
 */
export function parseChannelPriceConfig(channel: Pick<ChannelRow, 'price_config'> & { id?: number }): Record<string, PriceSpec> {
  if (!channel.price_config) return {};
  try {
    const parsed = JSON.parse(channel.price_config);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // 落到下面统一报错
  }
  console.error(`[pricing] 渠道 #${channel.id ?? '?'} 的 price_config 不是合法 JSON，按无覆盖处理`);
  return {};
}
