/**
 * 内置命令行（lib/cli.ts）集成测试：真 SQLite + 全部 migrations，
 * CLI 的每条命令都在真库上执行，不 mock SQL。
 *
 * Run: npm run test:cli
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCli } from '../src/lib/cli';

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

/** 最小 D1 适配层（同 query-plan.test.ts）：prepare/bind/first/all/run/batch。 */
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

const kv = () => {
  const m = new Map<string, string>();
  return {
    get: async (k: string, t?: string) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)!) : m.get(k)) : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
};

const envOf = () => ({ DB: asD1(freshDB()), CACHE: kv() }) as any;
const run = async (env: any, cmd: string) => runCli(env, cmd);

test('help：列出命令分组', async () => {
  const r = await run(envOf(), 'help');
  assert.ok(r.ok);
  assert.match(r.output, /命令分组/);
  assert.match(r.output, /channel add/);
});

test('status：owner 自动开户并预存 $10,000', async () => {
  const r = await run(envOf(), 'status');
  assert.ok(r.ok);
  assert.match(r.output, /\$10000\.0000/);
  assert.match(r.output, /渠道：0 个/);
});

test('channel add → list → models 全链路', async () => {
  const env = envOf();
  const added = await run(env, 'channel add openai deepseek https://api.deepseek.com sk-ds --models deepseek-v4-flash,gpt-4o');
  assert.ok(added.ok, added.output);
  assert.match(added.output, /渠道 #\d+/);

  const list = await run(env, 'channel list');
  assert.match(list.output, /deepseek-v4-flash,gpt-4o/);

  const models = await run(env, 'models');
  assert.match(models.output, /deepseek-v4-flash/);
  assert.match(models.output, /gpt-4o/);
});

test('channel 参数不全要报用法', async () => {
  const r = await run(envOf(), 'channel add openai only-name');
  assert.ok(!r.ok);
  assert.match(r.output, /用法/);
});

test('price set → get → rm 往返；表达式也要过校验', async () => {
  const env = envOf();
  const set = await run(env, 'price set my-model in=0.5 out=1.5 cached=0.05');
  assert.ok(set.ok, set.output);

  const got = await run(env, 'price get my-model');
  assert.match(got.output, /覆盖/);
  assert.match(got.output, /\$0\.5/);

  const list = await run(env, 'price list my-model');
  assert.match(list.output, /my-model/);

  const rm = await run(env, 'price rm my-model');
  assert.ok(rm.ok);
  const after = await run(env, 'price rm my-model');
  assert.match(after.output, /没有覆盖/);

  const bad = await run(env, 'price set broken expr="p *');
  assert.ok(!bad.ok);
  assert.match(bad.output, /无法编译/);
});

test('price default：兜底价可改并生效于未知模型', async () => {
  const env = envOf();
  const set = await run(env, 'price default in=2 out=4');
  assert.ok(set.ok, set.output);
  const got = await run(env, 'price get totally-unknown');
  assert.match(got.output, /\$2/);
});

test('token new → key → price → off 往返', async () => {
  const env = envOf();
  const created = await run(env, 'token new 测试 --usd 5 --models gpt-4o --price {"gpt-4o":{"in":1,"out":2}}');
  assert.ok(created.ok, created.output);
  assert.match(created.output, /sk-[0-9a-f]{48}/);

  const list = await run(env, 'token list');
  assert.match(list.output, /测试/);

  const id = /^\s*(\d+)\s/m.exec((await run(env, 'token list')).output)![1];
  const price = await run(env, `token price ${id}`);
  assert.match(price.output, /gpt-4o/);

  const off = await run(env, `token off ${id}`);
  assert.ok(off.ok);
  const del = await run(env, `token del ${id}`);
  assert.ok(del.ok);
});

test('token price 的坏 JSON 被校验拦下', async () => {
  const env = envOf();
  await run(env, 'token new t');
  const id = /^\s*(\d+)\s/m.exec((await run(env, 'token list')).output)![1];
  const bad = await run(env, `token price ${id} {"m":{"expr":"p *"}}`);
  assert.ok(!bad.ok);
  assert.match(bad.output, /无法编译/);
});

test('owner add/sub 调整预算并记账', async () => {
  const env = envOf();
  const before = await run(env, 'owner');
  assert.match(before.output, /\$10000\.0000/);
  assert.ok((await run(env, 'owner add 5.5')).ok);
  const mid = await run(env, 'owner');
  assert.match(mid.output, /\$10005\.5000/);
  assert.ok((await run(env, 'owner sub 0.5')).ok);
  const after = await run(env, 'owner');
  assert.match(after.output, /\$10005\.0000/);
  const rec = await run(env, 'reconcile');
  assert.ok(rec.ok, '账本必须对得上');
});

test('未知命令给出指引', async () => {
  const r = await run(envOf(), 'nonsense');
  assert.ok(!r.ok);
  assert.match(r.output, /未知命令/);
  assert.match(r.output, /help/);
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
console.log(`\ncli: ${tests.length} passed`);
