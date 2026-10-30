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

  const bad = await run(env, 'price set broken in="context *"');
  assert.ok(!bad.ok);
  assert.match(bad.output, /无法编译/);

  // 旧版整笔 {expr} 明确拒绝并指路 v2
  const legacy = await run(env, 'price set broken2 expr="p * 3"');
  assert.ok(!legacy.ok);
  assert.match(legacy.output, /已移除/);});

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
  const bad = await run(env, `token price ${id} {"m":{"in":"context *"}}`);
  assert.ok(!bad.ok);
  assert.match(bad.output, /无法编译/);
  const legacy = await run(env, `token price ${id} {"m":{"expr":"p * 3"}}`);
  assert.ok(!legacy.ok);
  assert.match(legacy.output, /已移除/);
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

test('channel set：按字段修改并重建路由索引', async () => {
  const env = envOf();
  const added = await run(env, 'channel add openai ds https://api.deepseek.com sk-ds --models deepseek-v4-flash');
  const id = /#(\d+)/.exec(added.output)![1];
  const renamed = await run(env, `channel set ${id} name=主力 models=gpt-4o,claude-sonnet-5-5 priority=5`);
  assert.ok(renamed.ok, renamed.output);
  assert.match(renamed.output, /gpt-4o,claude-sonnet-5-5/);
  const models = await run(env, 'models');
  assert.match(models.output, /gpt-4o/);
  assert.ok(!models.output.includes('deepseek-v4-flash'), '旧模型应随路由索引重建消失');
  const bad = await run(env, `channel set ${id} type=nonsense`);
  assert.ok(!bad.ok && /非法/.test(bad.output));
  const unknown = await run(env, `channel set ${id} nonsense=1`);
  assert.ok(!unknown.ok && /不可修改的字段/.test(unknown.output));
});

test('token set：改名/改额度/改模型限制；价格要走专门子命令', async () => {
  const env = envOf();
  await run(env, 'token new 测试');
  const id = /^\s*(\d+)\s/m.exec((await run(env, 'token list')).output)![1];
  const renamed = await run(env, `token set ${id} name=笔记本 models=gpt-4o usd=12.5 unlimited=0`);
  assert.ok(renamed.ok, renamed.output);
  assert.match(renamed.output, /笔记本/);
  assert.match(renamed.output, /\$12\.5000/);
  const list = await run(env, 'token list');
  assert.match(list.output, /gpt-4o/);
  const bad = await run(env, `token set ${id} price={"m":{"in":1}}`);
  assert.ok(!bad.ok && /不可修改的字段/.test(bad.output));
});

/* ------------------------------------------------- 新增：pull / test / billing / default */

function mockUpstream(models: string[], status = 200) {
  const original = globalThis.fetch;
  let body = '';
  globalThis.fetch = (async (_url: any, init: any) => {
    body = String(init?.body ?? '');
    return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status });
  }) as any;
  return { restore: () => (globalThis.fetch = original), get body() { return body; } };
}

test('channel pull：拉上游列表；--add 合并去重进渠道 models', async () => {
  const env = envOf();
  const added = await run(env, 'channel add openai 上游 https://up.test/v1 sk-up --models gpt-4o');
  const id = /#(\d+)/.exec(added.output)![1];

  const s = mockUpstream(['gpt-4o', 'gpt-5.5', 'o4-mini']);
  try {
    const pull = await run(env, `channel pull ${id}`);
    assert.ok(pull.ok, pull.output);
    assert.match(pull.output, /gpt-5\.5/);

    const add = await run(env, `channel pull ${id} --add`);
    assert.ok(add.ok, add.output);
    assert.match(add.output, /新增 2/);
    const list = await run(env, 'channel list');
    assert.match(list.output, /gpt-4o,gpt-5\.5,o4-mini/, '手工项保留 + 追加去重');
    // 模型真的进了路由索引
    assert.match((await run(env, 'models')).output, /o4-mini/);
  } finally {
    s.restore();
  }
});

test('channel test：显式模型必须属于该渠道；成功回写测试时间', async () => {
  const env = envOf();
  const added = await run(env, 'channel add openai 上游 https://up.test sk-up --models gpt-4o');
  const id = /#(\d+)/.exec(added.output)![1];

  const bad = await run(env, `channel test ${id} claude-x`);
  assert.ok(!bad.ok && /不属于该渠道/.test(bad.output));

  const s = mockUpstream(['gpt-4o']);
  try {
    const okRun = await run(env, `channel test ${id} gpt-4o`);
    assert.ok(okRun.ok, okRun.output);
    assert.match(okRun.output, /测试成功/);
    assert.match(okRun.output, /gpt-4o/);
  } finally {
    s.restore();
  }
});

test('billing：list / get / check 与严格开关', async () => {
  const env = envOf();
  await run(env, 'channel add openai 主力 https://up.test sk-up --models gpt-4o,mystery');

  // 宽松模式（有兜底价）：一切"已配置"，mystery 按兜底价记账
  const list = await run(env, 'billing list');
  assert.ok(list.ok, list.output);
  assert.match(list.output, /宽松计费/);
  assert.match(list.output, /未配置 0/);

  // 清掉兜底价 → 严格计费：mystery 变为未配置且排在最前
  const cleared = await run(env, 'price default --clear');
  assert.ok(cleared.ok, cleared.output);
  const mode = await run(env, 'price default');
  assert.match(mode.output, /严格计费/);

  const listStrict = await run(env, 'billing list');
  assert.match(listStrict.output, /严格计费/);
  assert.match(listStrict.output, /未配置 1/);
  assert.match(listStrict.output.split('\n').slice(-3).join('\n'), /mystery/, '未配置的排最前');

  const got = await run(env, 'billing get mystery');
  assert.ok(got.ok, got.output);
  assert.match(got.output, /未配置/);
  assert.match(got.output, /上游=mystery/);

  const checkStrict = await run(env, 'billing check');
  assert.ok(!checkStrict.ok, '严格计费下有未定价组合应当非零退出');
  assert.match(checkStrict.output, /model_price_not_configured/);

  // gpt-4o 有内置价，不受影响；设回兜底价恢复宽松
  const gotPriced = await run(env, 'billing get gpt-4o');
  assert.match(gotPriced.output, /已配置/);
  assert.match(gotPriced.output, /来源=table/);
  const back = await run(env, 'price default in=1 out=3');
  assert.ok(back.ok, back.output);
  assert.match((await run(env, 'billing check')).output, /宽松计费/);
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
