import { type Adaptor, type AdaptorContext, type ChatRequest, type StreamState, joinURL } from './adaptor';
import type { Usage } from '../lib/billing';
import { apiPrefix, normalizeUsage } from './openai';
import { buildDecisionsRequest } from './decisions';

/**
 * OpenAI Responses API adaptor（渠道类型 `openai-responses`）。
 *
 * 网关的中枢形状是 OpenAI Chat Completion；这个适配器把中枢形状**出站翻译**成
 * Responses（POST /v1/responses），响应和流再翻回来。这样任何 Chat 形状的客户端
 * 都能调用只提供 Responses API 的渠道。
 *
 * 翻译映射（对齐 OpenAI 官方语义）：
 *   - system 消息               → `instructions`
 *   - user / assistant 文本      → `input` 里的 message item
 *   - assistant.tool_calls       → input 里的 `function_call` item
 *   - role:'tool' 的工具结果     → input 里的 `function_call_output` item
 *   - max_tokens/max_completion_tokens → `max_output_tokens`
 *   - tools（嵌套 function）     → 扁平 function 工具
 *   - `stop` / `stream_options`  → Responses 没有，静默丢弃（文档已注明）
 *
 * 有状态参数（`previous_response_id`、`store`）属于入站翻译器的拒绝范围，
 * 出站方向不存在这个问题。
 */
export const openaiResponsesAdaptor: Adaptor = {
  name: 'openai-responses',
  label: 'OpenAI Responses',
  defaultBaseURL: 'https://api.openai.com',
  // Decisions 也是 Bearer + JSON，协议形状上没问题；能不能真打决策接口仍由
  // 渠道的 base_url / config 决定（decisionsSupport()）。
  supportsDecisions: true,

  buildRequest(req: ChatRequest, ctx: AdaptorContext) {
    const base = ctx.channel.base_url || ctx.config.base_url || openaiResponsesAdaptor.defaultBaseURL;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.channel.key}`,
    };
    if (ctx.config.organization) headers['OpenAI-Organization'] = ctx.config.organization;
    if (ctx.config.extra_headers && typeof ctx.config.extra_headers === 'object') {
      Object.assign(headers, ctx.config.extra_headers);
    }

    // Decisions 不在 /responses 下也不是 chat 形状——整条构造让给 decisions.ts。
    if (ctx.mode === 'decisions') return buildDecisionsRequest(req, ctx, base, headers);

    const body: Record<string, unknown> = { model: ctx.upstreamModel, input: toResponsesInput(req) };
    const instructions = systemText(req);
    if (instructions) body.instructions = instructions;
    const maxOut = req.max_tokens ?? req.max_completion_tokens;
    if (maxOut !== undefined) body.max_output_tokens = maxOut;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (Array.isArray(req.tools) && req.tools.length) body.tools = req.tools.map(flattenTool);
    if (req.tool_choice !== undefined) body.tool_choice = flattenToolChoice(req.tool_choice);
    if (req.stream) body.stream = true;
    // `stop` 与 `stream_options` 在 Responses 里没有对应物，丢弃而不是报错——
    // 绝大多数调用方只是把 Chat 形状的参数原样带来了，语义上没有也成立。

    return { url: joinURL(base, `${apiPrefix(base, ctx)}responses`), headers, body: JSON.stringify(body) };
  },

  convertResponse(json: any, ctx: AdaptorContext) {
    const outputs: any[] = Array.isArray(json?.output) ? json.output : [];
    let text = '';
    const reasoning: string[] = [];
    const toolCalls: any[] = [];
    for (const item of outputs) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
        }
      } else if (item?.type === 'reasoning' && Array.isArray(item.summary)) {
        for (const s of item.summary) if (typeof s?.text === 'string') reasoning.push(s.text);
      } else if (item?.type === 'function_call') {
        toolCalls.push({ id: String(item.call_id ?? item.id ?? ''), type: 'function', function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') } });
      }
    }

    const message: Record<string, unknown> = { role: 'assistant' };
    if (text) message.content = text;
    if (reasoning.length) message.reasoning_content = reasoning.join('\n');
    if (toolCalls.length) message.tool_calls = toolCalls;

    const body = {
      id: String(json?.id ?? ''),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.requestedModel,
      choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
      usage: responsesUsage(json?.usage),
    };
    return { body, usage: normalizeUsage(responsesUsage(json?.usage)) };
  },

  convertStreamEvent(event, ctx, state: StreamState) {
    if (event.data === '[DONE]') return { chunks: [], done: true };
    let json: any;
    try {
      json = JSON.parse(event.data);
    } catch {
      return { chunks: [] };
    }
    const type = json?.type ?? event.event;
    const chunk = (delta: any, finish?: string) => ({
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: ctx.requestedModel,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    });

    switch (type) {
      case 'response.created': {
        if (json.response?.id) state.id = String(json.response.id);
        // 首个 chunk 带 role，客户端（含 Anthropic 入站翻译）靠它开口。
        if (state.roleSent) return { chunks: [] };
        state.roleSent = true;
        return { chunks: [chunk({ role: 'assistant', content: '' })] };
      }
      case 'response.output_item.added': {
        const item = json.item;
        if (item?.type === 'function_call') {
          const itemId = String(item.id ?? '');
          const index = Number(state.toolIndex ?? 0);
          state.toolIndex = index + 1;
          // 并行工具调用按 item_id（及 call_id）建档——后续参数增量按它路由，
          // 否则两个工具的参数会互相串线。
          state.callByItem = { ...(state.callByItem ?? {}), [itemId]: index, [String(item.call_id ?? '')]: index };
          return {
            chunks: [chunk({ tool_calls: [{ index, id: String(item.call_id ?? itemId), type: 'function', function: { name: String(item.name ?? ''), arguments: '' } }] })],
          };
        }
        return { chunks: [] };
      }
      case 'response.output_text.delta': {
        const delta = typeof json.delta === 'string' ? json.delta : '';
        if (!delta) return { chunks: [] };
        state.textAcc += delta;
        return { chunks: [chunk({ content: delta })] };
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = typeof json.delta === 'string' ? json.delta : '';
        return delta ? { chunks: [chunk({ reasoning_content: delta })] } : { chunks: [] };
      }
      case 'response.function_call_arguments.delta': {
        if (typeof json.delta !== 'string' || !json.delta) return { chunks: [] };
        // 并行工具调用的参数增量按上游标注的 item_id 归位；缺标注才退回「最近一个」。
        const byItem = (state.callByItem ?? {}) as Record<string, number>;
        const index = byItem[String(json.item_id ?? '')] ?? Math.max(0, Number(state.toolIndex ?? 1) - 1);
        return { chunks: [chunk({ tool_calls: [{ index, function: { arguments: json.delta } }] })] };
      }
      case 'response.completed': {
        const usage = responsesUsage(json.response?.usage);
        // 收尾：给 include_usage 的客户端一个空 choices 的 usage chunk。
        return { chunks: [{ id: state.id, object: 'chat.completion.chunk', created: state.created, model: ctx.requestedModel, choices: [], usage }], usage, done: true };
      }
      /*
       * response.incomplete：截断不是成功。给 chat 客户端诚实的
       * finish_reason='length'（Responses 入站据此生成 response.incomplete），
       * usage 照带。
       */
      case 'response.incomplete': {
        const usage = responsesUsage(json.response?.usage);
        return {
          chunks: [{ id: state.id, object: 'chat.completion.chunk', created: state.created, model: ctx.requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'length' }], ...(usage ? { usage } : {}) }],
          usage,
          done: true,
        };
      }
      /*
       * response.failed：上游明确报告失败。绝不能伪装成正常收尾——错误作为
       * chunk 的 error 字段透传（chat 协议没有标准的流内错误形状），失败前
       * 消耗的 token 照计（usage 有就带），done 结束本次流。
       */
      case 'response.failed': {
        const err = json.response?.error ?? json.error;
        const message = String(err?.message ?? json.response?.status ?? '上游响应失败');
        const usage = json.response?.usage ? responsesUsage(json.response.usage) : undefined;
        return {
          chunks: [{ id: state.id, object: 'chat.completion.chunk', created: state.created, model: ctx.requestedModel, choices: [], error: { message, type: 'upstream_error', code: err?.code ?? null }, ...(usage ? { usage } : {}) }],
          ...(usage ? { usage } : {}),
          done: true,
        };
      }
      default:
        return { chunks: [] };
    }
  },
};

// ---------------------------------------------------------------- 请求翻译

/** 提取全部 system 消息的文本，作为 Responses 的 instructions。 */
function systemText(req: ChatRequest): string {
  return (req.messages ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : contentText(m.content)))
    .filter(Boolean)
    .join('\n\n');
}

/** 非系统消息 → Responses `input` items（含工具调用往返）。 */
function toResponsesInput(req: ChatRequest): unknown[] {
  const input: unknown[] = [];
  for (const m of req.messages ?? []) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(m.tool_call_id ?? ''), output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (typeof m.content === 'string' && m.content) {
        input.push({ role: 'assistant', content: m.content });
      }
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: String(tc.id ?? ''),
          name: String(tc.function?.name ?? ''),
          arguments: String(tc.function?.arguments ?? '{}'),
        });
      }
      continue;
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      // 多模态：text 部分拼进 input_text，图片部分映射 input_image。
      const parts = m.content.map((p: any) => {
        if (p?.type === 'text') return { type: 'input_text', text: String(p.text ?? '') };
        if (p?.type === 'image_url') {
          const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
          return { type: 'input_image', image_url: url, detail: p.image_url?.detail };
        }
        return null;
      }).filter(Boolean);
      input.push({ role: 'user', content: parts });
      continue;
    }
    input.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : contentText(m.content) });
  }
  return input;
}

function contentText(content: any): string {
  if (Array.isArray(content)) {
    return content.map((p) => (p?.type === 'text' ? String(p.text ?? '') : '')).filter(Boolean).join('');
  }
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/** Chat 的嵌套 function 工具 → Responses 的扁平 function 工具。 */
function flattenTool(t: any): unknown {
  if (t?.type === 'function' && t.function) {
    return { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters };
  }
  return t;
}

function flattenToolChoice(tc: any): unknown {
  if (tc && typeof tc === 'object' && tc.type === 'function' && tc.function?.name) {
    return { type: 'function', name: tc.function.name };
  }
  return tc;
}

// ---------------------------------------------------------------- 响应翻译

/** Responses usage → Chat usage 形状（缓存明细换名字），供 normalizeUsage 消费。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function responsesUsage(u: any): any {
  const input = Number(u?.input_tokens ?? 0) || 0;
  const output = Number(u?.output_tokens ?? 0) || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number(u?.total_tokens ?? input + output) || input + output,
    ...(u?.input_tokens_details?.cached_tokens ? { prompt_tokens_details: { cached_tokens: Number(u.input_tokens_details.cached_tokens) } } : {}),
  };
}
