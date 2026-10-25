-- one-api on Cloudflare Workers: D1 schema
-- Field names intentionally mirror upstream one-api's GORM models.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password      TEXT    NOT NULL,          -- pbkdf2$<iters>$<salt_b64>$<hash_b64>
  display_name  TEXT    NOT NULL DEFAULT '',
  role          INTEGER NOT NULL DEFAULT 1,  -- 1=user 10=admin 100=root
  status        INTEGER NOT NULL DEFAULT 1,  -- 1=enabled 2=disabled
  email         TEXT    NOT NULL DEFAULT '',
  quota         INTEGER NOT NULL DEFAULT 0,
  used_quota    INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  "group"       TEXT    NOT NULL DEFAULT 'default',
  aff_code      TEXT    NOT NULL DEFAULT '',
  inviter_id    INTEGER NOT NULL DEFAULT 0,
  created_time  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS tokens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  key             TEXT    NOT NULL UNIQUE,
  status          INTEGER NOT NULL DEFAULT 1,  -- 1=enabled 2=disabled 3=expired 4=exhausted
  name            TEXT    NOT NULL DEFAULT '',
  created_time    INTEGER NOT NULL DEFAULT 0,
  accessed_time   INTEGER NOT NULL DEFAULT 0,
  expired_time    INTEGER NOT NULL DEFAULT -1, -- -1 = never
  remain_quota    INTEGER NOT NULL DEFAULT 0,
  unlimited_quota INTEGER NOT NULL DEFAULT 0,
  used_quota      INTEGER NOT NULL DEFAULT 0,
  models          TEXT    NOT NULL DEFAULT ''  -- csv allowlist, '' = all
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

CREATE TABLE IF NOT EXISTS channels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL DEFAULT 'openai', -- adaptor key
  key           TEXT    NOT NULL DEFAULT '',
  status        INTEGER NOT NULL DEFAULT 1,  -- 1=enabled 2=manually disabled 3=auto disabled
  name          TEXT    NOT NULL DEFAULT '',
  weight        INTEGER NOT NULL DEFAULT 1,
  priority      INTEGER NOT NULL DEFAULT 0,
  created_time  INTEGER NOT NULL DEFAULT 0,
  test_time     INTEGER NOT NULL DEFAULT 0,
  response_time INTEGER NOT NULL DEFAULT 0,
  base_url      TEXT    NOT NULL DEFAULT '',
  balance       REAL    NOT NULL DEFAULT 0,
  models        TEXT    NOT NULL DEFAULT '',  -- csv
  "group"       TEXT    NOT NULL DEFAULT 'default', -- csv of groups
  used_quota    INTEGER NOT NULL DEFAULT 0,
  model_mapping TEXT    NOT NULL DEFAULT '',  -- json {"from":"to"}
  config        TEXT    NOT NULL DEFAULT '',  -- json, adaptor-specific
  system_prompt TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);

-- Denormalized (group, model) -> channel routing table, rebuilt on channel writes.
CREATE TABLE IF NOT EXISTS abilities (
  "group"    TEXT    NOT NULL,
  model      TEXT    NOT NULL,
  channel_id INTEGER NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 0,
  weight     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("group", model, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_abilities_lookup ON abilities("group", model, enabled, priority);

CREATE TABLE IF NOT EXISTS logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT 0,
  type              INTEGER NOT NULL DEFAULT 2, -- 1=topup 2=consume 3=manage 4=system
  content           TEXT    NOT NULL DEFAULT '',
  username          TEXT    NOT NULL DEFAULT '',
  token_name        TEXT    NOT NULL DEFAULT '',
  model_name        TEXT    NOT NULL DEFAULT '',
  quota             INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  channel_id        INTEGER NOT NULL DEFAULT 0,
  elapsed_ms        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id, created_at);

CREATE TABLE IF NOT EXISTS redemptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL DEFAULT 0,
  key           TEXT    NOT NULL UNIQUE,
  status        INTEGER NOT NULL DEFAULT 1, -- 1=unused 3=used 2=disabled
  name          TEXT    NOT NULL DEFAULT '',
  quota         INTEGER NOT NULL DEFAULT 0,
  created_time  INTEGER NOT NULL DEFAULT 0,
  redeemed_time INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS options (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
