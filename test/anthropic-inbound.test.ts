/**
 * Anthropic Messages API 的**入站路径**契约。
 *
 * 官方文档与官方 SDK 都是 `POST /v1/messages`：base 只填 origin（默认
 * `https://api.anthropic.com`），版本段属于**路径**——anthropic-sdk-typescript 里
 * 就是 `this._client.post('/v1/messages', …)`。所以 Claude Code 之类只把
 * `ANTHROPIC_BASE_URL` 设成站点根时，它打的是 `/v1/messages`。
 *
 * 这里不 mock 整条中继（协议转换另有 stream/anthropic 的测试），只钉「路由存在」：
 * 两个入口都必须进到 anthropic 错误形状（401），而不是落到 SPA 静态兜底。
 *
 * Run: npm run test:anthropic-inbound
 */
import assert from 'node:assert/strict';
import worker from '../src/index';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** 没有任何令牌的世界：鉴权必然 401，但足以区分「路由存在」和「路由不存在」。 */
function bareEnv() {
  return {
    DB: {
      prepare: (sql: string) => {
        const stmt: any = {
          bind: () => stmt,
          first: async () => {
            const one = sql.replace(/\s+/g, ' ').trim();
            if (/^SELECT \* FROM tokens WHERE key/.test(one)) return null;
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return stmt;
      },
      batch: async () => [],
    },
    CACHE: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    ASSETS: { fetch: async () => new Response('<!doctype html>spa', { headers: { 'Content-Type': 'text/html' } }) },
    ADMIN_KEY: 'x',
  } as never;
}

function makeCall(path: string, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request('https://oneapi.test' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    }),
    bareEnv(),
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
}

const anthropicErrorShape = async (res: Response) => {
  assert.match(res.headers.get('content-type') ?? '', /application\/json/, '必须是 JSON 错误，不是 SPA 兜底');
  const json: any = await res.json();
  assert.equal(json.type, 'error', 'Anthropic 错误外壳 {type:"error"}');
  assert.ok(json.error && typeof json.error.message === 'string');
  return json;
};

test('POST /v1/messages —— 标准路径（base 填站点根时 SDK 打的就是它）', async () => {
  const res = await makeCall('/v1/messages', { Authorization: 'Bearer sk-not-a-real-key' });
  assert.equal(res.status, 401, '无有效令牌 → 401，而不是 404');
  await anthropicErrorShape(res);
});

test('POST /api/anthropic/v1/messages —— base 带 /api/anthropic 前缀的写法仍可用', async () => {
  const res = await makeCall('/api/anthropic/v1/messages', { Authorization: 'Bearer sk-not-a-real-key' });
  assert.equal(res.status, 401);
  await anthropicErrorShape(res);
});

test('x-api-key 鉴权头在这两个路径上都照收（Anthropic 客户端就是这么发的）', async () => {
  for (const path of ['/v1/messages', '/api/anthropic/v1/messages']) {
    const res = await makeCall(path, { 'x-api-key': 'sk-not-a-real-key', 'anthropic-version': '2023-06-01' });
    assert.equal(res.status, 401, path + ' 应走同样的鉴权');
    const json: any = await res.json();
    assert.equal(json.type, 'error');
    assert.match(json.error.message, /令牌/);
  }
});

/* ---------------------------------------------------------------- runner */

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
console.log(`\nanthropic-inbound: ${tests.length} passed`);
