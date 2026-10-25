-- 删除「分组」概念：个人网关只有一个 owner，模型可见性由令牌的 models 白名单控制，
-- (group, model) -> channel 的 group 维度是纯开销。abilities 重建为 (model, channel_id)。
--
-- channels."group" 与 users."group" 列保留为惰性遗留列（与 0004-0013 的处理一致），
-- 代码不再读写。
CREATE TABLE abilities_new (
  model      TEXT    NOT NULL,
  channel_id INTEGER NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 0,
  weight     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (model, channel_id)
);
INSERT INTO abilities_new (model, channel_id, enabled, priority, weight)
  SELECT model, channel_id, enabled, priority, weight FROM abilities;
DROP TABLE abilities;
ALTER TABLE abilities_new RENAME TO abilities;
CREATE INDEX IF NOT EXISTS idx_abilities_lookup ON abilities(model, enabled, priority);
