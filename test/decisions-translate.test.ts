/**
 * 决策方言翻译（relay/decisions-translate.ts）单测。
 *
 * 钉死：方言识别（state/input）、请求翻译（state↔input、questions 对象↔数组按序、
 * noul↔predicate、criteria↔options、未知字段透传）、answers 双向按键序回翻、
 * 方言相同时原样返回。
 *
 * Run: npm run test:decisions-translate
 */
import assert from 'node:assert/strict';
import {
  detectDecisionsDialect, decisionsDialectOf, translateDecisionsRequest, translateDecisionsResponse,
} from '../src/relay/decisions-translate';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

/* ------------------------------------------------------------- 识别 */

test('方言识别：state → systemone，input → openai，都没有 → null', () => {
  assert.equal(detectDecisionsDialect({ state: 'x', questions: {} }), 'systemone');
  assert.equal(detectDecisionsDialect({ input: 'x', questions: [] }), 'openai');
  assert.equal(detectDecisionsDialect({ questions: [] }), null, '两种主字段都没有');
  assert.equal(detectDecisionsDialect(null), null);
  assert.equal(detectDecisionsDialect('str'), null);
});

test('渠道方言：decisions 类型 = openai；systemone / openai 兼容 = systemone', () => {
  assert.equal(decisionsDialectOf({ type: 'decisions' }), 'openai');
  assert.equal(decisionsDialectOf({ type: 'systemone' }), 'systemone');
  assert.equal(decisionsDialectOf({ type: 'openai' }), 'systemone', 'OpenRouter 老 = TypeSafe 方言');
});

/* ------------------------------------------------------------- 请求翻译 */

test('systemone → openai：state→input、questions 对象→数组按插入序、noul→predicate、criteria→options', () => {
  const body = {
    model: 'jev-latest',
    state: { ctx: '服务器 500 了' },
    questions: {
      dept: { type: 'choice', instructions: '谁处理', criteria: { billing: '账单', tech: '故障' } },
      urgent: { type: 'noul', instructions: '紧急吗' },
      sev: { type: 'score', instructions: '严重度', unknown_field: 1 },
    },
    extra: 'keep-me',
  };
  const r = translateDecisionsRequest(body, 'systemone', 'openai');
  assert.deepEqual(r.keys, ['dept', 'urgent', 'sev']);
  assert.equal(r.body.input, body.state, 'state → input（引用不变）');
  assert.equal(r.body.state, undefined);
  assert.ok(Array.isArray(r.body.questions) && r.body.questions.length === 3);
  const [dept, urgent, sev] = r.body.questions as any[];
  assert.equal(dept.type, 'choice');
  assert.deepEqual(dept.options, { billing: '账单', tech: '故障' }, 'criteria → options');
  assert.equal(dept.criteria, undefined);
  assert.equal(urgent.type, 'predicate', 'noul → predicate');
  assert.equal(sev.type, 'score');
  assert.equal(sev.unknown_field, 1, '未知字段透传');
  assert.equal(r.body.extra, 'keep-me', '顶层未知字段透传');
});

test('openai → systemone：input→state、questions 数组→对象合成 q0/q1…、predicate→noul、options→criteria', () => {
  const body = {
    model: 'gpt-6-luna',
    input: '被重复扣费了',
    questions: [
      { type: 'choice', instructions: '哪个部门', options: { billing: '支付' } },
      { type: 'predicate', instructions: '是重复扣费吗' },
    ],
  };
  const r = translateDecisionsRequest(body, 'openai', 'systemone');
  assert.deepEqual(r.keys, ['q0', 'q1']);
  assert.equal(r.body.state, body.input);
  assert.equal(r.body.input, undefined);
  const q = r.body.questions as Record<string, any>;
  assert.equal(q.q0.type, 'choice');
  assert.deepEqual(q.q0.criteria, { billing: '支付' }, 'options → criteria');
  assert.equal(q.q0.options, undefined);
  assert.equal(q.q1.type, 'noul', 'predicate → noul');
});

test('方言相同：原样返回、keys=null（不翻译）', () => {
  const body = { model: 'm', state: 's', questions: { a: { type: 'noul' } } };
  const r = translateDecisionsRequest(body, 'systemone', 'systemone');
  assert.equal(r.body, body);
  assert.equal(r.keys, null);
});

/* ------------------------------------------------------------- 响应翻译 */

test('响应 systemone → openai：answers 对象→数组按请求键序', () => {
  const json = { id: 'd1', model: 'jev-latest', answers: { dept: { choice: 'tech' }, urgent: { p: 0.9 } }, usage: { input_tokens: 10 } };
  const out = translateDecisionsResponse(json, 'systemone', 'openai', ['dept', 'urgent']) as any;
  assert.ok(Array.isArray(out.answers));
  assert.deepEqual(out.answers, [{ choice: 'tech' }, { p: 0.9 }]);
  assert.equal(out.id, 'd1', '外壳字段原样');
  assert.deepEqual(out.usage, { input_tokens: 10 }, 'usage 原样（另由 normalizeDecisionsUsage 解析）');
});

test('响应 openai → systemone：answers 数组→对象按合成键序', () => {
  const json = { id: 'd2', answers: [{ choice: 'billing' }, { refusal: 'x' }], usage: { input_tokens: 5 } };
  const out = translateDecisionsResponse(json, 'openai', 'systemone', ['q0', 'q1']) as any;
  assert.deepEqual(out.answers, { q0: { choice: 'billing' }, q1: { refusal: 'x' } }, 'refusal 原样保留');
});

test('响应边角：无 answers 原样；键序缺失时按对象键/数组下标兜底；方言相同不动', () => {
  const noAnswers = { id: 'd3', usage: {} };
  assert.equal(translateDecisionsResponse(noAnswers, 'systemone', 'openai', null), noAnswers);
  const byObjectKeys = translateDecisionsResponse({ answers: { b: 2, a: 1 } }, 'systemone', 'openai', null) as any;
  assert.deepEqual(byObjectKeys.answers, [2, 1], 'keys 缺失按对象插入序');
  const byIndex = translateDecisionsResponse({ answers: [7, 8] }, 'openai', 'systemone', null) as any;
  assert.deepEqual(byIndex.answers, { q0: 7, q1: 8 });
  const same = { answers: { a: 1 } };
  assert.equal(translateDecisionsResponse(same, 'openai', 'openai', null), same);
});

/* ------------------------------------------------------------- runner */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
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
console.log(`\ndecisions-translate: ${tests.length} passed`);
