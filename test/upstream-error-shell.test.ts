/**
 * 上游失败的客户端错误壳子（2026-11-16 真实故障的回归）。
 *
 * 背景：HPD 回源抖了两分钟，上游只回一句 `error code: 521\n`，网关原样透传，
 * 客户端看到 521 无法判断是网关坏了还是上游坏了，只能来问人。
 *
 * 契约（本文件钉死）：
 *   1. 客户端 `error.message` 是**网关自己写的判定句**，必须说清责任方
 *      （upstream failure / not a gateway fault）、渠道名、HTTP 状态码；
 *   2. 上游原话**不能**占据 `error.message`，只能降级进 `error.upstream.message`；
 *   3. 上游 4xx 不替上游认成"网关故障"（可能是参数，也可能是我们的翻译）；
 *   4. 网络层失败（fetch 抛错）说"上游不可达"，不说"上游返回了 xxx"；
 *   5. 流式断在半路时的错误事件同样是壳子文案。
 *
 * Run: npm run test:upstream-error-shell
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const resolveMigrations = (): string => {
  const candidates = [join(process.cwd(), 'migrations'), join(process.cwd(), 'worker-one-api', 'migrations')];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
};
const MIGRATIONS = resolveMigrations();

function freshDB(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

function kvMock() {
  const map = new Map<string, string>();
  return {
    get: async (k: string, type?: string) => {
      if (!map.has(k)) return null;
      const v = map.get(k)!;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k: string, v: unknown) => { map.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k: string) => { map.delete(k); },
  };
}

const ADMIN = 'test-admin-key';
const MODEL = 'm-up';

function asD1(db: DatabaseSync) {
  const norm = (v: unknown) => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v);
  const stmt = (sql: string, binds: unknown[] = []) => {
    const exec = () => db.prepare(sql).all(...(binds.map(norm) as any[]));
    return {
      bind: (...b: unknown[]) => stmt(sql, b),
      all: async () => ({ results: exec(), success: true, meta: {} }),
      first: async (col?: string) => {
        const row = exec()[0] as any;
        return row === undefined ? null : col ? row[col] : row;
      },
      run: async () => ({ results: exec(), success: true, meta: {} }),
      _exec: exec,
    };
  };
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: any[]) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => ({ results: s._exec(), success: true, meta: {} }));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** 建库 + 种子：owner、单渠道 HPD-test（ch4 是生产里真实出事的那个 id/名字形状）、一把令牌。 */
function setup() {
  const db = freshDB();
  db.exec(`INSERT INTO users (id, username, password, display_name, role, status, quota, used_quota, request_count, created_time) VALUES (1, 'owner', '', 'Owner', 100, 1, 10000000, 0, 0, 0)`);
  db.exec(`INSERT INTO channels (id, type, key, status, name, weight, priority, base_url, models, tags) VALUES
    (4, 'openai', 'k-up', 1, 'HPD-DOG-gpt-high', 1, 40, 'https://hpd.test', '${MODEL}', '[]')`);
  db.exec(`INSERT INTO abilities (model, channel_id, enabled, priority, weight) VALUES ('${MODEL}', 4, 1, 40, 1)`);
  db.prepare(
    `INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, used_quota, models, channel_acl)
     VALUES (1, ?, 1, 't', 0, 0, -1, 0, 1, 0, '', '')`,
  ).run('a'.repeat(48));
  const env = { DB: asD1(db), CACHE: kvMock(), ASSETS: { fetch: async () => new Response('spa') }, ADMIN_KEY: ADMIN } as never;
  return { db, env: env as never };
}

async function call(env: never, path: string, body: unknown, key = 'sk-' + 'a'.repeat(48)) {
  return worker.fetch(
    new Request('https://oneapi.test' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
}

/** 假上游：固定返回给定响应（或抛错）。 */
function mockUpstream(make: () => Response | Promise<Response>): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    calls.push(String(typeof input === 'string' ? input : input.url));
    return make();
  }) as any;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const CHAT_BODY = { model: MODEL, messages: [{ role: 'user', content: 'hi' }] };

test('上游 5xx 纯文本（521）：message 是网关壳子，原话降级进 upstream.message', async () => {
  const { env } = setup();
  const mock = mockUpstream(() => new Response('error code: 521\n', { status: 521, headers: { 'Content-Type': 'text/plain' } }));
  try {
    const res = await call(env, '/v1/chat/completions', CHAT_BODY);
    assert.equal(res.status, 521, '状态码仍然如实回上游的 521');
    const body = (await res.json()) as any;
    const message = String(body.error.message);
    assert.ok(message.includes('not a gateway fault'), `message 必须点明不是网关问题：${message}`);
    assert.ok(message.includes('HTTP 521'), `message 必须带状态码：${message}`);
    assert.ok(message.includes('HPD-DOG-gpt-high'), `message 必须带渠道名：${message}`);
    assert.ok(message.includes('error code: 521'), `message 必须原样带上上游原话，不能只剩一句"上游失败"：${message}`);
    assert.notEqual(message.trim(), 'error code: 521', '上游原话不得占据 error.message');
    assert.equal(body.error.upstream?.status, 521);
    assert.equal(body.error.upstream?.message, 'error code: 521');
  } finally { mock.restore(); }
});

test('上游 4xx（JSON）：说"上游拒绝了请求"，不替上游认成网关故障；type/code 保留', async () => {
  const { env } = setup();
  const mock = mockUpstream(() => new Response(JSON.stringify({
    error: { message: 'model not found upstream', type: 'invalid_request_error', code: 'model_not_found' },
  }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
  try {
    const res = await call(env, '/v1/chat/completions', CHAT_BODY);
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    const message = String(body.error.message);
    assert.ok(message.startsWith('Upstream rejected the request'), `4xx 文案：${message}`);
    assert.ok(!message.includes('not a gateway fault'), '4xx 可能是参数也可能是我们的翻译，不能替上游甩锅');
    assert.ok(message.includes('model not found upstream'), '上游原因要留在 message 里，方便判断是不是参数问题');
    assert.equal(body.error.type, 'invalid_request_error');
    assert.equal(body.error.code, 'model_not_found');
  } finally { mock.restore(); }
});

test('网络层失败（fetch 抛错）：说上游不可达，不说"上游返回了 xxx"', async () => {
  const { env } = setup();
  const mock = mockUpstream(() => { throw new Error('connection reset'); });
  try {
    const res = await call(env, '/v1/chat/completions', CHAT_BODY);
    assert.equal(res.status, 502);
    const body = (await res.json()) as any;
    const message = String(body.error.message);
    assert.ok(message.includes('Upstream unreachable'), `网络失败文案：${message}`);
    assert.ok(message.includes('not a gateway fault'), `网络失败也要点明不是网关问题：${message}`);
    assert.ok(message.includes('HPD-DOG-gpt-high'), `带渠道名：${message}`);
    assert.ok(message.includes('connection reset'), `带网络错误细节：${message}`);
  } finally { mock.restore(); }
});

test('Anthropic 入口同样使用壳子文案（不透传上游原文当主信息）', async () => {
  const { env } = setup();
  const mock = mockUpstream(() => new Response(JSON.stringify({ error: { message: 'boom', type: 'server_error' } }), {
    status: 500, headers: { 'Content-Type': 'application/json' },
  }));
  try {
    const res = await call(env, '/v1/messages', { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 500);
    const body = (await res.json()) as any;
    const message = String(body.error.message);
    assert.ok(message.includes('not a gateway fault'), `anthropic 壳子：${message}`);
    assert.ok(message.includes('HPD-DOG-gpt-high'), `anthropic 壳子带渠道名：${message}`);
    assert.notEqual(message, 'boom', '上游原文不得当主信息');
  } finally { mock.restore(); }
});

test('流中断在半路：SSE 错误事件也是壳子文案（带渠道名 + 不是网关）', async () => {
  const { env } = setup();
  const enc = new TextEncoder();
  const mock = mockUpstream(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"up","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'));
      // 没有 finish_reason / usage / [DONE]，直接断连接
      setTimeout(() => controller.error(new Error('Network connection lost.')), 5);
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  try {
    const res = await call(env, '/v1/chat/completions', { ...CHAT_BODY, stream: true });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Upstream stream interrupted'), `流中断文案：${text.slice(-400)}`);
    assert.ok(text.includes('not a gateway fault'), '流中断要点明不是网关问题');
    assert.ok(text.includes('HPD-DOG-gpt-high'), '流中断要带渠道名');
  } finally { mock.restore(); }
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
  // 显式退出：node:sqlite 的 DatabaseSync 会占住事件循环。
  process.exit(0);
})();
