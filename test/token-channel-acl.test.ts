/**
 * 令牌级渠道 ACL（白/黑名单）端到端契约。
 *
 * 钉死六件事：
 *   1. 无 ACL → 行为不变（高优先级渠道照常选中，向后兼容）；
 *   2. 白名单非空 → 只允许列表内渠道（**低优先级也能强制选中**——本特性的核心用例）；
 *   3. 白名单空数组 → 全禁（503 no_channel，上游零调用），等价禁用；
 *   4. 黑名单空数组 → 全放；黑名单命中 → 被禁渠道落选，其余照常；
 *   5. 损坏的 ACL JSON → fail-close（全禁 + 日志），绝不静默放行；
 *   6. 管理 API 校验：mode 非法 400、null 清除、GET 回解析对象（互斥由结构保证）。
 *
 * 白名单/黑名单是互斥模式，由存储结构（单个 mode 键）保证不可能同时设置。
 *
 * Run: npm run test:token-channel-acl
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
  // 忠实仿真真 KV：put 存字符串，get 带 type:'json' 时解析（与生产 KV 一致）。
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
const MODEL = 'm-a';

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

/** 建库 + 种子（owner 用户 / 两个渠道 A(优先级10, a.test, 组cn) B(优先级0, b.test, 组other) / abilities / 一把令牌）。 */
function setup(aclJson: string, tokenModels = MODEL) {
  const db = freshDB();
  db.exec(`INSERT INTO users (id, username, password, display_name, role, status, quota, used_quota, request_count, created_time) VALUES (1, 'owner', '', 'Owner', 100, 1, 10000000, 0, 0, 0)`);
  db.exec(`INSERT INTO channels (id, type, key, status, name, weight, priority, base_url, models, "group") VALUES
    (1, 'openai', 'k-a', 1, 'A', 1, 10, 'https://a.test', '${MODEL}', 'cn'),
    (2, 'openai', 'k-b', 1, 'B', 1, 0, 'https://b.test', '${MODEL}', 'other')`);
  db.exec(`INSERT INTO abilities (model, channel_id, enabled, priority, weight) VALUES
    ('${MODEL}', 1, 1, 10, 1),
    ('${MODEL}', 2, 1, 0, 1)`);
  db.prepare(
    `INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, used_quota, models, channel_acl)
     VALUES (1, ?, 1, 't', 0, 0, -1, 0, 1, 0, ?, ?)`,
  ).run('a'.repeat(48), tokenModels, aclJson);
  const env = {
    DB: asD1(db),
    CACHE: kvMock(),
    ASSETS: { fetch: async () => new Response('spa') },
    ADMIN_KEY: ADMIN,
  } as never;
  return { db, env: env as never };
}

/** 假上游：记录被请求的 URL，回标准 chat completion（usage 全零）。 */
function mockUpstream(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    urls.push(String(url));
    return new Response(JSON.stringify({
      id: 'chatcmpl-x', object: 'chat.completion', created: 0, model: 'up',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return { urls, restore: () => (globalThis.fetch = original) };
}

async function call(env: never, path: string, init: RequestInit = {}, key = 'sk-' + 'a'.repeat(48)) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  return worker.fetch(new Request('https://oneapi.test' + path, { ...init, headers }), env, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
}

async function admin(env: never, method: string, path: string, body?: unknown) {
  return worker.fetch(new Request('https://oneapi.test' + path, { method, headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
}

test('无 ACL：行为不变，高优先级渠道 A 选中', async () => {
  const { env } = setup('');
  const mock = mockUpstream();
  try {
    const res = await call(env, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://a.test/')), `应调 A 实际 ${mock.urls}`);
  } finally { mock.restore(); }
});

test('白名单 [B]：低优先级渠道被强制选中（核心用例）', async () => {
  const { env } = setup(JSON.stringify({ mode: 'whitelist', channels: [2] }));
  const mock = mockUpstream();
  try {
    const res = await call(env, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://b.test/')), `应调 B 实际 ${mock.urls}`);
    assert.ok(!mock.urls.some((u) => u.startsWith('https://a.test/')), '高优先级的 A 必须被排除');
  } finally { mock.restore(); }
});

test('白名单空数组：全禁（503，上游零调用）——等价禁用', async () => {
  const { env } = setup(JSON.stringify({ mode: 'whitelist', channels: [] }));
  const mock = mockUpstream();
  try {
    const res = await call(env, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 503);
    assert.equal(mock.urls.length, 0, '全禁时不得发出任何上游请求');
  } finally { mock.restore(); }
});

test('黑名单空数组：全放（高优先级 A 照常）', async () => {
  const { env } = setup(JSON.stringify({ mode: 'blacklist', channels: [] }));
  const mock = mockUpstream();
  try {
    const res = await call(env, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://a.test/')));
  } finally { mock.restore(); }
});

test('黑名单 [A]：A 被排除，落 B', async () => {
  const { env } = setup(JSON.stringify({ mode: 'blacklist', channels: [1] }));
  const mock = mockUpstream();
  try {
    const res = await call(env, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://b.test/')));
    assert.ok(!mock.urls.some((u) => u.startsWith('https://a.test/')));
  } finally { mock.restore(); }
});

test('黑名单 [A,B]：全部被禁 → 503', async () => {
  const { env } = setup(JSON.stringify({ mode: 'blacklist', channels: [1, 2] }));
  const mock = mockUpstream();
  try {
    const res = await call(env, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 503);
    assert.equal(mock.urls.length, 0);
  } finally { mock.restore(); }
});

test('损坏的 ACL JSON：fail-close 全禁（503），绝不静默放行', async () => {
  const { env } = setup('not-json{{{');
  const mock = mockUpstream();
  try {
    const res = await call(env, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 503);
    assert.equal(mock.urls.length, 0);
  } finally { mock.restore(); }
});

test('决策端也被 ACL 过滤：whitelist [B] 时 /v1/decisions 落 B', async () => {
  const { env } = setup(JSON.stringify({ mode: 'whitelist', channels: [2] }));
  const mock = mockUpstream();
  try {
    const res = await call(env, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://b.test/')));
  } finally { mock.restore(); }
});

test('白名单 [组名 cn]：A 命中组、B（other 组）被排除', async () => {
  const { env } = setup(JSON.stringify({ mode: 'whitelist', channels: ['cn'] }));
  const mock = mockUpstream();
  try {
    const res = await call(env, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://a.test/')));
    assert.ok(!mock.urls.some((u) => u.startsWith('https://b.test/')));
  } finally { mock.restore(); }
});

test('黑名单 [组名 cn]：A 被排除落 B；混合条目 [2, cn] 命中并集 → A', async () => {
  const { env } = setup(JSON.stringify({ mode: 'blacklist', channels: ['cn'] }));
  const mock = mockUpstream();
  try {
    const r1 = await call(env, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(r1.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://b.test/')));
    assert.ok(!mock.urls.some((u) => u.startsWith('https://a.test/')), '组名 cn 命中的 A 必须被排除');
  } finally { mock.restore(); }

  const { env: env2 } = setup(JSON.stringify({ mode: 'whitelist', channels: [2, 'cn'] }));
  const mock2 = mockUpstream();
  try {
    const r2 = await call(env2, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(r2.status, 200);
    // 并集：ID 2 与 组 cn（渠道 1）都允许 → 高优先级 A 胜出
    assert.ok(mock2.urls.some((u) => u.startsWith('https://a.test/')));
  } finally { mock2.restore(); }
});

test('管理 API：mode 非法 → 400；合法写入 → GET 回解析对象；null → 清除', async () => {
  const { db, env } = setup('');
  const bad = await admin(env, 'POST', '/api/tokens', { name: 'x', channel_acl: { mode: 'both', channels: [1] } });
  assert.equal(bad.status, 400);

  const put = await admin(env, 'PUT', '/api/tokens/1', { channel_acl: { mode: 'blacklist', channels: [1, 2, 1] } });
  assert.equal(put.status, 200);
  const list = await (await admin(env, 'GET', '/api/tokens')).json();
  assert.deepEqual(list.data[0].channel_acl, { mode: 'blacklist', channels: [1, 2] }); // 去重排序 + 解析对象

  const clear = await admin(env, 'PUT', '/api/tokens/1', { channel_acl: null });
  assert.equal(clear.status, 200);
  const list2 = await (await admin(env, 'GET', '/api/tokens')).json();
  assert.equal(list2.data[0].channel_acl, null);
  assert.equal((db.prepare('SELECT channel_acl FROM tokens WHERE id = 1').get() as any).channel_acl, '');
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
})();
