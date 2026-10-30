import { type Adaptor, type AdaptorContext, type ChatRequest, type StreamState, joinURL } from './adaptor';
import type { Usage } from '../lib/billing';
import { estimateTokens } from './sse';
import { buildDecisionsRequest, normalizeDecisionsUsage } from './decisions';

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
    const base = ctx.channel.base_url || ctx.config.base_url || openaiAdaptor.defaultBaseURL;
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
     * Decisions 响应原样回给客户端。
     *
     * 连 model 字段都不改写：客户端要的是 OpenRouter 的那份 JSON，任何"顺手规整
     * 一下"都会让它和上游文档对不上，而这个接口还在 alpha，形状随时会加字段。
     */
    if (ctx.mode === 'decisions') return { body: json, usage: normalizeDecisionsUsage(json?.usage) };
    const usage: Usage = normalizeUsage(json?.usage);
    if (json && typeof json === 'object' && json.model) json.model = ctx.requestedModel;
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
  // DeepSeek reports prompt_cache_hit_tokens; OpenAI nests it under
  // prompt_tokens_details.cached_tokens. Both are a subset of prompt_tokens.
  const cached = Number(u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  // OpenRouter / OpenAI 报的缓存**写入**，同样是 prompt_tokens 的子集。只进 billing_meta
  // 供审计，按普通输入价计——绝不当成缓存命中，也不影响金额。
  const cacheWrite = Number(u?.prompt_tokens_details?.cache_write_tokens ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 ? { cached_tokens: Math.min(cached, prompt) } : {}),
    ...(cacheWrite > 0 ? { cache_write_tokens: Math.min(cacheWrite, prompt) } : {}),
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
