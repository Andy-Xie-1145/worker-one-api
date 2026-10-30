import type { MiddlewareHandler } from 'hono';
import {
  type Env,
  type TokenRow,
  type UserRow,
  type Vars,
  RoleRoot,
  StatusEnabled,
  TokenStatusEnabled,
  TokenStatusExpired,
  TokenStatusExhausted,
} from '../types';
import { timingSafeEqual } from './crypto';
import { applyCredit } from './ledger';

// ---------------------------------------------------------------- 管理面：唯一管理员令牌

/**
 * 校验管理令牌。**没有账号、没有密码、没有会话**：一个足够长的随机令牌就是全部凭据。
 *
 * - 未配置 ADMIN_KEY 时管理面整体 503（宁可不可用也不敞开）；
 * - 比较走 constant-time，避免计时侧信道。
 */
export function checkAdminKey(env: Env, raw: string): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  const expected = env.ADMIN_KEY;
  if (!expected) return { ok: false, status: 503, error: 'ADMIN_KEY 未配置，管理面不可用（在 wrangler.jsonc 的 vars 里设置）' };
  const provided = (raw ?? '').trim().replace(/^Bearer\b\s*/i, '');
  if (!provided) return { ok: false, status: 401, error: '未提供管理令牌' };
  const enc = new TextEncoder();
  if (!timingSafeEqual(enc.encode(provided), enc.encode(expected))) return { ok: false, status: 401, error: '管理令牌不正确' };
  return { ok: true };
}

/** 所有 /api/* 管理端点的守门人（/api/status 除外）。 */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const result = checkAdminKey(c.env, c.req.header('Authorization') ?? '');
  if (!result.ok) return c.json({ success: false, message: result.error }, result.status);
  await next();
};

// ---------------------------------------------------------------- 唯一账户（owner）

export const OWNER_USERNAME = 'owner';

/**
 * 开户即预存的额度（$10,000）。个人网关的余额只是一把预算刻度尺：
 * 防失控、看消耗，需要时在后台「设置」页调整。
 */
export const OWNER_OPENING_QUOTA = 5_000_000_000;

/**
 * 确保唯一的 owner 账户存在，返回它。
 *
 * 在第一次令牌鉴权时懒创建，不需要任何初始化步骤。开余额走账本
 * （applyCredit）而不是直接 UPDATE 列，`reconcile()` 从第一笔起就能对上。
 * ref 幂等：并发首请求最多有一笔生效。
 */
export async function ensureOwner(env: Env): Promise<UserRow> {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(OWNER_USERNAME).first<UserRow>();
  if (existing) return existing;

  await env.DB.prepare(
    'INSERT INTO users (username, password, display_name, role, status, quota, created_time) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(username) DO NOTHING',
  )
    .bind(OWNER_USERNAME, '', 'Owner', RoleRoot, StatusEnabled, 0, Math.floor(Date.now() / 1000))
    .run();

  let user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(OWNER_USERNAME).first<UserRow>();
  await applyCredit(env, { userId: user!.id, delta: OWNER_OPENING_QUOTA, reason: 'adjust', ref: `opening:${user!.id}` });
  user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user!.id).first<UserRow>();
  return user!;
}

// ---------------------------------------------------------------- sk- 令牌鉴权（/v1 中继面）

/**
 * Reduces an Authorization header to the key string stored in `tokens.key`.
 *
 * Format: `sk-<48 hex>`, optionally with one-api's legacy `-channelId` hint
 * appended, which is ignored.
 */
export function normalizeKey(raw: string): string {
  // The auth scheme is case-insensitive per RFC 7235, and a bare "Bearer" with
  // no credentials must reduce to empty rather than to a key named "Bearer".
  let key = raw.trim().replace(/^Bearer\b\s*/i, '');
  if (key.startsWith('sk-')) key = key.slice(3);
  // one-api allows `key-channelId`; the channel hint is ignored here.
  return key.split('-')[0];
}

export interface TokenAuthResult {
  token: TokenRow;
  user: UserRow;
}

// Cloudflare KV enforces a 60s floor on expirationTtl.
const TOKEN_CACHE_TTL = 60;

/** Resolves an `Authorization: Bearer sk-...` API key to its token + owner. */
export async function authenticateToken(env: Env, raw: string): Promise<TokenAuthResult | { error: string; status: number }> {
  const key = normalizeKey(raw);
  if (!key) return { error: '未提供令牌', status: 401 };

  const cacheKey = `token:${key}`;
  /*
   * KV 只是加速层，不允许它变成单点：读失败回退 D1 直读，写失败静默放弃
   * （最多损失 60 秒缓存收益）。令牌的有效期/状态/额度检查仍全部照做——
   * 降级的只是速度，不是校验。
   */
  let token: TokenRow | null = null;
  try {
    token = (await env.CACHE.get(cacheKey, 'json')) as TokenRow | null;
  } catch (error) {
    console.error('[auth] KV 读失败，回退 D1：', error);
  }
  if (!token) {
    token = await env.DB.prepare('SELECT * FROM tokens WHERE key = ?').bind(key).first<TokenRow>();
    if (token) {
      try {
        await env.CACHE.put(cacheKey, JSON.stringify(token), { expirationTtl: TOKEN_CACHE_TTL });
      } catch {
        // 缓存写失败不影响本次请求。
      }
    }
  }
  if (!token) return { error: '无效的令牌', status: 401 };

  if (token.status === TokenStatusExpired) return { error: '该令牌已过期', status: 403 };
  if (token.status === TokenStatusExhausted) return { error: '该令牌额度已用尽', status: 403 };
  if (token.status !== TokenStatusEnabled) return { error: '该令牌状态不可用', status: 403 };

  const now = Math.floor(Date.now() / 1000);
  if (token.expired_time !== -1 && token.expired_time < now) {
    await env.DB.prepare('UPDATE tokens SET status = ? WHERE id = ?').bind(TokenStatusExpired, token.id).run();
    try {
      await env.CACHE.delete(cacheKey);
    } catch {
      // KV 删除失败：条目 60 秒后自然过期，短暂读到旧状态可接受。
    }
    return { error: '该令牌已过期', status: 403 };
  }
  if (!token.unlimited_quota && token.remain_quota <= 0) {
    await env.DB.prepare('UPDATE tokens SET status = ? WHERE id = ?').bind(TokenStatusExhausted, token.id).run();
    try {
      await env.CACHE.delete(cacheKey);
    } catch {
      // 同上：删除失败只影响缓存新鲜度。
    }
    return { error: '该令牌额度已用尽', status: 403 };
  }

  const user = await ensureOwner(env);
  if (user.status !== StatusEnabled) return { error: '账户已被禁用', status: 403 };

  // Deliberately no balance check here. Authentication answers "who is this",
  // not "can they afford it" — the guarded debit in preConsume() is the
  // authoritative affordability check, and it is per-request.
  //
  // Gating authentication on balance would also lock a spent-out user out of
  // /v1/models and /v1/usage, i.e. they could not look up their own balance
  // precisely when they need to. Free models would break too.
  return { token, user };
}

/** 缓存失效是 best-effort：KV 抖动不拦路（条目有 TTL 兜底）。 */
export async function invalidateTokenCache(env: Env, key: string): Promise<void> {
  try {
    await env.CACHE.delete(`token:${key}`);
  } catch {
    // KV 故障时静默——TTL 到期自然一致。
  }
}
