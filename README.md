# one-api on Cloudflare Workers

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Runtime: Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-f6821f)](https://workers.cloudflare.com/)
[![Language: TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6)](https://www.typescriptlang.org/)
[![Framework: Hono](https://img.shields.io/badge/framework-Hono-e36002)](https://hono.dev/)
[![Tests](https://img.shields.io/badge/tests-32%20suites-brightgreen)](#development)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

**English** | [简体中文](./README.zh-CN.md)

A personal LLM API gateway that runs entirely on one Cloudflare Worker — no server,
no container, no daemon. D1 for storage, KV for caching, a built-in SPA and CLI
for administration, and a single `ADMIN_KEY` instead of a user system. It pools
API keys from every platform into one endpoint your clients never have to change.

## Highlights

- **Runs on Workers, managed from your phone if you like** — deploy is
  `wrangler deploy`; there is nothing else to keep alive. The free tier covers
  light personal use (heavy traffic wants Workers Paid for CPU headroom).
- **Protocol translation matrix** — any inbound protocol × any upstream channel
  type: an Anthropic SDK client can land on an `openai-responses` channel and
  never know. Inbound: OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini,
  plus two decision protocols (TypeSafe System One, OpenAI Decisions) nobody
  else relays. Streaming and incremental tool-call arguments are translated
  event by event.
- **Prices that mean what they say** — every price field is a direct
  USD-per-1M-tokens rate, split into four buckets (fresh input, cache read,
  cache write 5m/1h, output). Tiered or time-based pricing is ordinary
  arithmetic, not a ratio maze: `"in": "4 * (context > 272k ? 2 : 1)"`. Strict
  mode (`503 model_price_not_configured`) refuses unpriced models before any
  upstream call instead of silently billing a fallback.
- **Model alias system** — one shared alias table resolves vendor prefixes
  (`openai/`, `zai/`, …), spelling variants (`claude-opus-5.5` →
  `claude-opus-5-5`), date-snapshot suffixes, and alias groups (overlapping
  groups merge); routing, token allowlists, upstream name translation and
  pricing all share it. Aliases carry no billing semantics — they are just
  names for the same model.
- **Channel tags** — channels carry tags; tokens carry a whitelist/blacklist
  ACL mixing channel IDs and tags (empty whitelist = deny all). This replaces
  one-api's group system; a denial is an honest `403 permission_error`, never a
  fake `503 no channel`.
- **Observability you can debug from** — per-channel success rates and latency
  percentiles; failure events keep the upstream's original error text; every
  client-facing error is a gateway-written shell that states whose fault it is
  (upstream/channel/status) with the upstream's words attached; route-gap alerts
  with recovery notices (WeCom webhook); a live in-flight panel for running
  requests.

## Design: less than one-api

Semantic inspiration from [songquanpeng/one-api](https://github.com/songquanpeng/one-api)
(MIT); this is an independent TypeScript rewrite that deliberately deletes the
complexity a single-operator gateway never needed:

| | this gateway | one-api / NewAPI |
|---|---|---|
| Deployment | one Worker + D1 + KV — `wrangler deploy`, free tier covers light use | Go server + MySQL (Redis optional) |
| Admin surface | one `ADMIN_KEY`, no sessions | registration, login, user roles |
| Channel access control | channel tags + per-token whitelist/blacklist ACL | user groups × group ratio |
| Price representation | direct USD / 1M-token rates per bucket; tiers & time windows via plain arithmetic | model ratio × completion ratio × group ratio |
| Balance integrity | every change is a ledger entry; daily self-check + `reconcile` | quota columns updated in place |
| Protocol coverage | 6 inbound protocols × 7 channel types, any-to-any, incl. two decision protocols | fixed inbound set, no decision protocols |
| Client-facing errors | gateway-written shell: whose fault + channel + upstream's original words | pass-through |
| Long streams | `finish_reason` synthesized when the upstream omits it; no total-duration cap | pass-through |

Stateless either way: `previous_response_id` → 400; bring full context.

## Quick start

Requires a Cloudflare account, Node.js 18+, and `wrangler`.

```bash
npm install

# 1. Create resources (put the returned ids into wrangler.jsonc)
wrangler d1 create oneapi
wrangler kv namespace create CACHE

# 2. Initialize the database
npm run db:init

# 3. Set the admin key (vars.ADMIN_KEY or: wrangler secret put ADMIN_KEY)
#    — the only credential for the admin surface; use a long random string

# 4. Deploy
npm run deploy
```

Open the site, unlock the SPA with `ADMIN_KEY` → add an upstream in
**Channels** → create an `sk-` key in **Tokens** (copied to clipboard) → call:

```bash
curl https://<your-site>/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxx" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Upgrades: `npm run db:migrate` (runs `migrations/*.sql` in order).

## Channel types

| Type | Upstream protocol | Notes |
|---|---|---|
| `openai` | OpenAI Chat Completions | any compatible API: OpenAI, DeepSeek, Moonshot, Groq, Zhipu, DashScope, SiliconFlow, OpenRouter, xAI, NVIDIA NIM, … |
| `openai-responses` | OpenAI Responses | upstreams that only expose `/v1/responses` |
| `anthropic` | Anthropic Messages | tool_use, images, thinking |
| `gemini` | Google Gemini | `generateContent` / `streamGenerateContent`, functionCall, inlineData |
| `azure` | Azure OpenAI | deployment name = model name, `api-key` auth |
| `decisions` | OpenAI Decisions | `{model, input, questions:[]}` — predicate / choice / score |
| `systemone` | TypeSafe System One | `{model, state, questions:{}}` — noul / choice / score |

Models on `decisions`/`systemone` channels are auto-triaged as decision-only;
others can be declared via built-in rules or `options.DecisionOnlyModels`.

## Endpoints

| Endpoint | Client protocol | Auth |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat | `Authorization: Bearer sk-…` |
| `POST /v1/responses` | OpenAI Responses | same |
| `POST /v1/messages`, `POST /api/anthropic/v1/messages` | Anthropic Messages | `x-api-key` (also accepts `Authorization`) |
| `POST /gemini/v1beta/models/{model}:generateContent` (`:streamGenerateContent?alt=sse`) | Gemini | `x-goog-api-key` |
| `POST /v1/decisions`, `POST /v1/systemone` | Decision protocols | `Authorization: Bearer sk-…` |
| `GET /v1/models` (`?capability=decisions`) | model list (decision models hidden by default) | same |
| `GET /v1/pricing` / `GET /v1/usage` | this key's effective prices / usage | same |
| `GET /api/status` · `GET /api/status/public` | public status | none |
| `POST /api/cli` | built-in CLI | admin |

Anthropic SDK base URL: `https://<site>` or `https://<site>/api/anthropic`.
Decision-channel outbound URL is `{base_url}/{endpoint}`; the version segment
belongs to `base_url`, overridable via `config.decisions_path`. The two inbound
decision dialects are auto-detected and cross-translated.

## Pricing

```
quota = ceil( (fresh×in + cacheRead×cached + cw5m×cw5 + cw1h×cw1 + out×out) / 1e6 × 500000 )
fresh = prompt − cacheRead − cw5m − cw1h          # 500000 quota == $1
```

- Cache reads map from OpenAI `cached_tokens`, DeepSeek `prompt_cache_hit_tokens`,
  Anthropic `cache_read_input_tokens`; writes split 5m/1h per Anthropic's tiers.
- Pre-charged on estimate, settled on real usage; interrupted requests are
  swept by a cron. Every balance change goes through one ledger entry point and
  `reconcile` can prove it at any time.

**Price sources, first hit wins**: channel override (`channels.price_config`)
→ global override → built-in `PRICE_TABLE` → fallback price. Channel overrides
let the same model cost differently per channel (reservations re-pin on
failover, never cross-billing). Clearing the fallback enables strict mode:
unpriced models get `503`, no upstream call, no reservation.

**Name resolution**: strip vendor prefix → spelling aliases → strip date-snapshot
suffix → exact match. No prefix matching — near-names never get billed wrong.

**Arithmetic prices**: each field may be a number or an expression evaluated
once per request (pinned to the reservation, reused at settlement):

```jsonc
{ "in": 1.32, "out": 3.96, "cached_in": 0.044 }
{ "in": "4 * (context > 272k ? 2 : 1)" }                                  // tiered
{ "in": "0.3 * (hour('Asia/Shanghai') >= 1 && hour('Asia/Shanghai') < 5 ? 0.5 : 1)" }
{ "out": "has(header('anthropic-beta'), 'fast-mode') ? 30 : 20" }
```

Variables: `context`/`len`, `n`; probes: `param()`, `header()`; functions:
`min max abs ceil floor tier hour minute weekday day month`; operators:
`+ - * / %`, comparisons, `&& || !`, ternary, `k`/`m` suffixes. Invalid
expressions are rejected at save time.

## Routing & fault tolerance

- Priority layers, weighted random within a layer; failures walk to the next
  candidate channel.
- `401` auto-disables the channel; `403` soft-circuit-breaks the
  channel×model×colo triple for 30 min and retries elsewhere; `429` enters an
  escalating cooldown; `408`/`5xx` retry.
- Three-tier upstream timeouts: headers 60s, stream idle 300s, non-stream body
  600s — **no total-duration cap on streams**. Healthy long streams are never
  cut; if an upstream omits `finish_reason`, the gateway synthesizes the
  terminal chunk so clients always get a proper end of stream.
- No channel left → `503` + WeCom alert (deduplicated per model, recovery notice
  included).

## Admin SPA & CLI

Pages: overview, tokens, channels, pricing, model billing, health, logs,
terminal, settings. Same powers over `POST /api/cli`:

```bash
curl -X POST https://<your-site>/api/cli -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json" -d '{"command":"channel list"}'
```

```text
channel list|add|set|show|test|pull|price|on|off|del    token list|new|set|key|on|off|del
price list|get|set|rm|default|aliases                   billing list|get|check
opt list|set                                            status / models / owner / logs / health / reconcile / watchdog
```

Channel tests use each channel type's native protocol — the same adaptor code
as real relays. Token secrets: created → clipboard only, never re-displayed;
every plaintext read is logged.

## Operations

- Health page: per-channel success/latency percentiles, cooldown/breaker state,
  recent failure events with upstream originals.
- Model-billing page: effective price + source per model, 7-day usage, cache
  hit rate, unpriced warnings.
- Crons: daily ledger self-check (alerts only on drift); every 5 min, sweep
  unclaimed reservations and recover route gaps.
- Pre-deploy: `npm run audit:llm-billing` (non-zero if any enabled channel has
  unpriced models); `npm run test:d1` (local vs remote migration parity).
- Logs live in D1 — archive periodically under heavy use.

## Architecture

```
client ──sk-…──▶ Worker
                  ├─ /v1/* /api/anthropic/* /gemini/*   relay: auth → route → translate → bill
                  ├─ /api/*                             admin API + built-in CLI
                  └─ /*                                 admin SPA (static assets)
                  ├─ D1: users/tokens/channels/abilities/logs/credits/options/relay_events
                  └─ KV: token & options cache (TTL 60s)
```

`abilities` is the model→channel index; routing is one indexed query. Every
balance mutation is a single atomic SQL through the ledger.

## Known limitations

- Stateless proxy: no `previous_response_id` (400); `store`/`metadata`/`include` ignored.
- Responses reasoning returns as text items, no `encrypted_content`.
- Anthropic upstreams have no `response_format` equivalent — use
  OpenAI/Responses/Gemini channels for strict JSON.
- Gemini streaming requires `streamGenerateContent?alt=sse` (SDK default).
- Decision endpoints are non-streaming (`stream:true` → 400).
- No image generation; `/v1/embeddings` only for upstreams that expose it.

## Development

```bash
npm install && npm run dev      # local wrangler dev
npm run typecheck
npm test                        # 32 suites: protocols, billing, expressions,
                                # routing, tokens, decisions, streaming, …
```

## License

AGPL-3.0. Semantic inspiration from
[songquanpeng/one-api](https://github.com/songquanpeng/one-api) (MIT); no code
shared.
