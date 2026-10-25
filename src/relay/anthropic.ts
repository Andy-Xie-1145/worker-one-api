import { type Adaptor, type AdaptorContext, type ChatRequest, type StreamState, joinURL } from './adaptor';
import type { Usage } from '../lib/billing';

const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

/** Native Anthropic Messages API <-> OpenAI chat-completions. */
export const anthropicAdaptor: Adaptor = {
  name: 'anthropic',
  label: 'Anthropic Messages',
  defaultBaseURL: 'https://api.anthropic.com',

  buildRequest(req: ChatRequest, ctx: AdaptorContext) {
    const base = ctx.channel.base_url || anthropicAdaptor.defaultBaseURL;
    const { system, messages } = splitSystem(req.messages ?? [], ctx.channel.system_prompt);

    const body: Record<string, any> = {
      model: ctx.upstreamModel,
      messages,
      max_tokens: req.max_tokens ?? req.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
      stream: !!req.stream,
    };
    if (system) body.system = system;
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (typeof req.top_p === 'number') body.top_p = req.top_p;
    if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    if (req.tools?.length) {
      body.tools = req.tools
        .filter((t: any) => t.type === 'function' && t.function)
        .map((t: any) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }));
      if (req.tool_choice === 'required') body.tool_choice = { type: 'any' };
      else if (req.tool_choice === 'none') delete body.tools;
      else if (typeof req.tool_choice === 'object' && req.tool_choice?.function?.name) {
        body.tool_choice = { type: 'tool', name: req.tool_choice.function.name };
      }
    }

    return {
      url: joinURL(base, 'v1/messages'),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ctx.channel.key,
        'anthropic-version': ctx.config.api_version || DEFAULT_VERSION,
      },
      body: JSON.stringify(body),
    };
  },

  convertResponse(json: any, ctx: AdaptorContext) {
    const usage: Usage = {
      prompt_tokens: json?.usage?.input_tokens ?? 0,
      completion_tokens: json?.usage?.output_tokens ?? 0,
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    let text = '';
    const toolCalls: any[] = [];
    for (const block of json?.content ?? []) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }

    const message: Record<string, any> = { role: 'assistant', content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls;

    return {
      body: {
        id: json?.id ?? `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: ctx.requestedModel,
        choices: [{ index: 0, message, finish_reason: mapStopReason(json?.stop_reason) }],
        usage,
      },
      usage,
    };
  },

  convertStreamEvent(event, ctx, state: StreamState) {
    let json: any;
    try {
      json = JSON.parse(event.data);
    } catch {
      return { chunks: [] };
    }
    const type = json.type ?? event.event;
    const base = { id: state.id, object: 'chat.completion.chunk', created: state.created, model: ctx.requestedModel };

    switch (type) {
      case 'message_start': {
        state.promptTokens = json.message?.usage?.input_tokens ?? 0;
        return { chunks: [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }] };
      }
      case 'content_block_start': {
        const block = json.content_block;
        if (block?.type === 'tool_use') {
          state.toolIndex = (state.toolIndex ?? -1) + 1;
          return {
            chunks: [
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: state.toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] },
                    finish_reason: null,
                  },
                ],
              },
            ],
          };
        }
        return { chunks: [] };
      }
      case 'content_block_delta': {
        const d = json.delta;
        if (d?.type === 'text_delta') {
          state.textAcc += d.text;
          return { chunks: [{ ...base, choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] }] };
        }
        if (d?.type === 'thinking_delta') {
          return { chunks: [{ ...base, choices: [{ index: 0, delta: { reasoning_content: d.thinking }, finish_reason: null }] }] };
        }
        if (d?.type === 'input_json_delta') {
          return {
            chunks: [
              {
                ...base,
                choices: [{ index: 0, delta: { tool_calls: [{ index: state.toolIndex ?? 0, function: { arguments: d.partial_json } }] }, finish_reason: null }],
              },
            ],
          };
        }
        return { chunks: [] };
      }
      case 'message_delta': {
        const usage: Usage = {
          prompt_tokens: state.promptTokens,
          completion_tokens: json.usage?.output_tokens ?? 0,
        };
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        return {
          chunks: [{ ...base, choices: [{ index: 0, delta: {}, finish_reason: mapStopReason(json.delta?.stop_reason) }] }],
          usage,
        };
      }
      case 'message_stop':
        return { chunks: [], done: true };
      case 'error':
        return { chunks: [{ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], error: json.error }], done: true };
      default:
        return { chunks: [] };
    }
  },
};

function mapStopReason(reason: string | undefined | null): string {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

/** Anthropic takes `system` out of band and requires alternating user/assistant turns. */
function splitSystem(messages: any[], channelSystemPrompt: string): { system: string; messages: any[] } {
  const systemParts: string[] = [];
  if (channelSystemPrompt) systemParts.push(channelSystemPrompt);
  const out: any[] = [];

  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      systemParts.push(contentToText(m.content));
      continue;
    }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: contentToText(m.content) };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks: any[] = [];
      const text = contentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls) {
        let input: any = {};
        try {
          input = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: convertContent(m.content) });
  }

  // Anthropic rejects an empty message list and leading assistant turns.
  if (!out.length) out.push({ role: 'user', content: '' });
  while (out.length && out[0].role === 'assistant') out.shift();

  return { system: systemParts.join('\n\n'), messages: out };
}

function convertContent(content: any): any {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((part: any) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const url: string = part.image_url?.url ?? '';
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
      return { type: 'image', source: { type: 'url', url } };
    }
    return { type: 'text', text: JSON.stringify(part) };
  });
}

function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : '')).join('');
  }
  return String(content ?? '');
}
