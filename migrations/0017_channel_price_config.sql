-- 渠道级价格：路由到这个渠道就按它的价（渠道 > 全局覆盖 > 内置表）。
-- 键是请求名（渠道 models 里声明的名字），形状 { "<请求名>": PriceSpec }。
-- Key 级价格（tokens.price_config）同批删除：令牌混用渠道且有 fallback，
-- 在 Key 上定价没有意义——线上唯一的存量（令牌 #1 的临时补丁）随列一起清掉。
ALTER TABLE channels ADD COLUMN price_config TEXT NOT NULL DEFAULT '';
ALTER TABLE tokens DROP COLUMN price_config;
