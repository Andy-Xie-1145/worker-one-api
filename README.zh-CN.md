# one-api on Cloudflare Workers

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Runtime: Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-f6821f)](https://workers.cloudflare.com/)
[![Language: TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6)](https://www.typescriptlang.org/)
[![Framework: Hono](https://img.shields.io/badge/framework-Hono-e36002)](https://hono.dev/)
[![Tests](https://img.shields.io/badge/tests-32%20suites-brightgreen)](#开发)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

[English](./README.md) | **简体中文**

跑在单个 Cloudflare Worker 上的个人 LLM API 网关：不需要服务器、容器、常驻进程。
D1 存储、KV 缓存、内置 SPA 与命令行管理，一把 `ADMIN_KEY` 代替整套用户体系。
它把各平台的 API Key 聚合成一个入口，客户端从此只认一个域名。

## 特性

- **Workers 原生，极低运维**——部署就是 `wrangler deploy`，之后没有任何要保活的东西。
  免费额度足够轻度个人使用（重度流量建议 Workers Paid 换 CPU 余量）。
- **协议翻译矩阵**——任意入站协议 × 任意上游渠道类型：Anthropic SDK 的客户端可以落到
  `openai-responses` 渠道上而毫无感知。入站：OpenAI Chat、OpenAI Responses、
  Anthropic Messages、Gemini，外加两个别家不中转的决策协议（TypeSafe System One、
  OpenAI Decisions）。流式与工具参数增量逐事件翻译。
- **价签即价格**——每个价格字段都是直接的「美元 / 百万 tokens」费率，按四桶拆分
  （新鲜输入、缓存读、缓存写 5m/1h、输出）。分档/时段定价用普通算术写，不搞倍率迷宫：
  `"in": "4 * (context > 272k ? 2 : 1)"`。严格模式下未定价模型直接
  `503 model_price_not_configured`，不发上游、不预扣，绝不偷偷按兜底价记账。
- **模型别名系统**——厂商前缀（`openai/`、`zai/` …）、拼写变体（`claude-opus-5.5` →
  `claude-opus-5-5`）、日期快照后缀、别名分组，全是同一个模型的互通名字——选路、令牌
  白名单、上游名字翻译、计价一视同仁。别名不携带任何计费语义。
- **渠道标签**——渠道带标签，令牌带白/黑名单 ACL（渠道 ID 与标签混用，空白名单 = 全禁），
  以此取代 one-api 的分组体系；权限拒绝是诚实的 `403 permission_error`，
  绝不伪装成 `503 no channel`。
- **可观测、可排查**——各渠道成功率与延迟分位；失败事件保留上游错误原文；每个回给
  客户端的错误都是网关写的壳子，先说清是谁的锅（上游/渠道/状态码）再附上游原话；
  路由缺口告警与恢复通知（企业微信）；进行中请求的实时面板。

## 设计：比 one-api 少了什么

语义灵感来自 [songquanpeng/one-api](https://github.com/songquanpeng/one-api)（MIT）；
本项目是独立的 TypeScript 重写，刻意删掉了单人网关用不上的复杂度：

| | 本网关 | one-api / NewAPI |
|---|---|---|
| 部署 | 单个 Worker + D1 + KV——`wrangler deploy`，免费额度可轻度使用 | Go 服务器 + MySQL（Redis 可选） |
| 管理面 | 一把 `ADMIN_KEY`，无会话 | 注册、登录、用户角色 |
| 渠道管控 | 渠道标签 + 令牌级白/黑名单 ACL | 用户分组 × 分组倍率 |
| 定价表示 | 按桶直标 USD / 百万 tokens；分档/时段用普通算术 | 模型倍率 × 补全倍率 × 分组倍率 |
| 余额完整性 | 每笔变动都是账本条目；每日自检 + `reconcile` 对账 | quota 字段原地增减 |
| 协议覆盖 | 6 种入站 × 7 种渠道任意组合，含两个决策协议 | 固定几种入站，无决策协议 |
| 客户端可见的错误 | 网关写的壳子：谁的锅 + 渠道 + 上游原话 | 原样透传 |
| 长流 | 上游缺 `finish_reason` 时网关合成；无总时长上限 | 原样透传 |

两者都是无状态代理：`previous_response_id` → 400，请携带完整上下文。

## 快速开始

前置：Cloudflare 账号、Node.js 18+、`wrangler`。

```bash
npm install

# 1. 建资源（把返回的 id 填进 wrangler.jsonc）
wrangler d1 create oneapi
wrangler kv namespace create CACHE

# 2. 初始化数据库
npm run db:init

# 3. 设置管理钥匙（vars.ADMIN_KEY，或 wrangler secret put ADMIN_KEY）
#    ——管理面的唯一凭据，用长随机串

# 4. 部署
npm run deploy
```

打开站点，用 `ADMIN_KEY` 解锁后台 → 「渠道」页添加上游 → 「令牌」页创建 `sk-` Key
（直接进剪贴板）→ 客户端调用：

```bash
curl https://<你的站点>/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxx" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

老库升级：`npm run db:migrate`（依次执行 `migrations/*.sql`）。

## 渠道类型

| 类型 | 上游协议 | 说明 |
|---|---|---|
| `openai` | OpenAI Chat Completions | 任意兼容接口：OpenAI、DeepSeek、Moonshot、Groq、智谱、DashScope、SiliconFlow、OpenRouter、xAI、NVIDIA NIM … |
| `openai-responses` | OpenAI Responses | 上游只提供 `/v1/responses` 时使用 |
| `anthropic` | Anthropic Messages | 原生 Messages API，支持 tool_use、图片、thinking |
| `gemini` | Google Gemini | `generateContent` / `streamGenerateContent`，functionCall、inlineData |
| `azure` | Azure OpenAI | deployment 名即模型名，`api-key` 鉴权 |
| `decisions` | OpenAI Decisions | `{model, input, questions:[]}`，题型 predicate / choice / score |
| `systemone` | TypeSafe System One | `{model, state, questions:{}}`，题型 noul / choice / score |

`decisions` / `systemone` 渠道上的模型自动按「仅决策接口」分诊；其余渠道可经内置规则
或 `options.DecisionOnlyModels` 声明。

## 端点

| 端点 | 客户端协议 | 鉴权 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat | `Authorization: Bearer sk-…` |
| `POST /v1/responses` | OpenAI Responses | 同上 |
| `POST /v1/messages`、`POST /api/anthropic/v1/messages` | Anthropic Messages | `x-api-key`（也接受 `Authorization`） |
| `POST /gemini/v1beta/models/{model}:generateContent`（`:streamGenerateContent?alt=sse`） | Gemini | `x-goog-api-key` |
| `POST /v1/decisions`、`POST /v1/systemone` | 决策协议 | `Authorization: Bearer sk-…` |
| `GET /v1/models`（`?capability=decisions`） | 模型列表（决策模型默认不出现） | 同上 |
| `GET /v1/pricing` / `GET /v1/usage` | 当前 Key 的生效价格 / 用量 | 同上 |
| `GET /api/status` · `GET /api/status/public` | 公开状态 | 无 |
| `POST /api/cli` | 内置命令行 | 管理员 |

Anthropic SDK 的 base URL：`https://<站点>` 或 `https://<站点>/api/anthropic`。
决策渠道的出站地址是 `{base_url}/{端点名}`，版本段属于 `base_url`，可用
`config.decisions_path` 覆盖；两个入站决策方言自动识别、互相翻译。

## 计费

```
quota = ceil( (fresh×in + 缓存读×cached + 写5m×cw5 + 写1h×cw1 + out×out) / 1e6 × 500000 )
fresh = prompt − 缓存读 − 写5m − 写1h                # 500000 quota == $1
```

- 缓存读映射 OpenAI `cached_tokens`、DeepSeek `prompt_cache_hit_tokens`、
  Anthropic `cache_read_input_tokens`；写缓存按 Anthropic 口径分 5m/1h 两档。
- 请求前按估算预扣、结束后按真实 usage 结算；被中断的请求由定时任务清扫回收。
  余额每次变动都走统一记账入口，`reconcile` 随时可对账。

**价格来源，先命中先得**：渠道覆盖（`channels.price_config`）→ 全局覆盖 → 内置
`PRICE_TABLE` → 兜底价。查价键一律是**实际被调用的模型**——`model_mapping` 重定向与
别名解析之后的真名，而不是客户端发来的名字（上游按实际模型收费，重定向不得继承旧名的
价格）。渠道覆盖让同一模型在不同渠道可以有不同价（故障转移换渠道时预扣退旧开新，不会
串账）。清空兜底价即启用严格模式：未定价模型 `503`，不发上游、不预扣。

**模型名解析**：剥厂商前缀 → 拼写别名 → 剥日期快照后缀 → 精确匹配。
不做前缀匹配——名字相近的模型绝不会按错价格计费。

**算术价格**：每个字段可以是数字或表达式，每请求求值一次（钉在预扣上，结算复用）：

```jsonc
{ "in": 1.32, "out": 3.96, "cached_in": 0.044 }
{ "in": "4 * (context > 272k ? 2 : 1)" }                                  // 分档
{ "in": "0.3 * (hour('Asia/Shanghai') >= 1 && hour('Asia/Shanghai') < 5 ? 0.5 : 1)" }
{ "out": "has(header('anthropic-beta'), 'fast-mode') ? 30 : 20" }
```

变量：`context`/`len`、`n`；探针：`param()`、`header()`；函数：`min max abs ceil floor
tier hour minute weekday day month`；运算符：`+ - * / %`、比较、`&& || !`、三目、
`k`/`m` 后缀。非法表达式保存时直接拒绝。

## 路由与容错

- 优先级分层、层内加权随机；失败自动走向下一个候选渠道。
- `401` 判定凭据失效自动禁用渠道；`403` 对「渠道 × 模型 × 机房」做 30 分钟软熔断并
  换渠道重试；`429` 进入递增冷却；`408` / `5xx` 重试。
- 上游超时三段式：响应头 60s、流式空闲 300s、非流式体 600s——**流式没有总时长上限**，
  健康长流绝不主动切；上游缺 `finish_reason` 时由网关合成终止 chunk，
  客户端永远能拿到正常的流结束。
- 没有可用渠道 → `503` + 企业微信告警（按模型去重，恢复后自动通知）。

## 管理后台与命令行

页面：总览、令牌、渠道、价格、模型计费、健康、日志、终端、设置。
同一套能力可经 `POST /api/cli` 远程调用：

```bash
curl -X POST https://<你的站点>/api/cli -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json" -d '{"command":"channel list"}'
```

```text
channel list|add|set|show|test|pull|price|on|off|del    token list|new|set|key|on|off|del
price list|get|set|rm|default|aliases                   billing list|get|check
opt list|set                                            status / models / owner / logs / health / reconcile / watchdog
```

渠道测试按渠道类型走各自原生协议——与真实中继同一份适配器代码。
令牌密钥：创建即进剪贴板、不再回显；每次读取明文都记管理日志。

## 运维

- 健康页：各渠道成败、延迟分位、冷却/熔断状态、最近失败事件（含上游原文）。
- 模型计费页：每个模型的生效价格与来源、近 7 天用量、缓存命中率、未定价警告。
- 定时任务：每日账本自检（有偏差才告警）；每 5 分钟回收无人认领的预扣、恢复路由缺口。
- 部署前检查：`npm run audit:llm-billing`（启用渠道上有未定价模型即非零退出）；
  `npm run test:d1`（本地迁移与远端一致）。
- 日志写在 D1，长期高频使用需要定期归档。

## 架构

```
客户端 ──sk-…──▶ Worker
                  ├─ /v1/*、/api/anthropic/*、/gemini/*   中继：鉴权 → 选路 → 翻译 → 计费
                  ├─ /api/*                              管理 API + 内置 CLI
                  └─ /*                                  后台 SPA（静态资源）
                  ├─ D1：users/tokens/channels/abilities/logs/credits/options/relay_events
                  └─ KV：令牌与配置缓存（TTL 60s）
```

`abilities` 是模型 → 渠道的索引表，选路只需一次带索引查询；
余额的每次变动都是一条经账本入口的原子 SQL。

## 已知限制

- 无状态代理：不支持 `previous_response_id`（400）；`store`/`metadata`/`include` 忽略。
- Responses 的推理内容以文本项返回，不提供 `encrypted_content`。
- Anthropic 上游没有 `response_format` 等价物——严格 JSON 输出请用
  OpenAI / Responses / Gemini 渠道。
- Gemini 流式仅支持 `streamGenerateContent?alt=sse`（官方 SDK 默认行为）。
- 决策接口不支持流式（`stream: true` 直接 400）。
- 未实现图片生成；`/v1/embeddings` 仅对支持该端点的上游有效。

## 开发

```bash
npm install && npm run dev      # 本地 wrangler dev
npm run typecheck
npm test                        # 32 个套件：协议转换、计费、表达式、
                                # 路由、令牌、决策、流式 …
```

## 许可证

AGPL-3.0。语义灵感来自
[songquanpeng/one-api](https://github.com/songquanpeng/one-api)（MIT），不含其代码。
