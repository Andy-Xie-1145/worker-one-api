-- 修补扫描要按 window_id 反查 logs（「这个窗口的流水落了没有」），每行一次 NOT EXISTS，
-- 没有索引就是全表扫。LLM 的行 window_id 是 ''（0007 的 DEFAULT），部分索引把它们排除
-- 在外，索引只有语音行那么大。
--
-- CREATE INDEX IF NOT EXISTS 重跑安全，所以这个文件不像 0007 那样「预期会失败」。
CREATE INDEX IF NOT EXISTS idx_logs_window ON logs(window_id) WHERE window_id != '';
