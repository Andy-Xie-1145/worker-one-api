-- logs.billing_meta：结算明细的 JSON 快照（价格版本、缓存命中/写入分桶、费率来源）。
--
-- 为什么不加一列列的标量：计费明细的形状还在演化（v2 按字段费率、缓存写 TTL 分桶、
-- 表达式 trace），JSON 一列不用跟着改表；而「模型计费」页要的聚合维度（模型、渠道、
-- 时间）本来就都是独立列。旧行/解析失败的行按「未知」处理，绝不当成 0。
ALTER TABLE logs ADD COLUMN billing_meta TEXT;
