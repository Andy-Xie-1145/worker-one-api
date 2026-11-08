-- 令牌级渠道访问控制（白/黑名单，互斥；两模式结构上不可能同时存在）。
-- 空串 = 不限制（所有启用渠道按优先级/权重参与选路）。
-- JSON 形态：{"mode":"whitelist","channels":[1,2]} 或 {"mode":"blacklist","channels":[3]}
-- 语义（lib/channel.ts parseTokenAcl / selectChannel）：
--   whitelist：只允许 channels 内的渠道；channels 为空 = 禁止任何渠道（等价禁用）
--   blacklist：禁止 channels 内的渠道；channels 为空 = 允许所有渠道
ALTER TABLE tokens ADD COLUMN channel_acl TEXT NOT NULL DEFAULT '';
