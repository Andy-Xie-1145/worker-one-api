-- Balances that predate the ledger were written straight into users.quota, so
-- reconciliation would report their whole opening balance as drift forever. A
-- monitoring signal that is never green gets ignored, which defeats the point.
--
-- Record one opening entry per user for exactly the unexplained amount. Users
-- already fully explained by the ledger get nothing (the WHERE filters them).

INSERT INTO credits (user_id, delta, reason, ref, balance_after, created_at)
SELECT
  u.id,
  u.quota - COALESCE((SELECT SUM(c.delta) FROM credits c WHERE c.user_id = u.id), 0),
  'adjust',
  'opening:' || u.id,
  u.quota,
  COALESCE(NULLIF(u.created_time, 0), unixepoch())
FROM users u
WHERE u.quota - COALESCE((SELECT SUM(c.delta) FROM credits c WHERE c.user_id = u.id), 0) != 0
  AND NOT EXISTS (SELECT 1 FROM credits c2 WHERE c2.ref = 'opening:' || u.id);
