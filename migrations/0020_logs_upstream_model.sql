-- 消费日志补「渠道实际服务的模型」（model_mapping 之后的名字，上游真正收到的）。
-- 请求名继续存 model_name；两者通常相同，model_mapping 重定向时不同——
-- 排障「到底哪个渠道的什么模型接的这单」需要这一列。
ALTER TABLE logs ADD COLUMN upstream_model TEXT NOT NULL DEFAULT '';
