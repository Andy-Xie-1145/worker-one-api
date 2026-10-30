# one-api on Cloudflare Workers · 个人版

一个受 [songquanpeng/one-api](https://github.com/songquanpeng/one-api) 语义启发、用 TypeScript 重写的
LLM API 中转网关，完整运行在 Cloudflare Workers 上，**不依赖任何单节点服务器**。

定位：**把个人分散在各平台的 API 整合为一个平台，方便统一调度**——所有渠道进一个池子，
所有客户端（Claude Code / ChatBox / 任意 OpenAI、Anthropic、Gemini SDK）走同一个入口，
按 Key 精细定价与限额，用量与健康度一目了然。

设计取向：
删去了全部倍率、注册登录、多用户体系和平台对接面，改为一把管理员令牌管理的
**个人 API 聚合**，并把内置价格表外显成可配置的「Key × 模型」价格矩阵，
支持 new-api 风格的表达式动态计费。

## 相比前代改造了什么

| 项 | 改造 |
|---|---|
| 倍率 | **全部删除**：分组倍率、时段折扣（DeepSeek 峰谷）等一律不存在。计费 = 用量 × 价格表，没有第二个因子 |
| 注册登录 | **删除**：`/api/setup`、`/api/auth/*`、用户管理、兑换码全部移除。唯一的管理凭据是 `ADMIN_KEY`（见下） |
| 账户 | 唯一的 `owner` 账户在第一次使用时自动创建，预存 $10,000 预算（只是刻度尺，可随时调整） |
| 价格 | 内置价格表外显（`GET /api/pricing`、`GET /v1/pricing`）；全局覆盖可配；**每个 Key 的每个模型**还可以再单独覆盖；支持表达式动态计费 |
| 平台生态 | **删除**：`/internal/*`（外部平台开户/发额度/订阅赠额）、`/internal/billing`（语音授权窗口）、平台 JWT 登录路径、多币种钱包全部移除 |

保留完整：多渠道路由与重试、403 软熔断、429 冷却、流式计费、账本（`credits`）与对账、
悬空预扣回收、路由缺口告警、OpenAI/Anthropic 双协议、Decisions API。

## 能力

- **OpenAI 兼容中转**：`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/models`，支持流式
- **Anthropic 原生端点**：`/api/anthropic/v1/messages`，真流式，可由任意渠道（含 OpenAI 形状的）承载
- **价格外显**：`/v1/pricing` 按 Key 返回生效价格，`/api/pricing` 给管理端全量视图
- **决策接口**：`/v1/decisions`（OpenRouter Decisions API / Jev），复用同一套选路与计费
- **用量查询**：`/v1/usage`，金额口径
- **多渠道路由**：按 `(分组, 模型)` 索引选路，优先级分层 + 层内加权随机，失败自动重试下一个渠道
- **额度计费**：请求前按 prompt 体量预扣，结束后按真实 usage 结算（含流式中断/客户端断开）
- **账本**：余额的每一次变动都是一条 `credits` 记录，`users.quota` 只是 `SUM(delta)` 的物化值，可随时对账
- **管理后台**：单页应用（令牌 / 渠道 / 价格 / 健康 / 日志 / 设置），解锁式输入管理员令牌

### 渠道类型

| type | 说明 |
|---|---|
| `openai` | **OpenAI Chat Completion**：通用 OpenAI 兼容接口，配 base_url 即可接入 DeepSeek、Moonshot、Groq、智谱、DashScope、SiliconFlow、OpenRouter、xAI 等 |
| `openai-responses` | **OpenAI Responses**：打上游的 `/v1/responses`；中枢 chat 形状会自动翻译过去（system→instructions、tool_calls→function_call item、max_tokens→max_output_tokens） |
| `anthropic` | **Anthropic Messages**：Anthropic 原生 Messages API，双向转换（含 tool_use / 图片 / system） |
| `gemini` | **Google Gemini**：generateContent，双向转换（含 functionCall / inlineData） |
| `azure` | **Azure OpenAI**：deployment URL + `api-key` 头 |

**协议翻译器**：四种入站方言 × 五种上游方言自由组合——

| 入站端点 | 客户端方言 | 鉴权头 |
|---|---|---|
| `/v1/chat/completions` 等 | OpenAI Chat | `Authorization: Bearer` |
| `/v1/responses` | OpenAI Responses | `Authorization: Bearer` |
| `/api/anthropic/v1/messages` | Anthropic Messages | `x-api-key` |
| `/gemini/v1beta/models/{model}:generateContent`（及 `:streamGenerateContent?alt=sse`） | Google Gemini | `x-goog-api-key` |

所有方言都翻译成中枢 chat 形状去选路、计费、重试，再把响应翻回客户端的方言——
**用任何一种 API 都能调用站内所有模型，无论上游是什么 API**。工具调用跨方言无损搬运
（`tool_calls`/`function_call`/`tool_use` 互译，流式参数增量逐块翻译）。两个边界：
Responses 的 `previous_response_id` 无法被无状态网关服务，直接 400（`store` 只控制留档，
网关从不留档，忽略之）；Gemini 流式仅支持 `alt=sse`（官方 SDK 默认走法）。

**Z.AI / GLM**：用 `openai` 类型 + base_url `https://api.z.ai/api/coding/paas/v4`。
价格表会自动剥掉 `zai/`、`zai-coding-plan/` 等前缀匹配到裸名。

## 架构

```
客户端 ──sk-xxx──> Worker
                    │
                    ├─ /v1/*              relay：鉴权 → 选路 → 适配器 → 流式透传 → 计费
                    │                     （入站方言：Chat / Responses / Anthropic / Gemini）
                    ├─ /api/*             管理 API（Authorization: Bearer ADMIN_KEY）+ 内置 CLI
                    ├─ /api/status/*      公开状态页（免鉴权，只有引擎名与状态枚举）
                    └─ /*                 Workers Assets 托管的管理后台 SPA
                    │
                    ├─ D1  users(仅 owner) / tokens / channels / abilities(model→channel) / logs / credits / options
                    └─ KV  令牌鉴权缓存、系统配置缓存（TTL 60s）
```

`abilities` 是 `model -> channel` 的反范式索引，选路只需一次带索引的查询。
没有分组：个人网关只有一个 owner，模型可见性由令牌的 models 白名单控制。

## 管理面：一个令牌，没有账号

- 凭据 = `wrangler.jsonc` 里 `vars.ADMIN_KEY` 的长随机令牌（**硬编码**，个人仓库自用；
  泄露就换一个再部署）。除 `GET /api/status`（公开）外，所有 `/api/*` 都要求
  `Authorization: Bearer <ADMIN_KEY>`，比较走 constant-time。
- 浏览器打开站点 → 输入一次令牌（存 `localStorage`）→ 之后每个请求自动带上；
  任意 401 会清掉存储回到解锁页。
- 唯一账户 `owner` 在第一次令牌鉴权时懒创建（username `owner`，走账本预存
  $10,000 预算）；后台「总览」页可以随时调整预算。**没有第二个账户，没有注册。**

## 内置命令行

管理面内置一个命令解释器：后台「终端」页直接敲命令；同样的命令也可以在真终端里用：

```bash
curl -X POST https://你的站点/api/cli \
  -H "Authorization: Bearer <管理令牌>" -H "Content-Type: application/json" \
  -d '{"command":"channel list"}'
```

命令与 REST 完全等价（同一套库函数，不存在两套行为）。规则：命令 = 子命令空格分隔，
参数用 `key=value`，开关用 `--flag value`；带空格的值用引号包裹（`expr="p * 3"`）；
JSON 参数原样内联（`--price {"模型":{"in":1}}`）。终端里输入 `help` / `help <分组>` 看同款说明。

### 命令总览

```text
# 概览与运维
status                    站点概览（余额 / 渠道数 / 模型数）
models                    列出全部可用模型
owner [show]              查看余额；owner add <美元> / owner sub <美元> 调整预算
logs [n]                  最近 n 条日志（默认 10）
health                    近 1 小时各渠道成败
reconcile                 账本对账（有无绕过账本的写入）
watchdog [run]            查看自检心跳 / 立即跑一次自检

# 渠道（类型：openai | openai-responses | anthropic | gemini | azure）
channel list                                        渠道列表
channel add <类型> <名称> <base_url> <key> --models m1,m2 [--priority N] [--weight N]
channel set <id> name=... type=... base_url=... key=... models=a,b priority=N weight=N status=1
                                                    按字段修改（改 models 自动重建路由索引）
channel show <id>                                   详情（密钥打码）
channel on <id> / off <id> / del <id>               启用 / 停用 / 删除

# 令牌
token list                                          令牌列表
token new <名称> [--usd N | --unlimited] [--models a,b] [--price JSON]
token set <id> name=... models=a,b usd=N unlimited=1|0 status=1|2 expired=<unix>
                                                    按字段修改（价格用 token price）
token key <id>                                      显示完整密钥
token on <id> / off <id> / del <id>                 启用 / 停用 / 删除
token price <id> [JSON | --clear]                   该 Key 的按模型价格（JSON 同全局覆盖形状）

# 价格（美元 / 1M tokens；四级优先：Key 覆盖 > 全局覆盖 > 内置表 > 默认价）
price list [过滤]                价格表（标注来源：内置 / 覆盖）
price get <模型>                 查一个模型的生效价
price set <模型> in=X out=Y [cached=Z]              固定价覆盖
price set <模型> expr="p * 3 + c * 15"              表达式覆盖
price rm <模型>                  清除覆盖，回到内置价
price default in=X out=Y         未知模型的兜底价
price aliases                    别名前缀列表

# 系统设置
opt list                         全部配置项与当前值
opt set RetryTimes=3 SystemName=我的网关            修改配置（JSON 值直接写）
```

例：

```text
channel add openai deepseek https://api.deepseek.com sk-ds-xxx --models deepseek-v4-flash,deepseek-v4-pro
price set deepseek-v4-pro in=1.32 out=3.96 cached=0.044
price set my-model expr="len <= 128000 ? fixed(0.002) : fixed(0.004)"
token new 笔记本 --unlimited
token price 2 {"gpt-4o":{"in":1,"out":2}}
```

## 计费：价格表 × 用量，没有倍率

```
quota = ceil( (fresh × 输入价 + 命中缓存 × 缓存价 + 写缓存5m × 写5m价 + 写缓存1h × 写1h价 + completion × 输出价)
              / 1e6 × 500000 )
fresh = prompt − 缓存命中 − 写缓存5m − 写缓存1h
```

- `500000 quota == $1`。价格单位一律是**美元 / 百万 tokens**。
- **没有任何倍率**：没有分组倍率、没有时段折扣、没有补全倍率。同一个模型对任何人、
  任何时候都只有一个价（除非你给它配了字段费率表达式，那也是表达式说了算）。
- **缓存命中计价**：DeepSeek 的 `prompt_cache_hit_tokens`、OpenAI 的
  `prompt_tokens_details.cached_tokens`、Anthropic 的 `cache_read_input_tokens` 都按
  `cached_in` 计价；未配 `cached_in` 的模型按输入价计，宁可高估不会低估。
- **缓存写入计价**（Anthropic 官方口径：5m TTL = 1.25× 输入价、1h TTL = 2×）：
  `cache_creation.ephemeral_5m/1h_input_tokens` 分桶按 `cache_write_5m` / `cache_write_1h`
  计价；只报总数时归入 5m 桶；未配置的模型按输入价计。OpenAI/Gemini 无写缓存概念。
- **严格计费开关 = 兜底价**：价格页清空默认价（存 `null`）即启用——查不到价的请求
  直接 503 `model_price_not_configured`（不调上游、不预扣）；设置兜底价则按它记账
  （默认 $1/$3）。后台新增「模型计费」页：每个模型按哪个价计、近 7 天用量、
  缓存命中率、有没有漏配价，一眼看完；总览与健康页有未定价警告横幅。

### 价格的四级优先

同一个 `(Key, 模型)` 格子的价格，按顺序取第一个命中的：

1. **Key 覆盖** —— `tokens.price_config`（JSON：`{ "模型名": PriceSpec }`），
   在后台「令牌」对话框里编辑；不同 Key 配不同价，就是在这里
2. **全局覆盖** —— `options.ModelPriceOverride`，后台「价格」页编辑
   （`PUT /api/pricing/overrides`，整包替换，逐条校验）
3. **内置价格表** —— `src/lib/pricing/llm.ts` 的 `PRICE_TABLE`，最长前缀匹配
   （`gpt-4o-mini-2024-07-18` 命中 `gpt-4o-mini`；`zai-coding-plan/glm-4.7` 剥前缀命中 `glm-4.7`）
4. **默认价** —— $1 / $3（严格计费下不生效；价格页可改/可清除）

`PriceSpec` 的**每个字段**（`in` / `out` / `cached_in` / `cache_write_5m` / `cache_write_1h`）
独立地是数字常量或费率表达式：

```jsonc
{ "in": 1.32, "out": 3.96, "cached_in": 0.044 }                      // 常量，美元/1M tokens
{ "in": "4 * (context > 272k ? 2 : 1)", "out": 20 }                  // 字段费率表达式，见下
```

### 表达式计费语言（v2：按字段的绝对费率）

字段表达式的求值结果 = **该字段本次请求的 USD / 1M tokens 费率**；token 数由计费引擎
按字段套用，表达式永远不碰 token 数。手写 lexer + parser + AST 解释器
（Cloudflare Workers 禁 eval/new Function），设计参考
[new-api 的 billingexpr](https://github.com/QuantumNous/new-api)
（`pkg/billingexpr/`）的函数面，语义按字段费率重新设计（v1 的整笔 `{expr}` 总价写法已移除）。

- **变量**：`context`（别名 `len`，完整输入 token 数，阶梯条件用它）、`n`（请求级数量，默认 1）。
- **请求探针**：`param("路径")`（点路径读请求体）、`header("名")`（读请求头）——
  缺失为 `null`：`==` 比较为 false、`has(null, ·)` 为 false，算术作用于 null 才报错；
  `has(s, 子串)` 判子串。
- **函数**：`min` `max` `abs` `ceil` `floor`、`tier("档名", 值)`（原样返回值并把档名
  记进消费日志）、`hour/minute/weekday/day/month("时区")`（IANA 时区，可省略默认 UTC，
  非法回退 UTC；`weekday` 0=周日）。
- **运算符**：`+ - * / %`（`/` 永远浮点）、比较 `> >= < <= == !=`、`&& || !`（严格布尔）、
  三目 `?:`（短路，走不到的分支不产生 tier 副作用）、括号、数字字面量支持 **k/m 后缀**
  （`272k` = 272000，`1.5m` = 1_500_000）。
- **求值时机**：每个请求在「选中渠道后、发上游前」求值一次并连同计费身份钉在预扣上，
  结算复用同一份；求值失败该渠道跳过（relay_events 可见），全部渠道跳过且无兜底价
  → 503 `model_price_not_configured`。
- **保存时校验**：逐字段编译 + 冒烟（context ∈ {0, 1k, 100k, 272k, 300k, 5m} × 探针缺失 ×
  三个时刻，费率必须有限非负），坏配置在保存那一刻就被拦下。

例子：

```jsonc
// GPT-6 长上下文档位（>272K 输入整笔翻倍）
{ "in": "4 * (context > 272k ? 2 : 1)", "out": "20 * (context > 272k ? 1.5 : 1)" }

// DeepSeek 谷时半价（北京时间 1-5 点）
{ "in": "0.3 * (hour('Asia/Shanghai') >= 1 && hour('Asia/Shanghai') < 5 ? 0.5 : 1)" }

// 请求头开关的倍率（fast-mode 档）
{ "out": "has(header('anthropic-beta'), 'fast-mode') ? 30 : 20" }
```

### 渠道运维三件套

- **测试选模型**：渠道页点「测试」弹窗选择该渠道 models 里的一个模型再测
  （显式传的 model 必须 ∈ 渠道 models——测试带渠道 key 直连上游，不能变成
  「拿这把 key 调任意模型」的后门）。
- **从上游拉取模型**：新增/编辑渠道时用 key 请求上游 `/models`（5 种渠道类型各自的
  端点与鉴权头，Gemini 分页取全并剥 `models/` 前缀，Azure 取 deployment 名），
  复选后追加合并进模型列表；编辑已有渠道可走库存 key，key 不回传前端。
- **模型计费页**：`GET /api/model-billing`，见上。

### 价格外显

- `GET /api/pricing`（管理员）：内置表全文、默认价、全局覆盖现状、别名前缀表。
- `GET /v1/pricing`（任意 sk- Key）：**这把 Key** 调用时的生效价格，每条带 `source`
  （`key` / `global` / `builtin` / `default`）。客户端可以在调用前算出成本。
- `GET /api/model-billing`（管理员）：模型计费页数据（声明模型全集 × 价格解析 × 近 7 天用量）。
- `npm run audit:llm-billing`：部署前的只读审计——列出启用渠道上未定价的 (渠道, 模型)
  组合；严格计费下不为空则以非零退出。`python scripts/d1_guard.py check`：部署前核对
  本地迁移文件与远端 `d1_migrations` 历史一致（fail-closed）。

### 403 的处理：模型/区域级软熔断 + 换渠道，不是渠道故障

403 的含义几乎总是「**这个渠道不让你（这个机房、这个模型）这么调**」，而不是渠道坏了。
所以：401（key 确认失效）仍是唯一触发渠道自动禁用的状态码；403 不动 `channels.status`，
本次请求换渠道继续（**不占重试配额**），并写入一条 30 分钟的 KV 软熔断
（`channel + model + colo` 粒度，`lib/deny403.ts`）。候选全部命中**仍有效**的熔断时，
0 fetch 直接 403（复用缓存的上游文案）；恢复探测只发生在熔断自然过期之后。
其余 4xx 立即结束，408/5xx 照旧重试，429 走渠道级冷却（`lib/cooldown.ts`）。

### 路由缺口告警：企业微信群机器人

请求指向当前分组下没有可用渠道的模型（客户端收到 503）时，`src/lib/route-alert.ts`
把告警推到企业微信群机器人：挂在 `waitUntil` 上不拖慢请求；同一 model + group 默认
30 分钟冷却；恢复由 `*/5` 清扫 cron 检查并发「已修复」。配置：

```bash
npx wrangler secret put WECOM_HEALTH_WEBHOOK_URL   # 群机器人完整 URL（含 ?key=）
```

不配时整个功能静默关闭。

## 双协议

同一套路由、计费、重试机制同时对外提供两种协议，只在边缘做转换：

| 入口 | 协议 | 鉴权头 |
|---|---|---|
| `/v1/*` | OpenAI | `Authorization: Bearer` |
| `/api/anthropic/v1/messages` | Anthropic Messages | `x-api-key`（也接受 `Authorization`） |

Anthropic 请求进来先转成内部的 OpenAI 形状用于选路和计费，响应再转回去。
OpenAI 兼容的推理模型把思维链放在 `delta.reasoning_content`，会映射成 Anthropic 的
`thinking` 块；OpenAI 形状的上游只在流末给 usage，所以 `message_start` 里的
`input_tokens` 只能是 0，真实值在 `message_delta` 的 usage 里给出。

## 决策接口：Jev / OpenRouter Decisions

Typesafe 的 Jev 走的不是 chat/completions，而是 Decisions API。本网关开在
`POST /v1/decisions`：请求体 `{model, state, questions}`，响应原样返回上游 JSON。
网关不做 schema 校验，`state` / `questions` 一律原样透传；唯一的例外是 `stream`：
Decisions 不是流式接口，带 `stream: true` 会在预扣之前直接 400。

鉴权、令牌模型权限、预扣、`selectChannel` 选路、429 冷却、`RetryTimes` 重试、
结算/退款、`relay_events` 全部复用 `handleRelay`。计价上 Jev 是 $0.042/1M 输入、
输出免费（内置表 `jev` 行）；预扣/结算按 `state`/`questions` 估算 token，不会按 0 结算。

### 能力分诊

规则集中在 `src/lib/capability.ts` 一处：`GET /v1/models` 默认只列 chat 模型
（`?capability=decisions` 才返回决策模型）；decision-only 模型走 chat/completions 400、
普通模型走 `/v1/decisions` 400。分诊发生在预扣之前，走错门不动账。
运维可以在「设置」里往 `DecisionOnlyModels` 追加名字（只增不减）。

## 账本与并发

余额的每一次变动都必须经过 `applyCredit()`（`src/lib/ledger.ts`），它是唯一入口：

> **余额由同一条语句读取并写入，绝不 read-then-write。**

```sql
UPDATE users SET quota = quota + ?1 WHERE id = ?2 AND quota + ?1 >= 0 RETURNING quota
```

命中 0 行即代表余额不足。这一条保证了 N 个并发请求不会各自看到同一份余额、各自把它花掉。
结算（`postConsume`）**不守门**：响应已经发出去了，即使真实用量超出预扣、把余额扣成负数
也必须入账。`GET /api/reconcile` 比对物化余额与 `SUM(delta)`；**有偏差就说明有写入绕过了
`applyCredit()`**。定时自检（cron `0 19 * * *`）只在有偏差时写系统日志 + 企业微信告警。

中继在调上游前先扣一笔估算（`pre:<tokenId>:<uuid>`）；客户端半路断开时结算和退款都没机会跑，
`*/5` 的清扫 cron（`reclaimAbandonedReservations`）按 15 分钟静置期把无人认领的预扣退回。
退款用与结算相同的 `fin:` ref，`credits.ref` 唯一索引保证既退又扣不可能同时发生。

## 开发

```bash
npm install
npm run dev          # 本地 wrangler dev
npm test             # 适配器流式转换 + 表达式引擎 + 查价/计费 + 决策/403/健康等
npm run typecheck
npm run deploy
```

首次部署到新账号：

```bash
npx wrangler d1 create oneapi
npx wrangler kv namespace create CACHE
# 把返回的 id 填进 wrangler.jsonc
npm run db:init            # 建表（migrations/0001）
# 换掉 wrangler.jsonc vars.ADMIN_KEY 里的示例令牌！
npm run deploy
```

老库升级只需 `npm run db:migrate`（0014 加 `tokens.price_config` 列）。
`migrations/0004–0013` 里平台生态的表和列保留原样（对老库友好），代码已不再读写，
属于惰性结构。

环境变量（`wrangler.jsonc` vars，或 `wrangler secret put`）：

| 变量 | 必填 | 用途 |
|---|---|---|
| `ADMIN_KEY` | ✅ | 唯一管理员令牌，管理面与后台解锁的唯一凭据 |
| `WECOM_WEBHOOK_URL` | | 账本自检告警（lib/watchdog.ts） |
| `WECOM_HEALTH_WEBHOOK_URL` | | 路由缺口 503 告警 + 恢复通知（lib/route-alert.ts） |

## 使用

在后台「令牌」页创建密钥（需要的话给某个 Key 单独配价格），然后：

```bash
curl https://your-worker.example/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

```bash
# 看这把 Key 的生效价格
curl https://your-worker.example/v1/pricing -H "Authorization: Bearer sk-xxxxx"
```

## 许可证

本项目以 [AGPL-3.0](./LICENSE) 发布。

- [songquanpeng/one-api](https://github.com/songquanpeng/one-api)（MIT）：额度/路由语义的灵感来源。MIT 不约束衍生项目的许可证选择；本项目是其语义的独立 TypeScript 重实现，不含其代码。
- [QuantumNous/new-api](https://github.com/QuantumNous/new-api)（AGPL-3.0）：表达式计费语言的设计参考——本项目的解释器为自主实现，未复制其代码；选择同许可证以对齐。

## 与上游（one-api）的差异

- 38 个适配器压缩为 5 种渠道类型（openai / openai-responses / anthropic / gemini / azure）
- 移除：注册/登录/多用户/兑换码、分组体系、分组倍率/时段折扣、`/internal/*` 平台对接、
  语音授权窗口计费、多币种钱包、邮箱验证、第三方登录
- 新增：ADMIN_KEY 单管理员、Key × 模型价格矩阵、表达式计费语言、价格外显与可视化改表、
  协议翻译器（任一入站方言 × 任一上游方言）、内置命令行（终端页 + `/api/cli`）
- 日志写在 D1，量大时需要定期归档（D1 单库写入吞吐有限）
