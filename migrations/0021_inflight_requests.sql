-- 活跃请求登记表：请求通过鉴权进入中继即写一行，响应完全送达（流关闭/失败返回）后删除。
--
-- 为什么需要它：本网关的 logs 只在结算时落库、relay_events 只记失败——「正在跑」的请求
-- 不留任何行。客户端-网关一段被掐断时整个 Worker 调用被运行时拆掉，连 cancel() 都没机会
-- 跑（watchdog.ts 注释里实测过：12 次尝试零痕迹）。这张表让「此刻有哪些请求、在哪个阶段」
-- 变成一条 SELECT 能回答的问题。
--
-- 运行时强拆时删除不会执行，行会悬挂；读取端（GET /api/inflight）按 started_at 懒回收，
-- 不依赖 cron（新部署没有 scheduled 入口）。
CREATE TABLE IF NOT EXISTS inflight_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   TEXT NOT NULL UNIQUE,
  token_id     INTEGER,
  token_name   TEXT,
  user_id      INTEGER,
  username     TEXT,
  model_name   TEXT,
  protocol     TEXT,
  stream       INTEGER NOT NULL DEFAULT 0,
  phase        TEXT NOT NULL DEFAULT 'route',
  channel_id   INTEGER,
  channel_name TEXT,
  started_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inflight_started ON inflight_requests(started_at);
