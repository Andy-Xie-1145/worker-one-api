/**
 * Deterministic tests for the riskiest part of the relay: converting each
 * upstream's SSE dialect into OpenAI chat-completion chunks, and the usage
 * numbers billing depends on.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { readSSE } from '../src/relay/sse';
import { openaiAdaptor } from '../src/relay/openai';
import { anthropicAdaptor } from '../src/relay/anthropic';
import { geminiAdaptor } from '../src/relay/gemini';
import { newStreamState } from '../src/relay/adaptor';
import { calcQuota, resolvePrice, stripAliasPrefix, type Price } from '../src/lib/pricing';
import { normalizeKey } from '../src/lib/auth';
import { stripAliasPrefix } from '../src/lib/pricing';
import {
  anthropicToChatRequest,
  chatResponseToAnthropic,
  encodeAnthropicChunk,
  finishAnthropicStream,
  newAnthropicEncoder,
} from '../src/relay/anthropic-inbound';

const channel: any = { id: 1, type: 'x', key: 'k', base_url: '', system_prompt: '', model_mapping: '', config: '' };
const ctx = (name: string): any => ({ channel, upstreamModel: 'up-model', requestedModel: name, mode: 'chat', path: 'chat/completions', config: {} });

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      // Deliberately split mid-event to prove the parser reassembles chunks.
      c.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
      c.enqueue(bytes.slice(Math.floor(bytes.length / 2)));
      c.close();
    },
  });
}

async function run(adaptor: any, raw: string, model: string) {
  const state = newStreamState();
  const c = ctx(model);
  const chunks: any[] = [];
  let usage: any;
  for await (const ev of readSSE(streamOf(raw))) {
    const out = adaptor.convertStreamEvent(ev, c, state);
    if (out.usage && (out.usage.prompt_tokens || out.usage.completion_tokens)) usage = out.usage;
    chunks.push(...out.chunks);
    if (out.done) break;
  }
  const text = chunks.map((k) => k.choices?.[0]?.delta?.content ?? '').join('');
  return { chunks, usage, text, state };
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ---------------------------------------------------------------- OpenAI

test('openai: forwards chunks, captures include_usage totals', async () => {
  const raw =
    `data: {"id":"c1","object":"chat.completion.chunk","model":"up-model","choices":[{"index":0,"delta":{"role":"assistant","content":"He"},"finish_reason":null}]}\n\n` +
    `data: {"id":"c1","object":"chat.completion.chunk","model":"up-model","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}\n\n` +
    `data: {"id":"c1","object":"chat.completion.chunk","model":"up-model","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\n` +
    `data: [DONE]\n\n`;
  const { text, usage, chunks } = await run(openaiAdaptor, raw, 'gpt-4o-mini');
  assert.equal(text, 'Hello');
  assert.deepEqual(usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
  // The requested model name is echoed back, not the upstream one.
  assert.equal(chunks[0].model, 'gpt-4o-mini');
});

test('openai: accumulates text when upstream reports no usage', async () => {
  const raw = `data: {"choices":[{"delta":{"content":"abcd"}}]}\n\ndata: [DONE]\n\n`;
  const { usage, state } = await run(openaiAdaptor, raw, 'gpt-4o-mini');
  assert.equal(usage, undefined);
  assert.equal(state.textAcc, 'abcd');
});

// ---------------------------------------------------------------- Anthropic

test('anthropic: converts message events and carries usage across the stream', async () => {
  const raw =
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n` +
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n` +
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const { text, usage, chunks } = await run(anthropicAdaptor, raw, 'claude-sonnet-4');
  assert.equal(text, 'Hi there');
  // input_tokens arrives in message_start, output_tokens only in message_delta.
  assert.deepEqual(usage, { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32 });
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(chunks[0].object, 'chat.completion.chunk');
});

test('anthropic: tool_use blocks become OpenAI tool_calls deltas', async () => {
  const raw =
    `data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n` +
    `data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}\n\n` +
    `data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n` +
    `data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}\n\n` +
    `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n`;
  const { chunks } = await run(anthropicAdaptor, raw, 'claude-sonnet-4');
  const calls = chunks.flatMap((k) => k.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(calls[0].function.name, 'get_weather');
  assert.equal(calls.map((t: any) => t.function.arguments ?? '').join(''), '{"city":"SF"}');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('anthropic: system messages are hoisted out of the message list', () => {
  const built = anthropicAdaptor.buildRequest(
    { model: 'm', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] },
    ctx('claude-sonnet-4'),
  );
  const body = JSON.parse(built.body);
  assert.equal(body.system, 'be brief');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.ok(body.max_tokens > 0, 'Anthropic requires max_tokens');
  assert.equal(built.headers['x-api-key'], 'k');
});

// ---------------------------------------------------------------- Gemini

test('gemini: converts candidates and counts thoughts as output tokens', async () => {
  const raw =
    `data: {"candidates":[{"content":{"parts":[{"text":"Sal"}]}}]}\n\n` +
    `data: {"candidates":[{"content":{"parts":[{"text":"ut"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":3,"thoughtsTokenCount":2}}\n\n`;
  const { text, usage, chunks } = await run(geminiAdaptor, raw, 'gemini-2.5-flash');
  assert.equal(text, 'Salut');
  assert.deepEqual(usage, { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 });
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
});

test('gemini: builds a streaming URL with the sse alt and safety overrides', () => {
  const built = geminiAdaptor.buildRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }, ctx('gemini-2.5-pro'));
  assert.ok(built.url.endsWith('/v1beta/models/up-model:streamGenerateContent?alt=sse'), built.url);
  assert.equal(built.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(built.body);
  assert.equal(body.safetySettings.length, 4);
  assert.equal(body.contents[0].role, 'user');
});

// ---------------------------------------------------------------- pricing

test('pricing: longest-prefix match and quota arithmetic, no ratios anywhere', () => {
  // gpt-4o-mini must not fall back to the shorter gpt-4o entry.
  assert.deepEqual(resolvePrice('gpt-4o-mini-2024-07-18').spec, { in: 0.15, out: 0.6 });
  assert.deepEqual(resolvePrice('gpt-4o-2024-11-20').spec, { in: 2.5, out: 10 });
  assert.equal(resolvePrice('gpt-4o-2024-11-20').source, 'builtin');
  const m = (p: number, c: number) => ({ prompt_tokens: p, completion_tokens: c });
  // 1M in + 1M out of gpt-4o == $12.50 == 6_250_000 quota. 倍率已全部删除：
  // 同样的用量无论账户、分组、时段，永远只有一个价。
  assert.equal(calcQuota('gpt-4o', m(1_000_000, 1_000_000)), 6_250_000);
  // Unknown models fall back to the default price rather than being free.
  assert.ok(calcQuota('some-unknown-model', m(1000, 1000)) > 0);
  assert.equal(resolvePrice('some-unknown-model').source, 'default');
});

test('pricing: GPT-6 家族与生图模型按官方 standard 档计价', () => {
  // 2026-10 官方定价页：astra $10/$50，6.1-sol $2/$10，luna $0.10/$0.50。
  assert.deepEqual(resolvePrice('gpt-6-astra').spec, { in: 10, out: 50, cached_in: 1 });
  assert.deepEqual(resolvePrice('gpt-6.1-sol').spec, { in: 2, out: 10, cached_in: 0.1 });
  assert.deepEqual(resolvePrice('gpt-6-luna').spec, { in: 0.1, out: 0.5, cached_in: 0.01 });
  // gpt-6-sol 是 6.1 的前代：in/out 同价，缓存 $0.20（6.1 降到 $0.10）。
  assert.deepEqual(resolvePrice('gpt-6-sol').spec, { in: 2, out: 10, cached_in: 0.2 });
  // 长前缀优先：gpt-image-2.5-flare 不得命中 gpt-image-2 的条目（同价，但匹配必须正确）。
  assert.deepEqual(resolvePrice('gpt-image-2.5-flare').spec, { in: 5, out: 30, cached_in: 1.25 });
  assert.deepEqual(resolvePrice('gpt-image-2.5-sunburst').spec, { in: 5, out: 30, cached_in: 1.25 });
  assert.deepEqual(resolvePrice('gpt-image-2').spec, { in: 5, out: 30, cached_in: 1.25 });
  // 1M 输入 + 1M 输出的 astra = $60 = 30_000_000 quota。
  assert.equal(calcQuota('gpt-6-astra', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 30_000_000);
});

test('pricing: Claude 5.5 家族按官方价计价', () => {
  // 2026-10 官方：Opus 5.5 $4/$20（缓存 $0.20），Sonnet 5.5 $2/$10（缓存 $0.10）。
  // 缓存写入按官方口径 5m=1.25×in、1h=2×in（platform.claude.com/docs/en/about-claude/pricing）。
  assert.deepEqual(resolvePrice('claude-opus-5-5').spec, { in: 4, out: 20, cached_in: 0.2, cache_write_5m: 5, cache_write_1h: 8 });
  assert.deepEqual(resolvePrice('claude-sonnet-5-5').spec, { in: 2, out: 10, cached_in: 0.1, cache_write_5m: 2.5, cache_write_1h: 4 });
  // 前缀不串门：opus-5-5 不得命中 claude-opus-4 / claude-3-opus 的条目。
  assert.equal(resolvePrice('claude-opus-5-5').source, 'builtin');
  // 1M 输入 + 1M 输出的 Opus 5.5 = $24 = 12_000_000 quota。
  assert.equal(calcQuota('claude-opus-5-5', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 12_000_000);
  // 缓存写入按各自 TTL 分桶计价：1M fresh + 0.5M 写 5m + 0.5M 写 1h + 1M 输出
  // = 4 + 2.5 + 4 + 20 = $30.50 = 15_250_000 quota。
  assert.equal(
    calcQuota('claude-opus-5-5', {
      prompt_tokens: 2_000_000,
      completion_tokens: 1_000_000,
      cache_write_5m_tokens: 500_000,
      cache_write_1h_tokens: 500_000,
    }),
    15_250_000,
  );
});

// ---------------------------------------------------------------- DeepSeek

test('deepseek: model line-up is priced, legacy V3 aliases are not guessed at', () => {
  assert.deepEqual(resolvePrice('deepseek-v4-flash').spec, { in: 0.44, out: 1.32, cached_in: 0.014 });
  assert.deepEqual(resolvePrice('deepseek-v4-pro').spec, { in: 1.32, out: 3.96, cached_in: 0.044 });
  // V4.1 Flash（API 名 deepseek-flash）：两个名字同价，2026-09-10 官方价。
  assert.deepEqual(resolvePrice('deepseek-v4.1-flash').spec, { in: 0.3, out: 1.2, cached_in: 0.006 });
  assert.deepEqual(resolvePrice('deepseek-flash').spec, { in: 0.3, out: 1.2, cached_in: 0.006 });
  // The vision model must win the prefix match over plain -flash.
  assert.equal((resolvePrice('deepseek-v4-flash-vision-exp').spec as Price).in, 0.44);
  // deepseek-chat/-reasoner are gone from the docs; they fall back to the
  // conservative default rather than to stale V3 numbers.
  assert.deepEqual(resolvePrice('deepseek-chat').spec, { in: 1, out: 3 });
});

test('deepseek: cache-hit prompt tokens bill at the cheaper tier', () => {
  // 1M prompt tokens, all cache misses: $0.44 -> 220_000 quota.
  assert.equal(calcQuota('deepseek-v4-flash', { prompt_tokens: 1_000_000, completion_tokens: 0 }), 220_000);
  // Same 1M prompt, but all served from cache: $0.014 -> 7_000 quota (31x cheaper).
  assert.equal(
    calcQuota('deepseek-v4-flash', { prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 1_000_000 }),
    7_000,
  );
  // cached_tokens can never exceed prompt_tokens, even if an upstream lies.
  assert.equal(
    calcQuota('deepseek-v4-flash', { prompt_tokens: 100, completion_tokens: 0, cached_tokens: 999_999 }),
    calcQuota('deepseek-v4-flash', { prompt_tokens: 100, completion_tokens: 0, cached_tokens: 100 }),
  );
});

test('deepseek: usage parsing picks up prompt_cache_hit_tokens', async () => {
  const raw =
    `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n` +
    `data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":20,"prompt_cache_hit_tokens":960,"prompt_cache_miss_tokens":40}}\n\n` +
    `data: [DONE]\n\n`;
  const { usage } = await run(openaiAdaptor, raw, 'deepseek-v4-pro');
  assert.equal(usage.prompt_tokens, 1000);
  assert.equal(usage.cached_tokens, 960);
  // 40 fresh @ $1.32 + 960 cached @ $0.044 + 20 out @ $3.96, all per 1M.
  const expected = Math.ceil(((40 * 1.32 + 960 * 0.044 + 20 * 3.96) / 1e6) * 500000);
  assert.equal(calcQuota('deepseek-v4-pro', usage), expected);
});

// ---------------------------------------------------------------- key formats

test('auth: key format survives normalization', () => {
  // This gateway's own keys: 48 hex, stored without the sk- prefix.
  assert.equal(normalizeKey('sk-' + 'a'.repeat(48)), 'a'.repeat(48));
  assert.equal(normalizeKey('Bearer sk-' + 'a'.repeat(48)), 'a'.repeat(48));
  // one-api's legacy `-channelId` hint is dropped.
  assert.equal(normalizeKey('sk-' + 'a'.repeat(48) + '-42'), 'a'.repeat(48));

  assert.equal(normalizeKey(''), '');
  assert.equal(normalizeKey('Bearer '), '');
});

// ---------------------------------------------------------------- GLM aliases

test('glm: legacy vendor prefixes price the same as the bare model', () => {
  // The shipped launcher defaults to this exact string.
  assert.deepEqual(resolvePrice('zai-coding-plan/glm-4.7').spec, resolvePrice('glm-4.7').spec);
  assert.deepEqual(resolvePrice('zai/glm-5').spec, resolvePrice('glm-5').spec);
  assert.equal(stripAliasPrefix('zai-coding-plan/glm-4.7'), 'glm-4.7');
  assert.equal(stripAliasPrefix('glm-4.7'), 'glm-4.7');
  // A slash in an unrelated model name must not be mangled.
  assert.equal(stripAliasPrefix('meta/llama-3'), 'meta/llama-3');
});

test('glm: longest-prefix match separates the flash variants', () => {
  // glm-4.7-flash is free upstream; glm-4.7-flashx is not. Neither may fall
  // back to the much pricier bare glm-4.7 entry.
  assert.deepEqual(resolvePrice('glm-4.7-flash').spec, { in: 0, out: 0 });
  assert.deepEqual(resolvePrice('glm-4.7-flashx').spec, { in: 0.07, out: 0.4 });
  assert.deepEqual(resolvePrice('glm-4.7').spec, { in: 0.6, out: 2.2 });
  assert.deepEqual(resolvePrice('glm-5-turbo').spec, { in: 1.2, out: 4 });
  assert.deepEqual(resolvePrice('glm-5').spec, { in: 1, out: 3.2 });
  // A free model must cost nothing.
  assert.equal(calcQuota('zai-coding-plan/glm-4.7-flash', { prompt_tokens: 1e6, completion_tokens: 1e6 }), 0);
});

// ------------------------------------------------- inbound Anthropic protocol

/** Parses an Anthropic SSE string back into (event, data) pairs. */
function parseAnthropic(sse: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  for (const raw of sse.split('\n\n')) {
    if (!raw.trim()) continue;
    const ev = /^event: (.+)$/m.exec(raw)?.[1];
    const dt = /^data: (.+)$/m.exec(raw)?.[1];
    if (ev && dt) out.push({ event: ev, data: JSON.parse(dt) });
  }
  return out;
}

test('anthropic inbound: system is hoisted and content blocks flatten', () => {
  const req = anthropicToChatRequest({
    model: 'glm-4.7',
    system: 'be brief',
    max_tokens: 100,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  });
  assert.equal(req.messages![0].role, 'system');
  assert.equal(req.messages![0].content, 'be brief');
  assert.equal(req.messages![1].role, 'user');
  assert.equal(req.messages![1].content, 'hello');
  assert.equal(req.max_tokens, 100);
});

test('anthropic inbound: system given as blocks is joined', () => {
  const req = anthropicToChatRequest({
    model: 'm',
    system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] as any,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(req.messages![0].content, 'a\nb');
});

test('anthropic inbound: tool_use and tool_result map onto OpenAI messages', () => {
  const req = anthropicToChatRequest({
    model: 'm',
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'SF' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '20C' }] },
    ],
  });
  const assistant = req.messages!.find((m) => m.role === 'assistant')!;
  assert.equal(assistant.tool_calls[0].function.name, 'get_weather');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"city":"SF"}');
  const tool = req.messages!.find((m) => m.role === 'tool')!;
  assert.equal(tool.tool_call_id, 'tu_1');
  assert.equal(tool.content, '20C');
});

test('anthropic inbound: tools and tool_choice convert', () => {
  const req = anthropicToChatRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'f', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'f' },
  });
  assert.equal(req.tools![0].function.name, 'f');
  assert.deepEqual(req.tools![0].function.parameters, { type: 'object', properties: { a: { type: 'string' } } });
  assert.deepEqual(req.tool_choice, { type: 'function', function: { name: 'f' } });
  assert.equal(anthropicToChatRequest({ model: 'm', messages: [], tools: [{ name: 'f' }], tool_choice: { type: 'any' } }).tool_choice, 'required');
});

test('anthropic inbound: base64 images become data URLs', () => {
  const req = anthropicToChatRequest({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
  });
  assert.deepEqual(req.messages![0].content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
});

test('anthropic outbound: non-streaming response carries usage and stop_reason', () => {
  const msg = chatResponseToAnthropic(
    {
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    },
    'glm-4.7',
  );
  assert.equal(msg.type, 'message');
  assert.equal(msg.model, 'glm-4.7');
  assert.deepEqual(msg.content, [{ type: 'text', text: 'hi' }]);
  assert.equal(msg.stop_reason, 'max_tokens');
  assert.deepEqual(msg.usage, { input_tokens: 7, output_tokens: 3 });
});

test('anthropic outbound: empty content still yields a valid block', () => {
  // Anthropic rejects an empty content array.
  const msg = chatResponseToAnthropic({ choices: [{ message: { content: null }, finish_reason: 'stop' }] }, 'm');
  assert.deepEqual(msg.content, [{ type: 'text', text: '' }]);
});

test('anthropic outbound: stream is correctly bracketed', () => {
  const st = newAnthropicEncoder();
  let sse = '';
  sse += encodeAnthropicChunk({ choices: [{ delta: { role: 'assistant', content: '' } }], usage: { prompt_tokens: 5 } }, 'm', st);
  sse += encodeAnthropicChunk({ choices: [{ delta: { content: 'He' } }] }, 'm', st);
  sse += encodeAnthropicChunk({ choices: [{ delta: { content: 'llo' } }] }, 'm', st);
  sse += encodeAnthropicChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }, 'm', st);
  sse += finishAnthropicStream(st, { prompt_tokens: 5, completion_tokens: 2 });

  const events = parseAnthropic(sse);
  assert.equal(events[0].event, 'message_start');
  assert.equal(events[0].data.message.usage.input_tokens, 5);
  assert.equal(events[1].event, 'content_block_start');
  const text = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text, 'Hello');
  // Every opened block must be closed, exactly once.
  assert.equal(events.filter((e) => e.event === 'content_block_start').length, 1);
  assert.equal(events.filter((e) => e.event === 'content_block_stop').length, 1);
  const delta = events.find((e) => e.event === 'message_delta')!;
  assert.equal(delta.data.delta.stop_reason, 'end_turn');
  assert.equal(delta.data.usage.output_tokens, 2);
  assert.equal(events.at(-1)!.event, 'message_stop');
});

test('anthropic outbound: text then tool call opens a second block', () => {
  const st = newAnthropicEncoder();
  let sse = encodeAnthropicChunk({ choices: [{ delta: { content: 'thinking' } }] }, 'm', st);
  sse += encodeAnthropicChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'toolu_1', function: { name: 'f', arguments: '' } }] } }] }, 'm', st);
  sse += encodeAnthropicChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }, 'm', st);
  sse += encodeAnthropicChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, 'm', st);
  sse += finishAnthropicStream(st);

  const events = parseAnthropic(sse);
  const starts = events.filter((e) => e.event === 'content_block_start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].data.content_block.type, 'text');
  assert.equal(starts[1].data.content_block.type, 'tool_use');
  assert.equal(starts[1].data.content_block.name, 'f');
  // The text block must be closed before the tool block opens.
  assert.equal(events.filter((e) => e.event === 'content_block_stop').length, 2);
  const args = events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta')
    .map((e) => e.data.delta.partial_json).join('');
  assert.equal(args, '{"a":1}');
  assert.equal(events.find((e) => e.event === 'message_delta')!.data.delta.stop_reason, 'tool_use');
});

test('anthropic outbound: reasoning becomes a thinking block before the text block', () => {
  const st = newAnthropicEncoder();
  let sse = encodeAnthropicChunk({ choices: [{ delta: { reasoning_content: '让我想想' } }] }, 'm', st);
  sse += encodeAnthropicChunk({ choices: [{ delta: { reasoning_content: '……' } }] }, 'm', st);
  sse += encodeAnthropicChunk({ choices: [{ delta: { content: '答案' } }] }, 'm', st);
  sse += finishAnthropicStream(st, { prompt_tokens: 11, completion_tokens: 4 });

  const events = parseAnthropic(sse);
  const starts = events.filter((e) => e.event === 'content_block_start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].data.content_block.type, 'thinking');
  assert.equal(starts[1].data.content_block.type, 'text');
  // Consecutive reasoning deltas share one block rather than opening a new one each time.
  const thinking = events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta')
    .map((e) => e.data.delta.thinking).join('');
  assert.equal(thinking, '让我想想……');
  assert.equal(events.filter((e) => e.event === 'content_block_stop').length, 2);
  // Input tokens are only known at the end for OpenAI-shaped upstreams.
  assert.deepEqual(events.find((e) => e.event === 'message_delta')!.data.usage, { input_tokens: 11, output_tokens: 4 });
});

test('anthropic outbound: two distinct tool calls get separate blocks', () => {
  const st = newAnthropicEncoder();
  let sse = encodeAnthropicChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'a', arguments: '{}' } }] } }] }, 'm', st);
  sse += encodeAnthropicChunk({ choices: [{ delta: { tool_calls: [{ index: 1, id: 't2', function: { name: 'b', arguments: '{}' } }] } }] }, 'm', st);
  sse += finishAnthropicStream(st);
  const starts = parseAnthropic(sse).filter((e) => e.event === 'content_block_start');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map((e) => e.data.content_block.name), ['a', 'b']);
  assert.notEqual(starts[0].data.index, starts[1].data.index);
});

test('anthropic outbound: finishing twice emits nothing the second time', () => {
  const st = newAnthropicEncoder();
  encodeAnthropicChunk({ choices: [{ delta: { content: 'x' } }] }, 'm', st);
  assert.notEqual(finishAnthropicStream(st), '');
  assert.equal(finishAnthropicStream(st), '');
});

// ---------------------------------------------------------------- runner

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
