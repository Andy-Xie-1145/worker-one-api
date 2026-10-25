-- 每 Key 每模型的价格配置。
--
-- 形状（JSON 文本，'' = 无覆盖）：{ "<模型名>": PriceSpec }
--   固定价  {"in": 美元/1M输入, "out": 美元/1M输出, "cached_in"?: ...}
--   表达式  {"expr": "p * 3 + c * 15 + cr * 0.3"}
--
-- 查价优先级：Key 覆盖（本列）> 全局覆盖（options.ModelPriceOverride）
--            > 内置价格表（lib/pricing/llm.ts PRICE_TABLE）> 默认价。
-- 同一个 Key 的不同模型、同一个模型的不同 Key，都可以配出不同的价格。
ALTER TABLE tokens ADD COLUMN price_config TEXT NOT NULL DEFAULT '';
