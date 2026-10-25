import type { ChatRequest } from './adaptor';
import type { Usage } from '../lib/billing';

/**
 * 入站翻译器：OpenAI Responses 形状 ⇄ 网关中枢（OpenAI Chat Completion）。
 *
 * 客户端用 Responses 形状打 `POST /v1/responses`，网关翻译成 chat 去选路、计费，
 * 再把 chat 的响应/流翻译回 Responses 形状——上游是什么方言与客户端无关。
 *
 * 有状态语义：本网关是**无状态代理**，不存对话树。`previous_response_id` 无法被
 * 服务，直接 400（客户端应自行携带完整上下文）；`store` 只控制服务端要不要留档，
 * 网关从不留档，忽略之。这是刻意的语义选择，不是能力缺失的遮掩。
 */

export class ResponsesInboundError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Responses 请求 → 中枢 ChatRequest。不合法处抛 ResponsesInboundError。 */
export function responsesToChatRequest(raw: any): ChatRequest {
  if (!raw || typeof raw !== 'object') throw new ResponsesInboundError('请求体不是合法的 JSON 对象');
  if (raw.previous_response_id !== undefined && raw.previous_response_id !== null) {
    throw new ResponsesInboundError(
      '本网关是无状态代理，不支持 previous_response_id（无法引用历史响应）。请携带完整对话上下文重试。',
    );
  }

  const req: ChatRequest = { model: String(raw.model ?? '') };
  const messages: ChatRequest['messages'] = [];

  if (typeof raw.instructions === 'string' && raw.instructions) {
    messages.push({ role: 'system', content: raw.instructions });
  }

  const input = raw.input;
  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item === null || item === undefined) continue;
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
        continue;
      }
      // message item：带 role 的对话消息
      if (typeof item.role === 'string') {
        messages.push({ role: normalizeRole(item.role), content: responsesContentToChat(item.content) });
        continue;
      }
      // function_call item：上一轮模型发起的工具调用
      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: String(item.call_id ?? item.id ?? ''), type: 'function', function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') } }],
        });
        continue;
      }
      // function_call_output item：工具执行结果
      if (item.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: String(item.call_id ?? ''), content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
        continue;
      }
      // reasoning 等状态 item：中枢形状无处安放，跳过（不影响请求语义）。
    }
  } else if (input !== undefined) {
    throw new ResponsesInboundError('input 必须是字符串或 item 数组');
  }

  if (raw.max_output_tokens !== undefined) req.max_tokens = Number(raw.max_output_tokens) || undefined;
  if (raw.temperature !== undefined) req.temperature = raw.temperature;
  if (raw.top_p !== undefined) req.top_p = raw.top_p;
  if (raw.stream !== undefined) req.stream = !!raw.stream;
  if (Array.isArray(raw.tools) && raw.tools.length) {
    req.tools = raw.tools.map((t: any) =>
      t?.type === 'function' && t.name
        ? { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }
        : t,
    );
  }
  if (raw.tool_choice !== undefined) {
    req.tool_choice =
      raw.tool_choice && typeof raw.tool_choice === 'object' && raw.tool_choice.type === 'function' && raw.tool_choice.name
        ? { type: 'function', function: { name: raw.tool_choice.name } }
        : raw.tool_choice;
  }
  req.messages = messages;
  return req;
}

function normalizeRole(role: string): string {
  // 'developer' 是 Responses 对 system 的新叫法。
  if (role === 'developer' || role === 'system') return 'system';
  if (role === 'assistant') return 'assistant';
  return 'user';
}

function responsesContentToChat(content: any): any {
  if (content === undefined || content === null || typeof content === 'string') return content ?? '';
  if (Array.isArray(content)) {
    const parts: any[] = [];
    for (const p of content) {
      if (typeof p === 'string') { parts.push({ type: 'text', text: p }); continue; }
      if (p?.type === 'input_text' || p?.type === 'output_text' || p?.type === 'text') {
        parts.push({ type: 'text', text: String(p.text ?? '') });
      } else if (p?.type === 'input_image') {
        parts.push({ type: 'image_url', image_url: { url: String(p.image_url ?? ''), detail: p.detail } });
      }
      // 其余 part 类型（audio 等）中枢不支持，跳过。
    }
    return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
  }
  return JSON.stringify(content);
}

// ---------------------------------------------------------------- 响应翻译

/** 中枢 chat completion JSON → Responses JSON。 */
export function chatResponseToResponses(chat: any, model: string): any {
  const msg = chat?.choices?.[0]?.message ?? {};
  const output: any[] = [];
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }] });
  }
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text) {
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
  }
  for (const tc of msg.tool_calls ?? []) {
    output.push({
      type: 'function_call',
      id: `fc_${String(tc.id ?? '')}`,
      call_id: String(tc.id ?? ''),
      name: String(tc.function?.name ?? ''),
      arguments: String(tc.function?.arguments ?? '{}'),
    });
  }
  const u = chat?.usage ?? {};
  return {
    id: String(chat?.id ?? ''),
    object: 'response',
    created_at: Number(chat?.created ?? Math.floor(Date.now() / 1000)),
    status: 'completed',
    model,
    output,
    parallel_tool_calls: true,
    usage: {
      input_tokens: Number(u.prompt_tokens ?? 0),
      output_tokens: Number(u.completion_tokens ?? 0),
      total_tokens: Number(u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
      input_tokens_details: { cached_tokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0) },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

// ---------------------------------------------------------------- 流式翻译

export interface ResponsesEncoder {
  responseId: string;
  outputIndex: number;
  messageOpened: boolean;
  /** 正在流式输出的 function_call（chat 侧 index → 输出序号）。 */
  callIndex: Map<number, number>;
  /** 按 chat 侧 index 累积的工具调用——最终 output 里要给出完整 function_call。 */
  calls: Map<number, { callId: string; name: string; args: string }>;
  textAcc: string;
  reasoningAcc: string;
  hasText: boolean;
  hasReasoning: boolean;
  messageItemId: string;
  /** 中枢侧的 finish_reason（'length' → 最终事件是 response.incomplete）。 */
  finishReason: string | null;
  /** 上游失败透传（chat chunk 带 error）时的错误信息。 */
  errorMsg: string | null;
  finished: boolean;
}

export function newResponsesEncoder(): ResponsesEncoder {
  return {
    responseId: '',
    outputIndex: 0,
    messageOpened: false,
    callIndex: new Map(),
    calls: new Map(),
    textAcc: '',
    reasoningAcc: '',
    hasText: false,
    hasReasoning: false,
    messageItemId: 'msg_1',
    finishReason: null,
    errorMsg: null,
    finished: false,
  };
}

/** 编码器累积出的 output items——最终响应对象要带完整内容，不能是空数组。 */
function encoderOutput(enc: ResponsesEncoder): any[] {
  const items: any[] = [];
  if (enc.hasReasoning) {
    items.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: enc.reasoningAcc }] });
  }
  if (enc.hasText) {
    items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: enc.textAcc, annotations: [] }] });
  }
  for (const call of enc.calls.values()) {
    items.push({ type: 'function_call', id: `fc_${call.callId}`, call_id: call.callId, name: call.name, arguments: call.args || '{}', status: 'completed' });
  }
  return items;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 流中途出错时的收尾事件（response.failed 携带 error）。 */
export function responsesErrorEvent(model: string, message: string): string {
  return sse('response.failed', {
    type: 'response.failed',
    response: { ...baseResponse(`resp_${Date.now()}`, model, 'failed'), error: { code: 'upstream_error', message } },
  });
}

/** 一个中枢 chat chunk → 零或多个 Responses SSE 事件。 */
export function encodeResponsesChunk(enc: ResponsesEncoder, chatChunk: any, model: string): string {
  if (enc.finished) return '';
  let out = '';
  const delta = chatChunk?.choices?.[0]?.delta;

  // 中枢 chunk 携带 error（上游失败透传）→ 立即以 response.failed 终止。
  if (chatChunk?.error) {
    enc.finished = true;
    enc.errorMsg = String(chatChunk.error.message ?? 'upstream error');
    return sse('response.failed', {
      type: 'response.failed',
      response: { ...baseResponse(enc.responseId || `resp_${Date.now()}`, model, 'failed'), error: { code: chatChunk.error.code ?? 'upstream_error', message: enc.errorMsg } },
    });
  }

  if (!enc.responseId) {
    enc.responseId = String(chatChunk?.id ?? `resp_${Date.now()}`);
    out += sse('response.created', {
      type: 'response.created',
      response: baseResponse(enc.responseId, model, 'in_progress'),
    });
  }

  // finish_reason：'length' 在最终事件里表达为 response.incomplete（截断不是成功）。
  const finish = chatChunk?.choices?.[0]?.finish_reason;
  if (finish) enc.finishReason = String(finish);

  // 推理内容（Claude Code 等客户端把它当 thinking 展示）
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
    enc.hasReasoning = true;
    enc.reasoningAcc += delta.reasoning_content;
    out += sse('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: delta.reasoning_content,
    });
  }

  // 文本增量
  if (typeof delta?.content === 'string' && delta.content) {
    if (!enc.messageOpened) {
      enc.messageOpened = true;
      enc.hasText = true;
      const idx = enc.outputIndex++;
      out += sse('response.output_item.added', {
        type: 'response.output_item.added', output_index: idx,
        item: { type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      });
      out += sse('response.content_part.added', {
        type: 'response.content_part.added', item_id: enc.messageItemId, output_index: idx, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    enc.textAcc += delta.content;
    out += sse('response.output_text.delta', {
      type: 'response.output_text.delta', item_id: enc.messageItemId, output_index: enc.outputIndex - 1, content_index: 0, delta: delta.content,
    });
  }

  // 工具调用增量：按 chat 侧 index 累积完整参数——function_call 不做增量，
  // 输出项在流末尾的 output 数组里整体给出。
  for (const tc of delta?.tool_calls ?? []) {
    const idx = Number(tc.index ?? 0);
    let entry = enc.calls.get(idx);
    if (!entry) {
      entry = { callId: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), args: '' };
      enc.calls.set(idx, entry);
    }
    if (tc.function?.name) entry.name = String(tc.function.name);
    if (tc.id) entry.callId = String(tc.id);
    if (tc.function?.arguments) entry.args += tc.function.arguments;
  }

  return out;
}

/** 流末尾：失败 → response.failed；截断 → response.incomplete；否则 completed（output 带完整内容）。 */
export function finishResponsesStream(enc: ResponsesEncoder, model: string, usage?: Usage): string {
  if (enc.finished) return '';
  enc.finished = true;
  const u = usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (enc.errorMsg) {
    return sse('response.failed', {
      type: 'response.failed',
      response: { ...baseResponse(enc.responseId || `resp_${Date.now()}`, model, 'failed'), error: { code: 'upstream_error', message: enc.errorMsg } },
    });
  }
  const incomplete = enc.finishReason === 'length';
  const response: any = {
    ...baseResponse(enc.responseId || `resp_${Date.now()}`, model, incomplete ? 'incomplete' : 'completed'),
    output: encoderOutput(enc),
    usage: {
      input_tokens: Number(u.prompt_tokens ?? 0),
      output_tokens: Number(u.completion_tokens ?? 0),
      total_tokens: Number(u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  if (incomplete) response.incomplete_details = { reason: 'max_output_tokens' };
  return sse(incomplete ? 'response.incomplete' : 'response.completed', {
    type: incomplete ? 'response.incomplete' : 'response.completed',
    response,
  });
}

function baseResponse(id: string, model: string, status: string) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [],
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    text: { format: { type: 'text' } },
    truncation: 'disabled',
    user: null,
  };
}
