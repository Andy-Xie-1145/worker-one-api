import type { Usage } from '../lib/billing';
import type { ChannelRow } from '../types';
import { type AdaptorContext, type BuiltRequest, type ChatRequest, joinURL } from './adaptor';
import { estimateTokens } from './sse';

/**
 * OpenRouter Decisions API（Jev）。
 *
 * 和 chat/completions 的区别只有三件事，全在这个文件里：
 *   1. 路径是 `/api/alpha/decisions`，**不在 /v1 下**；
 *   2. 请求体是 `{model, state, questions}`，没有 messages；
 *   3. 响应是 Decisions 自己的形状，原样回给客户端，不转成 chat shape。
 * 其余（选渠道、Bearer、重试、429 冷却、预扣/结算/退款）统统复用现有那套。
 */

/** 拼在渠道 base_url 后面的路径。base_url 已经是 `https://openrouter.ai/api`。 */
export const DECISIONS_PATH = 'alpha/decisions';

/**
 * 默认认得 Decisions 的上游主机。
 *
 * **能力属于渠道，不属于 adaptor。** `openai` 这个 type 同时承载 DeepSeek、Groq、
 * 智谱、OpenRouter……只要有人给其中任何一个配上 Jev 的 ability，光看 adaptor 就会
 * 让中继真的去打 `https://api.deepseek.com/alpha/decisions`：把渠道 key 发给一个
 * 根本不存在的路径，换回一个 4xx，而 4xx 在 handleRelay 里是"客户端的错，别重试"
 * ——于是真正的 OpenRouter 渠道一次都轮不到。
 */
const DECISIONS_HOSTS = ['openrouter.ai'];

/** 我们会读到的字段；其余一律透传，好让上游加字段时不用改这里。 */
export interface DecisionsRequest {
  model: string;
  state?: unknown;
  questions?: unknown;
  [k: string]: unknown;
}

/**
 * 请求里算作"提示词"的那部分。
 *
 * 预扣估算和兜底用量都按它算——两处必须是同一个口径，否则预扣和结算会按不同的
 * 体量走，差额只会在账上，不会在任何地方报错。
 */
export function decisionsPromptPayload(body: Record<string, unknown>): unknown {
  const { model: _model, stream: _stream, ...rest } = body ?? {};
  return rest;
}

/** 本地兜底估算：上游没给 usage 时用。输出侧 Jev 免费，只估输入。 */
export function estimateDecisionsUsage(body: Record<string, unknown>): Usage {
  const prompt = estimateTokens(JSON.stringify(decisionsPromptPayload(body) ?? ''));
  return { prompt_tokens: prompt, completion_tokens: 0, total_tokens: prompt };
}

/**
 * Decisions 响应的 usage 解析。
 *
 * 不复用 openai.ts 的 normalizeUsage：那个函数只认 chat 的两种拼法，而 Decisions
 * 是 alpha 接口，字段名还在动（见过 prompt_tokens / input_tokens / tokens.input
 * 三种）。认不出来时返回 0，让调用方掉到本地估算上——**绝不能把 0 当成真实用量
 * 记账**，那等于把 Jev 白送。
 */
export function normalizeDecisionsUsage(u: any): Usage {
  const prompt =
    num(u?.prompt_tokens) ?? num(u?.input_tokens) ?? num(u?.input) ?? num(u?.tokens?.input) ?? num(u?.tokens?.prompt) ?? 0;
  const completion =
    num(u?.completion_tokens) ?? num(u?.output_tokens) ?? num(u?.output) ?? num(u?.tokens?.output) ?? num(u?.tokens?.completion) ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && v !== null && v !== undefined && v !== '' ? n : undefined;
}

/**
 * 这个渠道能不能承载 Decisions，以及该打哪个路径。
 *
 * 判断只看渠道本身：主机在白名单里，或者运维在 channel config 里显式声明
 * （`{"decisions": true}` 用默认路径，`{"decisions_path": "..."}` 自定义路径）。
 * 留这个显式开关是为了不把新上游锁死在一次发版上，但**默认必须是不支持**——
 * 默认支持的代价是把一次配置错误变成一次带着密钥的跨厂商请求。
 */
export function decisionsSupport(
  channel: ChannelRow,
  config: Record<string, any>,
): { ok: true; path: string } | { ok: false; reason: string } {
  const explicit = config?.decisions_path;
  if (typeof explicit === 'string' && explicit.trim()) return { ok: true, path: explicit.trim().replace(/^\/+/, '') };
  if (config?.decisions === true) return { ok: true, path: DECISIONS_PATH };

  const host = hostOf(channel.base_url);
  if (host && DECISIONS_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    return { ok: true, path: DECISIONS_PATH };
  }
  return { ok: false, reason: host ? `上游 ${host} 未声明决策接口` : '渠道未配置 base_url' };
}

function hostOf(baseURL: string): string | null {
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 构造上游 Decisions 请求。
 *
 * 只改 model（套用渠道的 model_mapping）。`stream_options` 是防御性剥除——带
 * `stream: true` 的请求在 handleRelay 里已经被 400 挡掉了，这里不做任何静默改写。
 */
export function buildDecisionsRequest(
  req: ChatRequest,
  ctx: AdaptorContext,
  base: string,
  headers: Record<string, string>,
): BuiltRequest {
  const { stream_options: _streamOptions, ...rest } = req as Record<string, unknown>;
  const body = { ...rest, model: ctx.upstreamModel };
  return { url: joinURL(base, ctx.path), headers, body: JSON.stringify(body) };
}
