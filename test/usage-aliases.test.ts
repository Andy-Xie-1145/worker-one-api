/**
 * HPD 风格富用量解析的单元测试：
 *   1. normalizeUsage 认得三种缓存计数别名（DeepSeek/anthropic/OpenAI 式），取最大值；
 *   2. 缓存写入别名进 cache_write_tokens（仅审计，不影响计费分量）；
 *   3. anthropic 客户端面（finishAnthropicStream）把内部缓存字段翻译回官方协议三字段；
 *   4. responses 出站 adaptor 保留 input_tokens_details 全部明细（含 cache_write_tokens）。
 *
 * Run: npm run test:usage-aliases
 */
import assert from 'node:assert/strict';
import { normalizeUsage, openaiAdaptor } from '../src/relay/openai';
import { anthropicAdaptor } from '../src/relay/anthropic';
import { openaiResponsesAdaptor } from '../src/relay/responses';
import { finishAnthropicStream, type AnthropicEncoderState } from '../src/relay/anthropic-inbound';
import { compileBillingExpr, evaluateRate } from '../src/lib/pricing/expr';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

function makeState(): AnthropicEncoderState {
  return {
    id: 'msg_test', started: true, openBlock: -1, openBlockKind: null, nextIndex: 0,
    toolBlocks: new Map(), inputTokens: 0, outputTokens: 0, stopReason: 'end_turn', stopped: false,
  };
}
const ctx = { requestedModel: 'm', upstreamModel: 'm', channel: {}, config: {}, path: '' } as any;

test('normalizeUsage：HPD 三族缓存别名（读=取最大值，写=别名族）', () => {
  const u = normalizeUsage({
    prompt_tokens: 93386, completion_tokens: 5, total_tokens: 93391,
    prompt_cache_hit_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 12,
    prompt_cache_write_tokens: 12,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  });
  assert.equal(u.prompt_tokens, 93386);
  assert.equal(u.completion_tokens, 5);
  assert.equal(u.cached_tokens, undefined); // 全零 → 省略缓存键（源行为）
  assert.equal(u.cache_write_tokens, 12);
});

test('normalizeUsage：cache_read_input_tokens 别名参与取最大', () => {
  const u = normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, cache_read_input_tokens: 30 });
  assert.equal(u.cached_tokens, 30);
});

test('normalizeUsage：OpenAI 标准形状（details 嵌套）不变', () => {
  const u = normalizeUsage({ prompt_tokens: 41, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 7 } });
  assert.equal(u.cached_tokens, 7);
  assert.equal(u.cache_write_tokens, undefined);
});

test('normalizeUsage：全零缓存 → 无缓存键', () => {
  const u = normalizeUsage({ prompt_tokens: 10, completion_tokens: 3 });
  assert.equal(u.cached_tokens, undefined);
  assert.equal(u.cache_write_tokens, undefined);
});

test('anthropicAdaptor.convertResponse：cache_creation TTL 分桶（5m/1h）+ OpenAI 式嵌套 details', () => {
  const r = anthropicAdaptor.convertResponse({
    content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
    usage: { input_tokens: 46, output_tokens: 11, cache_read_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 } },
  }, ctx);
  assert.equal(r.usage.prompt_tokens, 46 + 20 + 4 + 6);
  assert.equal(r.usage.cached_tokens, 20);
  assert.equal(r.usage.cache_write_5m_tokens, 4);
  assert.equal(r.usage.cache_write_1h_tokens, 6);
  // OpenAI 形状客户端读嵌套 details；顶层 cached_tokens 保留兼容
  assert.deepEqual(r.body.usage.prompt_tokens_details, { cached_tokens: 20 });
  assert.equal((r.body.usage as any).cached_tokens, 20);
});

test('anthropicAdaptor.convertResponse：只有写入总数时整体归 5m 桶', () => {
  const r = anthropicAdaptor.convertResponse({
    content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 8 },
  }, ctx);
  assert.equal(r.usage.cache_write_5m_tokens, 8);
  assert.equal(r.usage.cache_write_1h_tokens ?? 0, 0);
});

test('finishAnthropicStream：message_delta 带官方缓存三字段（input=新鲜部分，防重复计数）', () => {
  const out = finishAnthropicStream(makeState(), { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 30, cache_write_5m_tokens: 4, cache_write_1h_tokens: 5 });
  const delta = out.split('\n').filter((l) => l.startsWith('data: ') && l.includes('message_delta'))
    .map((l) => JSON.parse(l.slice(6)))[0];
  // Anthropic 契约：三桶互斥，input_tokens 只装新鲜部分（100−30−4−5=61）
  assert.equal(delta.usage.input_tokens, 61);
  assert.equal(delta.usage.output_tokens, 10);
  assert.equal(delta.usage.cache_read_input_tokens, 30);
  assert.equal(delta.usage.cache_creation_input_tokens, 9);
  assert.equal(delta.usage.cache_creation.ephemeral_5m_input_tokens, 4);
  assert.equal(delta.usage.cache_creation.ephemeral_1h_input_tokens, 5);
  // 求和口径校验：三桶相加 = 总输入
  assert.equal(delta.usage.input_tokens + delta.usage.cache_read_input_tokens + delta.usage.cache_creation_input_tokens, 100);
});

test('finishAnthropicStream：无缓存 → usage 只有 input/output（形状不变）', () => {
  const out = finishAnthropicStream(makeState(), { prompt_tokens: 100, completion_tokens: 10 });
  const delta = out.split('\n').filter((l) => l.startsWith('data: ') && l.includes('message_delta'))
    .map((l) => JSON.parse(l.slice(6)))[0];
  assert.deepEqual(delta.usage, { input_tokens: 100, output_tokens: 10 });
});

test('openaiResponsesAdaptor.convertResponse：input_tokens_details 全明细保留', () => {
  const r = openaiResponsesAdaptor.convertResponse({
    id: 'resp_1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 7 } },
  }, ctx);
  assert.deepEqual(r.body.usage.prompt_tokens_details, { cached_tokens: 5, cache_write_tokens: 7 });
  assert.equal(r.usage.cached_tokens, 5);
  assert.equal(r.usage.cache_write_tokens, 7);
});

test('openaiAdaptor.convertResponse：HPD 混装 usage 原样透传 + 归一化取值', () => {
  const r = openaiAdaptor.convertResponse({
    model: 'up', choices: [], usage: {
      prompt_tokens: 49, completion_tokens: 40, total_tokens: 89,
      cache_creation_input_tokens: 9, cache_read_input_tokens: 13, prompt_cache_write_tokens: 9, prompt_cache_hit_tokens: 13,
      prompt_tokens_details: { cached_tokens: 13 }, completion_tokens_details: { reasoning_tokens: 33 },
    },
  }, ctx);
  // 原始 body 原样给客户端（model 改写除外）——别名字段一个不丢
  assert.equal(r.body.usage.cache_creation_input_tokens, 9);
  assert.equal(r.body.usage.prompt_cache_hit_tokens, 13);
  // 归一化：读=13，写=9
  assert.equal(r.usage.cached_tokens, 13);
  assert.equal(r.usage.cache_write_tokens, 9);
});

test('deepseek 渠道价时间表达式：高峰/窗外/周末三分支', () => {
  const DS_IN = "(weekday('UTC') >= 1 && weekday('UTC') <= 5 && ((hour('UTC') >= 1 && hour('UTC') < 4) || (hour('UTC') >= 6 && hour('UTC') < 10))) ? 0.3 : 0.15";
  const compiled = compileBillingExpr(DS_IN);
  assert.ok(compiled.ok, compiled.ok ? '' : JSON.stringify((compiled as { error?: string }).error));
  const program = (compiled as { program: Parameters<typeof evaluateRate>[0] }).program;
  const rateAt = (iso: string) => {
    const r = evaluateRate(program, { params: { context: 1000 }, now: new Date(iso) });
    return r.ok ? r.rate : NaN;
  };
  assert.equal(rateAt('2026-11-09T02:30:00Z'), 0.3); // 周一 02:30Z，高峰窗内
  assert.equal(rateAt('2026-11-09T12:00:00Z'), 0.15); // 工作日但窗外
  assert.equal(rateAt('2026-11-08T16:30:00Z'), 0.15); // 周末
});

/* ---------------------------------------------------------------- runner */
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(error);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed}/${tests.length} failed`);
    process.exit(1);
  }
  console.log(`\n${tests.length} passed`);
})();
