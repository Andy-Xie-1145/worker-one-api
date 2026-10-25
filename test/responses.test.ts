/**
 * OpenAI Responses 翻译测试：
 *   - 出站适配器（渠道类型 openai-responses）：中枢 chat → Responses 上游
 *   - 入站翻译器（POST /v1/responses）：Responses 客户端 → 中枢 chat
 *
 * Run: npm run test:responses
 */
import assert from 'node:assert/strict';
import { openaiResponsesAdaptor } from '../src/relay/responses';
import {
  responsesToChatRequest, chatResponseToResponses, ResponsesInboundError,
  newResponsesEncoder, encodeResponsesChunk, finishResponsesStream,
} from '../src/relay/responses-inbound';
import type { AdaptorContext } from '../src/relay/adaptor';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const ctx = (over: Partial<AdaptorContext> = {}): AdaptorContext => ({
  channel: { id: 1, type: 'openai-responses', key: 'sk-upstream', status: 1, name: 'r', weight: 1, priority: 0, created_time: 0, test_time: 0, response_time: 0, base_url: 'https://upstream.test', balance: 0, models: '', used_quota: 0, model_mapping: '', config: '', system_prompt: '' } as any,
  upstreamModel: 'gpt-5.1',
  requestedModel: 'my-alias',
  mode: 'chat',
  path: 'chat/completions',
  config: {},
  ...over,
});

// ---------------------------------------------------------------- 出站：请求

test('出站：system→instructions，消息→input items，工具扁平化', () => {
  const built = openaiResponsesAdaptor.buildRequest(
    {
      model: 'my-alias',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get', arguments: '{"q":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"r":2}' },
      ],
      max_completion_tokens: 100,
      tools: [{ type: 'function', function: { name: 'get', description: 'd', parameters: { type: 'object' } } }],
      stream: true,
    },
    ctx(),
  );
  assert.equal(built.url, 'https://upstream.test/v1/responses');
  const body = JSON.parse(built.body);
  assert.equal(body.model, 'gpt-5.1');
  assert.equal(body.instructions, 'be brief');
  assert.equal(body.max_output_tokens, 100);
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, [{ type: 'function', name: 'get', description: 'd', parameters: { type: 'object' } }]);
  assert.deepEqual(body.input, [
    { role: 'user', content: 'hi' },
    { type: 'function_call', call_id: 'c1', name: 'get', arguments: '{"q":1}' },
    { type: 'function_call_output', call_id: 'c1', output: '{"r":2}' },
  ]);
});

// ---------------------------------------------------------------- 出站：响应

test('出站：Responses 响应 → chat 形状（文本 + 工具调用 + 缓存明细）', () => {
  const { body, usage } = openaiResponsesAdaptor.convertResponse(
    {
      id: 'resp_1',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'c9', name: 'get', arguments: '{"q":1}' },
      ],
      usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050, input_tokens_details: { cached_tokens: 200 } },
    },
    ctx(),
  );
  assert.equal(body.model, 'my-alias');
  assert.equal(body.choices[0].message.content, 'hello');
  assert.equal(body.choices[0].message.reasoning_content, 'thinking');
  assert.deepEqual(body.choices[0].message.tool_calls, [{ id: 'c9', type: 'function', function: { name: 'get', arguments: '{"q":1}' } }]);
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(usage.prompt_tokens, 1000);
  assert.equal(usage.completion_tokens, 50);
  assert.equal(usage.cached_tokens, 200);
});

// ---------------------------------------------------------------- 出站：流

test('出站：Responses SSE → chat chunks（role 开口、文本增量、工具增量、completed 收尾）', () => {
  const state = { id: '', created: 0, textAcc: '', promptTokens: 0, completionTokens: 0 };
  const ev = (type: string, data: any) => openaiResponsesAdaptor.convertStreamEvent({ event: type, data: JSON.stringify({ type, ...data }) }, ctx(), state);

  const r0 = ev('response.created', { response: { id: 'resp_9' } });
  assert.equal(r0.chunks[0].choices[0].delta.role, 'assistant');

  const r1 = ev('response.output_text.delta', { delta: 'he' });
  assert.equal(r1.chunks[0].choices[0].delta.content, 'he');
  const r2 = ev('response.output_text.delta', { delta: 'llo' });
  assert.equal(r2.chunks[0].choices[0].delta.content, 'llo');

  const r3 = ev('response.output_item.added', { item: { type: 'function_call', call_id: 'c1', name: 'get' } });
  assert.deepEqual(r3.chunks[0].choices[0].delta.tool_calls, [{ index: 0, id: 'c1', type: 'function', function: { name: 'get', arguments: '' } }]);
  const r4 = ev('response.function_call_arguments.delta', { delta: '{"q"' });
  assert.equal(r4.chunks[0].choices[0].delta.tool_calls[0].function.arguments, '{"q"');

  const r5 = ev('response.completed', { response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
  assert.equal(r5.usage.prompt_tokens, 10);
  assert.equal(r5.done, true);
});

// ---------------------------------------------------------------- 入站：请求

test('入站：Responses 请求 → 中枢 chat（instructions/工具往返）', () => {
  const chat = responsesToChatRequest({
    model: 'gpt-5.1',
    instructions: 'sys',
    input: [
      { role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'c1', name: 'get', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'res' },
    ],
    max_output_tokens: 64,
    tools: [{ type: 'function', name: 'get', description: 'd', parameters: { type: 'object' } }],
    store: true,
  });
  assert.equal(chat.model, 'gpt-5.1');
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'res' },
  ]);
  assert.equal(chat.max_tokens, 64);
  assert.deepEqual(chat.tools, [{ type: 'function', function: { name: 'get', description: 'd', parameters: { type: 'object' } } }]);
  assert.equal(chat.stream, undefined, 'store 被忽略（无状态网关不留档）');
});

test('入站：字符串 input 与 developer 角色', () => {
  const chat = responsesToChatRequest({ model: 'm', instructions: 's', input: 'hello', max_output_tokens: 8 });
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 's' },
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(chat.max_tokens, 8);
});

test('入站：previous_response_id 明确拒绝，不带上下文的伪状态骗不过网关', () => {
  assert.throws(() => responsesToChatRequest({ model: 'm', previous_response_id: 'resp_old', input: 'hi' }), ResponsesInboundError);
});

// ---------------------------------------------------------------- 入站：响应

test('入站：chat 响应 → Responses JSON（文本 / 推理 / 工具 / usage）', () => {
  const resp = chatResponseToResponses(
    {
      id: 'chatcmpl_1', created: 1700000000,
      choices: [{ message: { role: 'assistant', content: 'yo', reasoning_content: 'hm', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'g', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_tokens_details: { cached_tokens: 2 } },
    },
    'my-model',
  );
  assert.equal(resp.object, 'response');
  assert.equal(resp.model, 'my-model');
  assert.equal(resp.output[0].type, 'reasoning');
  assert.equal(resp.output[1].content[0].type, 'output_text');
  assert.equal(resp.output[1].content[0].text, 'yo');
  assert.equal(resp.output[2].type, 'function_call');
  assert.equal(resp.output[2].call_id, 'c1');
  assert.equal(resp.usage.input_tokens, 7);
  assert.equal(resp.usage.input_tokens_details.cached_tokens, 2);
});

// ---------------------------------------------------------------- 入站：流

test('入站：chat 流 → response.* SSE（created / 文本增量 / completed+usage）', () => {
  const enc = newResponsesEncoder();
  const c1 = encodeResponsesChunk(enc, { id: 'ch_1', choices: [{ delta: { role: 'assistant', content: '' } }] }, 'm');
  assert.match(c1, /event: response\.created/);
  const c2 = encodeResponsesChunk(enc, { id: 'ch_1', choices: [{ delta: { content: 'hi' } }] }, 'm');
  assert.match(c2, /event: response\.output_item\.added/);
  assert.match(c2, /event: response\.output_text\.delta/);
  assert.match(c2, /"delta":"hi"/);
  const tail = finishResponsesStream(enc, 'm', { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
  assert.match(tail, /event: response\.completed/);
  assert.match(tail, /"input_tokens":3/);
  assert.equal(encodeResponsesChunk(enc, { choices: [{ delta: { content: 'late' } }] }, 'm'), '', '结束后不再产出');
});

test('入站：finish_reason 在流里不产生 per-choice 事件，状态只在 completed 给', () => {
  const enc = newResponsesEncoder();
  encodeResponsesChunk(enc, { id: 'ch_1', choices: [{ delta: { role: 'assistant' } }] }, 'm');
  const out = encodeResponsesChunk(enc, { id: 'ch_1', choices: [{ delta: {}, finish_reason: 'stop' }] }, 'm');
  assert.equal(out, '');
});

// ---------------------------------------------------------------- runner

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(error);
  }
}
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log(`\nresponses: ${tests.length} passed`);
