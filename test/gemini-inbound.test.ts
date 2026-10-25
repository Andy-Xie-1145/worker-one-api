/**
 * Gemini 入站翻译测试：generateContent ⇄ 中枢 chat。
 *
 * Run: npm run test:gemini
 */
import assert from 'node:assert/strict';
import {
  geminiToChatRequest, chatResponseToGemini, newGeminiEncoder, encodeGeminiChunk, finishGeminiStream,
} from '../src/relay/gemini-inbound';
import { geminiAdaptor } from '../src/relay/gemini';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('入站：contents/systemInstruction/generationConfig/tools 全量映射', () => {
  const chat = geminiToChatRequest(
    {
      systemInstruction: { parts: [{ text: 'be brief' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }] },
        { role: 'model', parts: [{ functionCall: { name: 'get', args: { q: 1 } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get', response: { r: 2 } } }] },
      ],
      generationConfig: { maxOutputTokens: 77, temperature: 0.5, stopSequences: ['\n\n'] },
      tools: [{ functionDeclarations: [{ name: 'get', description: 'd', parameters: { type: 'object' } }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get'] } },
    },
    'gemini-2.5-flash',
  );
  assert.equal(chat.model, 'gemini-2.5-flash');
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'get', type: 'function', function: { name: 'get', arguments: '{"q":1}' } }] },
    { role: 'tool', tool_call_id: 'get', name: 'get', content: '{"r":2}' },
  ]);
  assert.equal(chat.max_tokens, 77);
  assert.equal(chat.temperature, 0.5);
  assert.deepEqual(chat.stop, ['\n\n']);
  assert.deepEqual(chat.tools, [{ type: 'function', function: { name: 'get', description: 'd', parameters: { type: 'object' } } }]);
  assert.deepEqual(chat.tool_choice, { type: 'function', function: { name: 'get' } });
});

test('入站：toolConfig 的 NONE/AUTO 映射', () => {
  assert.equal(geminiToChatRequest({ toolConfig: { functionCallingConfig: { mode: 'NONE' } } }, 'm').tool_choice, 'none');
  assert.equal(geminiToChatRequest({ toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }, 'm').tool_choice, 'auto');
});

test('出站：chat 响应 → Gemini JSON（文本 / functionCall / usageMetadata）', () => {
  const gem = chatResponseToGemini(
    {
      id: 'ch_1', created: 1700000000,
      choices: [{ message: { role: 'assistant', content: 'yo', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get', arguments: '{"q":1}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, prompt_tokens_details: { cached_tokens: 3 } },
    },
    'gemini-2.5-flash',
  );
  assert.equal(gem.candidates[0].finishReason, 'STOP');
  assert.deepEqual(gem.candidates[0].content.parts, [{ text: 'yo' }, { functionCall: { name: 'get', args: { q: 1 } } }]);
  assert.equal(gem.usageMetadata.promptTokenCount, 9);
  assert.equal(gem.usageMetadata.cachedContentTokenCount, 3);
  assert.equal(gem.modelVersion, 'gemini-2.5-flash');
});

test('出站：finishReason 的 length → MAX_TOKENS', () => {
  const gem = chatResponseToGemini({ choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'length' }], usage: {} }, 'm');
  assert.equal(gem.candidates[0].finishReason, 'MAX_TOKENS');
});

test('出站：流——文本增量直通，工具参数累积到 finish 才整块吐出', () => {
  const enc = newGeminiEncoder();
  const c1 = encodeGeminiChunk(enc, { choices: [{ delta: { role: 'assistant', content: 'he' } }] }, 'm');
  assert.match(c1, /"text":"he"/);
  assert.equal(encodeGeminiChunk(enc, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get', arguments: '{"q"' } }] } }] }, 'm'), '', '工具增量不落流');
  assert.equal(encodeGeminiChunk(enc, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }, 'm'), '');
  const c2 = encodeGeminiChunk(enc, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, 'm');
  assert.match(c2, /"functionCall":\{"name":"get","args":\{"q":1\}\}/);
  assert.match(c2, /"finishReason":"STOP"/);
  const c3 = finishGeminiStream(enc, 'm', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  assert.match(c3, /"promptTokenCount":2/);
});

test('入站：同一条消息的多个 functionResponse 全部保留', () => {
  const chat = geminiToChatRequest(
    { contents: [{ role: 'user', parts: [{ functionResponse: { name: 'a', response: { r: 1 } } }, { functionResponse: { name: 'b', response: { r: 2 } } }] }] },
    'm',
  );
  assert.equal(chat.messages.length, 2, '两个结果都必须进上下文');
  assert.deepEqual(chat.messages.map((x) => x.tool_call_id), ['a', 'b']);
});

test('出站：tool 结果按 call_id 从历史 tool_calls 找回函数名', () => {
  const built = geminiAdaptor.buildRequest(
    {
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'weather', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_9', content: '{"r":1}' },
      ],
    },
    {
      channel: { id: 1, type: 'gemini', key: 'k', status: 1, name: 'g', weight: 1, priority: 0, created_time: 0, test_time: 0, response_time: 0, base_url: 'https://g.test', balance: 0, models: '', used_quota: 0, model_mapping: '', config: '', system_prompt: '' } as any,
      upstreamModel: 'm',
      requestedModel: 'm',
      mode: 'chat',
      path: 'chat/completions',
      config: {},
    },
  );
  const body = JSON.parse(built.body);
  const last = body.contents.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.parts[0].functionResponse.name, 'weather', 'tool_call_id 要映射回函数名');
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
console.log(`\ngemini: ${tests.length} passed`);
