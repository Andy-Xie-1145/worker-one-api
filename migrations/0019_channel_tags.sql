-- 渠道标签（多值，JSON 字符串数组），替代旧单值 "group" 作为令牌渠道 ACL 的组匹配键。
-- 每渠道 0..n 个标签；迁移：非默认的旧分组值迁为首标签，''/'default' 不迁（无标签）。
-- "group" 列保留为惰性遗留列（0015 同款处理），代码不再读写。
ALTER TABLE channels ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
UPDATE channels SET tags = JSON_ARRAY("group") WHERE "group" IS NOT NULL AND "group" NOT IN ('', 'default');
