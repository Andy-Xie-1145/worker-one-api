-- 等值查找用的完整索引，降 D1 Rows Read。验证见 test/query-plan.test.ts。
--
-- idx_credits_ref（0002）是 `WHERE ref != ''` 的部分唯一索引，它的职责是**防重**，
-- 保持不动。但 SQLite 只有在查询条件能证明 `ref != ''` 时才会用部分索引，而
-- `WHERE ref = ?`（ledger.ts 的 isDuplicate / CREDIT_LANDED 门控）、
-- `f.ref = 'fin:' || substr(...)`（watchdog 的回收器）、repairSettlements 的三处
-- NOT EXISTS 都证明不了——于是每一次都是 SCAN credits，整本账从头读到尾。
-- 这条普通索引专门给查找用，唯一性仍然由 idx_credits_ref 负责。
CREATE INDEX IF NOT EXISTS idx_credits_ref_lookup ON credits(ref);

-- 孤儿授权扫描按 idempotency_key 反查窗口（每个候选行一次 NOT EXISTS），授权入口的
-- 幂等重放也按它查。之前两处都是 SCAN billing_windows。
CREATE INDEX IF NOT EXISTS idx_windows_idempotency ON billing_windows(idempotency_key);

-- 孤儿授权扫描的外层：`ref LIKE 'auth:%'` 用不上 ref 上的 B-tree（LIKE 大小写不敏感），
-- 没有这条就是每 5 分钟一次全账本扫描。和 0012 的 idx_credits_pending 同一个形状：
-- 部分索引只收授权扣款那一类行。
CREATE INDEX IF NOT EXISTS idx_credits_auth
  ON credits(created_at)
  WHERE ref LIKE 'auth:%';
