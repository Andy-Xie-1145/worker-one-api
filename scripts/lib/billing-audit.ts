/**
 * LLM 计费审计的纯逻辑：只读 SQL 守卫（本地）+ 未定价判定（转发 src/lib/model-billing）。
 *
 * 不碰网络、不碰 D1——scripts/audit-llm-billing.ts 负责取数，这里只做判断，
 * 好让 test/audit-billing.test.ts 能逐条钉死。
 *
 * 判定逻辑本体（findUnpricedChannelModels / fallbackActive）放在 src/lib/model-billing.ts，
 * CLI 的 `billing check` 与本脚本共用同一份，绝不各自实现。
 */

const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|ALTER|DROP|CREATE|TRUNCATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/**
 * 审计脚本发出的每一条 SQL 都要先过这里：只能是**单条** SELECT（或 WITH … SELECT），
 * 不能含任何写 / DDL / 事务关键字，不能有第二条语句。宁可误拒。
 */
export function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, '').trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) throw new Error(`审计脚本只允许 SELECT：${trimmed.slice(0, 60)}`);
  if (trimmed.includes(';')) throw new Error('审计脚本不允许多条语句');
  if (FORBIDDEN.test(trimmed)) throw new Error(`审计 SQL 含写/DDL 关键字：${trimmed.slice(0, 60)}`);
  return trimmed;
}

/** 脚本用到的全部 SQL。**不 SELECT channels.key / tokens.key / options 的其他行。** */
export const AUDIT_SQL = {
  // key 绝不能进审计输出，所以查询列表面就不取它。
  channels: 'SELECT id, name, type, status, models, model_mapping FROM channels ORDER BY id',
  options: "SELECT key, value FROM options WHERE key IN ('ModelPriceOverride', 'DefaultPrice')",
};

export { findUnpricedChannelModels, fallbackActive } from '../../src/lib/model-billing';
