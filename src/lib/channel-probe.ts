import type { ChannelRow } from '../types';
import { getAdaptor } from '../relay';
import type { AdaptorContext, BuiltRequest, ChatRequest } from '../relay/adaptor';
import { decisionsSupport } from '../relay/decisions';

/**
 * 渠道「测试」发出的**探针请求**，按渠道类型走各自的**原生协议**。
 *
 * 为什么不能一律 chat/completions：上游不一定支持它。
 *   - `openai-responses` 渠道只认 `/responses`（拿 chat 去测必然 4xx，还以为渠道坏了）；
 *   - `anthropic` 渠道只认 `/v1/messages`；
 *   - `gemini` 渠道只认 `/{version}/models/{model}:generateContent`；
 *   - `decisions` / `systemone` 是决策协议，请求体根本没有 messages。
 *
 * 好消息是这些差异**全在 adaptor 里**：adaptor 的职责就是把中枢 chat 形状翻译成
 * 上游方言。所以探针只要给一个最小的中枢 ChatRequest，让 adaptor 自己翻——测的
 * 就是中继真正会走的那条路（路径、鉴权头、body 形状全一致），而不是另写一份
 * 容易和适配器漂移的构造逻辑。
 *
 * 唯一例外是决策两类：它们不吃 ChatRequest，按各自方言给最小决策请求体。
 */
export type ProbeKind = 'chat' | 'responses' | 'anthropic' | 'gemini' | 'decisions' | 'systemone';

export interface ProbeRequest {
  kind: ProbeKind;
  /** 人类可读的协议标签，用在成功/失败消息里。 */
  label: string;
  built: BuiltRequest;
  /** 出站 URL（错误信息里带上，排障时一眼看出打的是哪）。 */
  url: string;
}

/** 中枢形状的最小请求：一句话 + 1 token 输出。adaptor 会翻成各家方言。 */
function minimalChatRequest(model: string): ChatRequest {
  return { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };
}

/** 决策两类的最小合法请求体（按渠道方言）。题型用各自的是非题，最便宜。 */
export function decisionProbeBody(channel: Pick<ChannelRow, 'type'>, model: string): ChatRequest {
  if (channel.type === 'decisions') {
    // OpenAI Decisions 方言：{model, input, questions: []}，题型 predicate/choice/score
    return {
      model,
      input: 'ping',
      questions: [{ type: 'predicate', instructions: 'Is this a test request?' }],
    } as unknown as ChatRequest;
  }
  // TypeSafe System One 方言：{model, state, questions: {}}，题型 noul/choice/score
  return {
    model,
    state: 'ping',
    questions: { ok: { type: 'noul', instructions: 'Is this a test request?' } },
  } as unknown as ChatRequest;
}

/**
 * 构造探针请求。决策类型渠道走决策协议；其余按 adaptor 自己的原生端点构造。
 *
 * 注意 ctx.path 只是给 openai / azure 这两个**会读 path** 的 adaptor 用的；
 * responses / anthropic / gemini 的 buildRequest 自己拼死端点，这里填个语义名
 * 只是为了可读。
 */
export function buildProbeRequest(channel: ChannelRow, model: string): { ok: true; probe: ProbeRequest } | { ok: false; error: string } {
  const config = (() => {
    try {
      const parsed = JSON.parse(channel.config || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  })();
  const adaptor = getAdaptor(channel.type);

  // ---- 决策两类：不吃 ChatRequest，按方言给最小决策请求体
  if (channel.type === 'decisions' || channel.type === 'systemone') {
    const support = decisionsSupport(channel, config);
    if (!support.ok) return { ok: false, error: `渠道 ${channel.name} 不支持决策接口：${support.reason}` };
    const dialect = channel.type === 'decisions' ? 'openai' : 'systemone';
    const ctx: AdaptorContext = {
      channel,
      upstreamModel: model,
      requestedModel: model,
      mode: 'decisions',
      path: support.path,
      config,
      decisionsFrom: dialect,
      decisionsTo: dialect,
    };
    const built = adaptor.buildRequest(decisionProbeBody(channel, model), ctx);
    return {
      ok: true,
      probe: {
        kind: channel.type,
        label: channel.type === 'decisions' ? 'Decision API' : 'System One',
        built,
        url: built.url,
      },
    };
  }

  // ---- chat 家族：交给 adaptor 翻成它自己的原生方言
  const NATIVE: Record<string, { kind: ProbeKind; label: string; path: string }> = {
    openai: { kind: 'chat', label: 'OpenAI Chat Completions', path: 'chat/completions' },
    azure: { kind: 'chat', label: 'Azure OpenAI Chat Completions', path: 'chat/completions' },
    'openai-responses': { kind: 'responses', label: 'OpenAI Responses', path: 'responses' },
    anthropic: { kind: 'anthropic', label: 'Anthropic Messages', path: 'messages' },
    gemini: { kind: 'gemini', label: 'Google Gemini generateContent', path: '' },
  };
  const native = NATIVE[channel.type];
  if (!native) return { ok: false, error: `未知的渠道类型：${channel.type}` };

  const ctx: AdaptorContext = {
    channel,
    upstreamModel: model,
    requestedModel: model,
    mode: 'chat',
    path: native.path,
    config,
  };
  try {
    const built = adaptor.buildRequest(minimalChatRequest(model), ctx);
    return { ok: true, probe: { kind: native.kind, label: native.label, built, url: built.url } };
  } catch (e: any) {
    // 渠道配置不全（如 azure 缺 base_url）在构造期就炸——如实报，不要发请求。
    return { ok: false, error: `渠道 ${channel.name} 配置错误：${e?.message ?? e}` };
  }
}
