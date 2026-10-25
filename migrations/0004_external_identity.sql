-- Links a gateway account to the identities that already exist elsewhere.
-- Legacy platform-integration columns (inert since the personal edition):
-- auth_user_id was the cross-product identity key (one person = one account,
-- one balance); platform_user_id is a secondary index kept for historical
-- key formats already in circulation.

ALTER TABLE users ADD COLUMN auth_user_id     TEXT    NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN platform_user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN plan_slug        TEXT    NOT NULL DEFAULT '';

-- Partial uniqueness: the defaults mean "unlinked", and many rows may be
-- unlinked, but a real id must map to exactly one account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_user_id ON users(auth_user_id) WHERE auth_user_id != '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_platform_user_id ON users(platform_user_id) WHERE platform_user_id != 0;
