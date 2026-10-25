-- 流式计费的授权窗口。
--
-- 一条窗口 = 一次「你最多可以再用 N 秒音频 / N 个字符」的授权。授权那一刻钱就已经
-- 从 users.quota 扣走了（走 applyCredit 的守门语句），所以**可授权余额恒等于
-- users.quota 本身**——不需要另算「余额减去所有未结算授权」，也就不存在算错的可能。
-- 两个流抢最后一块钱，由那条守门 UPDATE 仲裁，和 LLM 的预扣走的是同一条路。
--
-- 没有 remaining_authorized_quota 这一列。钱已经离开 users.quota 了，再维护一个
-- 可变的「剩余」计数器就是 wallet.ts 开头警告的第二处可变状态：它和余额会各自漂，
-- 漂了之后没有任何依据判断哪边才对。窗口只需要两个不可变的数——授权了多少、
-- 最后用了多少。
CREATE TABLE IF NOT EXISTS billing_windows (
  id                TEXT    PRIMARY KEY,               -- win_<uuid>，由服务端生成
  user_id           INTEGER NOT NULL DEFAULT 0,
  session_id        TEXT    NOT NULL DEFAULT '',       -- 业务侧的流标识，仅供排查
  service           TEXT    NOT NULL DEFAULT '',       -- llm | asr | tts
  provider          TEXT    NOT NULL DEFAULT '',       -- azure | clone | deepseek …
  model             TEXT    NOT NULL DEFAULT '',
  unit              TEXT    NOT NULL DEFAULT '',       -- audio_second | character | …
  -- 成交那一刻冻结的计价参数。改价格不影响已经开出去的窗口，历史账也还原得回来。
  quota_per_unit_e6 INTEGER NOT NULL DEFAULT 0,        -- 每单位多少 quota × 1e6（含分组折扣）
  unit_price_e9     INTEGER NOT NULL DEFAULT 0,        -- 每单位多少美元 × 1e9（人看的口径）
  pricing_version   TEXT    NOT NULL DEFAULT '',
  authorized_quota  INTEGER NOT NULL DEFAULT 0,        -- 已经从 users.quota 扣掉的数
  limit_milli       INTEGER NOT NULL DEFAULT 0,        -- 换算成原始单位的上限 × 1000
  charged_quota     INTEGER NOT NULL DEFAULT 0,        -- 结算时真正收的钱
  raw_usage_milli   INTEGER NOT NULL DEFAULT 0,        -- 结算时上报的真实用量 × 1000
  -- active → settled（正常结算）或 expired（回收器收走）。状态推进用条件 UPDATE
  -- 做 CAS，它是本方案里**唯一的**序列化器：credits.ref 是 check-then-act，
  -- 并发下拦不住重复，只能当审计线索用。
  status            TEXT    NOT NULL DEFAULT 'active',
  prev_window_id    TEXT    NOT NULL DEFAULT '',       -- settle_and_authorize 的前驱，用于重试时找回后继
  idempotency_key   TEXT    NOT NULL DEFAULT '',
  expires_at        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT 0,
  settled_at        INTEGER NOT NULL DEFAULT 0
);

-- 回收器每几分钟扫一次「过期但还 active」的窗口，这条部分索引让它只读到候选行。
CREATE INDEX IF NOT EXISTS idx_windows_reclaim ON billing_windows(expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_windows_user    ON billing_windows(user_id, created_at);
-- 一个前驱只能有一个后继。重试 settle_and_authorize 时靠它保证不会开出第二个窗口。
CREATE UNIQUE INDEX IF NOT EXISTS idx_windows_prev ON billing_windows(prev_window_id) WHERE prev_window_id != '';
-- 修补扫描：CAS 成功之后、applyCredit 之前崩溃的窗口，事后补回那笔钱。
CREATE INDEX IF NOT EXISTS idx_windows_repair  ON billing_windows(settled_at) WHERE status IN ('settled', 'expired');
