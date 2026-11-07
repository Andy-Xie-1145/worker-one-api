/**
 * 维护栅栏（MAINTENANCE 环境变量）的 HTTP 契约。
 *
 * 钉死四件事：
 *   1. MAINTENANCE 不设或非 "on" → 一切如常（对现网零行为变化，这是能预部署的前提）；
 *   2. "on" 时三个写面全挡：/v1/*、/api/*（含 /api/anthropic、CLI、鉴权 GET）、/gemini/*，
 *      一律 503 + Retry-After，且挡在鉴权之前（无凭据也 503，不给任何写入面留缝）；
 *   3. 例外路径放行：/api/status（免鉴权状态）与 /health（零 D1 依赖观测口）；
 *   4. 响应可缓存性钉死 no-store——维护 503 绝不能被任何层缓存住。
 *
 * 这套断言对应迁移计划 §3-B：冻结=该门 503 + 排空断言，恢复=redeploy 移除变量。
 *
 * Run: npm run test:maintenance-gate
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** npm 嵌套脚本偶尔会把 cwd 顶到上层；向上找一层兜底（同 token-secret.test.ts）。 */
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
  const map = new Map<string, unknown>();
  return {
    get: async (k: string) => (map.has(k) ? map.get(k) : null),
    put: async (k: string, v: unknown) => { map.set(k, v); },
    delete: async (k: string) => { map.delete(k); },
  };
}

const ADMIN = 'test-admin-key';

function makeEnv(maintenance?: string) {
  return {
    DB: asD1(freshDB()),
    CACHE: kvMock(),
    ASSETS: { fetch: async () => new Response('spa') },
    ADMIN_KEY: ADMIN,
    ...(maintenance === undefined ? {} : { MAINTENANCE: maintenance }),
  } as never;
}

/** 最小 D1 适配层（同 token-secret.test.ts）。 */
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

async function call(env: never, path: string, init: RequestInit = {}, admin: string | null = ADMIN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (admin !== null) headers.Authorization = `Bearer ${admin}`;
  return worker.fetch(
    new Request('https://oneapi.test' + path, { ...init, headers }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
}

const chatBody = JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] });

/* ------------------------------------------------ 关：不设或非 "on" = 零变化 */

test('MAINTENANCE 不设：管理面正常（200），不是 503', async () => {
  const env = makeEnv();
  const res = await call(env, '/api/tokens');
  assert.equal(res.status, 200);
});

test('MAINTENANCE="off" 字符串：同样正常（只有精确 "on" 才触发）', async () => {
  const env = makeEnv('off');
  const res = await call(env, '/api/tokens');
  assert.equal(res.status, 200);
});

test('MAINTENANCE 不设：/health 200', async () => {
  const res = await call(makeEnv(), '/health', {}, null);
  assert.equal(res.status, 200);
});

/* ------------------------------------------------ 开："on" 时三个写面全挡 */

test('MAINTENANCE="on"：/v1/chat/completions → 503 + Retry-After + no-store（无凭据也挡，先于鉴权）', async () => {
  const env = makeEnv('on');
  const res = await call(env, '/v1/chat/completions', { method: 'POST', body: chatBody }, null);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Retry-After'), '30');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const json = (await res.json()) as any;
  assert.equal(json.error?.type, 'maintenance');
});

test('MAINTENANCE="on"：/v1/messages（Anthropic 根路径）→ 503', async () => {
  const res = await call(makeEnv('on'), '/v1/messages', { method: 'POST', body: chatBody }, null);
  assert.equal(res.status, 503);
});

test('MAINTENANCE="on"：/api/anthropic/v1/messages → 503', async () => {
  const res = await call(makeEnv('on'), '/api/anthropic/v1/messages', { method: 'POST', body: chatBody }, null);
  assert.equal(res.status, 503);
});

test('MAINTENANCE="on"：/gemini/v1beta/models/m:generateContent → 503', async () => {
  const res = await call(makeEnv('on'), '/gemini/v1beta/models/m:generateContent', { method: 'POST', body: '{}' }, null);
  assert.equal(res.status, 503);
});

test('MAINTENANCE="on"：带正确 ADMIN_KEY 的管理面也挡（部署期栅栏优先于鉴权）', async () => {
  const res = await call(makeEnv('on'), '/api/tokens');
  assert.equal(res.status, 503);
});

test('MAINTENANCE="on"：鉴权 GET 隐式写（/api/tokens/:id/key）→ 503（冻结期审计日志也不新增）', async () => {
  const res = await call(makeEnv('on'), '/api/tokens/1/key');
  assert.equal(res.status, 503);
});

test('MAINTENANCE="on"：CLI 入口 POST /api/cli → 503', async () => {
  const res = await call(makeEnv('on'), '/api/cli', { method: 'POST', body: JSON.stringify({ cmd: 'status' }) });
  assert.equal(res.status, 503);
});

/* ------------------------------------------------ 例外：状态与观测口放行 */

test('MAINTENANCE="on"：/api/status → 200（免鉴权状态口）', async () => {
  const res = await call(makeEnv('on'), '/api/status', {}, null);
  assert.equal(res.status, 200);
});

test('MAINTENANCE="on"：/health → 200', async () => {
  const res = await call(makeEnv('on'), '/health', {}, null);
  assert.equal(res.status, 200);
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
