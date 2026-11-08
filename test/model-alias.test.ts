/**
 * 模型别名（并查集）端到端契约——用户给的例子同构：
 *   令牌 M 的 models = [m-a]；渠道 A(优先级10) 拥有 m-a、渠道 B(优先级0) 拥有 m-b；
 *   AliasGroups = [["m-a","m-b"]]（A/B 是同一模型的不同叫法）。
 * 钉死四件事：
 *   1. 请求任一别名（m-a 或 m-b）都放行并路由到拥有它的渠道（m-b → B，尽管优先级低）；
 *   2. 出站模型名 = 渠道拥有的成员（发给 B 就是 m-b，自动翻译）；
 *   3. 令牌白名单按块展开：models 只有 m-a 也能用 m-b；不相关名字照旧 403；
 *   4. /v1/models 按块展开可见性；未配置别名时行为不变（回退精确匹配）。
 *
 * Run: npm run test:model-alias
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index';
import { buildAliasIndex } from '../src/lib/alias';

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
  // 忠实仿真真 KV：put 存字符串，get 带 type:'json' 时解析——否则 getOptions 的
  // {...DEFAULT, ...cached} 会被字符串展开污染（AliasGroups 悄悄变回默认 []）。
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

/** 建库 + 种子：A(a.test, m-a, 优先级10) B(b.test, m-b, 优先级0)，令牌 models 可指定。 */
function setup(opts: { aliasOption?: string; tokenModels?: string } = {}) {
  const db = freshDB();
  db.exec(`INSERT INTO users (id, username, password, display_name, role, status, quota, used_quota, request_count, created_time) VALUES (1, 'owner', '', 'Owner', 100, 1, 10000000, 0, 0, 0)`);
  db.exec(`INSERT INTO channels (id, type, key, status, name, weight, priority, base_url, models) VALUES
    (1, 'openai', 'k-a', 1, 'A', 1, 10, 'https://a.test', 'm-a'),
    (2, 'openai', 'k-b', 1, 'B', 1, 0, 'https://b.test', 'm-b')`);
  db.exec(`INSERT INTO abilities (model, channel_id, enabled, priority, weight) VALUES
    ('m-a', 1, 1, 10, 1),
    ('m-b', 2, 1, 0, 1)`);
  db.prepare(
    `INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, used_quota, models) VALUES (1, ?, 1, 't', 0, 0, -1, 0, 1, 0, ?)`,
  ).run('a'.repeat(48), opts.tokenModels ?? 'm-a');
  if (opts.aliasOption) {
    db.prepare('INSERT INTO options (key, value) VALUES (?, ?)').run('AliasGroups', opts.aliasOption);
  }
  const env = {
    DB: asD1(db),
    CACHE: kvMock(),
    ASSETS: { fetch: async () => new Response('spa') },
    ADMIN_KEY: ADMIN,
  } as never;
  return { db, env: env as never };
}

/** 假上游：记录 URL 与请求体的 model 字段（出站翻译断言用）。 */
function mockUpstream(): { urls: string[]; models: string[]; restore: () => void } {
  const urls: string[] = [];
  const models: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    urls.push(String(url));
    let bodyText = '';
    if (typeof input === 'string') bodyText = String(init?.body ?? '');
    else if (input.body) { try { bodyText = await input.clone().text(); } catch { /* 忽略 */ } }
    else if (init?.body) bodyText = String(init.body);
    let bodyModel: string | undefined;
    try { bodyModel = JSON.parse(bodyText).model; } catch { /* 忽略 */ }
    models.push(String(bodyModel ?? ''));
    return new Response(JSON.stringify({
      id: 'chatcmpl-x', object: 'chat.completion', created: 0, model: bodyModel ?? 'up',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return { urls, models, restore: () => (globalThis.fetch = original) };
}

async function call(env: never, model: string, key = 'sk-' + 'a'.repeat(48)) {
  return worker.fetch(
    new Request('https://oneapi.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
}

/* ---------------------------------------------------------------- 单元：并查集 */

test('buildAliasIndex：跨组重名自动合并（A,B + B,C → 一个块）', () => {
  const idx = buildAliasIndex([['a', 'b'], ['b', 'c']]);
  assert.deepEqual(idx.byName.get('a'), ['a', 'b', 'c']);
  assert.deepEqual(idx.byName.get('c'), ['a', 'b', 'c']);
});

test('buildAliasIndex：独立组不串线；未配置的名字不在表中', () => {
  const idx = buildAliasIndex([['x', 'y'], ['p', 'q']]);
  assert.deepEqual(idx.byName.get('x'), ['x', 'y']);
  assert.equal(idx.byName.get('z'), undefined);
  assert.deepEqual(idx.byName.get('p'), ['p', 'q']);
});

/* ---------------------------------------------------------- 端到端（用户例子） */

test('端到端：令牌持有 m-a，请求 m-b → 组件路由（优先级 A 胜出），出站翻译为 A 的名字 m-a', async () => {
  const { env } = setup({ aliasOption: JSON.stringify([['m-a', 'm-b']]), tokenModels: 'm-a' });
  const mock = mockUpstream();
  try {
    const res = await call(env, 'm-b');
    assert.equal(res.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://a.test/')), `组件路由应选 A 实际 ${mock.urls}`);
    assert.equal(mock.models.at(-1), 'm-a', '出站名 = 服务渠道拥有的成员');
    assert.ok(!mock.urls.some((u) => u.startsWith('https://b.test/')), '同一轮不会重试同块其他渠道（除非失败）');
  } finally { mock.restore(); }
});

test('端到端：ACL 白名单锁定 B 时，请求 m-b → 路由 B、出站 m-b（B 自己的名字）', async () => {
  const db = freshDB();
  db.exec(`INSERT INTO users (id, username, password, display_name, role, status, quota, used_quota, request_count, created_time) VALUES (1, 'owner', '', 'Owner', 100, 1, 10000000, 0, 0, 0)`);
  db.exec(`INSERT INTO channels (id, type, key, status, name, weight, priority, base_url, models) VALUES
    (1, 'openai', 'k-a', 1, 'A', 1, 10, 'https://a.test', 'm-a'),
    (2, 'openai', 'k-b', 1, 'B', 1, 0, 'https://b.test', 'm-b')`);
  db.exec(`INSERT INTO abilities (model, channel_id, enabled, priority, weight) VALUES
    ('m-a', 1, 1, 10, 1),
    ('m-b', 2, 1, 0, 1)`);
  db.prepare(
    `INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, used_quota, models, channel_acl)
     VALUES (1, ?, 1, 't', 0, 0, -1, 0, 1, 0, 'm-a', ?)`,
  ).run('a'.repeat(48), JSON.stringify({ mode: 'whitelist', channels: [2] }));
  db.prepare('INSERT INTO options (key, value) VALUES (?, ?)').run('AliasGroups', JSON.stringify([['m-a', 'm-b']]));
  const env = { DB: asD1(db), CACHE: kvMock(), ASSETS: { fetch: async () => new Response('spa') }, ADMIN_KEY: ADMIN } as never;
  const mock = mockUpstream();
  try {
    const KEY = 'sk-' + 'a'.repeat(48);
    const res = await worker.fetch(
      new Request('https://oneapi.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: 'm-b', messages: [{ role: 'user', content: 'hi' }] }),
      }),
      env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );
    assert.equal(res.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://b.test/')), `ACL 锁 B 应路由 B 实际 ${mock.urls}`);
    assert.equal(mock.models.at(-1), 'm-b');
  } finally { mock.restore(); }
});

test('端到端：请求 m-a 照常路由 A（优先级高者）', async () => {
  const { env } = setup({ aliasOption: JSON.stringify([['m-a', 'm-b']]), tokenModels: 'm-a' });
  const mock = mockUpstream();
  try {
    const res = await call(env, 'm-a');
    assert.equal(res.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://a.test/')));
    assert.equal(mock.models.at(-1), 'm-a');
  } finally { mock.restore(); }
});

test('令牌白名单按块展开：models=m-a 时 /v1/models 也可见 m-b', async () => {
  const { env } = setup({ aliasOption: JSON.stringify([['m-a', 'm-b']]), tokenModels: 'm-a' });
  const res = await worker.fetch(
    new Request('https://oneapi.test/v1/models', { headers: { Authorization: `Bearer ${'sk-' + 'a'.repeat(48)}` } }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
  const jj = (await res.json()) as any;
  const ids = jj.data.map((x: any) => x.id).sort();
  assert.deepEqual(ids, ['m-a', 'm-b'], `实际可见 ${JSON.stringify(ids)}`);
});

test('不相关的名字照旧 403（别名不放行无关块）', async () => {
  const { env } = setup({ aliasOption: JSON.stringify([['m-a', 'm-b']]), tokenModels: 'm-a' });
  const mock = mockUpstream();
  try {
    const res = await call(env, 'm-x');
    assert.equal(res.status, 403);
    assert.equal(mock.urls.length, 0);
  } finally { mock.restore(); }
});

test('未配置别名：行为不变（回退精确匹配，m-b 落 B）', async () => {
  const { env } = setup({ tokenModels: 'm-b' });
  const mock = mockUpstream();
  try {
    const res = await call(env, 'm-b');
    assert.equal(res.status, 200);
    assert.ok(mock.urls.some((u) => u.startsWith('https://b.test/')));
    assert.equal(mock.models.at(-1), 'm-b');
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
})();
