/**
 * 令牌明文密钥的「回显纪律」。
 *
 * 明文 sk- 密钥只允许出现在两个显式动作里：
 *   1. 交给剪贴板（SPA 取回后立刻写剪贴板，不落 DOM、不进 toast）；
 *   2. 人主动敲 `token key <id>` / `GET /api/tokens/:id/key`。
 *
 * 其它任何地方——列表接口、创建接口的响应、CLI 输出、终端页、日志——一律用
 * maskTokenKey()。原因很实际：一旦明文被回显，终端滚动历史、截图、AI 会话记录
 * 就都成了泄露面，而 keys 又不那么容易轮换。
 */

import type { Env, TokenRow } from '../types';
import { LogTypeManage } from '../types';
import { ensureOwner } from './auth';

const now = () => Math.floor(Date.now() / 1000);

/** `sk-` + 前 keep 位 + `…`：够认人，不够用。 */
export function maskTokenKey(key: string, keep = 6): string {
  const bare = String(key ?? '').replace(/^sk-/, '');
  return `sk-${bare.slice(0, keep)}…`;
}

/** 完整形态——只有显式取回时才拼，别把它塞进列表。 */
export function fullTokenKey(key: string): string {
  return `sk-${String(key ?? '').replace(/^sk-/, '')}`;
}

/**
 * 明文取回的唯一实现（写审计日志 + 返回完整密钥）。
 *
 * API 的 `GET /tokens/:id/key` 和 CLI 的 `token key` 都走这里：日志 SQL 各写一份，
 * 迟早会出现"从 CLI 取得明文却没留痕"的窟窿。
 */
export async function revealTokenKey(env: Env, token: TokenRow): Promise<string> {
  const owner = await ensureOwner(env);
  await env.DB.prepare('INSERT INTO logs (user_id, created_at, type, content, username, quota) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(owner.id, now(), LogTypeManage, `取回令牌 #${token.id}「${token.name}」明文密钥`, owner.username, 0)
    .run();
  return fullTokenKey(token.key);
}

/** 令牌的默认对外视图：没有明文，只有遮罩。 */
export type PublicToken = Omit<TokenRow, 'key'> & { key_masked: string };

/** 去掉明文 key，补一个遮罩。列表/创建接口都走它，别各自拼。 */
export function publicToken(t: TokenRow): PublicToken {
  const { key, ...rest } = t;
  return { ...rest, key_masked: maskTokenKey(key) };
}
