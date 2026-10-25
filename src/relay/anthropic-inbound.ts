import type { ChatRequest } from './adaptor';
import type { Usage } from '../lib/billing';

/**
 * Inbound Anthropic Messages API support — the mirror of `anthropic.ts`.
 *
 * `anthropic.ts` speaks Anthropic to an *upstream*. This speaks Anthropic to a
 * *client*: point Claude Code / OpenClaw at this gateway via ANTHROPIC_BASE_URL
 * (requests arrive in Anthropic's shape and must be answered in it, whatever
 * the channel behind them actually is).
 */

export interface AnthropicRequest {
  model: string;
  messages: Array<{ role: string; content: any }>;
  system?: string | Array<{ type: string; text?: string }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema?: any }>;
  tool_choice?: { type: string; name?: string };
  [k: string]: any;
}

/** Anthropic request -> the OpenAI-shaped request the router and adaptors expect. */
export function anthropicToChatRequest(req: AnthropicRequest): ChatRequest {
  const messages: ChatRequest['messages'] = [];

  const systemText = systemToText(req.system);
  if (systemText) messages.push({ role: 'system', content: systemText });

  for (const m of req.messages ?? []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    // A single Anthropic message can carry text, tool calls and tool results at
    // once; OpenAI needs those split across separate messages.
    const parts: any[] = [];
    const toolCalls: any[] = [];
    for (const block of m.content) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text });
      else if (block.type === 'image' && block.source) {
        const url =
          block.source.type === 'base64'
            ? `data:${block.source.media_type};base64,${block.source.data}`
            : block.source.url;
        parts.push({ type: 'image_url', image_url: { url } });
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
      } else if (block.type === 'tool_result') {
        // Tool results are their own message in OpenAI and must precede any
        // further user content, so flush them immediately.
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: blockToText(block.content) });
      }
    }

    if (m.role === 'assistant') {
      if (parts.length || toolCalls.length) {
        const msg: any = { role: 'assistant', content: parts.length ? parts.map((p) => p.text ?? '').join('') : null };
        if (toolCalls.length) msg.tool_calls = toolCalls;
        messages.push(msg);
      }
    } else if (parts.length) {
      messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    }
  }

  const out: ChatRequest = { model: req.model, messages, stream: !!req.stream };
  if (typeof req.max_tokens === 'number') out.max_tokens = req.max_tokens;
  if (typeof req.temperature === 'number') out.temperature = req.temperature;
  if (typeof req.top_p === 'number') out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } },
    }));
    if (req.tool_choice?.type === 'any') out.tool_choice = 'required';
    else if (req.tool_choice?.type === 'tool' && req.tool_choice.name) {
      out.tool_choice = { type: 'function', function: { name: req.tool_choice.name } };
    }
  }
  return out;
}

/** OpenAI chat completion -> Anthropic Message. */
export function chatResponseToAnthropic(json: any, model: string): any {
  const choice = json?.choices?.[0];
  const content: any[] = [];
  const text = choice?.message?.content;
  if (typeof text === 'string' && text) content.push({ type: 'text', text });
  for (const tc of choice?.message?.tool_calls ?? []) {
    let input: any = {};
    try {
      input = JSON.parse(tc.function?.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  // Anthropic rejects an empty content array.
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: json?.id ?? `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: json?.usage?.prompt_tokens ?? 0,
      output_tokens: json?.usage?.completion_tokens ?? 0,
    },
  };
}

function mapFinishReason(reason: string | undefined | null): string {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

export interface AnthropicEncoderState {
  id: string;
  started: boolean;
  /** Index of the block currently open, or -1 when none is. */
  openBlock: number;
  /** What kind of block is currently open, so a change of kind closes it. */
  openBlockKind: 'text' | 'thinking' | 'tool' | null;
  nextIndex: number;
  /** Maps an OpenAI tool_call index to the Anthropic block index it opened. */
  toolBlocks: Map<number, number>;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  stopped: boolean;
}

export function newAnthropicEncoder(): AnthropicEncoderState {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    started: false,
    openBlock: -1,
    openBlockKind: null,
    nextIndex: 0,
    toolBlocks: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    stopReason: 'end_turn',
    stopped: false,
  };
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Turns one OpenAI stream chunk into the Anthropic events it implies.
 *
 * Anthropic's stream is explicitly bracketed — every content block is opened
 * and closed — whereas OpenAI just emits deltas. This tracks which block is
 * open so text and tool calls interleave correctly.
 */
export function encodeAnthropicChunk(chunk: any, model: string, state: AnthropicEncoderState): string {
  let out = '';

  if (!state.started) {
    state.started = true;
    state.inputTokens = chunk?.usage?.prompt_tokens ?? state.inputTokens;
    out += event('message_start', {
      type: 'message_start',
      message: {
        id: state.id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: state.inputTokens, output_tokens: 0 },
      },
    });
  }

  if (chunk?.usage) {
    state.inputTokens = chunk.usage.prompt_tokens ?? state.inputTokens;
    state.outputTokens = chunk.usage.completion_tokens ?? state.outputTokens;
  }

  const choice = chunk?.choices?.[0];
  const delta = choice?.delta;

  /** Opens a block of `kind`, closing whatever was open if it differs. */
  const open = (kind: 'text' | 'thinking' | 'tool', block: unknown): string => {
    if (state.openBlockKind === kind) return '';
    let s = '';
    if (state.openBlock !== -1) s += event('content_block_stop', { type: 'content_block_stop', index: state.openBlock });
    state.openBlock = state.nextIndex++;
    state.openBlockKind = kind;
    s += event('content_block_start', { type: 'content_block_start', index: state.openBlock, content_block: block });
    return s;
  };

  // OpenAI-compatible reasoning models stream their chain of thought as
  // `reasoning_content`. Anthropic's equivalent is a thinking block — dropping
  // it would make a reasoning model look like it produced nothing at all.
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
    out += open('thinking', { type: 'thinking', thinking: '' });
    out += event('content_block_delta', {
      type: 'content_block_delta',
      index: state.openBlock,
      delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
    });
  }

  if (typeof delta?.content === 'string' && delta.content) {
    out += open('text', { type: 'text', text: '' });
    out += event('content_block_delta', {
      type: 'content_block_delta',
      index: state.openBlock,
      delta: { type: 'text_delta', text: delta.content },
    });
  }

  for (const tc of delta?.tool_calls ?? []) {
    const key = tc.index ?? 0;
    if (!state.toolBlocks.has(key)) {
      // Each tool call gets its own block, so force a fresh one even when a
      // tool block is already open for a *different* call.
      state.openBlockKind = null;
      out += open('tool', {
        type: 'tool_use',
        id: tc.id ?? `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        name: tc.function?.name ?? '',
        input: {},
      });
      state.toolBlocks.set(key, state.openBlock);
    }
    const args = tc.function?.arguments;
    if (args) {
      out += event('content_block_delta', {
        type: 'content_block_delta',
        index: state.toolBlocks.get(key),
        delta: { type: 'input_json_delta', partial_json: args },
      });
    }
  }

  if (choice?.finish_reason) state.stopReason = mapFinishReason(choice.finish_reason);
  return out;
}

/** Closes the stream. Safe to call twice; the second call emits nothing. */
export function finishAnthropicStream(state: AnthropicEncoderState, usage?: Usage): string {
  if (state.stopped) return '';
  state.stopped = true;
  let out = '';
  // A stream that produced nothing still needs a well-formed message.
  if (!state.started) {
    out += event('message_start', {
      type: 'message_start',
      message: { id: state.id, type: 'message', role: 'assistant', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }
  if (state.openBlock !== -1) out += event('content_block_stop', { type: 'content_block_stop', index: state.openBlock });
  // OpenAI-compatible upstreams only report usage at the end of the stream, so
  // message_start could not carry real input_tokens. Report both here.
  out += event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: state.stopReason, stop_sequence: null },
    usage: {
      input_tokens: usage?.prompt_tokens ?? state.inputTokens,
      output_tokens: usage?.completion_tokens ?? state.outputTokens,
    },
  });
  out += event('message_stop', { type: 'message_stop' });
  return out;
}

export function anthropicError(message: string, type = 'api_error'): unknown {
  return { type: 'error', error: { type, message } };
}

function systemToText(system: AnthropicRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text ?? '').join('\n');
}

function blockToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b))).join('');
  return JSON.stringify(content ?? '');
}
