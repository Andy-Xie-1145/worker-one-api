import { type Adaptor, type AdaptorContext, type ChatRequest, type StreamState, joinURL } from './adaptor';
import type { Usage } from '../lib/billing';

/** Google Gemini generateContent API <-> OpenAI chat-completions. */
export const geminiAdaptor: Adaptor = {
  name: 'gemini',
  label: 'Google Gemini',
  defaultBaseURL: 'https://generativelanguage.googleapis.com',

  buildRequest(req: ChatRequest, ctx: AdaptorContext) {
    const base = ctx.channel.base_url || geminiAdaptor.defaultBaseURL;
    const version = ctx.config.api_version || 'v1beta';
    const action = req.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';

    const { systemInstruction, contents } = toGeminiContents(req.messages ?? [], ctx.channel.system_prompt);
    const generationConfig: Record<string, any> = {};
    if (typeof req.temperature === 'number') generationConfig.temperature = req.temperature;
    if (typeof req.top_p === 'number') generationConfig.topP = req.top_p;
    const maxTokens = req.max_tokens ?? req.max_completion_tokens;
    if (typeof maxTokens === 'number') generationConfig.maxOutputTokens = maxTokens;
    if (req.stop) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];

    /*
     * 默认关掉思考。
     *
     * Gemini 3 系列默认 dynamic thinking，思考 token 计进 candidatesTokenCount +
     * thoughtsTokenCount（见下面的 usageFrom），既加钱又加延迟。实测同一批字幕：
     * gpt-4o-mini 707in/966out 用 11.6s，gemini 851in/1035out 要 22–36s。而字幕
     * 翻译一点也不需要推理——调用方 45s 就 abort，慢到那个份上等于不能用。
     *
     * 渠道 config 写 {"thinking_budget": -1} 可以放开（-1 = 动态），写具体数字则是
     * 给定预算，留给确实需要推理的渠道。
     *
     * **Pro 系列不自动关**：它们的思考预算有下限，硬塞 0 会被上游直接 400，
     * 那就是把一个能用的模型改坏了。要关就在渠道 config 里显式写。
     */
    const budget = ctx.config.thinking_budget;
    if (typeof budget === 'number') {
      generationConfig.thinkingConfig = { thinkingBudget: budget };
    } else if (!/pro/i.test(ctx.upstreamModel)) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const body: Record<string, any> = { contents };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    if (req.tools?.length) {
      const decls = req.tools
        .filter((t: any) => t.type === 'function' && t.function)
        .map((t: any) => ({ name: t.function.name, description: t.function.description ?? '', parameters: cleanSchema(t.function.parameters) }));
      if (decls.length) body.tools = [{ functionDeclarations: decls }];
    }
    // Gemini blocks a lot by default; relay traffic should pass through untouched.
    body.safetySettings = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(
      (category) => ({ category, threshold: ctx.config.safety_threshold || 'BLOCK_NONE' }),
    );

    return {
      url: joinURL(base, `${version}/models/${ctx.upstreamModel}:${action}`),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.channel.key },
      body: JSON.stringify(body),
    };
  },

  convertResponse(json: any, ctx: AdaptorContext) {
    const usage = usageFrom(json?.usageMetadata);
    const candidate = json?.candidates?.[0];
    const { text, toolCalls } = partsToOpenAI(candidate?.content?.parts ?? []);
    const message: Record<string, any> = { role: 'assistant', content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls;

    return {
      body: {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: ctx.requestedModel,
        choices: [{ index: 0, message, finish_reason: mapFinish(candidate?.finishReason, toolCalls.length > 0) }],
        usage,
      },
      usage,
    };
  },

  convertStreamEvent(event, ctx, state: StreamState) {
    if (event.data === '[DONE]') return { chunks: [], done: true };
    let json: any;
    try {
      json = JSON.parse(event.data);
    } catch {
      return { chunks: [] };
    }
    const base = { id: state.id, object: 'chat.completion.chunk', created: state.created, model: ctx.requestedModel };
    const candidate = json?.candidates?.[0];
    const { text, toolCalls } = partsToOpenAI(candidate?.content?.parts ?? []);
    const usage = json.usageMetadata ? usageFrom(json.usageMetadata) : undefined;

    const delta: Record<string, any> = {};
    if (text) {
      state.textAcc += text;
      delta.content = text;
    }
    if (toolCalls.length) {
      delta.tool_calls = toolCalls.map((tc, i) => ({ index: (state.toolIndex = (state.toolIndex ?? -1) + 1), ...tc }));
    }

    const finish = candidate?.finishReason ? mapFinish(candidate.finishReason, toolCalls.length > 0) : null;
    if (!Object.keys(delta).length && !finish) return { chunks: [], usage };
    return { chunks: [{ ...base, choices: [{ index: 0, delta, finish_reason: finish }] }], usage };
  },
};

function usageFrom(meta: any): Usage {
  const prompt = meta?.promptTokenCount ?? 0;
  // Gemini reports thoughts separately; bill them as output.
  const completion = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function partsToOpenAI(parts: any[]): { text: string; toolCalls: any[] } {
  let text = '';
  const toolCalls: any[] = [];
  for (const part of parts) {
    if (typeof part.text === 'string' && !part.thought) text += part.text;
    else if (part.functionCall) {
      toolCalls.push({
        id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
        type: 'function',
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
      });
    }
  }
  return { text, toolCalls };
}

function mapFinish(reason: string | undefined, hasTools: boolean): string {
  if (hasTools) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function toGeminiContents(messages: any[], channelSystemPrompt: string): { systemInstruction: string; contents: any[] } {
  const systemParts: string[] = [];
  if (channelSystemPrompt) systemParts.push(channelSystemPrompt);
  const contents: any[] = [];

  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      systemParts.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name ?? m.tool_call_id, response: { result: textOf(m.content) } } }] });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts: any[] = [];
      const t = textOf(m.content);
      if (t) parts.push({ text: t });
      for (const tc of m.tool_calls) {
        let args: any = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: tc.function?.name, args } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: toParts(m.content) });
  }

  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '' }] });
  return { systemInstruction: systemParts.join('\n\n'), contents };
}

function toParts(content: any): any[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content ?? '') }];
  return content.map((part: any) => {
    if (part.type === 'text') return { text: part.text };
    if (part.type === 'image_url') {
      const url: string = part.image_url?.url ?? '';
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
      return { fileData: { fileUri: url } };
    }
    return { text: JSON.stringify(part) };
  });
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : '')).join('');
  return String(content ?? '');
}

/** Gemini rejects JSON Schema keywords it does not implement. */
function cleanSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const drop = new Set(['$schema', 'additionalProperties', 'exclusiveMinimum', 'exclusiveMaximum', 'const', 'examples', 'default']);
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(node)) {
      if (drop.has(k)) continue;
      out[k] = walk(v);
    }
    return out;
  };
  return walk(schema);
}
