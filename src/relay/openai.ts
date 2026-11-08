import { type Adaptor, type AdaptorContext, type ChatRequest, type StreamState, joinURL } from './adaptor';
import type { Usage } from '../lib/billing';
import { estimateTokens } from './sse';
import { buildDecisionsRequest, convertDecisionsResponse, normalizeDecisionsUsage } from './decisions';

/**
 * Generic OpenAI-compatible adaptor. Covers OpenAI itself plus every vendor
 * that ships an OpenAI-shaped endpoint (DeepSeek, Moonshot, Groq, Zhipu,
 * DashScope compatible-mode, Qianfan v2, SiliconFlow, OpenRouter, xAI,
 * Doubao, Together, Ollama, ...) — the difference is just the base URL.
 */
export const openaiAdaptor: Adaptor = {
  name: 'openai',
  label: 'OpenAI Chat Completion',
  defaultBaseURL: 'https://api.openai.com',
  // Decisions 也是 Bearer + JSON，协议形状上没问题。**但这不代表每个 OpenAI 兼容
  // 渠道都能打决策接口**——那由渠道的 base_url / config 决定，见 decisionsSupport()。
  supportsDecisions: true,

  buildRequest(req: ChatRequest, ctx: AdaptorContext) {
    // 兜底用 this（= 实际的 adaptor）而不是写死 openaiAdaptor：decisions / systemone
    // 复用这个方法，留空 base_url 时应各自回落到自己的官方默认地址。
    const base = ctx.channel.base_url || ctx.config.base_url || this.defaultBaseURL || openaiAdaptor.defaultBaseURL;
    const body: ChatRequest = { ...req, model: ctx.upstreamModel };
    if (body.stream && ctx.config.no_stream_options !== true) {
      body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.channel.key}`,
    };
    if (ctx.config.organization) headers['OpenAI-Organization'] = ctx.config.organization;
    if (ctx.config.extra_headers && typeof ctx.config.extra_headers === 'object') {
      Object.assign(headers, ctx.config.extra_headers);
    }
    // Decisions 不在 /v1 下，请求体也不是 chat 形状——整条构造让给 decisions.ts。
    if (ctx.mode === 'decisions') return buildDecisionsRequest(req, ctx, base, headers);
    return { url: joinURL(base, `${apiPrefix(base, ctx)}${ctx.path}`), headers, body: JSON.stringify(body) };
  },

  convertResponse(json: any, ctx: AdaptorContext) {
    /*
     * Decisions 响应翻回客户端方言（state/input 两族的外壳字段原样，answers
     * 按请求翻译记录的键序数组↔对象），usage 从上游原始 JSON 解析。
     * 连 model 字段都不改写：客户端要的是上游那份语义，任何"顺手规整一下"
     * 都会让它和上游文档对不上，而这族接口还在快速演化。
     */
    if (ctx.mode === 'decisions') return { body: convertDecisionsResponse(json, ctx), usage: normalizeDecisionsUsage(json?.usage) };
    const usage: Usage = normalizeUsage(json?.usage);
    if (json && typeof json === 'object' && json.model) json.model = ctx.requestedModel;
    canonicalizePromptDetails(json, usage);
    return { body: json, usage };
  },

  convertStreamEvent(event, ctx, state: StreamState) {
    if (event.data === '[DONE]') return { chunks: [], done: true };
    let json: any;
    try {
      json = JSON.parse(event.data);
    } catch {
      return { chunks: [] };
    }
    if (json.model) json.model = ctx.requestedModel;
    let usage: Usage | undefined;
    if (json.usage) {
      usage = normalizeUsage(json.usage);
      canonicalizePromptDetails(json, usage);
    } else {
      // Accumulate text so a usage-less upstream can still be billed.
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') state.textAcc += delta;
    }
    // A usage-only final chunk (empty choices) is still forwarded: clients that
    // asked for include_usage expect it, and those that did not ignore it.
    return { chunks: [json], usage };
  },
};

/**
 * 把计费公式的三个字段钉进 prompt_tokens_details（cached_tokens / cache_write_tokens）。
 *
 * 公式口径：普通输入 = prompt_tokens − cached_tokens − cache_write_tokens，三桶互斥。
 * HPD 这类聚合站把缓存写放在顶层别名（cache_creation_input_tokens / 
 * prompt_cache_write_tokens），details 里没有 cache_write_tokens——调用方按公式读
 * details 会漏掉 W。这里用别名归一后的值补齐缺的键：已有键不覆盖（尊重上游原值），
 * 上游没报 usage 时不造结构。
 */
function canonicalizePromptDetails(json: any, usage: Usage): void {
  const u = json?.usage;
  if (!u || typeof u !== 'object') return;
  if (typeof u.prompt_tokens !== 'number' && typeof u.input_tokens !== 'number') return;
  let details = u.prompt_tokens_details;
  if (!details || typeof details !== 'object') details = u.prompt_tokens_details = {};
  if (details.cached_tokens === undefined && usage.cached_tokens !== undefined) details.cached_tokens = usage.cached_tokens;
  if (details.cache_write_tokens === undefined && usage.cache_write_5m_tokens !== undefined) details.cache_write_tokens = usage.cache_write_5m_tokens;
}

/**
 * Most compatible endpoints live under /v1, but some vendors pin another
 * version into the base URL (Zhipu /v4, Doubao /v3, Qianfan /v2). If the base
 * already ends in a version segment we must not append /v1 on top of it.
 */
export function apiPrefix(base: string, ctx: AdaptorContext): string {
  if (ctx.config.no_version_prefix === true) return '';
  if (/\/v\d+\/?$/.test(base)) return '';
  return 'v1/';
}

export function normalizeUsage(u: any): Usage {
  const prompt = Number(u?.prompt_tokens ?? u?.input_tokens ?? 0) || 0;
  const completion = Number(u?.completion_tokens ?? u?.output_tokens ?? 0) || 0;
  // 缓存计数的别名族：DeepSeek 报 prompt_cache_hit_tokens，OpenAI 嵌在
  // prompt_tokens_details.cached_tokens，HPD 这类聚合站还会补 anthropic 式的
  // cache_read_input_tokens——三者是同一计数器的不同名字，取最大值兜住各家拼写。
  // 缓存写入同理（cache_creation_input_tokens / prompt_cache_write_tokens 是别名）。
  // 按官方口径（prompt-caching guide）：input = 普通输入 + 缓存读 + 缓存写，三桶
  // 互斥相加——写装进 cache_write_5m_tokens 计费桶（单写计数器没有 TTL 拆分时
  // 归 30m 桶），quotaFromRates 扣减后按写价计，与 OpenAI/HPD expr 完全一致；
  // 渠道未设写价时写价继承输入价，金额不变（幂等安全）。
  const cached = Math.max(
    Number(u?.prompt_cache_hit_tokens ?? 0) || 0,
    Number(u?.cache_read_input_tokens ?? 0) || 0,
    Number(u?.prompt_tokens_details?.cached_tokens ?? 0) || 0,
  );
  const cacheWrite = Math.max(
    Number(u?.prompt_tokens_details?.cache_write_tokens ?? 0) || 0,
    Number(u?.cache_creation_input_tokens ?? 0) || 0,
    Number(u?.prompt_cache_write_tokens ?? 0) || 0,
  );
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 ? { cached_tokens: Math.min(cached, prompt) } : {}),
    ...(cacheWrite > 0 ? { cache_write_5m_tokens: Math.min(cacheWrite, Math.max(0, prompt - cached)), cache_write_tokens: cacheWrite } : {}),
  };
}

/** Last-resort usage when the upstream never reported any. */
export function estimateUsage(req: ChatRequest, state: StreamState): Usage {
  const promptText = JSON.stringify(req.messages ?? req.input ?? '');
  const prompt = state.promptTokens || estimateTokens(promptText);
  const completion = state.completionTokens || estimateTokens(state.textAcc);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** Preset base URLs offered in the admin UI; all use the OpenAI adaptor. */
export const OPENAI_COMPATIBLE_PRESETS: Record<string, string> = {
  openai: 'https://api.openai.com',
  workers_ai: 'https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai',
  deepseek: 'https://api.deepseek.com',
  moonshot: 'https://api.moonshot.cn',
  groq: 'https://api.groq.com/openai',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode',
  qianfan: 'https://qianfan.baidubce.com/v2',
  siliconflow: 'https://api.siliconflow.cn',
  openrouter: 'https://openrouter.ai/api',
  xai: 'https://api.x.ai',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  together: 'https://api.together.xyz',
  mistral: 'https://api.mistral.ai',
  stepfun: 'https://api.stepfun.com',
};
