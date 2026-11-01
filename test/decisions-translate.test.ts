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

test('systemone → openai：state→input、questions 对象→数组按插入序、noul→predicate、criteria→options 数组', () => {
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
  assert.deepEqual(dept.options, [
    { value: 'billing', description: '账单' },
    { value: 'tech', description: '故障' },
  ], 'criteria 对象 → options 数组');
  assert.equal(dept.criteria, undefined);
  assert.equal(urgent.type, 'predicate', 'noul → predicate');
  assert.equal(sev.type, 'score');
  assert.equal(sev.unknown_field, 1, '未知字段透传');
  assert.equal(r.body.extra, 'keep-me', '顶层未知字段透传');
});

test('openai → systemone：input→state、questions 数组按 name 键控、predicate→noul、choices→criteria 对象', () => {
  // 真实客户端（Simple Work Agent）的 decisions 形状：选项叫 choices 数组。
  // 上游对 criteria 的形状是硬校验的——原样改名成 criteria 数组会被 400 拒，
  // 报错原文：question 'q0': choice needs a non-empty "criteria" object。
  const body = {
    model: 'elephant-1',
    input: '被重复扣费了',
    questions: [
      { type: 'choice', name: 'intent', instructions: '哪个部门', choices: [
        { value: 'billing', description: '支付' },
        { value: 'tech', description: '故障' },
      ] },
      { type: 'predicate', instructions: '是重复扣费吗' },
    ],
  };
  const r = translateDecisionsRequest(body, 'openai', 'systemone');
  assert.deepEqual(r.keys, ['intent', 'q1'], '自带 name 的题用真名当键，没有才合成 qN');
  assert.equal(r.body.state, body.input);
  assert.equal(r.body.input, undefined);
  const q = r.body.questions as Record<string, any>;
  assert.equal(q.intent.type, 'choice');
  assert.deepEqual(q.intent.criteria, { billing: '支付', tech: '故障' }, 'choices 数组 → criteria 对象');
  assert.equal(q.intent.choices, undefined);
  assert.equal(q.intent.name, undefined, 'name 由 questions 的键承载，不再透传');
  assert.equal(q.q1.type, 'noul', 'predicate → noul');
});

test('openai → systemone：options 对象/数组都吃；input 是 JSON 文本时解析成 state 对象', () => {
  const fromObject = translateDecisionsRequest(
    { input: 'x', questions: [{ type: 'choice', name: 'a', options: { billing: '支付' } }] },
    'openai', 'systemone',
  );
  assert.deepEqual((fromObject.body.questions as any).a.criteria, { billing: '支付' }, 'options 对象 → criteria');

  const fromArray = translateDecisionsRequest(
    { input: 'x', questions: [{ type: 'choice', constraints: 1, choices: ['yes', 'no'] }] },
    'openai', 'systemone',
  );
  assert.deepEqual((fromArray.body.questions as any).q0.criteria, { yes: 'yes', no: 'no' }, '字符串选项 → criteria');

  // System One 的 state 是结构化对象；客户端常把 decisions 的 input 发成 JSON 文本。
  const structured = translateDecisionsRequest(
    { input: JSON.stringify({ text: 'hi', context: { goal: 'x' } }), questions: [] },
    'openai', 'systemone',
  );
  assert.deepEqual(structured.body.state, { text: 'hi', context: { goal: 'x' } }, 'JSON 文本 → 对象');
  // 纯文本照旧，不猜
  const plain = translateDecisionsRequest({ input: 'just text', questions: [] }, 'openai', 'systemone');
  assert.equal(plain.body.state, 'just text');
});

test('方言相同：原样返回、keys=null（不翻译）', () => {
  const body = { model: 'm', state: 's', questions: { a: { type: 'noul' } } };
  const r = translateDecisionsRequest(body, 'systemone', 'systemone');
  assert.equal(r.body, body);
  assert.equal(r.keys, null);
});

/* ------------------------------------------------------------- 响应翻译 */

test('响应 systemone → openai：真实上游形状 → 答案数组（带 name、probabilities 转数组、题型改名）', () => {
  // 上游实测响应（channel 8 / elephant-1）：
  // {"answers":{"intent":{"type":"choice","choice":"question",
  //   "probabilities":{"question":0.978,"newtask":0.022},"confidence":0.957}}}
  const json = {
    model: 'elephant-1',
    answers: { intent: { type: 'choice', choice: 'question', probabilities: { question: 0.978, newtask: 0.022 }, confidence: 0.957 } },
    usage: { input_tokens: 156, output_tokens: 1 },
  };
  const out = translateDecisionsResponse(json, 'systemone', 'openai', ['intent']) as any;
  assert.ok(Array.isArray(out.answers));
  // 客户端（Simple Work Agent）对 choice 答案是 exact-key 校验：多一个少一个都判非法。
  assert.deepEqual(out.answers, [{
    type: 'choice',
    name: 'intent',
    choice: 'question',
    confidence: 0.957,
    probabilities: [{ value: 'question', probability: 0.978 }, { value: 'newtask', probability: 0.022 }],
  }]);
  assert.deepEqual(out.usage, { input_tokens: 156, output_tokens: 1 }, 'usage 原样（另由 normalizeDecisionsUsage 解析）');
  assert.deepEqual(Object.keys(out).sort(), ['answers', 'model', 'usage'], '外壳字段不增不减');

  // noul 答案 → predicate，字段透传
  const noul = translateDecisionsResponse({ answers: { ok: { type: 'noul', noul: 0.72 } } }, 'systemone', 'openai', ['ok']) as any;
  assert.deepEqual(noul.answers, [{ type: 'predicate', noul: 0.72, name: 'ok' }]);
});

test('响应 openai → systemone：answers 数组→按键序的对象，probabilities 数组→对象，去掉 name', () => {
  const json = {
    answers: [{ type: 'choice', name: 'intent', choice: 'billing', confidence: 0.9, probabilities: [{ value: 'billing', probability: 0.9 }, { value: 'tech', probability: 0.1 }] }],
    usage: { input_tokens: 5 },
  };
  const out = translateDecisionsResponse(json, 'openai', 'systemone', ['intent']) as any;
  assert.deepEqual(out.answers, {
    intent: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, tech: 0.1 } },
  });
});

test('响应边角：无 answers 原样；键序缺失时按对象键/数组下标兜底；方言相同不动', () => {
  const noAnswers = { id: 'd3', usage: {} };
  assert.equal(translateDecisionsResponse(noAnswers, 'systemone', 'openai', null), noAnswers);
  const byObjectKeys = translateDecisionsResponse({ answers: { b: { p: 2 }, a: { p: 1 } } }, 'systemone', 'openai', null) as any;
  assert.deepEqual(byObjectKeys.answers, [{ p: 2, name: 'b' }, { p: 1, name: 'a' }], 'keys 缺失按对象插入序');
  const byIndex = translateDecisionsResponse({ answers: [{ p: 7 }, { p: 8 }] }, 'openai', 'systemone', null) as any;
  assert.deepEqual(byIndex.answers, { q0: { p: 7 }, q1: { p: 8 } });
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
