/**
 * 令牌明文密钥的「不回显」契约（HTTP 面）。
 *
 * 钉死三件事：
 *   1. GET  /api/tokens       —— 列表永远不含明文，只有 key_masked；
 *   2. POST /api/tokens       —— 创建响应同样只回遮罩（明文走剪贴板，不走回显）；
 *   3. GET  /api/tokens/:id/key —— 唯一的明文出口，且必须在管理日志里留痕。
 *
 * 为什么值得测：明文一旦被"顺手回显"，截图、终端历史、AI 会话记录就都成了泄露面，
 * 而密钥轮换成本很高。这类回归必须被测试挡住。
 *
 * Run: npm run test:token-secret
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** npm 嵌套脚本偶尔会把 cwd 顶到上层；向上找一层兜底。 */
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

/** 最小 D1 适配层（同 cli.test.ts / query-plan.test.ts）。 */
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

const ADMIN = 'test-admin-key';
const HEX48 = /^[0-9a-f]{48}$/;

function kvMock() {
  const map = new Map<string, unknown>();
  return {
    get: async (k: string) => (map.has(k) ? map.get(k) : null),
    put: async (k: string, v: unknown) => { map.set(k, v); },
    delete: async (k: string) => { map.delete(k); },
  };
}

function makeEnv() {
  const db = freshDB();
  return {
    db,
    env: {
      DB: asD1(db),
      CACHE: kvMock(),
      ASSETS: { fetch: async () => new Response('spa') },
      ADMIN_KEY: ADMIN,
    } as never,
  };
}

async function call(env: never, path: string, init: RequestInit = {}, admin: string | null = ADMIN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (admin !== null) headers.Authorization = `Bearer ${admin}`;
  return worker.fetch(
    new Request('https://oneapi.test' + path, { ...init, headers }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
}

/** 直接入库一把已知明文 key，方便断言"哪个字符串绝不该出现在响应里"。 */
function seedToken(db: DatabaseSync, key: string, name = '种子令牌'): number {
  db.prepare(
    "INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, models) VALUES (1, ?, 1, ?, 0, 0, -1, 0, 1, '')",
  ).run(key, name);
  return Number((db.prepare('SELECT id FROM tokens WHERE key = ?').get(key) as any).id);
}

/** 抹掉所有 "sk-<hex>" 形态，用于断言响应里连一串都不是明文。 */
const hexRuns = (text: string) => text.match(/[0-9a-f]{48}/g) ?? [];

/* ---------------------------------------------------------------- 列表 */

test('GET /api/tokens：只有遮罩，没有任何 48 位明文', async () => {
  const { db, env } = makeEnv();
  const key = 'a'.repeat(24) + 'b'.repeat(24); // 48 hex
  const id = seedToken(db, key, '测试-A');

  const res = await call(env, '/api/tokens');
  assert.equal(res.status, 200);
  const json = (await res.json()) as any;
  const row = json.data.find((t: any) => t.id === id);

  assert.ok(row, '列表里应有刚种的令牌');
  assert.equal('key' in row, false, '列表绝不能带明文 key 字段');
  assert.match(row.key_masked, /^sk-[0-9a-f]{6}…$/);
  assert.equal(row.key_masked, 'sk-aaaaaa…', '遮罩 = sk- + 前 6 位');

  const body = JSON.stringify(json);
  assert.equal(body.includes(key), false, '明文不得出现在响应体任何位置');
  assert.deepEqual(hexRuns(body), [], '响应体里不该有 48 位 hex 串');
});

/* ---------------------------------------------------------------- 创建 */

test('POST /api/tokens：创建响应只回遮罩，明文仅存在于库里', async () => {
  const { db, env } = makeEnv();
  const res = await call(env, '/api/tokens', {
    method: 'POST',
    body: JSON.stringify({ name: '新建-A', unlimited_quota: true }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as any;
  const created = json.data;

  assert.ok(created.id > 0);
  assert.equal(created.name, '新建-A');
  assert.equal('key' in created, false, '创建响应不能带明文（回显即泄露）');
  assert.match(created.key_masked, /^sk-[0-9a-f]{6}…$/);

  const body = JSON.stringify(json);
  assert.deepEqual(hexRuns(body), [], '创建响应体里不该有 48 位 hex 串');

  // 明文确实落库了（25 位随机 + sk- 之外，这里只验证库里是 48 hex）
  const row = db.prepare('SELECT key FROM tokens WHERE id = ?').get(created.id) as any;
  assert.match(row.key, HEX48);
  assert.equal(created.key_masked, `sk-${row.key.slice(0, 6)}…`, '遮罩必须来自真实密钥的前 6 位');
});

/* ---------------------------------------------------------------- 显式取回 */

test('GET /api/tokens/:id/key：唯一明文出口，并写一条管理日志', async () => {
  const { db, env } = makeEnv();
  const key = 'c'.repeat(48);
  const id = seedToken(db, key, '要取回的');

  const res = await call(env, `/api/tokens/${id}/key`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as any;
  assert.equal(json.data.key, 'sk-' + key, '取回接口返回完整 sk- 密钥');
  assert.equal(json.data.id, id);
  assert.equal(json.data.name, '要取回的');

  const logs = db.prepare('SELECT type, content FROM logs WHERE type = 3').all() as any[];
  assert.equal(logs.length, 1, '取回明文必须留管理日志');
  assert.match(logs[0].content, /取回令牌 #\d+「要取回的」明文密钥/);
});

test('取回接口：鉴权与 404（没有明文兜底路径）', async () => {
  const { db, env } = makeEnv();
  const id = seedToken(db, 'd'.repeat(48));

  const noAuth = await call(env, `/api/tokens/${id}/key`, {}, null);
  assert.equal(noAuth.status, 401);
  const wrong = await call(env, `/api/tokens/${id}/key`, {}, 'nope');
  assert.equal(wrong.status, 401);
  const missing = await call(env, '/api/tokens/9999/key');
  assert.equal(missing.status, 404);
  const badId = await call(env, '/api/tokens/abc/key');
  assert.equal(badId.status, 404, '非数字 id 当不存在处理，不抛 500');
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
