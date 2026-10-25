-- SQLite 没有 ADD COLUMN IF NOT EXISTS，而 db:migrate 每次重跑所有文件，所以这条
-- 语句在重跑时**预期会失败**。整个文件只放这一条语句，失败就连累不到别人
-- （0004 / 0005 是同样的形状，只是它们后面还跟了 CREATE INDEX，重跑时会被跳过）。
--
-- 语音结算写的是一条普通的 logs 行（type=2），现有后台和 /internal/usage 立刻就能
-- 看到它。机器可读的审计字段留在 billing_windows，靠这一列 join 回去——给 logs 加
-- 八个对 LLM 行毫无意义的列是错的形状。
ALTER TABLE logs ADD COLUMN window_id TEXT NOT NULL DEFAULT '';
