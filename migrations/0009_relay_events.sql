-- 中继失败事件。
--
-- 成功路径**不写这里**：postConsume 已经往 logs 写了 type=2 的成功行，带
-- channel_id / model_name / elapsed_ms。健康度 = logs(成功) ∪ relay_events(失败)，
-- 快乐路径因此一次额外写入都没有。
--
-- 为什么不塞进 logs 换一个 type：
--   1. logs 是账务记录，永远不能删；失败事件是运维数据，14 天就该清掉。同一张表
--      装两种保留期，最后要么账单被误删，要么错误行永久堆积。
--   2. 失败要记的维度（stage/attempt/group_name/上游报文）logs 一列都没有，塞进
--      content 里就等于没法按维度聚合。
--
-- 这张表存在的直接原因：字幕客户端选 Gemini 翻不出字幕，93 个真实响应里 67 个 503，
-- 而 relay.ts 那句「没有可用于模型 Y 的渠道」里的 Y 从来没被记下来过。
CREATE TABLE IF NOT EXISTS relay_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     INTEGER NOT NULL DEFAULT 0,   -- unix 秒，与 logs 一致
  outcome        TEXT    NOT NULL DEFAULT 'error',
  -- no_channel | build | network | upstream | stream | quota
  stage          TEXT    NOT NULL DEFAULT 'upstream',
  model_name     TEXT    NOT NULL DEFAULT '',  -- 客户端请求的模型串
  upstream_model TEXT    NOT NULL DEFAULT '',  -- model_mapping 之后的
  group_name     TEXT    NOT NULL DEFAULT '',
  channel_id     INTEGER NOT NULL DEFAULT 0,   -- 0 = 根本没选到渠道
  channel_type   TEXT    NOT NULL DEFAULT '',
  status         INTEGER NOT NULL DEFAULT 0,
  attempt        INTEGER NOT NULL DEFAULT 0,
  final          INTEGER NOT NULL DEFAULT 0,   -- 1 = 这条就是返回给用户的那次失败
  elapsed_ms     INTEGER NOT NULL DEFAULT 0,
  user_id        INTEGER NOT NULL DEFAULT 0,
  error_code     TEXT    NOT NULL DEFAULT '',
  error_text     TEXT    NOT NULL DEFAULT ''   -- 上游报文，脱敏后截断 300 字
);

CREATE INDEX IF NOT EXISTS idx_relay_events_created ON relay_events(created_at);
CREATE INDEX IF NOT EXISTS idx_relay_events_model   ON relay_events(model_name, created_at);
CREATE INDEX IF NOT EXISTS idx_relay_events_channel ON relay_events(channel_id, created_at);
