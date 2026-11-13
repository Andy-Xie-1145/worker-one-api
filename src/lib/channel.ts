import { type Env, type ChannelRow, ChannelStatusEnabled } from '../types';
import { getCooling } from './cooldown';
import { getDenied403, UNKNOWN_COLO, type Deny403Entry } from './deny403';
import type { PriceSpec } from './pricing/llm';
import { componentOf, type AliasIndex } from './alias';

export function csv(value: string): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 渠道标签解析（channels.tags，JSON 字符串数组）；坏值防御性回空数组。 */
export function parseChannelTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    if (!Array.isArray(p)) return [];
    return [...new Set(p.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim()))];
  } catch {
    return [];
  }
}

/** 渠道标签写入前规范化：数组 = 去空白去重；JSON 数组字符串 = 原样解析（幂等）；逗号分隔字符串 = 切分；其余非法。 */
export function normalizeChannelTags(value: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: false, error: '__absent__' };
  let list: unknown[];
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') {
    /*
     * 字符串若本身就是 JSON 数组（存量列的存储形态），按数组解析而不是按逗号切分。
     * 否则「PUT 不带 tags → 合并存量字符串 → 当成一个标签名再序列化」会把
     * ["HPD-DOG"] 双重编码成 ["[\"HPD-DOG\"]"]——标签 ACL 匹配就此全灭（2026-11-13 实况）。
     */
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        list = Array.isArray(parsed) ? parsed : [value];
      } catch { list = [value]; }
    } else list = value.split(',');
  }
  else return { ok: false, error: 'tags 必须是字符串数组或逗号分隔字符串' };
  const tags = [...new Set(list.map((n) => String(n ?? '').trim()).filter(Boolean))];
  for (const t of tags) if (t.length > 64) return { ok: false, error: `标签过长（≤64 字符）：${t.slice(0, 20)}…` };
  return { ok: true, json: JSON.stringify(tags) };
}

export interface TokenChannelAcl {
  mode: 'whitelist' | 'blacklist';
  /** 条目：数字 = 渠道 ID；字符串 = 渠道标签名（channels.tags，多值）。两者可混用。 */
  channels: Array<number | string>;
}

/**
 * 解析令牌的渠道 ACL（tokens.channel_acl，JSON 文本）。三种返回：
 *   - null          ：未配置（'' / null），所有启用渠道参与选路；
 *   - {mode,channels}：合法配置。条目匹配：渠道 ID 相等 **或** 渠道分组名相等。
 *     语义：whitelist 只允许匹配条目的渠道（无匹配条目 = 禁止任何渠道，等价禁用）；
 *     blacklist 禁止匹配条目的渠道（无条目 = 全放）；
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
  const rawEntries = (Array.isArray(p.channels) ? p.channels : []) as unknown[];
  const ids = [...new Set(rawEntries.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const names = [...new Set(rawEntries.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim()))].sort();
  return { mode: p.mode === 'whitelist' ? 'whitelist' : 'blacklist', channels: [...ids, ...names] };
}

/**
 * 管理入口（API/CLI）写入前的校验：接受 {mode, channels} 对象或 null（清除），
 * channels 条目 = 渠道 ID（正整数）或 分组名（非空字符串），可混用；返回规范化 JSON。
 * 白名单/黑名单互斥由结构保证——一个对象只有一个 mode。
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
  if (!Array.isArray(v.channels)) return { ok: false, error: 'channel_acl.channels 必须是数组（条目 = 渠道 ID 或 分组名；白名单可为空数组 = 全禁）' };
  const ids = [...new Set(v.channels.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const names = [...new Set(v.channels.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim()))].sort();
  return { ok: true, json: JSON.stringify({ mode: v.mode, channels: [...ids, ...names] }) };
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
  | { kind: 'channel'; channel: ChannelRow; /** 别名解析后，该渠道在 abilities 里拥有的成员名（无别名 = 请求名）。 */ matchedModel: string }
  | { kind: 'all_denied_403'; earliest: Deny403Entry };

/**
 * Picks a channel for a model: highest priority tier first, then a weighted
 * random pick inside that tier. `exclude` carries channels already tried in
 * this request so retries land somewhere else. `colo` scopes the 403
 * soft-breaker (见 lib/deny403.ts)：同一渠道换个机房/模型不受另一处的熔断牵连。
 *
 * `aliasIndex`（模型别名并查集）：请求名展开为联通块全部成员，候选 = 拥有其中
 * **任意**成员的渠道（每渠道取字典序最小成员，避免同渠道多成员重复计数）；
 * matchedModel 带回该成员，出站名用它（= 翻译成渠道自己拥有的叫法）。
 */
export async function selectChannel(
  env: Env,
  model: string,
  exclude: number[] = [],
  colo: string = UNKNOWN_COLO,
  acl?: TokenChannelAcl | null,
  aliasIndex?: AliasIndex | null,
): Promise<ChannelSelection | null> {
  const members = aliasIndex ? componentOf(aliasIndex, model) : [model];
  const rows = await env.DB.prepare(
    `SELECT model, channel_id, priority, weight FROM abilities WHERE model IN (${members.map(() => '?').join(',')}) AND enabled = 1 ORDER BY model`,
  )
    .bind(...members)
    .all<{ model: string; channel_id: number; priority: number; weight: number }>();

  // 每渠道取一个成员（同渠道多个成员同组时按字典序取首个，不重复计数）。
  const seenCh = new Set<number>();
  let candidates: Array<{ model: string; channel_id: number; priority: number; weight: number }> = [];
  for (const r of rows.results ?? []) {
    if (seenCh.has(r.channel_id) || exclude.includes(r.channel_id)) continue;
    seenCh.add(r.channel_id);
    candidates.push(r);
  }
  if (!candidates.length) return null;

  /*
   * 令牌级渠道 ACL（白/黑名单），在冷却/熔断检查**之前**——不允许的渠道连冷却
   * 状态都不必查。条目 = 渠道 ID 或 渠道标签（channels.tags，多值，无倍率）。
   * 标签匹配 = 渠道标签数组包含该条目（一个渠道可同时属于多个标签）。
   * 白名单无匹配条目 = 全禁（null → 503 no_channel）；黑名单空 = 全放。
   * 过滤发生在候选生成阶段，重试/failover 的每一轮都带同一份 ACL。
   */
  if (acl) {
    const match = (id: number): boolean => {
      if (acl.channels.some((c) => typeof c === 'number' && c === id)) return true;
      const hasTagEntries = acl.channels.some((c) => typeof c === 'string');
      if (!hasTagEntries) return false;
      const tags = channelTags.get(id) ?? [];
      return tags.some((t) => acl.channels.includes(t));
    };
    // 标签匹配需要候选渠道的标签数组：一次批量查询（只有 ACL 条目含标签时才查）。
    const channelTags = acl.channels.some((c) => typeof c === 'string')
      ? await (async () => {
          const ids = candidates.map((r) => r.channel_id);
          const rows2 = ids.length
            ? await env.DB.prepare(`SELECT id, tags FROM channels WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: number; tags: string }>()
            : { results: [] as Array<{ id: number; tags: string }> };
          return new Map((rows2.results ?? []).map((r) => [r.id, parseChannelTags(r.tags)]));
        })()
      : new Map<number, string[]>();
    const allowed = candidates.filter((r) => (acl.mode === 'whitelist' ? match(r.channel_id) : !match(r.channel_id)));
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
  return channel ? { kind: 'channel', channel, matchedModel: picked.model } : null;
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
