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
 *
 * 推理过程（reasoning）：OpenAI 兼容上游把思维链放在 `reasoning_content`
 * （部分厂商叫 `reasoning`），Messages/Responses 原生上游放在各自的结构里，
 * adaptor 统一收敛到 `reasoning_content`。本文件把它还原成 Responses 的
 * `reasoning` 输出项 + `response.reasoning_summary_text.*` 事件，并把
 * `usage.output_tokens_details.reasoning_tokens` 如实回传——**推理过程要能被客户端
 * 看见，不能只算 token 不返回内容**。
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
        const role = normalizeRole(item.role);
        const content = responsesContentToChat(item.content);
        // 连续 assistant 文本（agent 历史里 tool 调用前后的文本）并成一条，
        // 否则翻译到 Anthropic/Gemini 会出现「连续两条 assistant」的畸形历史。
        const last = messages[messages.length - 1];
        if (role === 'assistant' && last?.role === 'assistant') {
          last.content = joinContent(last.content, content);
          continue;
        }
        messages.push({ role, content });
        continue;
      }
      // function_call item：上一轮模型发起的工具调用
      if (item.type === 'function_call') {
        const call = { id: String(item.call_id ?? item.id ?? ''), type: 'function' as const, function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') } };
        // agent 历史是「assistant 文本 item + function_call item」分开给的——并进同一条
        // assistant 消息（chat 形状本来就是 content + tool_calls 同体）。
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          (last as any).tool_calls = [...((last as any).tool_calls ?? []), call];
          continue;
        }
        messages.push({ role: 'assistant', content: null, tool_calls: [call] } as any);
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
  // reasoning.effort → chat 的 reasoning_effort（o 系列/兼容上游都认这个字段）。
  // 只有客户端显式给了才透传：给普通模型塞 reasoning_effort 有的上游会直接 400。
  const effort = raw.reasoning && typeof raw.reasoning === 'object' ? raw.reasoning.effort : undefined;
  if (typeof effort === 'string' && effort) (req as any).reasoning_effort = effort;
  // text.format → chat 的 response_format（结构化输出）。
  const format = raw.text && typeof raw.text === 'object' ? raw.text.format : undefined;
  const responseFormat = responsesFormatToChat(format);
  if (responseFormat) (req as any).response_format = responseFormat;
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

/** Responses 的 `text.format` → chat 的 `response_format`；不认识的形状返回 null（不猜）。 */
function responsesFormatToChat(format: any): any {
  if (!format || typeof format !== 'object') return null;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema' && format.schema && typeof format.schema === 'object') {
    return {
      type: 'json_schema',
      json_schema: {
        name: String(format.name ?? 'response'),
        schema: format.schema,
        ...(format.strict !== undefined ? { strict: !!format.strict } : {}),
      },
    };
  }
  return null;
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
      } else if (p?.type === 'input_image' || p?.type === 'image_url') {
        // Responses 规范里 input_image.image_url 是**字符串**（data: 或 https:）；
        // 也有客户端发对象 {url, detail}，两种都收编成 chat 的 image_url。
        const raw = p.image_url ?? p.url ?? p.source;
        const url = typeof raw === 'string' ? raw : typeof raw?.url === 'string' ? raw.url : '';
        const detail = p.detail ?? (typeof raw === 'object' ? raw?.detail : undefined);
        if (url) parts.push({ type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } });
      }
      // 其余 part 类型（audio、file 等）中枢不支持，跳过。
    }
    return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
  }
  return JSON.stringify(content);
}

/** 合并两段消息内容（连续 assistant 文本并成一条时用）。 */
function joinContent(a: any, b: any): any {
  if (a === undefined || a === null || a === '') return b;
  if (b === undefined || b === null || b === '') return a;
  if (Array.isArray(a) || Array.isArray(b)) {
    const asParts = (x: any) => (Array.isArray(x) ? x : [{ type: 'text', text: String(x) }]);
    return [...asParts(a), ...asParts(b)];
  }
  return `${a}\n${b}`;
}

/** chat 的 content（字符串或多模态数组）→ 纯文本。 */
function chatContentText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === 'text' || p?.type === 'output_text' || p?.type === 'input_text')
      .map((p: any) => String(p.text ?? ''))
      .join('');
  }
  return '';
}

/** 上游 chat 响应里的推理文本：`reasoning_content` / `reasoning` 都认。 */
function reasoningText(msg: any): string {
  const a = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '';
  if (a) return a;
  return typeof msg?.reasoning === 'string' ? msg.reasoning : '';
}

// ---------------------------------------------------------------- 响应翻译

/** 中枢 chat completion JSON → Responses JSON。 */
export function chatResponseToResponses(chat: any, model: string): any {
  const choice = chat?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const id = String(chat?.id ?? '');
  const output: any[] = [];

  const reasoning = reasoningText(msg);
  if (reasoning) {
    output.push({ id: `rs_${id || 'r'}`, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: reasoning }] });
  }
  const text = chatContentText(msg.content);
  if (text) {
    output.push({
      id: `msg_${id || 'm'}`,
      type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const tc of msg.tool_calls ?? []) {
    output.push({
      id: `fc_${String(tc.id ?? '')}`,
      type: 'function_call',
      status: 'completed',
      call_id: String(tc.id ?? ''),
      name: String(tc.function?.name ?? ''),
      arguments: String(tc.function?.arguments ?? '{}'),
    });
  }

  // 截断不是成功：finish_reason=length → status=incomplete（与流式同一口径）。
  const incomplete = String(choice.finish_reason ?? '') === 'length';
  const u = chat?.usage ?? {};
  const response: any = {
    id,
    object: 'response',
    created_at: Number(chat?.created ?? Math.floor(Date.now() / 1000)),
    status: incomplete ? 'incomplete' : 'completed',
    model,
    output,
    parallel_tool_calls: true,
    usage: {
      input_tokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0),
      output_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0),
      total_tokens: Number(u.total_tokens ?? (Number(u.prompt_tokens ?? 0) + Number(u.completion_tokens ?? 0))),
      input_tokens_details: { cached_tokens: Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0) },
      output_tokens_details: {
        reasoning_tokens: Number(u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? 0),
      },
    },
  };
  if (incomplete) response.incomplete_details = { reason: 'max_output_tokens' };
  return response;
}

// ---------------------------------------------------------------- 流式翻译

interface ReasoningState { index: number; itemId: string; acc: string; }
interface MessageState { index: number; itemId: string; acc: string; }
interface CallState { index: number; itemId: string; callId: string; name: string; args: string; opened: boolean; }

export interface ResponsesEncoder {
  responseId: string;
  created: number;
  /** 下一个输出项的 output_index（reasoning / message / function_call 共用一条序列）。 */
  nextIndex: number;
  reasoning: ReasoningState | null;
  message: MessageState | null;
  /** 按 chat 侧 index 累积的工具调用。 */
  calls: Map<number, CallState>;
  /** 中枢侧的 finish_reason（'length' → 最终事件是 response.incomplete）。 */
  finishReason: string | null;
  /** 上游失败透传（chat chunk 带 error）时的错误信息。 */
  errorMsg: string | null;
  finished: boolean;
  /** 上游 usage 明细（部分上游只在最后一个 chunk 给）。 */
  cachedTokens: number;
  reasoningTokens: number;
}

export function newResponsesEncoder(): ResponsesEncoder {
  return {
    responseId: '',
    created: 0,
    nextIndex: 0,
    reasoning: null,
    message: null,
    calls: new Map(),
    finishReason: null,
    errorMsg: null,
    finished: false,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

/** 编码器累积出的 output items——最终响应对象要带完整内容，不能是空数组。 */
function encoderOutput(enc: ResponsesEncoder): any[] {
  const items: Array<{ index: number; item: any }> = [];
  if (enc.reasoning) {
    items.push({
      index: enc.reasoning.index,
      item: {
        id: enc.reasoning.itemId, type: 'reasoning', status: 'completed',
        summary: [{ type: 'summary_text', text: enc.reasoning.acc }],
      },
    });
  }
  if (enc.message) {
    items.push({
      index: enc.message.index,
      item: {
        id: enc.message.itemId, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: enc.message.acc, annotations: [] }],
      },
    });
  }
  for (const call of enc.calls.values()) {
    items.push({
      index: call.index,
      item: {
        id: call.itemId, type: 'function_call', status: 'completed',
        call_id: call.callId, name: call.name, arguments: call.args || '{}',
      },
    });
  }
  return items.sort((a, b) => a.index - b.index).map((i) => i.item);
}

/** 每个已打开的输出项补齐官方规定的 “*.done” 事件（客户端靠它们归档/收尾）。 */
function encoderDoneEvents(enc: ResponsesEncoder): string {
  const parts: Array<{ index: number; text: string }> = [];
  if (enc.reasoning) {
    const { index, itemId, acc } = enc.reasoning;
    parts.push({ index, text:
      sse('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: itemId, output_index: index, summary_index: 0, text: acc }) +
      sse('response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', item_id: itemId, output_index: index, summary_index: 0, part: { type: 'summary_text', text: acc } }) +
      sse('response.output_item.done', { type: 'response.output_item.done', output_index: index, item: { id: itemId, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: acc }] } }),
    });
  }
  if (enc.message) {
    const { index, itemId, acc } = enc.message;
    parts.push({ index, text:
      sse('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: index, content_index: 0, text: acc }) +
      sse('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: index, content_index: 0, part: { type: 'output_text', text: acc, annotations: [] } }) +
      sse('response.output_item.done', { type: 'response.output_item.done', output_index: index, item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: acc, annotations: [] }] } }),
    });
  }
  for (const call of enc.calls.values()) {
    if (!call.opened) continue;
    parts.push({ index: call.index, text:
      sse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: call.itemId, output_index: call.index, arguments: call.args || '{}' }) +
      sse('response.output_item.done', { type: 'response.output_item.done', output_index: call.index, item: { id: call.itemId, type: 'function_call', status: 'completed', call_id: call.callId, name: call.name, arguments: call.args || '{}' } }),
    });
  }
  return parts.sort((a, b) => a.index - b.index).map((p) => p.text).join('');
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
  const choice = chatChunk?.choices?.[0];
  const delta = choice?.delta;

  // 中枢 chunk 携带 error（上游失败透传）→ 立即以 response.failed 终止。
  if (chatChunk?.error) {
    enc.finished = true;
    enc.errorMsg = String(chatChunk.error.message ?? 'upstream error');
    return sse('response.failed', {
      type: 'response.failed',
      response: { ...baseResponse(enc.responseId || `resp_${Date.now()}`, model, 'failed'), error: { code: chatChunk.error.code ?? 'upstream_error', message: enc.errorMsg } },
    });
  }

  // usage 明细：有的上游只在最后一个（choices 为空的）chunk 给，先记下来，收尾时用。
  const u = chatChunk?.usage;
  if (u) {
    const reasoning = Number(u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? 0);
    if (Number.isFinite(reasoning) && reasoning >= 0) enc.reasoningTokens = reasoning;
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0);
    if (Number.isFinite(cached) && cached > 0) enc.cachedTokens = cached;
  }

  if (!enc.responseId) {
    enc.responseId = String(chatChunk?.id ?? `resp_${Date.now()}`);
    enc.created = Number(chatChunk?.created ?? Math.floor(Date.now() / 1000));
    out += sse('response.created', { type: 'response.created', response: baseResponse(enc.responseId, model, 'in_progress') });
    out += sse('response.in_progress', { type: 'response.in_progress', response: baseResponse(enc.responseId, model, 'in_progress') });
  }

  // finish_reason：'length' 在最终事件里表达为 response.incomplete（截断不是成功）。
  const finish = choice?.finish_reason;
  if (finish) enc.finishReason = String(finish);

  // 推理内容：先开 reasoning 输出项，再逐个 delta。
  const reasoningDelta = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';
  if (reasoningDelta) {
    if (!enc.reasoning) {
      const index = enc.nextIndex++;
      const itemId = `rs_${enc.responseId || Date.now()}`;
      enc.reasoning = { index, itemId, acc: '' };
      out += sse('response.output_item.added', {
        type: 'response.output_item.added', output_index: index,
        item: { id: itemId, type: 'reasoning', status: 'in_progress', summary: [] },
      });
      out += sse('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added', item_id: itemId, output_index: index, summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
    }
    enc.reasoning.acc += reasoningDelta;
    out += sse('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta', item_id: enc.reasoning.itemId,
      output_index: enc.reasoning.index, summary_index: 0, delta: reasoningDelta,
    });
  }

  // 文本增量
  if (typeof delta?.content === 'string' && delta.content) {
    if (!enc.message) {
      const index = enc.nextIndex++;
      const itemId = `msg_${enc.responseId || Date.now()}`;
      enc.message = { index, itemId, acc: '' };
      out += sse('response.output_item.added', {
        type: 'response.output_item.added', output_index: index,
        item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      });
      out += sse('response.content_part.added', {
        type: 'response.content_part.added', item_id: itemId, output_index: index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    enc.message.acc += delta.content;
    out += sse('response.output_text.delta', {
      type: 'response.output_text.delta', item_id: enc.message.itemId,
      output_index: enc.message.index, content_index: 0, delta: delta.content,
    });
  }

  // 工具调用增量：按 chat 侧 index 累积完整参数；首个增量时开 output item。
  for (const tc of delta?.tool_calls ?? []) {
    const idx = Number(tc.index ?? 0);
    let entry = enc.calls.get(idx);
    if (!entry) {
      const index = enc.nextIndex++;
      entry = { index, itemId: `fc_${String(tc.id ?? index)}`, callId: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), args: '', opened: false };
      enc.calls.set(idx, entry);
    }
    if (tc.function?.name) entry.name = String(tc.function.name);
    if (tc.id) { entry.callId = String(tc.id); entry.itemId = `fc_${entry.callId}`; }
    if (!entry.opened && (entry.name || entry.callId)) {
      entry.opened = true;
      out += sse('response.output_item.added', {
        type: 'response.output_item.added', output_index: entry.index,
        item: { id: entry.itemId, type: 'function_call', status: 'in_progress', call_id: entry.callId, name: entry.name, arguments: '' },
      });
    }
    if (tc.function?.arguments) {
      entry.args += tc.function.arguments;
      out += sse('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta', item_id: entry.itemId, output_index: entry.index, delta: tc.function.arguments,
      });
    }
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
      input_tokens_details: { cached_tokens: enc.cachedTokens || Number(u.cached_tokens ?? 0) },
      output_tokens_details: { reasoning_tokens: enc.reasoningTokens },
    },
  };
  if (incomplete) response.incomplete_details = { reason: 'max_output_tokens' };
  return (
    encoderDoneEvents(enc) +
    sse(incomplete ? 'response.incomplete' : 'response.completed', {
      type: incomplete ? 'response.incomplete' : 'response.completed',
      response,
    })
  );
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
