-- Append-only ledger. `users.quota` is the materialized SUM(delta) kept for
-- speed; this table is the audit trail and the reconciliation source.

CREATE TABLE IF NOT EXISTS credits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  delta         INTEGER NOT NULL,            -- quota units, 500000 == $1, signed
  reason        TEXT    NOT NULL,            -- trial|grant|purchase|consume|refund|budget|adjust
  ref           TEXT    NOT NULL DEFAULT '', -- idempotency key / order no / log id
  balance_after INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credits_user ON credits(user_id, created_at);

-- One entry per source. Consume entries carry no natural key and pass '',
-- which the partial index deliberately excludes from deduplication.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credits_ref ON credits(ref) WHERE ref != '';
