import type { Env } from '../types';

export type CreditReason = 'trial' | 'grant' | 'purchase' | 'consume' | 'refund' | 'budget' | 'adjust';

export interface ApplyCreditArgs {
  userId: number;
  /** Signed: positive credits, negative debits. */
  delta: number;
  reason: CreditReason;
  /** Idempotency key. A repeat with the same non-empty ref is rejected as a duplicate. */
  ref?: string;
  /**
   * When true (the default for debits), the balance is not allowed to go
   * negative and the call fails instead. Settlement passes false: the service
   * was already delivered, so the charge must land even if it overdraws.
   */
  guard?: boolean;
  /** Extra statements to commit alongside the ledger row. */
  also?: D1PreparedStatement[];
  /**
   * ref 是刚生成、不可能重复的（如预扣的 uuid）——跳过那次去重查询。
   *
   * 只在**能证明唯一**的地方传 true。它省的是每个中继请求热路径上的一次 D1 往返；
   * 结算和退款绝不能传，那两处正要靠去重来互斥。
   */
  assumeNew?: boolean;
  /**
   * 这笔钱是用哪种货币买的（'CNY' | 'USD'）。只有充值行有意义。
   * 历史遗留列：多币种钱包已随平台生态移除，新写入一律记 'USD'，仅供对账参考。
   */
  currency?: string;
  /** 成交那一刻的汇率，1 USD = rateE4 / 10000 该币种。冻结不重算。 */
  rateE4?: number;
  /** 原币金额（分 / cent），带符号，仅供展示与对账。 */
  amountMinor?: number;
}

export type ApplyCreditResult =
  | { ok: true; balance: number; duplicate?: false }
  | { ok: true; balance: number; duplicate: true }
  | { ok: false; reason: 'insufficient' | 'no_such_user'; balance?: number };

/**
 * The single entry point for every change to a user's balance.
 *
 * Correctness rests on one rule: the balance is read and written by the *same*
 * statement, so concurrent requests cannot both pass a check and both debit.
 * Never reintroduce a read-then-write here.
 *
 * D1 has no explicit transactions, and `batch()` does not roll back when a
 * conditional UPDATE simply matches zero rows — so the guarded update must run
 * on its own and be inspected before anything else is committed.
 */
export async function applyCredit(env: Env, args: ApplyCreditArgs): Promise<ApplyCreditResult> {
  const { userId, delta, reason, ref = '', also = [], amountMinor = 0 } = args;
  const currency = args.currency || 'USD';
  const rateE4 = args.rateE4 || 10_000;
  const guard = args.guard ?? delta < 0;

  if (ref && !args.assumeNew && (await isDuplicate(env, ref))) {
    const balance = await getBalance(env, userId);
    return { ok: true, balance, duplicate: true };
  }

  // `RETURNING` gives us the post-update balance without a second read, so the
  // number written to the ledger is exactly what the UPDATE produced.
  const sql = guard
    ? 'UPDATE users SET quota = quota + ?1 WHERE id = ?2 AND quota + ?1 >= 0 RETURNING quota'
    : 'UPDATE users SET quota = quota + ?1 WHERE id = ?2 RETURNING quota';

  const row = await env.DB.prepare(sql).bind(delta, userId).first<{ quota: number }>();
  if (!row) {
    // Either the user is gone or the guard rejected the debit. Distinguish them
    // so callers can report something useful.
    const exists = await env.DB.prepare('SELECT quota FROM users WHERE id = ?').bind(userId).first<{ quota: number }>();
    if (!exists) return { ok: false, reason: 'no_such_user' };
    return { ok: false, reason: 'insufficient', balance: exists.quota };
  }

  const stmts = [
    env.DB.prepare(
      'INSERT INTO credits (user_id, delta, reason, ref, balance_after, created_at, currency, rate_e4, amount_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      userId,
      delta,
      reason,
      ref,
      row.quota,
      Math.floor(Date.now() / 1000),
      currency,
      rateE4,
      amountMinor,
    ),
    ...also,
  ];
  await env.DB.batch(stmts);

  return { ok: true, balance: row.quota };
}

/**
 * 门控谓词：这笔账的账本行已经落地。
 *
 * 每一条 `also` 语句都要追加它，绑定同一个 ref。所以那些语句**必须已经带 WHERE**。
 */
const CREDIT_LANDED = 'EXISTS (SELECT 1 FROM credits WHERE ref = ?)';

export interface GatedStatement {
  /** 必须已经带 WHERE 子句——本模块会往后面追加 ` AND <门控>`。 */
  sql: string;
  binds: unknown[];
}

export interface ApplyCreditGatedArgs {
  userId: number;
  delta: number;
  reason: CreditReason;
  /** 必填且非空。它同时是幂等键和门控依据。 */
  ref: string;
  /** 追加到账本 INSERT 的守门条件，可以引用别名 `u`（users 那一行）。 */
  guardSql: string;
  guardBinds?: unknown[];
  /** 在账本行之前执行的语句（比如抢结算权的 CAS）。不门控。 */
  before?: GatedStatement[];
  /** 与这笔账同生共死的语句。会被自动追加门控谓词。 */
  also?: GatedStatement[];
  currency?: string;
  rateE4?: number;
  amountMinor?: number;
}

export type ApplyCreditGatedResult =
  /** 账本行插进去了，余额和附加语句都跟着做了。 */
  | { applied: true; duplicate: false }
  /** 守门条件不成立（余额不够 / 前置状态不对），什么都没发生。 */
  | { applied: false; duplicate: false }
  /** 这个 ref 之前就用过了。整批回滚，什么都没发生。 */
  | { applied: false; duplicate: true };

/**
 * 一次**同生共死**的余额变动。
 *
 * 和 `applyCredit()` 的区别只有一个，但那一个很关键：这里**账本行先插、其余全部门控
 * 在它身上**，而不是先动余额再补账本行。
 *
 * ```sql
 * ① INSERT INTO credits ... SELECT ... FROM users u WHERE u.id = ? AND <守门条件>
 * ② UPDATE users SET quota = quota + ? WHERE id = ? AND EXISTS(credits.ref)
 * ③ <also>                                          ... AND EXISTS(credits.ref)
 * ```
 *
 * 换来三件事：
 *
 * 1. **`credits.ref` 成了真正的序列化器。** `applyCredit()` 的去重是 check-then-act
 *    （先 SELECT 再 UPDATE 再 INSERT），并发的两个相同 ref 会双双移动余额，只有第二条
 *    INSERT 撞唯一索引。这里重复的 ref 在**第一条语句**就撞索引抛错，②③ 根本不会跑。
 * 2. **任何前缀提交都不会把账写坏。** D1 的 batch 在本地是一个事务（miniflare 走
 *    `state.storage.transactionSync`），但**类型声明里对原子性只字未提，生产行为本地
 *    无从证实**——所以这里不把它当契约。就算只提交了 ①，结果也只是"账本说扣了、余额
 *    没动"，`reconcile()` 当场报漂移，重放整段又是幂等的。绝不会出现反过来的那种：
 *    钱动了却没有账本行——那种没有任何线索能查。
 * 3. **`balance_after` 算得对。** ① 在 ② 之前跑，`u.quota + delta` 正是这笔之后的余额。
 *
 * 「有没有插进去」用 `RETURNING id` 判断，不看 `meta.changes`：meta 里有哪些字段是驱动的
 * 实现细节（wrangler CLI 就不给 changes），返回的行是 SQL 层面的事实。
 */
export async function applyCreditGated(env: Env, args: ApplyCreditGatedArgs): Promise<ApplyCreditGatedResult> {
  const { userId, delta, reason, ref, guardSql, guardBinds = [], before = [], also = [], amountMinor = 0 } = args;
  const currency = args.currency || 'USD';
  const rateE4 = args.rateE4 || 10_000;
  const createdAt = Math.floor(Date.now() / 1000);

  const stmts = [
    ...before.map((s) => env.DB.prepare(s.sql).bind(...s.binds)),
    env.DB.prepare(
      `INSERT INTO credits (user_id, delta, reason, ref, balance_after, created_at, currency, rate_e4, amount_minor)
       SELECT ?, ?, ?, ?, u.quota + ?, ?, ?, ?, ?
         FROM users u
        WHERE u.id = ? AND (${guardSql})
       RETURNING id`,
    ).bind(userId, delta, reason, ref, delta, createdAt, currency, rateE4, amountMinor, userId, ...guardBinds),
    env.DB.prepare(`UPDATE users SET quota = quota + ? WHERE id = ? AND ${CREDIT_LANDED}`).bind(delta, userId, ref),
    ...also.map((s) => env.DB.prepare(`${s.sql} AND ${CREDIT_LANDED}`).bind(...s.binds, ref)),
  ];

  let results;
  try {
    results = await env.DB.batch(stmts);
  } catch (error) {
    if (isDuplicateRef(error)) return { applied: false, duplicate: true };
    throw error;
  }

  const inserted = (results[before.length]?.results ?? []).length > 0;
  return inserted ? { applied: true, duplicate: false } : { applied: false, duplicate: false };
}

/**
 * 这次失败是不是「这个 ref 已经用过了」。
 *
 * D1 客户端把 SQLite 的报错包成 `Error("D1_ERROR: UNIQUE constraint failed: credits.ref")`，
 * 所以只能认字符串。认得宽一点（不要求 `credits.ref` 全名）：批里唯一带唯一索引的
 * 就是账本行那一条，认错的余地很小，而认不出会把一次重试变成 500。
 */
function isDuplicateRef(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${(error.cause as Error | undefined)?.message ?? ''}` : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

async function isDuplicate(env: Env, ref: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS hit FROM credits WHERE ref = ?').bind(ref).first<{ hit: number }>();
  return !!row;
}

export async function getBalance(env: Env, userId: number): Promise<number> {
  const row = await env.DB.prepare('SELECT quota FROM users WHERE id = ?').bind(userId).first<{ quota: number }>();
  return row?.quota ?? 0;
}

export interface Reconciliation {
  user_id: number;
  username: string;
  materialized: number;
  ledger_sum: number;
  drift: number;
}

/**
 * Compares the materialized balance against the ledger. A non-zero drift means
 * some write bypassed applyCredit() — that is the bug to hunt, not the number.
 *
 * Users created before the ledger existed have no entries and are skipped;
 * their opening balance is not a drift.
 */
export async function reconcile(env: Env): Promise<Reconciliation[]> {
  const rows = await env.DB.prepare(
    `SELECT u.id AS user_id, u.username, u.quota AS materialized, COALESCE(SUM(c.delta), 0) AS ledger_sum
     FROM users u
     JOIN credits c ON c.user_id = u.id
     GROUP BY u.id
     HAVING u.quota != COALESCE(SUM(c.delta), 0)`,
  ).all<Omit<Reconciliation, 'drift'>>();
  return (rows.results ?? []).map((r) => ({ ...r, drift: r.materialized - r.ledger_sum }));
}
