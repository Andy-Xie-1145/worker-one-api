/**
 * LLM 计费审计的纯逻辑：只读 SQL 守卫 + 未定价模型判定。
 *
 * 不碰网络、不碰 D1——scripts/audit-llm-billing.ts 负责取数，这里只做判断，
 * 好让 test/audit-billing.test.ts 能逐条钉死。
 *
 * （上游 webclaw-api 的同名文件还包含一段「修复前旧计价规则复刻」的历史回放逻辑，
 * 那是他们生产账目的一次性补偿工具，与本项目无关，没有移植。）
 */
import { findPrice, resolveBillableModel } from '../../src/lib/pricing/llm';
import { mapModel } from '../../src/lib/channel';
import type { ChannelRow } from '../../src/types';
import type { Options } from '../../src/lib/options';

/* ------------------------------------------------------------ 只读守卫 */

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

/* ------------------------------------------------------------ 未定价判定 */

export interface UnpricedRow {
  channelId: number;
  channelName: string;
  channelType: string;
  /** 请求方会用的名字（渠道 models 里写的）。 */
  requested: string;
  /** model_mapping 之后要查价的上游名；没有映射时与 requested 相同。 */
  upstream: string;
}

/**
 * 找出启用渠道上查不到价的 (渠道, 模型) 组合——严格计费下这些组合会以
 * model_price_not_configured 拒绝，部署前必须清零。
 */
export function findUnpricedChannelModels(channels: ChannelRow[], options?: Options): UnpricedRow[] {
  const out: UnpricedRow[] = [];
  for (const channel of channels) {
    if (channel.status !== 1) continue;
    for (const requested of (channel.models ?? '').split(',').map((m) => m.trim()).filter(Boolean)) {
      const upstream = mapModel(channel, requested);
      if (!resolveBillableModel(requested, upstream, options)) {
        out.push({ channelId: channel.id, channelName: channel.name, channelType: channel.type, requested, upstream });
      }
    }
  }
  return out;
}

/** 兜底价是否在起作用（决定未定价是「拒绝」还是「按默认价记账」）。 */
export function fallbackActive(options?: Options): boolean {
  return !!options?.DefaultPrice;
}

/** 便利重导出：watchdog 的按声明扫描与这里共用 findPrice 的「查不到就是查不到」。 */
export { findPrice };
