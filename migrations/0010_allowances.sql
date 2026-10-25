-- 订阅赠额（allowance）：和充值余额并存的第二个池子。
--
-- ## 为什么不能直接记成 users.quota
--
-- 充值余额永不过期，订阅赠额按会员周期失效。两者混在一个数里之后，「这个人还剩
-- 的钱里有多少会在下周一作废」就再也算不出来了——而那正是发放赠额的全部意义。
--
-- ## 失效靠时间条件，不靠任何写操作
--
-- 旧周期的行**永远原样留着**：不扣、不清零、不回收，也没有 cron 去动它。一行赠额
-- 有效当且仅当 `period_start <= now < period_end`，过期就是这个条件不再成立。
--
-- 这么做换来三件事：
--   1. 没有定时任务，也就没有「任务没跑」这种故障态；
--   2. 历史每一期发了多少、用了多少，原样留在表里可对账；
--   3. 「回收」这个动作根本不存在，也就不可能把一笔赠额回收两次。
--
-- ## consumed 是物化值，不是账本
--
-- credits 表是**充值余额**的账本，users.quota = SUM(credits.delta) 是 reconcile()
-- 的对账依据，赠额的收支绝不能写进去，否则那条恒等式当场失真。赠额自己的事实来源
-- 就是这张表：granted 不可变，consumed 单调增（结算退款时回落），可用额 =
-- granted - consumed。
--
-- 两个池子各有各的单一事实来源，互不污染。
CREATE TABLE IF NOT EXISTS allowances (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  -- 发放方。同一个人将来可能同时有多个来源的赠额，靠它区分。
  source       TEXT    NOT NULL DEFAULT 'legacy-subscription',
  period_start INTEGER NOT NULL,                 -- unix 秒，闭区间起
  period_end   INTEGER NOT NULL,                 -- unix 秒，开区间止
  granted      INTEGER NOT NULL,                 -- 本期发放的 quota，发出去就不再改
  consumed     INTEGER NOT NULL DEFAULT 0,       -- 已用掉的 quota
  created_at   INTEGER NOT NULL
);

-- 「同一个人、同一个来源、同一期只能有一行」由数据库保证。
-- 发放接口因此可以写成 INSERT ... ON CONFLICT DO NOTHING，不需要在代码里
-- 先查后插——那是 check-then-act，并发下拦不住重复发放。
CREATE UNIQUE INDEX IF NOT EXISTS idx_allowances_period
  ON allowances(user_id, source, period_start);

-- 取「这个人当前有效的那一期」用的索引。授权路径上每次都要查，必须走索引。
CREATE INDEX IF NOT EXISTS idx_allowances_active
  ON allowances(user_id, period_end);

-- 一个窗口的 authorized_quota 里，有多少是从赠额出的。
--
-- **结算和回收必须按原路退回**，所以这个拆分必须记在窗口行上，不能事后再推算：
-- 赠额开的窗口如果把退款退进 users.quota，等于把一笔会过期的钱洗成了永久余额。
-- 这是这套双池模型里最容易漏、也最贵的一个洞。
ALTER TABLE billing_windows ADD COLUMN allowance_id    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_windows ADD COLUMN allowance_quota INTEGER NOT NULL DEFAULT 0;
