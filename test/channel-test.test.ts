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
  /** 捕获渠道测试回写的 UPDATE（test_time / response_time）——失败也要写。 */
  const updates: Array<{ test_time: number; response_time: number; id: number }> = [];
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
        run: async () => {
          const one = sql.replace(/\s+/g, ' ').trim();
          if (/^UPDATE channels SET test_time = \?, response_time = \? WHERE id = \?$/.test(one)) {
            const [test_time, response_time, id] = stmt._binds ?? [];
            updates.push({ test_time, response_time, id });
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    batch: async (stmts: any[]) => { for (const s of stmts) await s.run(); },
  };
  return { DB: db, CACHE: kv, ASSETS: { fetch: async () => new Response('spa') }, ADMIN_KEY: ADMIN, _updates: updates } as never;
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

test('端点：即使上游失败也回写 response_time（前端「响应」列要能更新），消息带耗时', async () => {
  const env: any = makeEnv(CHANNEL);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as any;
  try {
    const res = await call(env, 6, { body: { model: 'gpt-a' } });
    assert.equal(res.status, 200, '测试失败也是 200（success:false）——这是既有契约');
    const body = await res.json() as any;
    assert.equal(body.success, false);
    assert.match(body.message, /测试失败（OpenAI Chat Completions .*HTTP 401/, body.message);
    assert.match(body.message, /耗时 \d+ms/, '失败信息带耗时');
    assert.equal(env._updates.length, 1, '失败也要写 test_time/response_time');
    assert.equal(env._updates[0].id, 6);
    assert.ok(env._updates[0].response_time >= 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('端点：成功消息带耗时，并回写 response_time', async () => {
  const env: any = makeEnv(CHANNEL);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })) as any;
  try {
    const res = await call(env, 6, { body: { model: 'gpt-a' } });
    const body = await res.json() as any;
    assert.equal(body.success, true);
    assert.match(body.message, /测试成功（gpt-a，OpenAI Chat Completions），耗时 \d+ms/);
    assert.equal(env._updates.length, 1);
    assert.equal(typeof env._updates[0].test_time, 'number');
  } finally {
    globalThis.fetch = original;
  }
});

/* ------------------------------------- 探针按渠道类型走原生协议（不是一律 chat） */

test('探针：openai-responses 渠道打 /responses（body 是 input，不是 messages）', async () => {
  const CH = { ...CHANNEL, id: 11, type: 'openai-responses', base_url: 'https://api.openai.com/v1', models: 'gpt-6-sol' };
  const env: any = makeEnv(CH);
  const original = globalThis.fetch;
  let seen: { url: string; body: any } = { url: '', body: null };
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), body: JSON.parse(init?.body ?? '{}') };
    return new Response(JSON.stringify({ id: 'r1', output: [] }), { status: 200 });
  }) as any;
  try {
    const body = await (await call(env, 11, { body: { model: 'gpt-6-sol' } })).json() as any;
    assert.equal(body.success, true, JSON.stringify(body));
    assert.equal(seen.url, 'https://api.openai.com/v1/responses', '不能打 chat/completions');
    assert.ok('input' in seen.body && seen.body.messages === undefined);
    assert.match(body.message, /OpenAI Responses/);
  } finally {
    globalThis.fetch = original;
  }
});

test('探针：anthropic 渠道打 /v1/messages（body 是 messages+max_tokens，没有 chat 字段）', async () => {
  const CH = { ...CHANNEL, id: 12, type: 'anthropic', base_url: 'https://api.anthropic.com', models: 'claude-opus-5-5' };
  const env: any = makeEnv(CH);
  const original = globalThis.fetch;
  let seen: { url: string; body: any; headers: any } = { url: '', body: null, headers: {} };
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), body: JSON.parse(init?.body ?? '{}'), headers: init?.headers ?? {} };
    return new Response(JSON.stringify({ id: 'm1', content: [] }), { status: 200 });
  }) as any;
  try {
    const body = await (await call(env, 12, { body: { model: 'claude-opus-5-5' } })).json() as any;
    assert.equal(body.success, true, JSON.stringify(body));
    assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
    assert.ok(seen.body.max_tokens !== undefined, 'anthropic 必需 max_tokens');
    assert.equal(seen.headers['x-api-key'], 'upstream-secret');
    assert.match(body.message, /Anthropic Messages/);
  } finally {
    globalThis.fetch = original;
  }
});

test('探针：gemini 渠道打 /{version}/models/{model}:generateContent', async () => {
  const CH = { ...CHANNEL, id: 13, type: 'gemini', base_url: 'https://generativelanguage.googleapis.com', models: 'gemini-3.8-flash' };
  const env: any = makeEnv(CH);
  const original = globalThis.fetch;
  let seen: { url: string; body: any; headers: any } = { url: '', body: null, headers: {} };
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), body: JSON.parse(init?.body ?? '{}'), headers: init?.headers ?? {} };
    return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
  }) as any;
  try {
    const body = await (await call(env, 13, { body: { model: 'gemini-3.8-flash' } })).json() as any;
    assert.equal(body.success, true, JSON.stringify(body));
    assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    assert.ok(Array.isArray(seen.body.contents), 'Gemini 用 contents');
    assert.equal(seen.headers['x-goog-api-key'], 'upstream-secret');
    assert.match(body.message, /Gemini/);
  } finally {
    globalThis.fetch = original;
  }
});

test('探针：decisions 渠道打 {base}/decisions，body 是 input+questions 数组', async () => {
  const CH = { ...CHANNEL, id: 14, type: 'decisions', base_url: 'https://api.openai.com/v1', models: 'gpt-6-luna' };
  const env: any = makeEnv(CH);
  const original = globalThis.fetch;
  let seen: { url: string; body: any } = { url: '', body: null };
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), body: JSON.parse(init?.body ?? '{}') };
    return new Response(JSON.stringify({ id: 'd1', answers: [] }), { status: 200 });
  }) as any;
  try {
    const body = await (await call(env, 14, { body: { model: 'gpt-6-luna' } })).json() as any;
    assert.equal(body.success, true, JSON.stringify(body));
    assert.equal(seen.url, 'https://api.openai.com/v1/decisions');
    assert.ok('input' in seen.body);
    assert.ok(Array.isArray(seen.body.questions));
    assert.equal(seen.body.questions[0].type, 'predicate');
    assert.match(body.message, /Decision API/);
  } finally {
    globalThis.fetch = original;
  }
});

test('探针：systemone 渠道打 {base}/systemone，body 是 state+questions 对象（题型 noul）', async () => {
  const CH = { ...CHANNEL, id: 15, type: 'systemone', base_url: 'https://api.typesafe.ai/v1', models: 'jev-latest' };
  const env: any = makeEnv(CH);
  const original = globalThis.fetch;
  let seen: { url: string; body: any } = { url: '', body: null };
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), body: JSON.parse(init?.body ?? '{}') };
    return new Response(JSON.stringify({ id: 's1', answers: {} }), { status: 200 });
  }) as any;
  try {
    const body = await (await call(env, 15, { body: { model: 'jev-latest' } })).json() as any;
    assert.equal(body.success, true, JSON.stringify(body));
    assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(seen.body.state, 'ping');
    assert.equal(seen.body.questions.ok.type, 'noul');
    assert.match(body.message, /System One/);
  } finally {
    globalThis.fetch = original;
  }
});

test('探针：失败消息带协议标签、真实出站 URL 与 HTTP 状态', async () => {
  const CH = { ...CHANNEL, id: 11, type: 'openai-responses', base_url: 'https://api.openai.com/v1', models: 'gpt-6-sol' };
  const env: any = makeEnv(CH);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })) as any;
  try {
    const body = await (await call(env, 11, { body: { model: 'gpt-6-sol' } })).json() as any;
    assert.equal(body.success, false);
    assert.match(body.message, /OpenAI Responses/);
    assert.match(body.message, /https:\/\/api\.openai\.com\/v1\/responses/);
    assert.match(body.message, /HTTP 404/);
    assert.match(body.message, /model not found/, '上游可读原因透出');
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
