# one-api on Cloudflare Workers

用 TypeScript 重写的 LLM API 中转网关，整个服务跑在 Cloudflare Workers 上，
不需要服务器、不需要容器，用一把管理员令牌管理。

它把分散在各平台的 API Key 聚合成一个入口：所有渠道进一个池子，客户端只认一个域名，
按「渠道 × 模型」精细定价，用量、余额、渠道健康度一目了然。

支持的客户端形态：任何 OpenAI / Anthropic / Gemini / Responses 兼容的 SDK 或应用，
以及 Decisions、System One 这类分类接口。上游是什么协议与客户端无关——网关负责翻译。

## 特性

- **多协议入站**：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、
  Google Gemini，以及 Decisions / System One 两种决策协议
- **多协议出站**：七种渠道类型覆盖上述所有上游，任意入站 × 任意上游自由组合
- **流式**：所有协议都支持流式，工具调用（含并行）参数增量逐块翻译
- **精细定价**：渠道级价格覆盖 > 全局覆盖 > 内置价格表 > 兜底价，字段级费率表达式动态计费
- **没有倍率**：计费 = 用量 × 价格，不存在分组倍率、时段折扣等第二因子
- **可靠路由**：优先级分层 + 层内加权随机、失败自动换渠道、429 冷却、403 软熔断
- **额度与账本**：请求前预扣、结束后按真实 usage 结算；余额变更全部落账本，可随时对账
- **可观测**：请求日志、失败事件、渠道健康度、模型计费报表、路由缺口告警
- **管理后台**：单页应用 + 内置命令行（后台终端页，或 `POST /api/cli` 远程调用）
- **单管理员**：只有一把 `ADMIN_KEY`，没有注册、登录、多用户、分组

## 快速开始

前置：一个 Cloudflare 账号、Node.js 18+、全局安装的 `wrangler`。

```bash
npm install

# 1. 建资源（把返回的 id 填进 wrangler.jsonc）
wrangler d1 create oneapi
wrangler kv namespace create CACHE

# 2. 初始化数据库
npm run db:init

# 3. 设置管理员令牌（wrangler.jsonc 的 vars.ADMIN_KEY，或 wrangler secret put ADMIN_KEY）
#    这是管理面与后台解锁的唯一凭据，用长随机串

# 4. 部署
npm run deploy
```

部署后打开站点，输入 `ADMIN_KEY` 解锁后台 → 「渠道」页添加一个上游 →
「令牌」页创建一把 `sk-` Key（密钥会直接进剪贴板）→ 客户端即可调用：

```bash
curl https://<你的站点>/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

老库升级：`npm run db:migrate`（依次执行 `migrations/*.sql`）。

## 渠道类型

| 类型 | 上游协议 | 说明 |
|---|---|---|
| `openai` | OpenAI Chat Completions | 通用 OpenAI 兼容接口：OpenAI、DeepSeek、Moonshot、Groq、智谱、DashScope、SiliconFlow、OpenRouter、xAI、NVIDIA NIM 等，配 `base_url` 即可 |
| `openai-responses` | OpenAI Responses | 上游只提供 `/v1/responses` 时使用 |
| `anthropic` | Anthropic Messages | 原生 Messages API，支持 tool_use、图片、thinking |
| `gemini` | Google Gemini | `generateContent` / `streamGenerateContent`，支持 functionCall、inlineData |
| `azure` | Azure OpenAI | deployment 名即模型名，`api-key` 鉴权 |
| `decisions` | OpenAI Decisions | 分类/判定接口，请求 `{model, input, questions:[]}`，题型 predicate / choice / score |
| `systemone` | TypeSafe System One | 分类/判定接口，请求 `{model, state, questions:{}}`，题型 noul / choice / score |

`decisions` / `systemone` 两类渠道上的模型自动按「决策模型」处理，无需额外声明。
其余渠道上的决策模型（例如 OpenRouter 上的 `jev`）内置规则或「设置 → 仅决策接口的模型」
可以声明（`options.DecisionOnlyModels`）。

## 协议与端点

| 入站端点 | 客户端协议 | 鉴权 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat | `Authorization: Bearer sk-…` |
| `POST /v1/completions`、`POST /v1/embeddings` | OpenAI 兼容 | `Authorization: Bearer sk-…` |
| `POST /v1/responses` | OpenAI Responses | `Authorization: Bearer sk-…` |
| `POST /v1/messages` | Anthropic Messages | `x-api-key`（也接受 `Authorization`） |
| `POST /api/anthropic/v1/messages` | Anthropic Messages | 同上 |
| `POST /gemini/v1beta/models/{model}:generateContent` | Google Gemini | `x-goog-api-key`（也接受 `Authorization`） |
| `POST /gemini/v1beta/models/{model}:streamGenerateContent?alt=sse` | Google Gemini 流式 | 同上 |
| `POST /v1/decisions` | OpenAI Decisions | `Authorization: Bearer sk-…` |
| `POST /v1/systemone` | TypeSafe System One | `Authorization: Bearer sk-…` |

辅助端点：

| 端点 | 说明 |
|---|---|
| `GET /v1/models`（`?capability=decisions`） | 可用模型列表，决策模型默认不出现 |
| `GET /v1/pricing` | 当前 Key 的生效价格（每条带 `source`） |
| `GET /v1/usage` | 当前 Key 的用量与金额 |
| `GET /api/status` | 公开状态（站点名、版本号） |
| `GET /api/status/public` | 公开状态页数据（引擎名、成功率、延迟档位） |
| `POST /api/cli` | 内置命令行（管理员） |

### Anthropic 客户端的 base URL

Anthropic 官方路径自带版本段（`POST /v1/messages`），SDK 的 base 只填 origin，
所以两种写法都支持：

```bash
export ANTHROPIC_BASE_URL=https://<你的站点>                 # 推荐
export ANTHROPIC_BASE_URL=https://<你的站点>/api/anthropic   # 等价
export ANTHROPIC_API_KEY=sk-xxxxx
```

### 决策接口的 URL 拼接

决策类渠道的出站地址是 `{base_url}/{端点名}`，版本段属于 `base_url`：

```bash
# 出站分别是 https://api.openai.com/v1/decisions 与 https://api.typesafe.ai/v1/systemone
channel add decisions 上游-dec https://api.openai.com/v1 sk-xxx --models gpt-6-luna
channel add systemone 上游-so  https://api.typesafe.ai/v1 sk-xxx --models jev-latest
# 上游路径不统一时用渠道 config 覆盖端点名
channel set <id> config='{"decisions_path":"custom/decide"}'
```

两个入站入口的方言会自动识别（有 `state` 视为 System One，有 `input` 视为 OpenAI
Decisions），跨方言请求会翻译到上游方言并把响应翻回来。

## 配置

`wrangler.jsonc` 的 `vars` 或 `wrangler secret put`：

| 变量 | 必填 | 用途 |
|---|---|---|
| `ADMIN_KEY` | ✅ | 管理面与后台解锁的唯一凭据 |
| `WECOM_WEBHOOK_URL` | | 账本自检告警（企业微信群机器人） |
| `WECOM_HEALTH_WEBHOOK_URL` | | 路由缺口告警与恢复通知 |

绑定：`DB`（D1）、`CACHE`（KV，令牌与配置缓存，TTL 60s）、`ASSETS`（后台静态资源）。

系统参数在后台「设置」页或 CLI `opt set` 修改：站点名、预扣下限、重试次数、渠道冷却
基数/上限、是否记录健康事件、仅决策接口的模型、全局价格覆盖、兜底价。

## 计费

```
quota = ceil( (fresh × 输入价 + 命中缓存 × 缓存价 + 写缓存5m × 写5m价 + 写缓存1h × 写1h价
               + completion × 输出价) / 1e6 × 500000 )
fresh = prompt − 缓存命中 − 写缓存5m − 写缓存1h
```

- `500000 quota == $1`，价格单位统一是**美元 / 百万 tokens**。
- 缓存命中按 `cached_in` 计价（OpenAI `cached_tokens`、DeepSeek `prompt_cache_hit_tokens`、
  Anthropic `cache_read_input_tokens`）；未配 `cached_in` 时按输入价计。
- 缓存写入按 Anthropic 口径分 5m / 1h 两档（1.25× 与 2× 输入价），未配置时按输入价计。
- 请求前按估算预扣，结束后按真实 usage 结算；客户端中断由定时清扫回收预扣。

### 价格来源与优先级

同一个模型的价格按顺序取第一个命中的：

1. **渠道覆盖** —— `channels.price_config`，键是渠道 `models` 里写的名字，仅该渠道生效
2. **全局覆盖** —— `options.ModelPriceOverride`（后台「价格」页编辑）
3. **内置价格表** —— `PRICE_TABLE`（精确匹配）
4. **兜底价** —— 默认 $1/$3

渠道覆盖让同一模型在不同渠道可以有不同价（换渠道时预扣会退旧开新，不会串账）。
按 Key 定价不提供：令牌会混用渠道并发生故障转移，价格跟着渠道走。

**严格计费**：清空兜底价即启用——查不到价格的请求直接 `503 model_price_not_configured`，
不发上游、不预扣。保留兜底价则是宽松模式，按兜底价记账。

**模型名解析**：先剥厂商前缀（`openai/`、`zai/`、`deepseek/` 等），再套拼写别名
（`claude-opus-5.5` → `claude-opus-5-5`），最后剥结尾的日期快照后缀
（`-YYYY-MM-DD` / `-YYYYMMDD`），然后**精确匹配**。不做前缀匹配，避免把名字相近的
模型按错误价格计费。

### 费率表达式

`PriceSpec` 的每个字段（`in` / `out` / `cached_in` / `cache_write_5m` / `cache_write_1h`）
都可以是数字常量或表达式，表达式求值结果是**该字段本次请求的 USD / 1M tokens 费率**：

```jsonc
{ "in": 1.32, "out": 3.96, "cached_in": 0.044 }

// 长上下文档位
{ "in": "4 * (context > 272k ? 2 : 1)", "out": "20 * (context > 272k ? 1.5 : 1)" }

// 时段定价（北京时间 1-5 点半价）
{ "in": "0.3 * (hour('Asia/Shanghai') >= 1 && hour('Asia/Shanghai') < 5 ? 0.5 : 1)" }

// 按请求头切换档位
{ "out": "has(header('anthropic-beta'), 'fast-mode') ? 30 : 20" }
```

- 变量：`context`（输入 token 数，别名 `len`）、`n`（请求级数量）
- 请求探针：`param("路径")`、`header("名")`（缺失为 `null`）
- 函数：`min` `max` `abs` `ceil` `floor` `tier(名, 值)` `hour` `minute` `weekday` `day` `month`（带 IANA 时区）
- 运算符：`+ - * / %`、比较、`&& || !`、三目 `?:`（短路）、数字后缀 `k` / `m`
- 每个请求在选中渠道后、发上游前求值一次，结果钉在预扣上，结算复用同一份
- 保存时逐字段编译并冒烟校验，非法表达式拒绝保存

## 路由与容错

- 按 `(模型, 渠道)` 索引选路：优先级分层，层内按权重随机；失败自动尝试下一个候选渠道
- `401` 判定渠道凭据失效，自动禁用该渠道；`403` 视为「该渠道/该模型不可用」，换渠道继续
  并写入短期软熔断（不复用无效渠道）；`429` 进入渠道级冷却；`408` / `5xx` 重试
- 冷却、熔断、失败事件都会体现在后台「健康」页与告警里
- 没有可用渠道时返回 `503`，并按配置推送企业微信告警（同一模型有冷却，恢复后自动通知）

## 管理后台与命令行

后台是单页应用，包含：总览、令牌、渠道、价格、模型计费、健康、日志、终端、设置。
解锁一次（令牌存在浏览器本地）后续请求自动携带。

令牌行为：创建后密钥直接复制到剪贴板、页面不回显明文；列表只显示前 6 位遮罩；
需要再次复制时点该行「复制」；每次读取明文都会记一条管理日志。

同一套能力也可以从终端调用：

```bash
curl -X POST https://<你的站点>/api/cli \
  -H "Authorization: Bearer <ADMIN_KEY>" -H "Content-Type: application/json" \
  -d '{"command":"channel list"}'
# → {"success":true,"message":"","data":{"output":"…","ok":true}}
```

常用命令（`help` 输出完整说明）：

```text
status / models / owner / logs / health / reconcile / watchdog
channel list | add | set | show | test | pull | price | on | off | del
token list | new | set | key | on | off | del
price list | get | set | rm | default | aliases
billing list | get | check
opt list | set
```

示例：

```text
channel add openai deepseek https://api.deepseek.com sk-ds-xxx --models deepseek-v4-flash,deepseek-v4-pro
price set deepseek-v4-pro in=1.32 out=3.96 cached=0.044
channel price 1 '{"z-ai/glm-5.3-flash":{"in":0.15,"out":0.5}}'
token new 笔记本 --unlimited
channel test 1 deepseek-v4-flash
billing check
```

渠道测试按渠道类型走各自的**原生协议**（chat/completions、responses、messages、
generateContent、decisions、systemone），由对应适配器构造请求，等价于真实中继路径。

## 运维

- **健康页**：近 1 小时各渠道成败、延迟分位、冷却/熔断状态、最近失败事件（含上游错误原文）
- **模型计费页**：每个声明模型的生效价格、来源、近 7 天用量、缓存命中率、未定价警告
- **账本对账**：`reconcile` / `GET /api/reconcile` 比对物化余额与账本流水总和
- **定时任务**：每日账本自检（有偏差才告警）、每 5 分钟回收无人认领的预扣
- **部署前检查**：
  - `npm run audit:llm-billing`：列出启用渠道上未定价的 (渠道, 模型) 组合，非空即非零退出
  - `python scripts/d1_guard.py check`（或 `npm run test:d1`）：本地迁移与远端 `d1_migrations` 一致

## 架构

```
客户端 ──sk-…──▶ Worker
                  ├─ /v1/*、/api/anthropic/*、/gemini/*   中继：鉴权 → 选路 → 方言翻译 → 计费
                  ├─ /api/*                              管理 API + 内置 CLI
                  ├─ /api/status*                        公开状态
                  └─ /*                                  后台 SPA（静态资源）
                  ├─ D1：users / tokens / channels / abilities / logs / credits / options / relay_events
                  └─ KV：令牌与系统配置缓存（TTL 60s）
```

`abilities` 是 `模型 → 渠道` 的索引表，选路只需要一次带索引查询。
余额的每一次变动都经过统一的记账入口（单条 SQL 原子增减），可随时与账本对账。

## 已知限制

- 无状态代理：不支持 `previous_response_id`（返回 400），请携带完整上下文；`store`、
  `metadata`、`include` 等留档/加密相关参数忽略
- Responses 的推理内容以 `reasoning` 项文本形式返回，不提供 `reasoning.encrypted_content`
- Anthropic 上游没有结构化的 `response_format` 等价物：需要严格 JSON 输出时请用
  OpenAI / Responses / Gemini 渠道
- Gemini 流式仅支持 `streamGenerateContent?alt=sse`（官方 SDK 默认行为）
- 决策接口不支持流式（`stream: true` 会直接 400）
- 未实现图片生成接口；`/v1/embeddings` 仅对支持该端点的上游有效
- 日志写在 D1，长期高频使用需要定期归档

## 开发

```bash
npm install
npm run dev        # 本地 wrangler dev
npm run typecheck
npm test           # 协议转换 / 计费 / 表达式 / 路由 / 令牌 / 决策 等 23 个套件
npm run deploy
```

## 许可证

以 [AGPL-3.0](./LICENSE) 发布。

- 语义灵感来自 [songquanpeng/one-api](https://github.com/songquanpeng/one-api)（MIT），
  本项目是独立的 TypeScript 重实现，不含其代码
- 表达式计费语言的设计参考 [QuantumNous/new-api](https://github.com/QuantumNous/new-api)
  （AGPL-3.0），解释器为自主实现
