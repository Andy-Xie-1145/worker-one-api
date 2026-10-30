import type { ChannelRow } from '../types';
import type { Usage } from '../lib/billing';

/** Minimal shape of the OpenAI chat-completions request we route on. */
export interface ChatRequest {
  model: string;
  messages?: Array<{ role: string; content: any; name?: string; tool_calls?: any; tool_call_id?: string }>;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: any[];
  tool_choice?: any;
  n?: number;
  input?: any;
  [k: string]: any;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * 'decisions' 是 OpenRouter 的 Decisions API（见 relay/decisions.ts）：请求体和
 * 响应都不是 chat 形状，只有选路/计费/重试和其它模式共用。
 */
export type RelayMode = 'chat' | 'embeddings' | 'completions' | 'passthrough' | 'decisions';

export interface AdaptorContext {
  channel: ChannelRow;
  /** Model name after model_mapping is applied — what the upstream should see. */
  upstreamModel: string;
  /** Model name the client asked for — what gets billed and echoed back. */
  requestedModel: string;
  mode: RelayMode;
  /** Path suffix after /v1, e.g. "chat/completions". */
  path: string;
  config: Record<string, any>;
}

export interface Adaptor {
  name: string;
  defaultBaseURL: string;
  /** Human-facing label for the admin UI. */
  label: string;
  /**
   * 这个 adaptor 的**协议形状**能不能承载 mode='decisions'（Bearer + JSON body）。
   *
   * 这只是必要条件，不是充分条件：能不能真的打决策接口由**渠道**决定，见
   * relay/decisions.ts 的 decisionsSupport()。少了这个标记，一个 anthropic 渠道
   * 要是被配上了 Jev，buildRequest 会安静地把它当成一次普通 chat 发出去。
   */
  supportsDecisions?: boolean;
  buildRequest(req: ChatRequest, ctx: AdaptorContext): BuiltRequest;
  /** Convert a non-streaming upstream response into OpenAI shape. */
  convertResponse(json: any, ctx: AdaptorContext): { body: any; usage: Usage };
  /**
   * Convert one upstream SSE event into zero or more OpenAI-format chunks.
   * Return usage when the event carries it.
   */
  convertStreamEvent(
    event: { event?: string; data: string },
    ctx: AdaptorContext,
    state: StreamState,
  ): { chunks: any[]; usage?: Usage; done?: boolean };
}

export interface StreamState {
  id: string;
  created: number;
  textAcc: string;
  promptTokens: number;
  completionTokens: number;
  /** Anthropic 流式：message_start 报来的缓存读 token（含在 promptTokens 里）。 */
  cacheReadTokens?: number;
  /** Anthropic 流式：缓存写入 5m/1h 分桶（含在 promptTokens 里）。 */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  [k: string]: any;
}

export function newStreamState(): StreamState {
  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    created: Math.floor(Date.now() / 1000),
    textAcc: '',
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

export function joinURL(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
