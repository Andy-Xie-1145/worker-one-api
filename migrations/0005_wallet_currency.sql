-- 多币种钱包。
--
-- 一次充值就是账本里的一条正数行，所以币种不需要另建一张表——给 credits 加三列
-- 就够了。余额按币种拆分是这些行的**纯函数**（见 src/lib/wallet.ts 的 allocateFifo），
-- 不引入第二处可变状态，也就不会和 users.quota 漂移。
--
-- 消费仍然只扣 users.quota 这一个数，守门语句一个字不改。币种只在**读**的时候
-- 才参与计算：把消费总额按先充先用摊到各条充值行上，剩下的就是各币种的余额。

-- 'CNY' | 'USD'。历史行全是走 /internal/grant 的 usd/quota 入参进来的，是美元。
ALTER TABLE credits ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';

-- 充值当刻冻结的汇率（1 USD = rate_e4 / 10000 该币种），USD 行恒为 10000。
--
-- **冻结而不是每次重算**：用户充的 ¥100 换到多少 quota 是成交那一刻定下的，
-- 汇率之后怎么动都不该改变他已经买到的东西。也让"余额折回原币显示"有唯一答案。
ALTER TABLE credits ADD COLUMN rate_e4 INTEGER NOT NULL DEFAULT 10000;

-- 原币金额（分 / cent），带符号，仅供展示与对账。quota 仍是唯一的消费单位。
-- 0 = 这一行没有原币金额可言（消费行、以及本次迁移之前的历史充值行）。
ALTER TABLE credits ADD COLUMN amount_minor INTEGER NOT NULL DEFAULT 0;

-- 按币种拆余额要顺序扫某个用户的全部充值行，这条索引让它只读到正数行。
CREATE INDEX IF NOT EXISTS idx_credits_lots ON credits(user_id, id) WHERE delta > 0;
