-- 回收器扫「有 pre: 没有 fin:」的悬空预扣（lib/watchdog.ts 的
-- reclaimAbandonedReservations）。没有这条索引，那个查询要按 created_at 全表扫，
-- 而 credits 是只增不减的账本，扫描代价会随时间线性变长。
--
-- 部分索引：只有中继预扣这一种 ref 需要被扫，其余账本行（充值、窗口结算、赠额）
-- 一条都不进这个索引。
CREATE INDEX IF NOT EXISTS idx_credits_pending
  ON credits(created_at)
  WHERE reason = 'consume' AND ref LIKE 'pre:%';
