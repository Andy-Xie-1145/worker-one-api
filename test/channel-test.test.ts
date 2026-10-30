/**
 * 渠道测试端点的选模型语义（routes/api.ts 的 resolveTestModel + POST /channels/:id/test）。
 *
 * 核心安全语义：显式传 model 时**必须**是该渠道 models 里的一个——测试接口直连上游、
 * 带着渠道 key，不能让它变成「拿这把 key 调任意模型」的后门。
 *
 * Run: npm run test:channel-test
 */
import assert from 'node:assert/strict';
import worker from '../src/index';
import { resolveTestModel } from '../src/lib/channel';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/* ------------------------------------------------------- resolveTestModel */

const channel = { models: 'gpt-a, gpt-b ,gpt-c' };

test('没传模型 → 回退第一个（兼容旧调用方）', () => {
  assert.deepEqual(resolveTestModel(channel, undefined), { model: 'gpt-a' });
  assert.deepEqual(resolveTestModel(channel, null), { model: 'gpt-a' });
  assert.deepEqual(resolveTestModel(channel, ''), { model: 'gpt-a' });
});

test('显式传 model：必须是渠道 models 里的一个（trim 后精确匹配）', () => {
  assert.deepEqual(resolveTestModel(channel, 'gpt-b'), { model: 'gpt-b' });
  const notInList = resolveTestModel(channel, 'claude-x');
  assert.ok('error' in notInList && /不属于该渠道/.test(notInList.error));
  // 后门被堵死：models 列表是空格拆不出来的前缀也不行
  const prefix = resolveTestModel(channel, 'gpt');
  assert.ok('error' in prefix);
});

test('渠道未配置模型 → 明确报错；非字符串 model → 报错', () => {
  const empty = resolveTestModel({ models: '' }, undefined);
  assert.ok('error' in empty && /未配置模型/.test(empty.error));
  const bad = resolveTestModel(channel, 42 as never);
  assert.ok('error' in bad && /字符串/.test(bad.error));
});

/* ------------------------------------------------------- 端点 */

const ADMIN = 'admin-key-123';
const TOKEN_KEY = 'a'.repeat(48);

function makeEnv(channelRow: any) {
  const kv = new Map<string, string>();
  const db = {
    prepare: (sql: string) => {
      const stmt: any = {
        bind: (...b: any[]) => (stmt._binds = b, stmt),
        first: async () => {
          const one = sql.replace(/\s+/g, ' ').trim();
          if (/^SELECT \* FROM channels WHERE id = \?$/.test(one)) return channelRow && channelRow.id === stmt._binds?.[0] ? channelRow : null;
          if (/^SELECT key, value FROM options/.test(one)) return { results: [] };
          if (/^SELECT \* FROM tokens WHERE key/.test(one)) {
            return { id: 9, key: TOKEN_KEY, user_id: 1, name: 't', status: 1, models: '', unlimited_quota: 1, remain_quota: 0, used_quota: 0, expired_time: -1 } as any;
          }
          if (/^SELECT \* FROM users WHERE id/.test(one)) {
            return { id: 1, username: 'u', status: 1, quota: 1000, used_quota: 0, request_count: 0, email: '' } as any;
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      };
      return stmt;
    },
    batch: async (stmts: any[]) => { for (const s of stmts) await s.run(); },
  };
  return { DB: db, CACHE: kv, ASSETS: { fetch: async () => new Response('spa') }, ADMIN_KEY: ADMIN } as never;
}

async function call(env: never, id: number, init: { body?: unknown; query?: string; admin?: string | null }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.admin !== null) headers.Authorization = `Bearer ${init.admin ?? ADMIN}`;
  return worker.fetch(
    new Request(`https://oneapi.test/api/channels/${id}/test${init.query ?? ''}`, {
      method: 'POST',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
}

const CHANNEL = {
  id: 6, type: 'openai', key: 'upstream-secret', status: 1, name: 'ch-6', weight: 1, priority: 0,
  base_url: 'https://up.test/v1', models: 'gpt-a,gpt-b', group: 'default', model_mapping: '', config: '', system_prompt: '',
};

test('端点：body {model} 与 ?model= 都收；不在列表里的 400', async () => {
  const env = makeEnv(CHANNEL);
  let original = globalThis.fetch;
  let upstreamModel = '';
  globalThis.fetch = (async (url: any) => {
    upstreamModel = String(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200 });
  }) as any;
  try {
    const viaBody = await call(env, 6, { body: { model: 'gpt-b' } });
    assert.equal(viaBody.status, 200);
    const viaQuery = await call(env, 6, { query: '?model=gpt-a' });
    assert.equal(viaQuery.status, 200);
    // 恢复上游 mock 再测拒绝路径
    const rejected = await call(env, 6, { body: { model: 'claude-x' } });
    assert.equal(rejected.status, 400);
    assert.match(((await rejected.json()) as any).message, /不属于该渠道/);
  } finally {
    globalThis.fetch = original;
  }
});

test('端点：测试请求带着渠道 key 打向渠道 base_url，模型进 URL', async () => {
  const env = makeEnv(CHANNEL);
  const original = globalThis.fetch;
  let seen: { url: string; auth: string; body: string } = { url: '', auth: '', body: '' };
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), auth: (init?.headers as any)?.Authorization ?? '', body: String(init?.body ?? '') };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  }) as any;
  try {
    const res = await call(env, 6, { body: { model: 'gpt-a' } });
    assert.equal(res.status, 200);
    assert.ok(seen.url.includes('up.test'), '打向渠道 base_url');
    assert.ok(seen.auth.includes('upstream-secret'), '带渠道 key');
    assert.ok(seen.body.includes('"gpt-a"'), '模型名进请求体');
  } finally {
    globalThis.fetch = original;
  }
});

test('端点：渠道不存在 404；未配置模型 400；管理令牌错误 401', async () => {
  let original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as any;
  try {
    const missing = await call(makeEnv(null), 99, {});
    assert.equal(missing.status, 404);
    const noModels = await call(makeEnv({ ...CHANNEL, models: '' }), 6, {});
    assert.equal(noModels.status, 400);
    const badAdmin = await call(makeEnv(CHANNEL), 6, { admin: 'wrong' });
    assert.equal(badAdmin.status, 401);
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
console.log(`\nchannel-test: ${tests.length} passed`);
