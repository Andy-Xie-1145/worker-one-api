# one-api on Cloudflare Workers · 个人版

一个受 [songquanpeng/one-api](https://github.com/songquanpeng/one-api) 语义启发、用 TypeScript 重写的
LLM API 中转网关，完整运行在 Cloudflare Workers 上，**不依赖任何单节点服务器**。

定位：**把个人分散在各平台的 API 整合为一个平台，方便统一调度**——所有渠道进一个池子，
所有客户端（Claude Code / ChatBox / 任意 OpenAI、Anthropic、Gemini SDK）走同一个入口，
按渠道精细定价、按 Key 限额，用量与健康度一目了然。

设计取向：删去了全部倍率、注册登录、多用户体系和平台对接面，改为一把管理员令牌管理的
**个人 API 聚合**，并把内置价格表外显成可配置的「渠道 × 模型」价格矩阵
（路由到哪个渠道就按哪个渠道的价），支持按字段的费率表达式动态计费。

## 相比前代改造了什么

| 项 | 改造 |
|---|---|
| 倍率 | **全部删除**：分组倍率、时段折扣（DeepSeek 峰谷）等一律不存在。计费 = 用量 × 价格表，没有第二个因子 |
| 注册登录 | **删除**：`/api/setup`、`/api/auth/*`、用户管理、兑换码全部移除。唯一的管理凭据是 `ADMIN_KEY`（见下） |
| 账户 | 唯一的 `owner` 账户在第一次使用时自动创建，预存 $10,000 预算（只是刻度尺，可随时调整） |
| 分组 | **删除**：只有个人使用，没有分组维度；模型可见性由令牌的 `models` 白名单控制 |
| 价格 | 内置价格表外显（`GET /api/pricing`、`GET /v1/pricing`）；**渠道级覆盖**优先于全局覆盖；支持按字段的费率表达式动态计费。**没有 Key 级价格**（令牌混用渠道 + 故障转移，在 Key 上定价没有意义） |
| 平台生态 | **删除**：`/internal/*`（外部平台开户/发额度/订阅赠额）、`/internal/billing`（语音授权窗口）、平台 JWT 登录路径、多币种钱包全部移除 |

保留完整：多渠道路由与重试、403 软熔断、429 冷却、流式计费、账本（`credits`）与对账、
悬空预扣回收、路由缺口告警、四种入站方言（Chat / Responses / Anthropic / Gemini）、
两种决策协议（Decisions / System One）。

## 能力

- **OpenAI 兼容中转**：`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/models`
- **OpenAI Responses 入站**：`/v1/responses`，流式事件序列完整（含**推理过程**与 reasoning tokens）
- **Anthropic Messages 原生**：`/v1/messages`（标准路径）与 `/api/anthropic/v1/messages`，真流式
- **Google Gemini 入站**：`/gemini/v1beta/models/{model}:generateContent`（`?alt=sse` 流式）
- **决策接口**：`/v1/decisions`（OpenAI Decisions）与 `/v1/systemone`（TypeSafe System One）双入站，方言自动互译
- **价格外显**：`/v1/pricing` 按 Key 返回生效价格，`/api/pricing` 给管理端全量视图
- **用量查询**：`/v1/usage`，金额口径
- **多渠道路由**：按 `(模型, 渠道)` 索引选路，优先级分层 + 层内加权随机，失败自动重试下一个渠道
- **额度计费**：请求前按 prompt 体量预扣，结束后按真实 usage 结算（含流式中断/客户端断开）
- **账本**：余额的每一次变动都是一条 `credits` 记录，`users.quota` 只是 `SUM(delta)` 的物化值，可随时对账
- **管理后台**：单页应用（总览 / 令牌 / 渠道 / 价格 / 模型计费 / 健康 / 日志 / 终端 / 设置），解锁式输入管理员令牌

### 渠道类型（7 种，覆盖 5 类上游协议）

| type | 说明 |
|---|---|
| `openai` | **OpenAI Chat Completion**：通用 OpenAI 兼容接口，配 base_url 即可接入 DeepSeek、Moonshot、Groq、智谱、DashScope、SiliconFlow、OpenRouter、xAI、NVIDIA NIM 等 |
| `openai-responses` | **OpenAI Responses**：打上游的 `/v1/responses`；中枢 chat 形状自动翻译过去（system→instructions、tool_calls→function_call item、max_tokens→max_output_tokens） |
| `anthropic` | **Anthropic Messages**：Anthropic 原生 Messages API，双向转换（含 tool_use / 图片 / system / thinking） |
| `gemini` | **Google Gemini**：generateContent，双向转换（含 functionCall / inlineData）；`response_format` 会映射成 `responseMimeType`/`responseSchema`，`tool_choice` 映射成 `toolConfig` |
| `azure` | **Azure OpenAI**：deployment URL + `api-key` 头 |
| `decisions` | **Decision API**（OpenAI 方言）：出站 `{base_url}/decisions`，请求 `{model, input, questions:[]}`，题型 predicate/choice/score；渠道里的模型**自动**全部视为决策模型 |
| `systemone` | **System One**（TypeSafe 方言）：出站 `{base_url}/systemone`，请求 `{model, state, questions:{}}`，题型 noul/choice/score；模型同样自动视为决策模型，两种方言间自动翻译 |

**协议翻译器**：四种入站方言 × 七种渠道，任意组合——

| 入站端点 | 客户端方言 | 鉴权头 |
|---|---|---|
| `/v1/chat/completions` 等 | OpenAI Chat | `Authorization: Bearer` |
| `/v1/responses` | OpenAI Responses | `Authorization: Bearer` |
| `/v1/messages` 或 `/api/anthropic/v1/messages` | Anthropic Messages | `x-api-key`（也接受 `Authorization`） |
| `/gemini/v1beta/models/{model}:generateContent`（及 `:streamGenerateContent?alt=sse`） | Google Gemini | `x-goog-api-key`（也接受 `Authorization`） |
| `/v1/decisions`、`/v1/systemone` | Decisions / System One | `Authorization: Bearer` |

所有方言都翻译成中枢 chat 形状去选路、计费、重试，再把响应翻回客户端的方言——
**用任何一种 API 都能调用站内所有模型，无论上游是什么 API**。工具调用跨方言无损搬运
（`tool_calls`/`function_call`/`tool_use` 互译，流式参数增量逐块翻译）。

Anthropic Messages 的**路径自带版本段**（官方文档与 SDK 都是 `POST /v1/messages`，
SDK 的 base 只填 origin），所以两种 `ANTHROPIC_BASE_URL` 写法都支持：

```bash
# 主流写法：base 填站点根，SDK 自己拼 /v1/messages
export ANTHROPIC_BASE_URL=https://你的站点
# 老写法：base 带前缀（客户端会拼成 /api/anthropic/v1/messages）
export ANTHROPIC_BASE_URL=https://你的站点/api/anthropic
```

**Z.AI / GLM**：用 `openai` 类型 + base_url `https://api.z.ai/api/coding/paas/v4`。
价格表会自动剥掉 `zai/`、`zai-coding-plan/` 等前缀匹配到裸名。

## Responses API 入站（`POST /v1/responses`）

无状态翻译器：Responses 形状 ⇄ 中枢 chat。**推理过程会返回**，不是只算 token。

**请求字段映射**

| Responses | 中枢 chat |
|---|---|
| `instructions` | `system` 消息（`developer` 角色同样归到 system） |
| `input`（字符串 / item 数组） | `messages`（`role` 消息、`function_call`、`function_call_output`；`reasoning` item 跳过） |
| `max_output_tokens` | `max_tokens` |
| `temperature` / `top_p` | 同名 |
| `tools` / `tool_choice` | 扁平函数 → `{type:'function',function:{…}}`；`tool_choice` 同名转换 |
| `reasoning.effort` | `reasoning_effort`（仅客户端显式给出时透传） |
| `text.format` | `response_format`（支持 `json_object`、`json_schema`；其它形状不猜、不下发） |
| `stream` | 同名 |

**响应（非流式）**：`status`（`completed` / `incomplete` + `incomplete_details`）、`output` 数组
（`reasoning` / `message` / `function_call` 三类项，每项都带 `id` 与 `status`）、`usage`
（`input_tokens_details.cached_tokens` 与 **`output_tokens_details.reasoning_tokens`** 如实回传）。

**流式事件序列**（官方形状）：

```text
response.created → response.in_progress
  ├─ response.output_item.added (reasoning) → response.reasoning_summary_part.added
  │    → response.reasoning_summary_text.delta … → *.text.done → *.part.done → output_item.done
  ├─ response.output_item.added (message) → response.content_part.added
  │    → response.output_text.delta … → response.output_text.done → content_part.done → output_item.done
  └─ response.output_item.added (function_call) → response.function_call_arguments.delta …
       → response.function_call_arguments.done → output_item.done
response.completed / response.incomplete / response.failed
```

`finish_reason=length` 一律表达成 `response.incomplete`（流式）或 `status:"incomplete"`
（非流式）——**截断不是成功**，客户端不会把半截答案当成完整回复。

**跨方言的几处归一**（翻译器是通用的，组合越自由越要在这里收口）：

- `input_image.image_url` 的**字符串**写法（官方规范）与 `{url, detail}` **对象**写法都收编成
  chat 的 `image_url`，不会变成 `[object Object]`（这个 bug 曾让三个上游全部 400）；
- agent 历史里「assistant 文本 item」与「function_call item」分开给的写法，会合并成
  **同一条** assistant 消息（`content` + `tool_calls`），否则翻译到 Anthropic/Gemini 会出现
  连续两条 assistant 的畸形历史；
- `text.format` 在出站侧会翻回去：chat 渠道走 `response_format`、`openai-responses` 渠道走
  `text.format`、`gemini` 渠道走 `responseMimeType`/`responseSchema`（Anthropic 无原生等价物，
  只能忽略——需要严格 JSON 的客户端请别把该模型挂在 anthropic 渠道上）；
- `reasoning.effort` 出站到 chat 是 `reasoning_effort`、到 Responses 是 `reasoning.effort`；
  Anthropic/Gemini 没有同名参数，忽略。

**已知限制**（刻意的语义选择，不是能力缺失的遮掩）：

- `previous_response_id`：无状态网关不存对话树，直接 400，客户端请携带完整上下文；
- `store` / `metadata` / `truncation` / `include`：一律忽略（网关从不留档；没有可加密回传的
  `reasoning.encrypted_content`，推理文本以 `reasoning` 项的 `summary` 给出）；
- 图片输入：`input_image` 会翻译成 chat 的 `image_url`，但图片**生成**接口未实现。

## 架构

```
客户端 ──sk-xxx──> Worker
                    │
                    ├─ /v1/*              relay：鉴权 → 选路 → 适配器 → 流式透传 → 计费
                    │                     （入站方言：Chat / Responses / Anthropic / Gemini / Decisions / System One）
                    ├─ /api/*             管理 API（Authorization: Bearer ADMIN_KEY）+ 内置 CLI
                    ├─ /api/status/*      公开状态页（免鉴权，只有引擎名与状态枚举）
                    └─ /*                 Workers Assets 托管的管理后台 SPA
                    │
                    ├─ D1  users(仅 owner) / tokens / channels / abilities(model→channel) / logs / credits / options / relay_events
                    └─ KV  令牌鉴权缓存、系统配置缓存（TTL 60s）
```

`abilities` 是 `model -> channel` 的反范式索引，选路只需一次带索引的查询。
没有分组：个人网关只有一个 owner，模型可见性由令牌的 `models` 白名单控制。

## 管理面：一个令牌，没有账号

- 凭据 = `wrangler.jsonc` 里 `vars.ADMIN_KEY` 的长随机令牌（**硬编码**，个人仓库自用；
  泄露就换一个再部署）。除 `GET /api/status`、`GET /api/status/public` 外，所有 `/api/*`
  都要求 `Authorization: Bearer <ADMIN_KEY>`，比较走 constant-time。
- 浏览器打开站点 → 输入一次令牌（存 `localStorage`）→ 之后每个请求自动带上；
  任意 401 会清掉存储回到解锁页。
- 唯一账户 `owner` 在第一次令牌鉴权时懒创建（username `owner`，走账本预存
  $10,000 预算）；后台「总览」页可以随时调整预算。**没有第二个账户，没有注册。**

### 密钥从不回显

明文 `sk-` 密钥只走两条通道：**剪贴板** 和 **显式取回**（`token key <id>` /
`GET /api/tokens/:id/key`）。理由是回显的代价不对称——终端滚动历史、截图、录屏、
AI 会话记录都会把屏幕上出现过的东西留存下来，而密钥轮换很贵。

- 令牌列表 / 创建接口只返回 `sk-` + 前 6 位遮罩（`key_masked`），列表响应里没有任何明文；
- 后台「新建令牌」建完自动把密钥写进剪贴板，页面不显示（剪贴板不可用时降级为该行「复制」）；
- CLI `token new` 只回报 `#ID`、名称和遮罩，取明文要敲 `token key <id>`——
  输出单行，方便 `KEY=$(... | jq -r .data.output)` 捕获；
- 每次取回明文都会写一条管理日志（`取回令牌 #N 明文密钥`），密钥万一外泄能回溯。

### 前后端构建号握手

后台是单文件 SPA + hash 路由：标签页挂久了浏览器里跑的还是旧 JS，而 Worker 已经是新代码。
`/api/status` 带 `spa_build`，前端启动时 / 切回标签页 / 每 5 分钟对一次构建号，不一致就自动
重载一次（`sessionStorage` 防重载循环，仍不一致就挂横幅提示硬刷新）。
后台「设置 → 版本」能看到前端与服务端构建号，肉眼可核对。

## 内置命令行

管理面内置一个命令解释器：后台「终端」页直接敲命令；同样的命令也可以在真终端里用：

```bash
curl -X POST https://你的站点/api/cli \
  -H "Authorization: Bearer <管理令牌>" -H "Content-Type: application/json" \
  -d '{"command":"channel list"}'
```

返回 `{"success":true,"message":"","data":{"output":"<文本>","ok":true}}`；HTTP 层只在请求本身
出错时非 200（缺 command / 令牌错 / 未配 ADMIN_KEY），命令执行失败用 `data.ok` 表示。

命令与 REST 完全等价（同一套库函数，不存在两套行为）。规则：命令 = 子命令空格分隔，
参数用 `key=value`，开关用 `--flag value`；带空格的值用引号包裹（`in="4 * (context > 272k ? 2 : 1)"`）；
JSON 参数原样内联（`channel price 1 '{"m":{"in":1,"out":2}}'`）。

终端里输入 **`help`** 输出全部命令的详实说明（通用规则 + 每条命令的参数、行为与示例），
**`help <分组>`** 只看该组（`general` / `channel` / `token` / `price` / `billing` / `opt`）。
下面的总览只是速查，参数与示例以 `help` 为准。

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

# 渠道（类型：openai | openai-responses | anthropic | gemini | azure | decisions | systemone）
channel list                                        渠道列表
channel add <类型> <名称> <base_url> <key> --models m1,m2 [--priority N] [--weight N]
channel set <id> name=... type=... base_url=... key=... models=a,b priority=N weight=N status=1
                                                    按字段修改（改 models 自动重建路由索引）
channel show <id>                                   详情（密钥打码）
channel test <id> [模型]                            走该类型的原生协议直连上游测一个模型
channel pull <id> [--add]                           用渠道 key 拉上游 /models；--add 合并进 models（去重）
channel price <id> [JSON | --clear]                 该渠道的价格覆盖（{"请求名":{...}}，仅此渠道生效）
channel on <id> / off <id> / del <id>               启用 / 停用 / 删除

# 令牌
token list                                          令牌列表（密钥只显示 sk- 前 6 位遮罩）
token new <名称> [--usd N | --unlimited] [--models a,b]
                                                    建令牌，回 #ID + 名称 + 遮罩，**不打印明文**
token set <id> name=... models=a,b usd=N unlimited=1|0 status=1|2 expired=<unix>
                                                    按字段修改
token key <id>                                      取回完整密钥（唯一的明文出口）
token on <id> / off <id> / del <id>                 启用 / 停用 / 删除
（没有 Key 级价格：令牌混用渠道且有故障转移，价格跟着渠道走——见 channel price）

# 价格（美元 / 1M tokens；渠道覆盖 > 全局覆盖 > 内置表 > 兜底价）
price list [过滤]                价格表（标注来源与缓存写 5m/1h 价；基础价，不含渠道覆盖）
price get <模型>                 查一个模型的生效价（表达式截断显示）
price set <模型> in=X out=Y [cached=Z] [cw5=A] [cw1=B]   常量覆盖；字段也可写费率表达式
price rm <模型>                  清除覆盖，回到内置价
price default                    查看当前兜底价与计费模式
price default in=X out=Y         设兜底价（宽松计费）
price default --clear            清除兜底价 = 启用严格计费（未定价 503 拒绝）
price aliases                    厂商前缀 + 拼写别名表

# 模型计费
billing list [过滤]              模型计费报表（状态/费率/7天用量，未配置在前）
billing get <模型>               单模型详情：渠道明细 + 价格 + 用量 + 缓存命中
billing check                    部署前自检：严格模式 + 启用渠道未定价组合

# 系统设置
opt list                         全部配置项与当前值
opt set RetryTimes=3 SystemName=我的网关            修改配置（JSON 值直接写）
```

例：

```text
channel add openai deepseek https://api.deepseek.com sk-ds-xxx --models deepseek-v4-flash,deepseek-v4-pro
price set deepseek-v4-pro in=1.32 out=3.96 cached=0.044
price set my-model in="4 * (context > 272k ? 2 : 1)" out=20
channel price 1 '{"z-ai/glm-5.3-flash":{"in":0,"out":0}}'
token new 笔记本 --unlimited
channel pull 1 --add
billing check
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
  （默认 $1/$3）。后台「模型计费」页：每个模型按哪个价计、近 7 天用量、缓存命中率、
  有没有漏配价，一眼看完；总览与健康页有未定价警告横幅。

### 价格的优先级：渠道 > 全局 > 内置表 > 兜底

同一个模型的价格，按顺序取第一个命中的：

1. **渠道覆盖** —— `channels.price_config`（JSON：`{ "请求名": PriceSpec }`，键是渠道
   models 里写的名字），后台「渠道」编辑弹窗或 CLI `channel price <id> '...'` 配置；
   **路由到这个渠道就按它的价**——折扣渠道/免费自部署模型各配各的。同一模型在不同渠道
   可以不同价（换渠道时预扣自动退旧开新，不会串账）
2. **全局覆盖** —— `options.ModelPriceOverride`，后台「价格」页编辑
   （`PUT /api/pricing/overrides`，整包替换，逐条校验）
3. **内置价格表** —— `src/lib/pricing/llm.ts` 的 `PRICE_TABLE`，**精确命中**
   （为什么不是前缀匹配，见下面「名字解析」）
4. **兜底价** —— $1 / $3（严格计费下不生效；价格页可改/可清除）

> **没有 Key 级价格**（曾有，已删）：令牌混用各个渠道、渠道间还会故障转移，
> 在令牌上定价既不合理也没意义——价格跟着**渠道**走。

`PriceSpec` 的**每个字段**（`in` / `out` / `cached_in` / `cache_write_5m` / `cache_write_1h`）
独立地是数字常量或费率表达式：

```jsonc
{ "in": 1.32, "out": 3.96, "cached_in": 0.044 }                      // 常量，美元/1M tokens
{ "in": "4 * (context > 272k ? 2 : 1)", "out": 20 }                  // 字段费率表达式，见下
```

### 名字解析：别名表 + 快照后缀，没有前缀匹配

同一个模型在不同提供商那里拼写不同（`claude-opus-5.5` 对官方 `claude-opus-5-5`、
Azure 部署名 `gpt-35-turbo`、聚合器的 `openai/gpt-4o`）。解析规则（`priceNameCandidates`，
对渠道覆盖 / 全局覆盖 / 内置表三层统一生效）：

1. **原名** → **剥厂商前缀**（`ALIAS_PREFIXES`：`openai/` `anthropic/` `google/` `deepseek/`
   `zai/` 等）→ **拼写别名**（`PRICE_ALIASES` 显式映射到规范名，`price aliases` 可查全部）
2. 带日期快照后缀的再剥一次：只剥**结尾**的 `-YYYY-MM-DD` / `-YYYYMMDD`
   （`claude-sonnet-4-20250514` → `claude-sonnet-4`；版本号 `-4.5` 不是日期，永不剥）
3. 除此之外**没有最长前缀匹配**——名字查不到就是查不到（报警/严格拒绝），
   绝不"看起来像"就按别人的价收。上游为此付过学费：前缀匹配让 `gpt-5.4-mini`
   命中 `gpt-5`、按错误价记了 264 笔账且毫无报警。

渠道改名后（`model_mapping`）**计价只认上游名**：管理员给请求名显式定的价除外，
映射指向的模型查不到价就如实报未定价，绝不退回请求名的表价偷偷放行。

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

- **测试选模型**：渠道页点「测试」——**单个模型直接测，多个模型弹窗选**；命令行的
  `channel test <id> [模型]` 等价。（显式传的 model 必须 ∈ 渠道 models——测试带渠道 key
  直连上游，不能变成「拿这把 key 调任意模型」的后门。）
- **测试走原生协议**：探针按渠道类型发对应的最小请求，**不是一律 chat/completions**
  （上游不一定支持它）：`openai`/`azure` → chat/completions、`openai-responses` →
  responses、`anthropic` → v1/messages、`gemini` → models/{m}:generateContent、
  `decisions` → `{base}/decisions`、`systemone` → `{base}/systemone`。请求由对应
  adaptor 构造，所以测的就是中继真正会走的那条路；成功/失败消息都带协议标签、
  真实出站 URL 与耗时。
- **从上游拉取模型**：新增/编辑渠道时用 key 请求上游 `/models`（各渠道类型自己的
  端点与鉴权头，Gemini 分页取全并剥 `models/` 前缀，Azure 取 deployment 名），
  复选后追加合并进模型列表；编辑已有渠道可走库存 key，key 不回传前端。
- **模型计费页**：`GET /api/model-billing`，见上。

### 价格外显

- `GET /api/pricing`（管理员）：内置表全文、默认价、全局覆盖现状、别名前缀表。
- `GET /v1/pricing`（任意 sk- Key）：**这把 Key** 调用时的生效价格，每条带 `source`
  （`channel` / `global` / `builtin` / `default`）。客户端可以在调用前算出成本。
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

请求指向没有可用渠道的模型（客户端收到 503）时，`src/lib/route-alert.ts`
把告警推到企业微信群机器人：挂在 `waitUntil` 上不拖慢请求；同一 model 默认
30 分钟冷却；恢复由 `*/5` 清扫 cron 检查并发「已修复」。配置：

```bash
wrangler secret put WECOM_HEALTH_WEBHOOK_URL   # 群机器人完整 URL（含 ?key=）
```

不配时整个功能静默关闭。

## Anthropic 入站细节

同一套路由、计费、重试机制对外提供 Anthropic Messages 协议，只在边缘做转换：

| 入口 | 协议 | 鉴权头 |
|---|---|---|
| `/v1/messages`、`/api/anthropic/v1/messages` | Anthropic Messages | `x-api-key`（也接受 `Authorization`） |

Anthropic 请求进来先转成内部的 OpenAI 形状用于选路和计费，响应再转回去。
OpenAI 兼容的推理模型把思维链放在 `delta.reasoning_content`，会映射成 Anthropic 的
`thinking` 块；OpenAI 形状的上游只在流末给 usage，所以 `message_start` 里的
`input_tokens` 只能是 0，真实值在 `message_delta` 的 usage 里给出。

## 决策接口：Decisions / System One

决策接口有两个公开协议，网关**两个入站入口都开**（客户端只认其中一个，缺哪个都是 404）：

| 入站端点 | 方言 | 请求体 |
|---|---|---|
| `POST /v1/decisions` | OpenAI Decisions | `{model, input, questions:[]}`，题型 predicate/choice/score |
| `POST /v1/systemone` | TypeSafe System One | `{model, state, questions:{}}`，题型 noul/choice/score |

两个入口的入站方言是**自动识别**的（有 `state` = System One，有 `input` = OpenAI），
`/v1/systemone` 还会把方言定死成 System One。其余（鉴权、令牌模型权限、预扣、
`selectChannel` 选路、429 冷却、`RetryTimes` 重试、结算/退款、`relay_events`）
全部复用 `handleRelay`。网关不做 schema 校验，`state` / `questions` 一律原样透传；
唯一的例外是 `stream`：Decisions 不是流式接口，带 `stream: true` 会在预扣之前直接 400。

计价上 Jev 是 $0.042/1M 输入、输出免费（内置表 `jev` 行）；预扣/结算按
`state`/`questions` 估算 token，不会按 0 结算。

### 接入一个决策渠道

决策接口有**两种方言**（2026-11 官方文档核对）：OpenAI Decisions
（`{model, input, questions:[]}`，题型 predicate/choice/score，模型 gpt-6-luna）与
TypeSafe System One（`{model, state, questions:{}}`，题型 noul/choice/score，
模型 jev-latest）。对应**两个专用类型**，渠道里的模型**自动全部视为决策模型**，
无需任何声明：

```bash
# base_url 写到版本段；网关只往后拼端点名 decisions / systemone
channel add decisions oai-dec https://api.openai.com/v1 sk-xxx --models gpt-6-luna
channel add systemone jev https://api.typesafe.ai/v1 sk-xxx --models jev-latest
# 路径不统一的上游用 config.decisions_path 改（同样是纯拼接，不注入 /vN）
channel set <id> config='{"decisions_path":"custom/decide"}'
```

**URL 拼接规则**（与 chat/completions、responses 完全同待遇）：`{base_url}/{端点名}`。
版本段（`/v1`、`/v2`…）属于 base_url，由运维填——网关**不注入、也不剥除**任何
`/vN`，因为版本不一定是 1。上游是 `https://host/v1/systemone` 就把 base 写成
`https://host/v1`；`config.decisions_path` 只替换端点路径本身。

**方言自动翻译**（与 chat 翻译器同一哲学）：入站按 `state`/`input` 自动识别客户端
方言，跨方言时翻译到上游方言并把 `answers` 双向翻回——OpenAI SDK 可以直接调
systemone 渠道上的 jev，TypeSafe SDK 可以直接调 decisions 渠道上的 gpt-6-luna。
翻译规则：`state↔input`（`input` 是 JSON 文本时解析成结构化 `state`）、
questions 对象↔数组（对象键就是题名，数组项用 `name`）、`noul↔predicate`、
choice 选项三套写法互转、`answers` 双向按键序回翻，未知字段一律透传。

choice 题的选项有三套写法，**形状是硬约束**：OpenAI 侧是数组
（`choices` / `options: [{value, description}]`），System One 侧是对象
（`criteria: {选项名: 描述}`）。上游对 `criteria` 校验很硬，实测报错：
`choice needs a non-empty "criteria" object (option name -> description)`
——只把数组改名成 `criteria` 会被 400 拒（曾经就是这个 bug，所有 choice 请求全挂）。

响应侧同理：System One 的答案是 `{"answers":{"题名":{"type":"choice","choice":…,"probabilities":{选项:概率},"confidence":…}}}`
而 OpenAI Decisions 是 `{"answers":[{"type":"choice","name":…,"probabilities":[{"value":…,"probability":…}]}]}`
——网关两个方向都翻，choice 型答案只保留协议契约字段，方便严格校验的客户端。

**计价提示**：gpt-6-luna 走决策接口是 $0.10/M 输入、缓存 $0.01、**输出免费**，
与 chat 行（$0.1/$0.5）不同价——在决策渠道上配渠道价：

```bash
channel price <id> '{"gpt-6-luna":{"in":0.1,"out":0,"cached_in":0.01}}'
```

**兼容方式：OpenAI 形状渠道 + 声明**（TypeSafe 方言，OpenRouter 老 = 这条路）。
能不能承载由 `decisionsSupport()` 判定（OpenRouter 主机白名单自动启用；其他上游
在 config 写 `{"decisions":true}` 或 `{"decisions_path":"..."}`）：

```bash
# OpenRouter：主机命中白名单，自动启用（路径 alpha/decisions）
channel add openai jev https://openrouter.ai/api sk-or-xxx --models '~typesafe/jev-latest,typesafe/jev-1.13'
```

网页端等价操作：渠道编辑弹窗勾选「此渠道承载决策接口」并填出站路径
（勾选会写入 config 的 `decisions` / `decisions_path`，取消勾选自动移除；
类型选 Decision API / System One 时开关自动锁定，路径输入仍可改）。

### 声明决策模型

- **`decisions` / `systemone` 类型渠道：无需声明**——模型自动按决策模型分诊。
- **挂在 OpenAI 形状渠道上的决策模型**：内置规则自动识别 `jev` 前缀
  （`jev-latest`、`~typesafe/jev-1.13` 等都命中）；其余在
  「设置 → 仅决策接口的模型」（`options.DecisionOnlyModels`，JSON 数组）追加：

```bash
opt set DecisionOnlyModels=["foo/decide-x"]
```

不声明的后果：模型被当普通 chat 模型暴露在 `/v1/models`，chat 请求发去上游的
chat/completions（自定义决策上游多半 404），而 `/v1/decisions` 会以
「不是决策模型」400 拒绝——两个门都进不去。

### 能力分诊

规则集中在 `src/lib/capability.ts` 一处：`GET /v1/models` 默认只列 chat 模型
（`?capability=decisions` 才返回决策模型）；decision-only 模型走 chat/completions 400、
普通模型走 `/v1/decisions` / `/v1/systemone` 400。分诊发生在预扣之前，走错门不动账。
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
npm run typecheck
npm test             # 23 个测试套件：协议转换 / 计费 / 表达式 / 路由 / 令牌与构建号 / 决策
npm run test:d1      # 迁移文件与远端 d1_migrations 一致性守卫（需要 bash）
npm run deploy
```

测试套件：`stream` `expr` `pricing` `billing-identity` `responses` `gemini` `cli`
`channel-test` `fetch-models` `model-billing` `cooldown` `health` `decisions`
`decisions-translate` `auto-disable` `403-fallback` `route-alert` `models`
`audit-billing` `query-plan` `token-secret` `spa-build` `anthropic-inbound`。

首次部署到新账号：

```bash
wrangler d1 create oneapi
wrangler kv namespace create CACHE
# 把返回的 id 填进 wrangler.jsonc
npm run db:init            # 建表（migrations/0001）
# 换掉 wrangler.jsonc vars.ADMIN_KEY 里的示例令牌！
npm run deploy
```

老库升级只需 `npm run db:migrate`（脚本遍历 `migrations/*.sql`，当前到 0017：
0014 加过 `tokens.price_config`、0017 已把它删除并换成 `channels.price_config`）。
`migrations/0004–0013` 里平台生态的表和列保留原样（对老库友好），代码已不再读写，
属于惰性结构。

环境变量（`wrangler.jsonc` vars，或 `wrangler secret put`）：

| 变量 | 必填 | 用途 |
|---|---|---|
| `ADMIN_KEY` | ✅ | 唯一管理员令牌，管理面与后台解锁的唯一凭据 |
| `WECOM_WEBHOOK_URL` | | 账本自检告警（lib/watchdog.ts） |
| `WECOM_HEALTH_WEBHOOK_URL` | | 路由缺口 503 告警 + 恢复通知（lib/route-alert.ts） |

## 使用

在后台「令牌」页创建密钥（建完自动进剪贴板，页面不回显明文；要再复制点该行「复制」），然后：

```bash
curl https://your-worker.example/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

```bash
# Responses 入站（推理过程会以 reasoning 项返回）
curl https://your-worker.example/v1/responses \
  -H "Authorization: Bearer sk-xxxxx" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","input":"用一句话说明什么是会议纪要","stream":true}'

# Anthropic Messages 入站（base 填站点根时 SDK 打的就是这个路径）
curl https://your-worker.example/v1/messages \
  -H "x-api-key: sk-xxxxx" -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'

# 看这把 Key 的生效价格
curl https://your-worker.example/v1/pricing -H "Authorization: Bearer sk-xxxxx"
```

## 许可证

本项目以 [AGPL-3.0](./LICENSE) 发布。

- [songquanpeng/one-api](https://github.com/songquanpeng/one-api)（MIT）：额度/路由语义的灵感来源。MIT 不约束衍生项目的许可证选择；本项目是其语义的独立 TypeScript 重实现，不含其代码。
- [QuantumNous/new-api](https://github.com/QuantumNous/new-api)（AGPL-3.0）：表达式计费语言的设计参考——本项目的解释器为自主实现，未复制其代码；选择同许可证以对齐。

## 与上游（one-api）的差异

- 38 个适配器压缩为 **7 种渠道类型**（openai / openai-responses / anthropic / gemini / azure / decisions / systemone）
- 移除：注册/登录/多用户/兑换码、分组体系、分组倍率/时段折扣、Key 级价格、
  `/internal/*` 平台对接、语音授权窗口计费、多币种钱包、邮箱验证、第三方登录
- 新增：ADMIN_KEY 单管理员、渠道 × 模型价格矩阵（价格跟着渠道走）、表达式计费语言、
  价格外显与可视化改表、协议翻译器（四种入站方言 × 七种渠道）、Responses 入站与推理过程回传、
  内置命令行（终端页 + `/api/cli`）、前后端构建号握手、密钥不回显策略
- 日志写在 D1，量大时需要定期归档（D1 单库写入吞吐有限）
