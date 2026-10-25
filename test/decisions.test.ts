/**
 * Jev / OpenRouter Decisions API 接入。
 *
 * 这条路的风险不在「能不能把请求发出去」，而在两件安静的事：
 *
 *   1. **分诊**。Jev 只接受 Decisions API。它一旦出现在 /v1/models 里，任何按那份
 *      列表选模型的客户端都会把它发去 chat/completions，拿回一个来自上游的 404。
 *   2. **计价**。Jev 是 $0.042/1M 输入、输出免费。价格表里没有它就掉进 DEFAULT_PRICE
 *      （$1/$3）——输入贵 24 倍，输出更是凭空多收一笔，而且不会报任何错。
 *
 * 其余（预扣/结算/退款、429 冷却重试）走的是和 chat 完全相同的机器，这里端到端各钉
 * 一条，确保接的是那台机器而不是复制了一台。
 *
 * Run: npm run test:decisions
 */
import assert from 'node:assert/strict';
import worker from '../src/index';
import { calcQuota, findPrice, resolvePrice } from '../src/lib/pricing/llm';
import { isDecisionOnlyModel } from '../src/lib/capability';
import type { Options } from '../src/lib/options';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const KEY = 'sk-' + 'a'.repeat(48);
const JEV = '~typesafe/jev-latest';
const OPENROUTER_KEY = 'or-secret';

/* ---------------------------------------------------------------- 测试替身 */

interface World {
  user: any;
  token: any;
  abilities: Array<{ group: string; model: string; channel_id: number; priority: number; weight: number }>;
  channels: any[];
  credits: Array<{ delta: number; reason: string; ref: string }>;
  logs: any[][];
  events: any[][];
}

function makeWorld(over: Partial<World> = {}): World {
  const channel = (id: number, name: string) => ({
    id,
    type: 'openai',
    key: OPENROUTER_KEY,
    status: 1,
    name,
    weight: 1,
    priority: 0,
    base_url: 'https://openrouter.ai/api',
    models: JEV,
    group: 'default',
    model_mapping: '',
    config: '',
    system_prompt: '',
  });
  return {
    user: { id: 1, username: 'u', group: 'default', status: 1, quota: 1_000_000, used_quota: 0, request_count: 0, email: '', plan_slug: '' },
    token: { id: 9, key: 'a'.repeat(48), user_id: 1, name: 't', status: 1, models: '', unlimited_quota: 0, remain_quota: 1_000_000, used_quota: 0, expired_time: -1 },
    abilities: [{ group: 'default', model: JEV, channel_id: 6, priority: 0, weight: 1 }],
    channels: [channel(6, 'openrouter')],
    credits: [],
    logs: [],
    events: [],
    ...over,
  };
}

/** 按 SQL 形状应答的最小 D1 替身。只实现中继路径真正会发的那些语句。 */
function makeDB(w: World) {
  const route = (sql: string, binds: any[]): any => {
    const one = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT \* FROM tokens WHERE key/.test(one)) return w.token.key === binds[0] ? w.token : null;
    // authenticateToken → ensureOwner 用 username 找唯一账户；mock 世界里 w.user 就是它。
    if (/^SELECT \* FROM users WHERE username/.test(one)) return w.user;
    if (/^SELECT \* FROM users WHERE id/.test(one)) return w.user.id === binds[0] ? w.user : null;
    if (/^SELECT key, value FROM options/.test(one)) return { results: [] };
    if (/^SELECT 1 AS hit FROM credits WHERE ref/.test(one)) return w.credits.some((c) => c.ref === binds[0]) ? { hit: 1 } : null;
    if (/^SELECT quota FROM users WHERE id/.test(one)) return { quota: w.user.quota };

    if (/^UPDATE users SET quota = quota \+ \?/.test(one)) {
      const [delta, id] = binds;
      if (w.user.id !== id) return null;
      const guarded = /quota \+ \?1 >= 0/.test(one);
      if (guarded && w.user.quota + delta < 0) return null;
      w.user.quota += delta;
      return { quota: w.user.quota };
    }
    if (/^INSERT INTO credits/.test(one)) {
      const ref = binds[3];
      // credits.ref 上有唯一索引——结算和退款正靠它互斥，替身必须也守这条。
      if (ref && w.credits.some((c) => c.ref === ref)) throw new Error('UNIQUE constraint failed: credits.ref');
      w.credits.push({ delta: binds[1], reason: binds[2], ref });
      // applyCreditGated 的账本行是 INSERT ... SELECT ... RETURNING id——回行让「已插入」判定成立。
      if (/RETURNING id/.test(one)) return { results: [{ id: 1 }] };
      return {};
    }

    if (/^SELECT DISTINCT model FROM abilities/.test(one)) {
      // decisions 的 abilities 替身行不带 enabled 字段——缺省视为启用。
      const scoped = w.abilities.filter((a) => a.enabled !== 0);
      const models = [...new Set(scoped.map((a) => a.model))].sort();
      return { results: models.map((model) => ({ model })) };
    }
    if (/FROM abilities WHERE model = \? AND enabled = 1/.test(one)) {
      return { results: w.abilities.filter((a) => a.model === binds[0] && a.enabled !== 0) };
    }
    if (/^SELECT \* FROM channels WHERE id = \?/.test(one)) {
      return w.channels.find((ch) => ch.id === binds[0] && ch.status === binds[1]) ?? null;
    }

    if (/^INSERT INTO logs/.test(one)) {
      w.logs.push(binds);
      return {};
    }
    if (/^INSERT INTO relay_events/.test(one)) {
      w.events.push(binds);
      return {};
    }
    // 各种计数器更新（users/tokens/channels）不影响断言，吞掉。
    if (/^UPDATE /.test(one)) return { meta: { changes: 1 } };
    throw new Error(`未预期的 SQL: ${one}`);
  };

  const stmt = (sql: string, binds: any[] = []) => ({
    bind: (...b: any[]) => stmt(sql, b),
    first: async () => route(sql, binds),
    all: async () => {
      const r = route(sql, binds);
      return r && 'results' in r ? r : { results: [] };
    },
    run: async () => route(sql, binds) ?? { meta: { changes: 0 } },
  });

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: any[]) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

function makeKV() {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: async (k: string, type?: string) => {
      const v = store.get(k) ?? null;
      return v !== null && type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  };
}

/** 一次上游应答的脚本。`use()` 返回捕获到的请求。 */
function scriptFetch(responses: Array<{ status: number; body: any }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '{}') });
    const next = responses.shift() ?? { status: 500, body: { error: { message: '脚本用完了' } } };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(Promise.resolve(p)), passThroughOnException: () => {} } as never;
/** waitUntil 里跑的是结算/退款/事件落库，断言之前必须等它们完成。 */
const drain = async () => {
  while (pending.length) await pending.shift();
};

async function call(
  w: World,
  path: string,
  body: unknown,
  opts: { key?: string | null; method?: string } = {},
): Promise<Response> {
  const kv = makeKV();
  const env = { DB: makeDB(w), CACHE: kv, ASSETS: { fetch: async () => new Response('spa') } } as never;
  const key = opts.key === undefined ? KEY : opts.key;
  const method = opts.method ?? 'POST';
  const res = await worker.fetch(
    new Request(`https://oneapi.test${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    ctx,
  );
  await drain();
  return res;
}

/*
 * 形状抄自 OpenRouter 官方 Jev Lab 示例：
 * `decisions.create({ decisionsRequest: { model, state, questions } })`，
 * questions 是按 question id 键控的**对象**（Object.fromEntries 出来的），
 * 响应回的是 `answers`，每个答案带 typed 结果（choice / score / noul …）。
 * 网关本身不做 schema 校验——它只透传——但样例必须长得像真接口，
 * 否则第一个照着测试写客户端的人会被带进一个不存在的形状里。
 */
const DECISION_BODY = {
  model: JEV,
  state: {
    context: '仓库里有一个 300 行的 handleRelay',
    files: [{ path: 'src/routes/relay.ts', summary: '中继主循环' }],
  },
  questions: {
    should_refactor: { type: 'choice', prompt: '要不要拆分这个函数？', choices: ['yes', 'no'] },
    risk: { type: 'score', prompt: '改动风险有多高？', min: 0, max: 10 },
  },
};
const OK_DECISION = {
  id: 'dec_01J8',
  model: JEV,
  answers: {
    should_refactor: { type: 'choice', choice: 'yes', confidence: 0.82 },
    risk: { type: 'score', score: 3 },
  },
};

/** 净额：预扣 + 结算/退款之和。成功时 = -quota，全失败时应为 0。 */
const net = (w: World) => w.credits.reduce((sum, c) => sum + c.delta, 0);

/* -------------------------------------------------------------------- 定价 */

test('Jev 按 $0.042/1M 输入计价，输出免费', () => {
  const opts = { ModelPriceOverride: {} } as unknown as Options;
  assert.deepEqual(findPrice(JEV, opts), { in: 0.042, out: 0 });
  assert.deepEqual(findPrice('typesafe/jev-1.13', opts), { in: 0.042, out: 0 });
  // 1M 输入 = $0.042 = 21000 quota；输出 1M 一分不收。
  assert.equal(calcQuota(JEV, { prompt_tokens: 1_000_000, completion_tokens: 0 }, opts), 21_000);
  assert.equal(calcQuota(JEV, { prompt_tokens: 0, completion_tokens: 1_000_000 }, opts), 0);
});

test('没有这一行的话会按默认价记账——差 24 倍，这就是它必须在的理由', () => {
  const opts = { ModelPriceOverride: {} } as unknown as Options;
  const usage = { prompt_tokens: 100_000, completion_tokens: 2_000 };
  const right = calcQuota(JEV, usage, opts);
  const wrong = calcQuota('some-unpriced-model', usage, opts);
  assert.ok(wrong > right * 20, `默认价 ${wrong} 应远高于 Jev 实价 ${right}`);
  assert.deepEqual(resolvePrice(JEV, opts).spec, { in: 0.042, out: 0 });
});

test('能力规则认得 Jev 的各种写法，且不误伤普通模型', () => {
  assert.ok(isDecisionOnlyModel(JEV));
  assert.ok(isDecisionOnlyModel('typesafe/jev-1.13'));
  assert.ok(isDecisionOnlyModel('jev-latest'));
  assert.ok(!isDecisionOnlyModel('gpt-4o'));
  assert.ok(!isDecisionOnlyModel('glm-5.2'));
  // 运维可以不发版追加名字
  const opts = { DecisionOnlyModels: ['vendor/oracle-1'] } as unknown as Options;
  assert.ok(isDecisionOnlyModel('vendor/oracle-1', opts));
  assert.ok(!isDecisionOnlyModel('vendor/oracle-1'));
  // 配置被手写成字符串时不能退化成子串匹配——那会把一整批模型静悄悄判成决策模型
  const wrong = { DecisionOnlyModels: 'gpt' } as unknown as Options;
  assert.ok(!isDecisionOnlyModel('gpt-4o', wrong));
});

/* -------------------------------------------------------------------- 分诊 */

test('不带凭证打 /v1/decisions 得到 401', async () => {
  const w = makeWorld();
  const res = await call(w, '/v1/decisions', DECISION_BODY, { key: null });
  assert.equal(res.status, 401);
  assert.equal(w.credits.length, 0, '没鉴权就不该动账');
});

test('令牌模型白名单不含 Jev 时 403', async () => {
  const w = makeWorld();
  w.token.models = 'gpt-4o,glm-5.2';
  const res = await call(w, '/v1/decisions', DECISION_BODY);
  assert.equal(res.status, 403);
  assert.match((await res.json<any>()).error.message, /无权访问/);
  assert.equal(w.credits.length, 0);
});

test('decision-only 模型不出现在 /v1/models 里', async () => {
  const w = makeWorld();
  w.abilities.push({ group: 'default', model: 'glm-5.2', channel_id: 6, priority: 0, weight: 1 });
  const res = await call(w, '/v1/models', null, { method: 'GET' });
  const ids = (await res.json<any>()).data.map((m: any) => m.id);
  assert.deepEqual(ids, ['glm-5.2'], `Jev 不该出现在常规列表里，实际 ${ids.join(',')}`);
});

test('显式问 ?capability=decisions 才拿得到 Jev', async () => {
  const w = makeWorld();
  w.abilities.push({ group: 'default', model: 'glm-5.2', channel_id: 6, priority: 0, weight: 1 });
  const res = await call(w, '/v1/models?capability=decisions', null, { method: 'GET' });
  assert.deepEqual((await res.json<any>()).data.map((m: any) => m.id), [JEV]);
});

test('Jev 走 chat/completions 被明确拒绝，并指向 /v1/decisions', async () => {
  const w = makeWorld();
  const res = await call(w, '/v1/chat/completions', { model: JEV, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 400);
  assert.match((await res.json<any>()).error.message, /\/v1\/decisions/);
  assert.equal(w.credits.length, 0, '分诊在预扣之前，不该留下任何账本行');
});

test('普通模型走 /v1/decisions 同样被拒，指回 chat/completions', async () => {
  const w = makeWorld();
  w.abilities = [{ group: 'default', model: 'glm-5.2', channel_id: 6, priority: 0, weight: 1 }];
  const res = await call(w, '/v1/decisions', { model: 'glm-5.2', state: {}, questions: {} });
  assert.equal(res.status, 400);
  assert.match((await res.json<any>()).error.message, /chat\/completions/);
});

test('stream:true 被明确拒绝，而不是被静默删掉', async () => {
  const w = makeWorld();
  const script = scriptFetch([{ status: 200, body: OK_DECISION }]);
  let res: Response;
  try {
    res = await call(w, '/v1/decisions', { ...DECISION_BODY, stream: true });
  } finally {
    script.restore();
  }
  assert.equal(res!.status, 400);
  const err = (await res!.json<any>()).error;
  assert.equal(err.type, 'invalid_request_error');
  assert.match(err.message, /stream/);
  assert.equal(script.calls.length, 0, '拒绝发生在打上游之前');
  assert.equal(w.credits.length, 0, '拒绝发生在预扣之前，不该有任何账本变动');
});

/* ------------------------------------------------------------------ 成功路径 */

test('上游打的是 /api/alpha/decisions，带渠道 key，不是 chat/completions', async () => {
  const w = makeWorld();
  const script = scriptFetch([{ status: 200, body: { ...OK_DECISION, usage: { prompt_tokens: 1000, completion_tokens: 0 } } }]);
  try {
    await call(w, '/v1/decisions', DECISION_BODY);
  } finally {
    script.restore();
  }
  assert.equal(script.calls.length, 1);
  assert.equal(script.calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal((script.calls[0].headers as any).Authorization, `Bearer ${OPENROUTER_KEY}`);
  assert.deepEqual(script.calls[0].body.state, DECISION_BODY.state, 'state 必须原样透传');
  assert.deepEqual(script.calls[0].body.questions, DECISION_BODY.questions, 'questions 是按 id 键控的对象，原样透传');
  assert.ok(!('stream' in script.calls[0].body), 'Decisions 不是流式接口');
});

test('渠道 model_mapping 生效，未知字段照样透传', async () => {
  const w = makeWorld();
  w.channels[0].model_mapping = JSON.stringify({ [JEV]: 'typesafe/jev-1.13' });
  const script = scriptFetch([{ status: 200, body: OK_DECISION }]);
  try {
    await call(w, '/v1/decisions', { ...DECISION_BODY, future_field: { a: 1 } });
  } finally {
    script.restore();
  }
  assert.equal(script.calls[0].body.model, 'typesafe/jev-1.13');
  assert.deepEqual(script.calls[0].body.future_field, { a: 1 }, '未知字段应原样带给上游');
});

test('成功响应原样返回，并按上游 usage 结算', async () => {
  const w = makeWorld();
  const before = w.user.quota;
  const script = scriptFetch([{ status: 200, body: { ...OK_DECISION, usage: { prompt_tokens: 100_000, completion_tokens: 500 } } }]);
  let res: Response;
  try {
    res = await call(w, '/v1/decisions', DECISION_BODY);
  } finally {
    script.restore();
  }
  assert.equal(res!.status, 200);
  assert.deepEqual(await res!.json(), { ...OK_DECISION, usage: { prompt_tokens: 100_000, completion_tokens: 500 } }, '不得转成 chat shape');

  // 100k 输入 × $0.042/1M = $0.0042 = 2100 quota；输出 500 token 不计。
  const expected = calcQuota(JEV, { prompt_tokens: 100_000, completion_tokens: 500 }, { ModelPriceOverride: {} } as any);
  assert.equal(expected, 2100);
  assert.equal(before - w.user.quota, expected, `应恰好扣 ${expected} quota`);
  assert.equal(-net(w), expected);
});

test('上游没给 usage 时按请求体本地估算，不会白送', async () => {
  const w = makeWorld();
  const before = w.user.quota;
  const big = { model: JEV, state: { blob: 'x'.repeat(40_000) }, questions: { q1: { type: 'choice', prompt: '?', choices: ['a'] } } };
  const script = scriptFetch([{ status: 200, body: OK_DECISION }]); // 无 usage 字段
  try {
    assert.equal((await call(w, '/v1/decisions', big)).status, 200);
  } finally {
    script.restore();
  }
  const charged = before - w.user.quota;
  assert.ok(charged > 0, '缺 usage 也必须计费，否则 Jev 等于白送');
  // 40k 字符 ≈ 10k token ≈ $0.00042 ≈ 210 quota；这里只钉量级，估算口径可调。
  assert.ok(charged >= 200, `估算过低：${charged}`);
});

/* -------------------------------------------------------------- 失败与重试 */

test('429 让渠道进冷却，并重试到另一个渠道', async () => {
  const w = makeWorld();
  w.channels.push({ ...w.channels[0], id: 7, name: 'openrouter-2' });
  w.abilities.push({ group: 'default', model: JEV, channel_id: 7, priority: 0, weight: 1 });
  const kv = makeKV();
  const env = { DB: makeDB(w), CACHE: kv, ASSETS: { fetch: async () => new Response('spa') } } as never;
  const script = scriptFetch([
    { status: 429, body: { error: { message: 'rate limited' } } },
    { status: 200, body: { ...OK_DECISION, usage: { prompt_tokens: 1_000, completion_tokens: 0 } } },
  ]);
  let res: Response;
  try {
    res = await worker.fetch(
      new Request('https://oneapi.test/v1/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify(DECISION_BODY),
      }),
      env,
      ctx,
    );
    await drain();
  } finally {
    script.restore();
  }
  assert.equal(res!.status, 200, '第二个渠道成功，用户就该拿到 200');
  assert.equal(script.calls.length, 2, '应重试到另一个渠道');
  const cooled = [...kv._store.keys()].some((k) => k.includes('cooldown') || k.includes('429') || k.includes('ratelimit'));
  assert.ok(cooled, `429 后应写入冷却键，实际键：${[...kv._store.keys()].join(',')}`);
  assert.notEqual(res!.headers.get('X-OneAPI-Channel'), null);
});

test('所有渠道都失败时整笔退款，账面净额归零', async () => {
  const w = makeWorld();
  const before = w.user.quota;
  const script = scriptFetch([
    { status: 500, body: { error: { message: 'boom' } } },
    { status: 500, body: { error: { message: 'boom' } } },
    { status: 500, body: { error: { message: 'boom' } } },
  ]);
  let res: Response;
  try {
    res = await call(w, '/v1/decisions', DECISION_BODY);
  } finally {
    script.restore();
  }
  assert.equal(res!.status, 500);
  assert.equal(w.user.quota, before, '失败必须全额退回');
  assert.equal(net(w), 0, `账本净额应为 0，实际 ${net(w)}`);
  assert.ok(w.events.length > 0, '失败应写进 relay_events');
});

test('没有可用渠道时 503，并退款', async () => {
  const w = makeWorld();
  const before = w.user.quota;
  w.abilities = [];
  const res = await call(w, '/v1/decisions', DECISION_BODY);
  assert.equal(res.status, 503);
  assert.equal(w.user.quota, before);
  assert.equal(net(w), 0);
});

test('余额不足时 403，不打上游', async () => {
  const w = makeWorld();
  w.user.quota = 1;
  w.token.remain_quota = 1;
  const script = scriptFetch([{ status: 200, body: OK_DECISION }]);
  try {
    assert.equal((await call(w, '/v1/decisions', DECISION_BODY)).status, 403);
  } finally {
    script.restore();
  }
  assert.equal(script.calls.length, 0, '额度不够就不该产生上游调用');
});

test('误配了 Jev 的非 OpenRouter 渠道：一个字节都不发过去，且不挡住真正的渠道', async () => {
  const w = makeWorld();
  // 高优先级的 DeepSeek 渠道被误配上了 Jev；真正的 OpenRouter 渠道优先级更低。
  w.channels.push({ ...w.channels[0], id: 5, name: 'deepseek', base_url: 'https://api.deepseek.com', priority: 10 });
  w.abilities.push({ group: 'default', model: JEV, channel_id: 5, priority: 10, weight: 1 });
  const script = scriptFetch([{ status: 200, body: { ...OK_DECISION, usage: { prompt_tokens: 1_000, completion_tokens: 0 } } }]);
  let res: Response;
  try {
    res = await call(w, '/v1/decisions', DECISION_BODY);
  } finally {
    script.restore();
  }
  assert.equal(res!.status, 200, '配错的渠道必须被跳过，请求最终应落到 OpenRouter');
  assert.equal(script.calls.length, 1, '只该有一次上游调用');
  assert.equal(script.calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.ok(
    !script.calls.some((call) => call.url.includes('deepseek')),
    '绝不能把渠道 key 发到 https://api.deepseek.com/alpha/decisions 去',
  );
  assert.equal(res!.headers.get('X-OneAPI-Channel'), '6');
});

test('运维可以在 channel config 里显式声明决策能力与路径', async () => {
  const w = makeWorld();
  w.channels[0].base_url = 'https://gateway.internal';
  w.channels[0].config = JSON.stringify({ decisions_path: '/v2/decisions' });
  const script = scriptFetch([{ status: 200, body: OK_DECISION }]);
  try {
    assert.equal((await call(w, '/v1/decisions', DECISION_BODY)).status, 200);
  } finally {
    script.restore();
  }
  assert.equal(script.calls[0].url, 'https://gateway.internal/v2/decisions');
});

test('没显式声明的 OpenAI 兼容渠道默认不支持决策接口', async () => {
  const w = makeWorld();
  w.channels[0].base_url = 'https://api.deepseek.com';
  const script = scriptFetch([{ status: 200, body: OK_DECISION }]);
  let res: Response;
  try {
    res = await call(w, '/v1/decisions', DECISION_BODY);
  } finally {
    script.restore();
  }
  assert.equal(script.calls.length, 0);
  assert.equal(res!.status, 500);
  assert.match((await res!.json<any>()).error.message, /不支持决策接口/);
  assert.equal(net(w), 0, '没打出去也要退款');
});

test('非 OpenAI 形状的渠道被挡在决策接口之外，而不是当成 chat 发出去', async () => {
  const w = makeWorld();
  w.channels[0].type = 'anthropic';
  const script = scriptFetch([{ status: 200, body: OK_DECISION }]);
  let res: Response;
  try {
    res = await call(w, '/v1/decisions', DECISION_BODY);
  } finally {
    script.restore();
  }
  assert.equal(script.calls.length, 0, '不支持决策的渠道不该发出任何上游请求');
  assert.equal(res!.status, 500);
  assert.match((await res!.json<any>()).error.message, /不支持决策接口/);
  assert.equal(net(w), 0, '构造失败也要退款');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.stack ?? e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
