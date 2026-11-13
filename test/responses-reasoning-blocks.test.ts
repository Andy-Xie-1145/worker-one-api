/**
 * Responses 编码器多 reasoning 块回归（2026-11-13，HPD 实测形态）：
 *   HPD 的推理会拆成多段、穿插在正文/工具调用之间（一段思考 → 干活 → 又一段思考……）。
 *   旧行为：所有推理追加进同一个 output item → 事件流 output_index 倒挂、块边界丢失。
 *   新行为：被正文/工具打断即收口当前 reasoning 项（done 三连），推理再现则开新 item；
 *   最终 response.completed 的 output 数组按 index 排序、包含全部块。
 *
 * 纯函数测试（不碰 D1/KV）：newResponsesEncoder + encodeResponsesChunk + finishResponsesStream。
 *
 * Run: npm run test:responses-reasoning-blocks
 */
import assert from 'node:assert/strict';
import { newResponsesEncoder, encodeResponsesChunk, finishResponsesStream } from '../src/relay/responses-inbound';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

interface SseEvent { event: string; data: any }
function parse(sseText: string): SseEvent[] {
  return sseText
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const eventLine = block.split('\n').find((l) => l.startsWith('event: ')) ?? '';
      const dataLine = block.split('\n').find((l) => l.startsWith('data: ')) ?? '';
      return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
    });
}

const chatChunk = (delta: any, extra: any = {}) => JSON.stringify({ id: 'chatcmpl-x', created: 1700000000, choices: [{ index: 0, delta, finish_reason: null }], ...extra });

/** 复刻截图形态：思考A(2块) → 正文 → 工具1 → 思考B → 工具2 → 思考C → 正文收尾 */
function runScreenshotScenario() {
  const enc = newResponsesEncoder();
  let text = '';
  const feed = (delta: any, extra?: any) => { text += encodeResponsesChunk(enc, JSON.parse(chatChunk(delta, extra)), 'gpt-6.1-sol'); };
  feed({ reasoning_content: '思考A：' });
  feed({ reasoning_content: '先核对账单' });
  feed({ content: '开始干活' });
  feed({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'edit_file', arguments: '{"p"' } }] });
  feed({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] });
  feed({ reasoning_content: '思考B：再查一遍' });
  feed({ tool_calls: [{ index: 1, id: 'call_2', function: { name: 'read_file', arguments: '{}' } }] });
  feed({ reasoning_content: '思考C：都对了' });
  feed({ content: '干完了' });
  feed({}, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  text += finishResponsesStream(enc, 'gpt-6.1-sol', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  return { enc, events: parse(text), text };
}

test('截图形态：3 个独立 reasoning item，id/index 各异，事件流 output_index 单调', () => {
  const { enc, events } = runScreenshotScenario();
  const added = events.filter((e) => e.event === 'response.output_item.added' && e.data.item.type === 'reasoning');
  assert.equal(added.length, 3, `应开 3 个 reasoning item，实际 ${added.length}`);
  const ids = added.map((e) => e.data.item.id);
  assert.equal(new Set(ids).size, 3, 'id 不得重复');
  assert.deepEqual(added.map((e) => e.data.output_index), [0, 3, 5]); // A=0, msg=1, fc1=2, B=3, fc2=4, C=5

  // 每个块各自的 delta 都引用自己的 item_id/output_index（不再倒挂回 item0）
  const reasoningDeltas = events.filter((e) => e.event === 'response.reasoning_summary_text.delta');
  const byItem: Record<string, number> = {};
  for (const e of reasoningDeltas) byItem[e.data.item_id] = (byItem[e.data.item_id] ?? 0) + 1;
  assert.deepEqual(Object.keys(byItem).sort(), [...ids].sort());
  for (const e of reasoningDeltas) {
    const addedRow = added.find((a) => a.data.item.id === e.data.item_id)!;
    assert.equal(e.data.output_index, addedRow.data.output_index, 'delta 的 output_index 必须等于所属 item 的 index');
  }
  void enc;
});

test('块 A 在正文开始前收口：done(0) 先于第一条正文 delta', () => {
  const { events } = runScreenshotScenario();
  const doneIdx = events.findIndex((e) => e.event === 'response.output_item.done' && e.data.item.type === 'reasoning' && e.data.output_index === 0);
  const textDeltaIdx = events.findIndex((e) => e.event === 'response.output_text.delta');
  assert.ok(doneIdx >= 0 && textDeltaIdx >= 0 && doneIdx < textDeltaIdx, `done(0)=${doneIdx} 应早于首条正文 delta=${textDeltaIdx}`);
});

test('最终 response.completed 的 output 按序含全部块：A、message、B、fc、C、fc2', () => {
  const { events } = runScreenshotScenario();
  const completed = events.find((e) => e.event === 'response.completed');
  assert.ok(completed, '缺 response.completed');
  const types = completed.data.response.output.map((o: any) => o.type);
  assert.deepEqual(types, ['reasoning', 'message', 'function_call', 'reasoning', 'function_call', 'reasoning']);
  const reasoning0 = completed.data.response.output[0];
  assert.equal(reasoning0.summary[0].text, '思考A：先核对账单');
  const message = completed.data.response.output[1];
  assert.equal(message.content[0].text, '开始干活干完了'); // 两次正文合并进同一个 message item
  const fc = completed.data.response.output[2];
  assert.equal(fc.arguments, '{"p":1}');
  const reasoning3 = completed.data.response.output[3];
  assert.equal(reasoning3.summary[0].text, '思考B：再查一遍');
  const reasoning5 = completed.data.response.output[5];
  assert.equal(reasoning5.summary[0].text, '思考C：都对了');
});

test('usage 照常回传（reasoning_tokens 透传）', () => {
  const { events } = runScreenshotScenario();
  const completed = events.find((e) => e.event === 'response.completed');
  assert.equal(completed.data.response.usage.input_tokens, 100);
  assert.equal(completed.data.response.usage.output_tokens, 50);
});

test('纯单块推理（无打断）行为不变：1 个 item、done 一次、output=[reasoning]', () => {
  const enc = newResponsesEncoder();
  let text = '';
  text += encodeResponsesChunk(enc, JSON.parse(chatChunk({ reasoning_content: '独白' })), 'm');
  text += encodeResponsesChunk(enc, JSON.parse(chatChunk({ reasoning_content: '继续想' })), 'm');
  text += encodeResponsesChunk(enc, JSON.parse(chatChunk({ content: '答案' })), 'm');
  text += finishResponsesStream(enc, 'm', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  const events = parse(text);
  const added = events.filter((e) => e.event === 'response.output_item.added' && e.data.item.type === 'reasoning');
  assert.equal(added.length, 1);
  const done = events.filter((e) => e.event === 'response.output_item.done' && e.data.item.type === 'reasoning');
  assert.equal(done.length, 1);
  const completed = events.find((e) => e.event === 'response.completed');
  assert.deepEqual(completed.data.response.output.map((o: any) => o.type), ['reasoning', 'message']);
  assert.equal(completed.data.response.output[0].summary[0].text, '独白继续想');
});

test('纯正文流（无推理）行为不变', () => {
  const enc = newResponsesEncoder();
  let text = '';
  text += encodeResponsesChunk(enc, JSON.parse(chatChunk({ content: '你好' })), 'm');
  text += finishResponsesStream(enc, 'm', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  const events = parse(text);
  assert.ok(!events.some((e) => e.data.item?.type === 'reasoning'));
  const completed = events.find((e) => e.event === 'response.completed');
  assert.deepEqual(completed.data.response.output.map((o: any) => o.type), ['message']);
});

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`\n${tests.length} 个用例全部通过`);
