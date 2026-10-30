/**
 * GET /v1/models 的契约：这个 Key 实际能调哪些模型。
 *
 * 列表和中继准入必须是同一套规则，否则下拉里能选、一发请求就 403：
 *   - 必须鉴权（sk- 令牌），未鉴权 401，OpenAI 错误形状；
 *   - 只列 enabled = 1 的 abilities；decision-only 的（Jev）默认不出现；
 *   - 令牌的 models 白名单再取交集——和 chat/completions 的 403 同一份 csv；
 *   - 响应只有 id/object/created/owned_by，渠道的 key/base_url/name/mapping 一个字节都不出去。
 *
 * Run: npm run test:models
 */
import assert from 'node:assert/strict';
import worker from '../src/index';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const HEX = 'b'.repeat(48);
const KEY = 'sk-' + HEX;
const CHANNEL_SECRET = 'upstream-secret-key';
const CHANNEL_BASE = 'https://secret-upstream.example';
const CHANNEL_NAME = 'internal-channel-name';

interface World {
  user: any;
  tokens: any[];
  abilities: Array<{ model: string; channel_id: number; enabled: number }>;
  channels: any[];
}

function makeWorld(over: Partial<World> = {}): World {
  return {
    user: { id: 1, username: 'u', status: 1, quota: 0, used_quota: 0, request_count: 0, email: '' },
    tokens: [
      { id: 9, key: HEX, user_id: 1, name: 't', status: 1, models: '', unlimited_quota: 1, remain_quota: 0, used_quota: 0, expired_time: -1 },
    ],
    abilities: [
      { model: 'glm-5.2', channel_id: 1, enabled: 1 },
      { model: 'deepseek-flash', channel_id: 1, enabled: 1 },
      { model: 'disabled-model', channel_id: 1, enabled: 0 },
      { model: '~typesafe/jev-latest', channel_id: 1, enabled: 1 },
    ],
    channels: [
      {
        id: 1, type: 'openai', key: CHANNEL_SECRET, status: 1, name: CHANNEL_NAME, weight: 1, priority: 0,
        base_url: CHANNEL_BASE, models: 'glm-5.2', group: 'default', model_mapping: '{"glm-5.2":"glm-5.2-upstream"}',
        config: '{"secret":"x"}', system_prompt: 'hidden prompt',
      },
    ],
    ...over,
  };
}

function makeDB(w: World) {
  const route = (sql: string, binds: any[]): any => {
    const one = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT \* FROM tokens WHERE key/.test(one)) return w.tokens.find((t) => t.key === binds[0]) ?? null;
    if (/^SELECT \* FROM users WHERE username/.test(one)) return w.user;
    if (/^SELECT \* FROM users WHERE id/.test(one)) return w.user.id === binds[0] ? w.user : null;
    if (/^SELECT key, value FROM options/.test(one)) return { results: [] };
    if (/^SELECT 1 AS hit FROM credits WHERE ref/.test(one)) return null;
    if (/^SELECT quota FROM users WHERE id/.test(one)) return { quota: w.user.quota };
    if (/^SELECT DISTINCT model FROM abilities/.test(one)) {
      const enabled = /enabled = 1/.test(one);
      const rows = enabled ? w.abilities.filter((a) => a.enabled === 1) : w.abilities;
      return { results: [...new Set(rows.map((a) => a.model))].sort().map((model) => ({ model })) };
    }
    if (/FROM abilities WHERE model = \? AND enabled = 1/.test(one)) {
      return { results: w.abilities.filter((a) => a.model === binds[0] && a.enabled === 1) };
    }
    if (/^SELECT \* FROM channels WHERE id = \?/.test(one)) {
      return w.channels.find((ch) => ch.id === binds[0] && ch.status === binds[1]) ?? null;
    }
    if (/^INSERT INTO credits/.test(one)) return {};
    if (/^INSERT INTO logs/.test(one)) return {};
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

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

async function call(w: World, path: string, init: { key?: string | null; method?: string; body?: unknown } = {}): Promise<Response> {
  const env = { DB: makeDB(w), CACHE: new Map(), ASSETS: { fetch: async () => new Response('spa') } } as never;
  const key = init.key === undefined ? KEY : init.key;
  const method = init.method ?? 'GET';
  return worker.fetch(
    new Request(`https://oneapi.test${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
    }),
    env,
    ctx,
  );
}

const ids = async (res: Response) => ((await res.json()) as any).data.map((m: any) => m.id);

/* ---------------------------------------------------------------- 用例 */

test('未带令牌 → 401，OpenAI 错误形状', async () => {
  const res = await call(makeWorld(), '/v1/models', { key: null });
  assert.equal(res.status, 401);
  const body = (await res.json()) as any;
  assert.equal(typeof body.error?.message, 'string');
});

test('无效令牌 → 401', async () => {
  const res = await call(makeWorld(), '/v1/models', { key: 'sk-' + 'f'.repeat(48) });
  assert.equal(res.status, 401);
});

test('只列 enabled 的 abilities；decision-only 不在默认列表', async () => {
  const res = await call(makeWorld(), '/v1/models');
  assert.equal(res.status, 200);
  assert.deepEqual(await ids(res), ['deepseek-flash', 'glm-5.2']);
});

test('?capability=decisions 显式可查决策模型', async () => {
  const res = await call(makeWorld(), '/v1/models?capability=decisions');
  assert.equal(res.status, 200);
  assert.deepEqual(await ids(res), ['~typesafe/jev-latest']);
});

test('令牌 models 白名单与列表取交集', async () => {
  const w = makeWorld();
  w.tokens[0].models = 'glm-5.2, claude-sonnet-5';
  // claude-sonnet-5 在白名单里但渠道没声明，不应出现
  assert.deepEqual(await ids(await call(w, '/v1/models')), ['glm-5.2']);
});

test('余额为 0 仍能列模型（鉴权不看余额）', async () => {
  const w = makeWorld();
  w.user.quota = 0;
  assert.equal((await call(w, '/v1/models')).status, 200);
});

test('响应形状只有 id/object/created/owned_by，不泄露渠道配置', async () => {
  const res = await call(makeWorld(), '/v1/models');
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.object, 'list');
  for (const m of body.data) assert.deepEqual(Object.keys(m).sort(), ['created', 'id', 'object', 'owned_by']);
  for (const secret of [CHANNEL_SECRET, CHANNEL_BASE, CHANNEL_NAME, 'glm-5.2-upstream', 'hidden prompt', 'channel']) {
    assert.ok(!text.includes(secret), `响应里不该出现 ${secret}`);
  }
});

test('列表外的模型在 chat/completions 被同一份白名单拒绝（403，未发上游）', async () => {
  const w = makeWorld();
  w.tokens[0].models = 'glm-5.2';
  const original = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = (async () => {
    upstream++;
    return new Response('{}');
  }) as any;
  try {
    const res = await call(w, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).error.type, 'permission_error');
    assert.equal(upstream, 0);
  } finally {
    globalThis.fetch = original;
  }
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
console.log(`\nmodels-list: ${tests.length} passed`);
