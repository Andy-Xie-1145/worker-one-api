import type { ChatRequest } from './adaptor';
import type { Usage } from '../lib/billing';

/**
 * 入站翻译器：Google Gemini generateContent 形状 ⇄ 网关中枢（OpenAI Chat）。
 *
 * 客户端按 Gemini SDK 的方式打 `POST /gemini/v1beta/models/{model}:generateContent`
 * （或 `:streamGenerateContent?alt=sse`），网关翻译成 chat 去选路/计费，响应再翻回
 * Gemini 形状——上游是什么方言与客户端无关。
 *
 * 鉴权与官方一致：`x-goog-api-key` 头（也接受 Authorization Bearer）。
 * 流式只支持 `alt=sse`（官方 SDK 的默认走法）；纯 JSON 数组流式不支持，缺这个
 * 参数时返回 400 而不是默默回一份 SSE。
 */

export class GeminiInboundError extends Error {}

/** Gemini 请求 → 中枢 ChatRequest。 */
export function geminiToChatRequest(raw: any, model: string): ChatRequest {
  if (!raw || typeof raw !== 'object') throw new GeminiInboundError('请求体不是合法的 JSON 对象');
  const req: ChatRequest = { model };
  const messages: ChatRequest['messages'] = [];

  const sys = raw.systemInstruction ?? raw.system_instruction;
  const sysText = sys ? partsText(sys.parts ?? []) : '';
  if (sysText) messages.push({ role: 'system', content: sysText });

  for (const c of raw.contents ?? []) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const textParts: string[] = [];
    const images: any[] = [];
    let functionCalls: any[] | undefined;
    let functionResponse: { name: string; response: any } | undefined;

    for (const p of c.parts ?? []) {
      if (typeof p?.text === 'string') {
        textParts.push(p.text);
      } else if (p?.inlineData?.data || p?.inline_data?.data) {
        const mime = p.inlineData?.mimeType ?? p.inline_data?.mime_type ?? 'image/png';
        const data = p.inlineData?.data ?? p.inline_data?.data;
        images.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
      } else if (p?.functionCall || p?.function_call) {
        const fc = p.functionCall ?? p.function_call;
        (functionCalls ??= []).push({
          id: String(fc.name ?? ''),
          type: 'function',
          function: { name: String(fc.name ?? ''), arguments: JSON.stringify(fc.args ?? {}) },
        });
      } else if (p?.functionResponse || p?.function_response) {
        const fr = p.functionResponse ?? p.function_response;
        functionResponse = { name: String(fr.name ?? ''), response: fr.response };
      }
    }

    if (functionResponse) {
      // Gemini 用**函数名**配对工具结果；中枢用 tool_call_id，直接拿名字当 id。
      messages.push({
        role: 'tool',
        tool_call_id: functionResponse.name,
        name: functionResponse.name,
        content: JSON.stringify(functionResponse.response ?? {}),
      });
      continue;
    }

    if (functionCalls?.length) {
      messages.push({
        role: 'assistant',
        content: textParts.join('') || null,
        tool_calls: functionCalls,
      });
      continue;
    }

    const content = images.length
      ? [...(textParts.length ? [{ type: 'text', text: textParts.join('') }] : []), ...images]
      : textParts.join('');
    messages.push({ role, content });
  }

  req.messages = messages;

  const gc = raw.generationConfig ?? raw.generation_config;
  if (gc) {
    if (gc.maxOutputTokens !== undefined || gc.max_output_tokens !== undefined) {
      req.max_tokens = Number(gc.maxOutputTokens ?? gc.max_output_tokens) || undefined;
    }
    if (gc.temperature !== undefined) req.temperature = gc.temperature;
    if (gc.topP !== undefined || gc.top_p !== undefined) req.top_p = gc.topP ?? gc.top_p;
    if (gc.stopSequences || gc.stop_sequences) req.stop = gc.stopSequences ?? gc.stop_sequences;
  }

  // Gemini 的 functionDeclarations 本来就是扁平形状，套回中枢的嵌套结构即可。
  const decls: any[] = [];
  for (const t of raw.tools ?? []) {
    for (const fd of t?.functionDeclarations ?? t?.function_declarations ?? []) {
      decls.push({ type: 'function', function: { name: fd.name, description: fd.description, parameters: fd.parameters } });
    }
  }
  if (decls.length) req.tools = decls;

  const tcc = raw.toolConfig?.functionCallingConfig ?? raw.tool_config?.function_calling_config;
  if (tcc) {
    const mode = String(tcc.mode ?? 'AUTO').toUpperCase();
    const allowed: string[] | undefined = tcc.allowedFunctionNames ?? tcc.allowed_function_names;
    req.tool_choice = mode === 'NONE' ? 'none' : mode === 'ANY' ? (allowed?.length === 1 ? { type: 'function', function: { name: allowed[0] } } : 'required') : 'auto';
  }

  return req;
}

function partsText(parts: any[]): string {
  return (parts ?? []).map((p) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('');
}

// ---------------------------------------------------------------- 响应翻译

export function chatFinishToGemini(reason: string | null | undefined): string {
  if (reason === 'length') return 'MAX_TOKENS';
  if (reason === 'content_filter') return 'SAFETY';
  return 'STOP';
}

/** 中枢 chat completion JSON → Gemini generateContent JSON。 */
export function chatResponseToGemini(chat: any, model: string): any {
  const msg = chat?.choices?.[0]?.message ?? {};
  const parts: any[] = [];
  if (typeof msg.content === 'string' && msg.content) parts.push({ text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let args: any = {};
    try { args = JSON.parse(String(tc.function?.arguments ?? '{}')); } catch { args = {}; }
    parts.push({ functionCall: { name: String(tc.function?.name ?? ''), args } });
  }
  const u = chat?.usage ?? {};
  return {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: chatFinishToGemini(chat?.choices?.[0]?.finish_reason),
      index: 0,
    }],
    modelVersion: model,
    usageMetadata: {
      promptTokenCount: Number(u.prompt_tokens ?? 0),
      candidatesTokenCount: Number(u.completion_tokens ?? 0),
      totalTokenCount: Number(u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
      ...(u.prompt_tokens_details?.cached_tokens
        ? { cachedContentTokenCount: Number(u.prompt_tokens_details.cached_tokens) } : {}),
    },
  };
}

// ---------------------------------------------------------------- 流式翻译

export interface GeminiEncoder {
  /** chat 工具调用 index → 已累积的参数串（Gemini 的 functionCall 需要完整 args）。 */
  calls: Map<number, { id: string; name: string; args: string }>;
  finished: boolean;
}

export function newGeminiEncoder(): GeminiEncoder {
  return { calls: new Map(), finished: false };
}

function geminiSse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** 一个中枢 chat chunk → 零或多个 Gemini SSE 事件。 */
export function encodeGeminiChunk(enc: GeminiEncoder, chatChunk: any, model: string): string {
  if (enc.finished) return '';
  const choice = chatChunk?.choices?.[0];
  const delta = choice?.delta;
  const parts: any[] = [];
  if (typeof delta?.content === 'string' && delta.content) parts.push({ text: delta.content });
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) parts.push({ text: delta.reasoning_content });

  for (const tc of delta?.tool_calls ?? []) {
    const idx = Number(tc.index ?? 0);
    const call = enc.calls.get(idx) ?? { id: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), args: '' };
    if (tc.function?.arguments) call.args += tc.function.arguments;
    enc.calls.set(idx, call);
  }

  const finish = choice?.finish_reason;
  if (finish) {
    // 收尾：把累积完成的工具调用整块吐出（Gemini 的 functionCall 不做增量）。
    for (const call of enc.calls.values()) {
      let args: any = {};
      try { args = JSON.parse(call.args || '{}'); } catch { args = {}; }
      parts.push({ functionCall: { name: call.name, args } });
    }
  }

  if (!parts.length) return '';

  const chunk: any = {
    candidates: [{
      content: { role: 'model', parts },
      index: 0,
      ...(finish ? { finishReason: chatFinishToGemini(finish) } : {}),
    }],
    modelVersion: model,
  };
  return geminiSse(chunk);
}

/** 流末尾：带 usageMetadata 的收尾 chunk（中枢在最后一个 chunk 给 usage）。 */
export function finishGeminiStream(enc: GeminiEncoder, model: string, usage?: Usage): string {
  if (enc.finished) return '';
  enc.finished = true;
  const u = usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return geminiSse({
    candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
    modelVersion: model,
    usageMetadata: {
      promptTokenCount: Number(u.prompt_tokens ?? 0),
      candidatesTokenCount: Number(u.completion_tokens ?? 0),
      totalTokenCount: Number(u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
    },
  });
}

export function geminiErrorEvent(message: string): string {
  return geminiSse({ error: { code: 502, message, status: 'INTERNAL' } });
}
