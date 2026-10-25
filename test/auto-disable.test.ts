/**
 * 401/403 的自动禁用策略。
 *
 * 只看 status 就永久关掉一个渠道，是中继里杀伤力最大的一行代码。真实事故：
 * OpenRouter 在受限地区调 OpenAI/Claude 时按上游地区规则回 403——key 是好的，
 * 别的模型、别的地区都能用——渠道却被整个禁掉了。所以 401（key 确认失效）是
 * 唯一允许自动禁用的状态码；这里把这条边界从两个方向都钉死。
 *
 * 断言全部落在**渠道之后还可不可用**这个行为结果上（channels.status、
 * abilities.enabled、下一次请求还能不能路由过去），不匹配报错文案。
 *
 * Run: npm run test:auto-disable
 */
import assert from 'node:assert/strict';
import worker from '../src/index';
import { shouldAutoDisable } from '../src/routes/relay';
import { ChannelStatusAutoDisabled } from '../src/types';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const KEY = 'sk-' + 'a'.repeat(48);
const JEV = '~typesafe/jev-latest';

/* ---------------------------------------------------------------- 测试替身 */

interface Ability {
  group: string;
  model: string;
  channel_id: number;
  enabled: number;
  priority: number;
  weight: number;
}

interface World {
  user: any;
  token: any;
  abilities: Ability[];
  channels: any[];
  credits: Array<{ delta: number; reason: string; ref: string }>;
  logs: any[][];
  events: any[][];
}

function makeWorld(): World {
  return {
    user: { id: 1, username: 'u', group: 'default', status: 1, quota: 1_000_000, used_quota: 0, request_count: 0, email: '', plan_slug: '' },
    token: { id: 9, key: 'a'.repeat(48), user_id: 1, name: 't', status: 1, models: '', unlimited_quota: 0, remain_quota: 1_000_000, used_quota: 0, expired_time: -1 },
    abilities: [{ group: 'default', model: JEV, channel_id: 6, enabled: 1, priority: 0, weight: 1 }],
    channels: [{
      id: 6, type: 'openai', key: 'or-secret', status: 1, name: 'openrouter', weight: 1, priority: 0,
      base_url: 'https://openrouter.ai/api', models: JEV, group: 'default', model_mapping: '', config: '', system_prompt: '',
    }],
    credits: [],
    logs: [],
    events: [],
  };
}

/**
 * 按 SQL 形状应答的最小 D1 替身，抄自 decisions.test.ts。区别在于：渠道禁用那两条
 * UPDATE 在这里**真的落地**到 World 上——断言看的是状态变化，不是语句文本。
 */
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

    if (/^UPDATE users SET quota = quota \+ \?1/.test(one)) {
      const [delta, id] = binds;
      if (w.user.id !== id) return null;
      w.user.quota += delta;
      return { quota: w.user.quota };
    }
    if (/^INSERT INTO credits/.test(one)) {
      if (binds[3] && w.credits.some((c) => c.ref === binds[3])) throw new Error('UNIQUE constraint failed: credits.ref');
      w.credits.push({ delta: binds[1], reason: binds[2], ref: binds[3] });
      return {};
    }

    if (/^SELECT DISTINCT model FROM abilities/.test(one)) {
      const models = [...new Set(w.abilities.filter((a) => a.enabled === 1).map((a) => a.model))].sort();
      return { results: models.map((model) => ({ model })) };
    }
    if (/FROM abilities WHERE model = \? AND enabled = 1/.test(one)) {
      return { results: w.abilities.filter((a) => a.model === binds[0] && a.enabled === 1) };
    }
    if (/^SELECT \* FROM channels WHERE id = \?/.test(one)) {
      return w.channels.find((ch) => ch.id === binds[0] && ch.status === binds[1]) ?? null;
    }

    // autoDisableChannel 的第一批语句：禁用渠道本身。
    if (/^UPDATE channels SET status = \? WHERE id = \? AND status = 1$/.test(one)) {
      const ch = w.channels.find((c) => c.id === binds[1] && c.status === 1);
      if (ch) ch.status = binds[0];
      return { meta: { changes: ch ? 1 : 0 } };
    }
    // 第二批：连同 abilities 一起下线。
    if (/^UPDATE abilities SET enabled = 0 WHERE channel_id = \?$/.test(one)) {
      for (const a of w.abilities) if (a.channel_id === binds[0]) a.enabled = 0;
      return { meta: { changes: w.abilities.filter((a) => a.channel_id === binds[0]).length } };
    }

    if (/^INSERT INTO logs/.test(one)) {
      w.logs.push(binds);
      return {};
    }
    if (/^INSERT INTO relay_events/.test(one)) {
      w.events.push(binds);
      return {};
    }
    // 其余计数器更新（users/tokens/channels）不影响断言，吞掉。
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
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => store.set(k, v),
    delete: async (k: string) => store.delete(k),
  };
}

/** 一次上游应答的脚本。 */
function scriptFetch(responses: Array<{ status: number; body: any }>) {
  const calls: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push(String(url));
    const next = responses.shift() ?? { status: 500, body: { error: { message: '脚本用完了' } } };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(Promise.resolve(p)), passThroughOnException: () => {} } as never;
const drain = async () => {
  while (pending.length) await pending.shift();
};

const DECISION_BODY = {
  model: JEV,
  state: { context: 'x' },
  questions: { q1: { type: 'choice', prompt: '?', choices: ['a', 'b'] } },
};

async function call(w: World, responses: Array<{ status: number; body: any }>) {
  const env = { DB: makeDB(w), CACHE: makeKV(), ASSETS: { fetch: async () => new Response('spa') } } as never;
  const script = scriptFetch(responses);
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
  return { res, calls: script.calls };
}

const net = (w: World) => w.credits.reduce((sum, c) => sum + c.delta, 0);

/* -------------------------------------------------------------------- 策略 */

test('策略本身：只有 401 自动禁用', () => {
  assert.equal(shouldAutoDisable(401), true);
  // 403 是地区/模型受限（OpenRouter 访问 OpenAI/Claude 就是这个形状），渠道没坏。
  assert.equal(shouldAutoDisable(403), false, '403 不得自动禁用渠道');
  assert.equal(shouldAutoDisable(429), false, '限流走冷却，不是禁用');
  assert.equal(shouldAutoDisable(500), false);
  assert.equal(shouldAutoDisable(408), false);
});

/* ---------------------------------------------------------------- 401 方向 */

test('上游 401：渠道与 abilities 被禁用，且留系统日志', async () => {
  const w = makeWorld();
  const { res } = await call(w, [{ status: 401, body: { error: { message: 'Invalid API key' } } }]);
  assert.equal(res.status, 401);
  assert.equal(w.channels[0].status, ChannelStatusAutoDisabled, '401 后渠道应被自动禁用');
  assert.equal(w.abilities.every((a) => a.enabled === 0), true, '401 后 abilities 应全部下线');
  assert.ok(w.logs.length > 0, '自动禁用要写系统日志，运维才能发现');
  assert.equal(net(w), 0, '失败的请求要全额退款');
});

/* ---------------------------------------------------------------- 403 方向 */

test('上游 403：渠道保持启用、abilities 不动，但 403 照记 relay_events', async () => {
  const w = makeWorld();
  const { res } = await call(w, [{ status: 403, body: { error: { message: 'not allowed to access this model in your region' } } }]);
  assert.equal(res.status, 403, '按 4xx 语义结束本次请求');
  assert.equal(w.channels[0].status, 1, '403 不代表渠道失效，必须保持启用');
  assert.equal(w.abilities.every((a) => a.enabled === 1), true, '403 不得下线 abilities');
  const ev403 = w.events.filter((b) => b[8] === 403);
  assert.ok(ev403.length > 0, `403 应记入 relay_events（status 列在 binds[8]），实际 events：${JSON.stringify(w.events)}`);
  assert.equal(net(w), 0, '失败的请求要全额退款');
});

test('403 之后同一个渠道仍然可用——下一次请求照常路由过去', async () => {
  const w = makeWorld();
  const first = await call(w, [{ status: 403, body: { error: { message: 'region restricted' } } }]);
  assert.equal(first.res.status, 403);
  assert.equal(first.calls.length, 1);

  // 同一个渠道、换一个（上游允许的）场景：应当直接复用渠道 6，而不是 503 no_channel。
  const second = await call(w, [{ status: 200, body: { id: 'dec_1', model: JEV, answers: {} } }]);
  assert.equal(second.res.status, 200, '403 之后渠道必须还能接单');
  assert.equal(second.calls.length, 1);
  assert.equal(second.res.headers.get('X-OneAPI-Channel'), '6');
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
