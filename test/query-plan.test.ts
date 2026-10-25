/**
 * D1 按 Rows Read 计费：一条 SCAN 就是整张表读一遍。这里钉住两件事：
 *
 * 1. **查询计划**——把 migrations/ 全部灌进一个真的 SQLite（node:sqlite），用它当 D1
 *    去跑回收器、公开状态页的**真实代码**，把它们发出的每一条 SQL 都
 *    EXPLAIN QUERY PLAN 一遍：credits / billing_windows / logs 上不许出现 SCAN。
 *    SQL 是从源码里抓的，不是抄一份，所以改了 SQL 或删了索引这里会立刻红。
 * 2. **语义没变**——同一个真库上，悬空预扣退一次且只退一次；公开状态页 60 秒内命中
 *    Cache API（caches.default），不重复打库，缓存键只由规范化后的窗口决定。
 *
 * Run: npm run test:query-plan
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reclaimAbandonedReservations } from '../src/lib/watchdog';
import api, { resetPublicStatusCache } from '../src/routes/api';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// 打包产物在 node_modules/.cache 下跑，import.meta.url 靠不住；npm 脚本总在项目根目录执行。
// npm 嵌套脚本偶尔会把 cwd 顶到上层，向上找一层兜底。
const resolveBase = (): string => {
  const candidates = [process.cwd(), join(process.cwd(), 'worker-one-api')];
  return candidates.find((p) => existsSync(join(p, 'migrations'))) ?? candidates[0];
};
const BASE = resolveBase();
const MIGRATIONS = join(BASE, 'migrations');
const src = (f: string) => readFileSync(join(BASE, f), 'utf8');
const HOT_TABLES = ['credits', 'billing_windows', 'logs'];

function freshDB(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

/** 最小 D1 适配层：prepare/bind/first/all/run/batch，batch 是一个事务。记下每条 SQL。 */
function asD1(db: DatabaseSync) {
  const seen: string[] = [];
  const norm = (v: unknown) => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v);
  const stmt = (sql: string, binds: unknown[] = []) => {
    seen.push(sql);
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
    seen,
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

const kv = () => {
  const m = new Map<string, string>();
  return {
    get: async (k: string, t?: string) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)!) : m.get(k)) : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
};

/** 所有 SCAN 行，排除与热表无关的（常量行、临时 B 树等）。 */
function scans(db: DatabaseSync, sql: string): string[] {
  const aliasOf = new Map<string, string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    aliasOf.set(m[1], m[1]);
    if (m[2] && !/^(WHERE|GROUP|ORDER|LIMIT|ON)$/i.test(m[2])) aliasOf.set(m[2], m[1]);
  }
  const params = (sql.match(/\?/g) ?? []).map(() => null);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
  return plan
    .map((r) => r.detail)
    .filter((d) => {
      const m = /^SCAN (\w+)/.exec(d);
      return m && HOT_TABLES.includes(aliasOf.get(m[1]) ?? m[1]);
    });
}

const now = () => Math.floor(Date.now() / 1000);

function seedUser(db: DatabaseSync, quota = 1_000_000) {
  db.prepare("INSERT INTO users (id, username, password, quota) VALUES (1, 'u', 'x', ?)").run(quota);
  db.prepare("INSERT INTO tokens (id, user_id, key, name, remain_quota, unlimited_quota) VALUES (42, 1, 'k', 't', 0, 0)").run();
}
const credit = (db: DatabaseSync, ref: string, delta: number, reason: string, at: number) =>
  db
    .prepare('INSERT INTO credits (user_id, delta, reason, ref, balance_after, created_at) VALUES (1, ?, ?, ?, 0, ?)')
    .run(delta, reason, ref, at);

// ------------------------------------------------------------------ 查询计划

test('credits(ref) 等值查找走索引（ledger.ts 的去重与门控）', () => {
  const db = freshDB();
  const ledger = src('src/lib/ledger.ts');
  for (const sql of ['SELECT 1 AS hit FROM credits WHERE ref = ?', 'SELECT 1 WHERE EXISTS (SELECT 1 FROM credits WHERE ref = ?)']) {
    assert.deepEqual(scans(db, sql), [], sql);
  }
  // 防止上面两条和源码悄悄分叉
  assert.ok(ledger.includes("'SELECT 1 AS hit FROM credits WHERE ref = ?'"));
  assert.ok(ledger.includes("'EXISTS (SELECT 1 FROM credits WHERE ref = ?)'"));
});

test('部分唯一索引 idx_credits_ref 仍在，重复 ref 仍然被拒', () => {
  const db = freshDB();
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_credits_ref'").get() as { sql: string };
  assert.match(idx.sql, /UNIQUE INDEX .*credits\(ref\) WHERE ref != ''/);
  credit(db, 'fin:1', 1, 'refund', 1);
  assert.throws(() => credit(db, 'fin:1', 1, 'refund', 1), /UNIQUE constraint failed: credits\.ref/);
  // 空 ref 不去重（消费行）
  credit(db, '', -1, 'consume', 1);
  credit(db, '', -1, 'consume', 1);
});

test('回收器发出的每条 SQL 都不 SCAN 热表', async () => {
  const db = freshDB();
  const d1 = asD1(db);
  const env = { DB: d1, CACHE: kv() } as any;
  await reclaimAbandonedReservations(env);
  const selects = d1.seen.filter((s) => /^\s*SELECT/i.test(s));
  assert.ok(selects.length >= 1, `抓到的 SELECT 太少：${selects.length}`);
  for (const sql of selects) assert.deepEqual(scans(db, sql), [], sql);
});

test('公开状态页与管理员健康页的 logs 最近延迟查询走 idx_logs_created', async () => {
  const db = freshDB();
  const d1 = asD1(db);
  resetPublicStatusCache();
  const res = await api.fetch(new Request('http://x/status/public'), { DB: d1, CACHE: kv() } as any);
  assert.equal(res.status, 200);
  const latency = d1.seen.find((s) => s.includes('elapsed_ms > 0'))!;
  assert.match(latency, /ORDER BY created_at DESC LIMIT 1000/);
  assert.deepEqual(scans(db, latency), []);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${latency}`).all(null) as { detail: string }[];
  assert.ok(plan.some((r) => /idx_logs_created/.test(r.detail)));
  // 管理员页那条（/health/channels）同形，从源码里抓
  const apiSrc = src('src/routes/api.ts');
  assert.ok(!/created_at >= \? AND elapsed_ms > 0 ORDER BY id DESC/.test(apiSrc), '不应再按 id 倒序取最近延迟');
  for (const sql of d1.seen) assert.deepEqual(scans(db, sql), [], sql);
});

// ------------------------------------------------------------------ 语义

test('悬空预扣：退一次，第二轮不再退；已结算的不动', async () => {
  const db = freshDB();
  seedUser(db, 1000);
  const old = now() - 3600;
  credit(db, 'pre:42:aaa', -300, 'consume', old); // 悬空
  credit(db, 'pre:42:bbb', -200, 'consume', old); // 已结算
  credit(db, 'fin:42:bbb', 50, 'refund', old);
  credit(db, 'pre:42:ccc', -100, 'consume', now()); // 还在静置期
  const env = { DB: asD1(db), CACHE: kv() } as any;

  assert.equal(await reclaimAbandonedReservations(env), 1);
  assert.equal(await reclaimAbandonedReservations(env), 0);
  const q = db.prepare('SELECT quota FROM users WHERE id = 1').get() as { quota: number };
  assert.equal(q.quota, 1300);
  const fin = db.prepare("SELECT COUNT(*) AS n FROM credits WHERE ref = 'fin:42:aaa'").get() as { n: number };
  assert.equal(fin.n, 1);
});

// ------------------------------------------------------------------ 公开状态缓存

/**
 * caches.default 替身：按 URL 存，按 put 时的 Cache-Control max-age 过期（时钟走 Date.now）。
 *
 * 命中时模仿线上真实行为：带上 Age，并把 Cache-Control 改写成 zone 的 Browser Cache TTL
 * （默认 4 小时 = 14400）——线上就是这样把状态页冻住的。
 */
function fakeEdgeCache() {
  const store = new Map<string, { body: string; init: ResponseInit; at: number; until: number }>();
  const cache = {
    store,
    puts: 0,
    match: async (req: Request): Promise<Response | undefined> => {
      const e = store.get(req.url);
      if (!e || Date.now() >= e.until) return undefined;
      const headers = new Headers(e.init.headers);
      headers.set('Cache-Control', 'public, max-age=14400');
      headers.set('Age', String(Math.floor((Date.now() - e.at) / 1000)));
      return new Response(e.body, { status: e.init.status, headers });
    },
    put: async (req: Request, res: Response) => {
      cache.puts++;
      const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 0);
      store.set(req.url, {
        body: await res.text(),
        init: { status: res.status, headers: [...res.headers] },
        at: Date.now(),
        until: Date.now() + maxAge * 1000,
      });
    },
  };
  return cache;
}

async function withEdgeCache(fn: (cache: ReturnType<typeof fakeEdgeCache>, clock: { t: number }) => Promise<void>) {
  const cache = fakeEdgeCache();
  const realNow = Date.now;
  const clock = { t: realNow() };
  Date.now = () => clock.t;
  (globalThis as any).caches = { default: cache };
  try {
    await fn(cache, clock);
  } finally {
    delete (globalThis as any).caches;
    Date.now = realNow;
    resetPublicStatusCache();
  }
}

test('Cache API：60 秒内连续请求命中 caches.default，不再打 D1；过期后重新读', async () => {
  await withEdgeCache(async (cache, clock) => {
    const d1 = asD1(freshDB());
    const env = { DB: d1, CACHE: kv() } as any;

    const r1 = await api.fetch(new Request('http://x/status/public'), env);
    const after1 = d1.seen.length;
    assert.ok(after1 > 0);
    assert.equal(cache.puts, 1);
    assert.match(r1.headers.get('cache-control') ?? '', /max-age=60/);
    const body1 = await r1.json();

    for (let i = 1; i <= 5; i++) {
      clock.t += 5_000;
      const r = await api.fetch(new Request('http://x/status/public'), env);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), body1);
      // 命中时对客户端给剩余寿命，而不是 Cache API 改写出来的 14400
      assert.equal(r.headers.get('age'), String(i * 5));
      assert.equal(r.headers.get('cache-control'), `public, max-age=${60 - i * 5}`);
    }
    assert.equal(d1.seen.length, after1, '命中 Cache API 时不应再查 D1');
    assert.equal(cache.puts, 1);

    clock.t += 36_000; // 累计 61 秒
    const r3 = await api.fetch(new Request('http://x/status/public'), env);
    assert.ok(d1.seen.length > after1, '过期后必须重新查库');
    assert.equal(cache.puts, 2);
    assert.equal(r3.headers.get('cache-control'), 'public, max-age=60', 'MISS 仍给满 60 秒');
  });
});

test('Cache API：Age 超过 60 或缺失时，给客户端的 max-age 不为负、也不回退到 14400', async () => {
  await withEdgeCache(async (cache) => {
    const env = { DB: asD1(freshDB()), CACHE: kv() } as any;
    const hit = (headers: Record<string, string>) => async () => new Response('{"success":true}', { headers });
    const cases: Array<[Record<string, string>, string]> = [
      [{ 'Cache-Control': 'public, max-age=14400', Age: '75' }, 'public, max-age=0'],
      [{ 'Cache-Control': 'public, max-age=14400' }, 'public, max-age=60'],
      [{ 'Cache-Control': 'public, max-age=14400', Age: 'junk' }, 'public, max-age=60'],
    ];
    for (const [headers, expected] of cases) {
      cache.match = hit(headers);
      const r = await api.fetch(new Request('http://x/status/public'), env);
      assert.equal(r.headers.get('cache-control'), expected, JSON.stringify(headers));
    }
  });
});

test('Cache API：键只由规范化后的窗口秒数决定，原始 query 造不出新键', async () => {
  await withEdgeCache(async (cache) => {
    const d1 = asD1(freshDB());
    const env = { DB: d1, CACHE: kv() } as any;
    await api.fetch(new Request('http://x/status/public'), env); // 默认 3600
    const after1 = d1.seen.length;
    for (const q of ['?window=60m', '?window=1h', '?window=1h&x=1', '?window=garbage', '?x=' + 'a'.repeat(50), '?window=1h&window=2h']) {
      await api.fetch(new Request(`http://x/status/public${q}`), env);
    }
    assert.equal(d1.seen.length, after1, '等价窗口都应命中同一个键');
    // clamp：1m 和 5m 都是 300 秒
    await api.fetch(new Request('http://x/status/public?window=1m'), env);
    const after2 = d1.seen.length;
    assert.ok(after2 > after1);
    await api.fetch(new Request('http://x/status/public?window=5m'), env);
    assert.equal(d1.seen.length, after2);
    assert.deepEqual([...cache.store.keys()].sort(), [
      'http://x/api/status/public?window_sec=300',
      'http://x/api/status/public?window_sec=3600',
    ]);
  });
});

test('Cache API：查库失败不写缓存', async () => {
  await withEdgeCache(async (cache) => {
    const broken = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1 down'); } }) }) };
    const r = await api.fetch(new Request('http://x/status/public'), { DB: broken, CACHE: kv() } as any);
    assert.equal(r.status, 500);
    assert.equal(cache.puts, 0);
    assert.equal(cache.store.size, 0);
  });
});

test('Cache API 可用时不写内存 fallback', async () => {
  await withEdgeCache(async (cache) => {
    await api.fetch(new Request('http://x/status/public'), { DB: asD1(freshDB()), CACHE: kv() } as any);
    assert.equal(cache.puts, 1);
  });
  // 撤掉 caches 之后，内存里没有残留：新请求必须查库
  const d1 = asD1(freshDB());
  await api.fetch(new Request('http://x/status/public'), { DB: d1, CACHE: kv() } as any);
  assert.ok(d1.seen.length > 0);
  resetPublicStatusCache();
});

test('无 Cache API 时退到内存 fallback：60 秒内不重复查库，过期后重新读', async () => {
  assert.equal((globalThis as any).caches, undefined);
  const d1 = asD1(freshDB());
  const env = { DB: d1, CACHE: kv() } as any;
  resetPublicStatusCache();
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    await api.fetch(new Request('http://x/status/public'), env);
    const after1 = d1.seen.length;
    t += 30_000;
    await api.fetch(new Request('http://x/status/public?window=60m'), env);
    assert.equal(d1.seen.length, after1);
    t += 31_000;
    await api.fetch(new Request('http://x/status/public'), env);
    assert.ok(d1.seen.length > after1);
  } finally {
    Date.now = realNow;
    resetPublicStatusCache();
  }
});

test('内存 fallback：查库失败不写缓存', async () => {
  resetPublicStatusCache();
  const broken = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1 down'); } }) }) };
  const r = await api.fetch(new Request('http://x/status/public'), { DB: broken, CACHE: kv() } as any);
  assert.equal(r.status, 500);
  const d1 = asD1(freshDB());
  const ok = await api.fetch(new Request('http://x/status/public'), { DB: d1, CACHE: kv() } as any);
  assert.equal(ok.status, 200);
  assert.ok(d1.seen.length > 0, '失败那次不该留下缓存');
  resetPublicStatusCache();
});

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
console.log(`\nquery-plan: ${tests.length} passed`);
