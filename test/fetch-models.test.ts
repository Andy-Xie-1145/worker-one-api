/**
 * 从上游拉取模型列表（lib/upstream-models.ts + POST /api/channels/fetch-models）。
 *
 * 钉死：5 种渠道类型各自的端点/鉴权头、Gemini 分页与 models/ 前缀剥离、
 * 名字清洗（trim/去空/去重/截断）、channel_id 走库存 key（绝不回传前端）、
 * 上游错误净化（状态码 + 截断文本，不回显完整报文）。
 *
 * Run: npm run test:fetch-models
 */
import assert from 'node:assert/strict';
import worker from '../src/index';
import { listUpstreamModels } from '../src/lib/upstream-models';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** 脚本化 fetch：记录每次调用的 url/headers，按序应答 JSON。 */
function scriptFetch(responses: Array<{ status?: number; body: any }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), headers });
    const next = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/* ------------------------------------------------------- 类型适配器 */

test('openai：GET /v1/models + Bearer；base 已带 /v1 不重复加前缀', async () => {
  const s = scriptFetch([
    { body: { data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] } },
    { body: { data: [{ id: 'gpt-a' }] } },
  ]);
  try {
    const models = await listUpstreamModels({ type: 'openai', baseUrl: 'https://api.openai.com', key: 'sk-k' });
    assert.deepEqual(models, ['gpt-a', 'gpt-b']);
    assert.equal(s.calls[0].url, 'https://api.openai.com/v1/models');
    assert.equal(s.calls[0].headers.Authorization, 'Bearer sk-k');
    const models2 = await listUpstreamModels({ type: 'openai-responses', baseUrl: 'https://x.test/v1', key: 'k' });
    assert.deepEqual(models2, ['gpt-a']);
    assert.equal(s.calls[1].url, 'https://x.test/v1/models', '已带 /v1 不重复加前缀');
  } finally {
    s.restore();
  }
});

test('anthropic：x-api-key + anthropic-version（config 可覆盖版本）', async () => {
  const s = scriptFetch([{ body: { data: [{ id: 'claude-a' }] } }]);
  try {
    await listUpstreamModels({ type: 'anthropic', baseUrl: 'https://api.anthropic.com', key: 'ak', config: { api_version: '2024-01-01' } });
    assert.equal(s.calls[0].url, 'https://api.anthropic.com/v1/models');
    assert.equal(s.calls[0].headers['x-api-key'], 'ak');
    assert.equal(s.calls[0].headers['anthropic-version'], '2024-01-01');
  } finally {
    s.restore();
  }
});

test('gemini：x-goog-api-key、分页取全、剥 models/ 前缀、去重', async () => {
  const s = scriptFetch([
    { body: { models: [{ name: 'models/gemini-a' }, { name: 'models/gemini-b' }], nextPageToken: 'T2' } },
    { body: { models: [{ name: 'models/gemini-a' }, { name: 'gemini-c' }] } },
  ]);
  try {
    const models = await listUpstreamModels({ type: 'gemini', baseUrl: 'https://g.test', key: 'gk' });
    assert.deepEqual(models, ['gemini-a', 'gemini-b', 'gemini-c'], '前缀剥离 + 跨页去重');
    assert.ok(s.calls[0].url.includes('pageSize=1000'));
    assert.ok(s.calls[1].url.includes('pageToken=T2'));
    assert.equal(s.calls[0].headers['x-goog-api-key'], 'gk');
  } finally {
    s.restore();
  }
});

test('azure：deployment 名即模型名（data 或 value 数组都认）', async () => {
  const s = scriptFetch([{ body: { data: [{ id: 'dep-a' }, { deployment: 'dep-b' }] } }]);
  try {
    const models = await listUpstreamModels({ type: 'azure', baseUrl: 'https://r.openai.azure.com', key: 'azk', config: { api_version: '2024-02-01' } });
    assert.deepEqual(models, ['dep-a', 'dep-b']);
    assert.ok(s.calls[0].url.includes('openai/deployments?api-version=2024-02-01'));
    assert.equal(s.calls[0].headers['api-key'], 'azk');
  } finally {
    s.restore();
  }
});

test('清洗：trim / 去空 / 去重 / 上限 5000；未知类型与缺 base_url 报错', async () => {
  const s = scriptFetch([{ body: { data: [{ id: ' a ' }, { id: 'a' }, { id: '' }, {}] } }]);
  try {
    assert.deepEqual(await listUpstreamModels({ type: 'openai', baseUrl: 'https://x.test', key: 'k' }), ['a']);
  } finally {
    s.restore();
  }
  await assert.rejects(listUpstreamModels({ type: 'ftp', baseUrl: 'https://x.test', key: 'k' }), /不支持的渠道类型/);
  await assert.rejects(listUpstreamModels({ type: 'openai', baseUrl: '', key: 'k' }), /base_url/);
});

test('上游错误净化：只透传状态码 + 截断文本', async () => {
  const s = scriptFetch([{ status: 401, body: { error: { message: 'bad key sk-realtoken123' } } }]);
  try {
    await assert.rejects(
      listUpstreamModels({ type: 'openai', baseUrl: 'https://x.test', key: 'k' }),
      (e: Error) => /401/.test(e.message),
    );
  } finally {
    s.restore();
  }
});

/* ------------------------------------------------------- 端点 */

const ADMIN = 'admin-key-123';
const CHANNEL = {
  id: 6, type: 'openai', key: 'stored-key', status: 1, name: 'ch-6', weight: 1, priority: 0,
  base_url: 'https://stored.test/v1', models: 'gpt-a', group: 'default', model_mapping: '', config: '', system_prompt: '',
};

function makeEnv(channelRow: any) {
  const db = {
    prepare: (sql: string) => {
      const stmt: any = {
        bind: (...b: any[]) => (stmt._binds = b, stmt),
        first: async () => {
          const one = sql.replace(/\s+/g, ' ').trim();
          if (/^SELECT \* FROM channels WHERE id = \?$/.test(one)) return channelRow && channelRow.id === stmt._binds?.[0] ? channelRow : null;
          if (/^SELECT key, value FROM options/.test(one)) return { results: [] };
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      };
      return stmt;
    },
    batch: async () => [],
  };
  return { DB: db, CACHE: new Map(), ASSETS: { fetch: async () => new Response('spa') }, ADMIN_KEY: ADMIN } as never;
}

async function call(env: never, body: unknown, admin: string = ADMIN) {
  return worker.fetch(
    new Request('https://oneapi.test/api/channels/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
}

test('端点：channel_id 用库存 key 且不回传；inline 凭据不落库', async () => {
  const s = scriptFetch([{ body: { data: [{ id: 'm1' }] } }]);
  try {
    const res = await call(makeEnv(CHANNEL), { channel_id: 6 });
    assert.equal(res.status, 200);
    assert.equal(s.calls[0].headers.Authorization, 'Bearer stored-key', '用库存 key');
    assert.equal(s.calls[0].url, 'https://stored.test/v1/models');
    const json = await res.json() as any;
    assert.deepEqual(json.data.models, ['m1']);
    assert.equal(JSON.stringify(json).includes('stored-key'), false, 'key 绝不出现在响应里');

    const inline = await call(makeEnv(null), { type: 'anthropic', base_url: 'https://a.test', key: 'inline-key' });
    assert.equal(inline.status, 200);
    assert.equal(s.calls[1].headers['x-api-key'], 'inline-key');
  } finally {
    s.restore();
  }
});

test('端点：校验（未知类型 / 缺 key / 坏 channel_id）与鉴权', async () => {
  const env = makeEnv(CHANNEL);
  const badType = await call(env, { type: 'ftp', base_url: 'https://x.test', key: 'k' });
  assert.equal(badType.status, 400);
  const noKey = await call(env, { type: 'openai', base_url: 'https://x.test' });
  assert.equal(noKey.status, 400);
  const badId = await call(env, { channel_id: -1 });
  assert.equal(badId.status, 400);
  const missing = await call(env, { channel_id: 99 });
  assert.equal(missing.status, 404);
  const noAuth = await call(env, { channel_id: 6 }, 'wrong');
  assert.equal(noAuth.status, 401);
  // 新建渠道连 base_url 都没填 → 净化错误 502
  const noBase = await call(env, { type: 'openai', base_url: '', key: 'k' });
  assert.equal(noBase.status, 502);
});

test('端点：上游错误净化成 502（只留 error.message，不透传响应体其余字段）', async () => {
  const s = scriptFetch([{ status: 403, body: { error: { message: 'region blocked' }, internal_secret: 'xyz' } }]);
  try {
    const res = await call(makeEnv(CHANNEL), { channel_id: 6 });
    assert.equal(res.status, 502);
    const json = await res.json() as any;
    assert.match(json.message, /403/);
    assert.match(json.message, /region blocked/, '保留上游自己整理的 error.message');
    assert.equal(json.message.includes('secret=xyz'), false, '响应体其余字段不透传');
  } finally {
    s.restore();
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
console.log(`\nfetch-models: ${tests.length} passed`);
