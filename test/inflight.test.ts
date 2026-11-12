/**
 * 活跃请求登记（lib/inflight.ts，migration 0021）。
 *
 * 用一个只认识本模块那几条 SQL 的微型 D1 桩，断言：
 *   1. register → list 能看到行（含全部字段）；
 *   2. update 只改给的列，request_id 定位；
 *   3. delete 按 request_id 删；
 *   4. list 的懒回收：started_at 超过阈值的悬挂行被删掉并报 reaped 数；
 *   5. D1 报错时全部静默（监控绝不打断中继），list 仍返回空集不抛。
 *
 * Run: npm run test:inflight
 */
import assert from 'node:assert/strict';
import {
  registerInflight, updateInflight, deleteInflight, listInflight, INFLIGHT_STALE_SEC,
} from '../src/lib/inflight';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/* ---------------------------------------------------------------- D1 桩 */

interface Row {
  request_id: string; token_id: number; token_name: string; user_id: number; username: string;
  model_name: string; protocol: string; stream: number; phase: string;
  channel_id: number | null; channel_name: string | null; started_at: number;
}

function makeD1() {
  const rows: Row[] = [];
  const exec = (sql: string, binds: unknown[] = []): { results?: unknown[]; meta?: { changes?: number } } => {
    if (/INSERT INTO inflight_requests/.test(sql)) {
      const [request_id, token_id, token_name, user_id, username, model_name, protocol, stream, started_at] = binds as never[];
      rows.push({ request_id: request_id as string, token_id: token_id as number, token_name: token_name as string, user_id: user_id as number, username: username as string, model_name: model_name as string, protocol: protocol as string, stream: stream as number, phase: 'route', channel_id: null, channel_name: null, started_at: started_at as number });
      return { results: [] };
    }
    const upd = sql.match(/UPDATE inflight_requests SET (.+) WHERE request_id = \?/);
    if (upd) {
      const row = rows.find((r) => r.request_id === binds[binds.length - 1]);
      const cols = upd[1].split(',').map((s) => s.trim());
      cols.forEach((c, i) => {
        const col = c.replace(/ = \?$/, '') as keyof Row;
        (row as any)[col] = binds[i];
      });
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (/DELETE FROM inflight_requests WHERE request_id = \?/.test(sql)) {
      const n = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].request_id === binds[0]) rows.splice(i, 1);
      return { meta: { changes: n - rows.length } };
    }
    if (/DELETE FROM inflight_requests/.test(sql)) {
      // 分层回收：流式行按 binds[0]（30min），其余行按 binds[1]（5min）。
      const [streamCut, otherCut] = binds as number[];
      const keep = rows.filter((r) => r.started_at >= (r.stream === 1 && r.phase === 'stream' ? streamCut : otherCut));
      const reaped = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { meta: { changes: reaped } };
    }
    if (/SELECT \* FROM inflight_requests ORDER BY started_at/.test(sql)) {
      return { results: [...rows].sort((a, b) => a.started_at - b.started_at) };
    }
    throw new Error('inflight 桩不认识的 SQL: ' + sql);
  };
  return {
    rows,
    DB: {
      prepare: (sql: string) => {
        const stmt = {
          run: async () => exec(sql, bound.splice(0)),
          all: async <T>() => exec(sql, bound.splice(0)) as { results?: T[] },
          first: async () => null,
          bind: (...binds: unknown[]) => {
            bound.push(...binds);
            return stmt;
          },
        };
        const bound: unknown[] = [];
        return stmt;
      },
    },
  };
}

// listInflight 用真实时钟做懒回收，用例时间戳必须贴着它造，否则行会被当成悬挂行删掉。
const NOW = Math.floor(Date.now() / 1000);
const base = {
  tokenId: 9, tokenName: 't', userId: 1, username: 'u', modelName: 'm',
  protocol: 'openai', stream: true, startedAt: NOW,
};

/* ---------------------------------------------------------------- 用例 */

test('register → list 看到完整行', async () => {
  const db = makeD1();
  await registerInflight(db as never, { requestId: 'r1', ...base });
  const { rows } = await listInflight(db as never);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].request_id, rows[0].token_name, rows[0].model_name, rows[0].protocol, rows[0].stream, rows[0].phase],
    ['r1', 't', 'm', 'openai', 1, 'route'],
  );
});

test('update 只改给定列（phase + 渠道），request_id 定位', async () => {
  const db = makeD1();
  await registerInflight(db as never, { requestId: 'r1', ...base });
  await updateInflight(db as never, 'r1', { phase: 'stream', channelId: 4, channelName: 'HPD' });
  const { rows } = await listInflight(db as never);
  assert.equal(rows[0].phase, 'stream');
  assert.equal(rows[0].channel_id, 4);
  assert.equal(rows[0].channel_name, 'HPD');
  assert.equal(rows[0].model_name, 'm'); // 其它列不动
});

test('delete 按 request_id 删除', async () => {
  const db = makeD1();
  await registerInflight(db as never, { requestId: 'r1', ...base });
  await registerInflight(db as never, { requestId: 'r2', ...base, startedAt: base.startedAt + 1 });
  await deleteInflight(db as never, 'r1');
  const { rows } = await listInflight(db as never);
  assert.deepEqual(rows.map((r) => r.request_id), ['r2']);
});

test('懒回收：流式行 30min、其余行 5min', async () => {
  const db = makeD1();
  await registerInflight(db as never, { requestId: 'stream-live', ...base, startedAt: NOW - INFLIGHT_STALE_SEC + 60 }); // 流式，尚在寿命内
  await updateInflight(db as never, 'stream-live', { phase: 'stream' }); // 真实链路里进入转发阶段
  await registerInflight(db as never, { requestId: 'stream-dead', ...base, startedAt: NOW - INFLIGHT_STALE_SEC - 5 }); // 流式，超寿
  await updateInflight(db as never, 'stream-dead', { phase: 'stream' });
  await registerInflight(db as never, { requestId: 'route-fresh', ...base, stream: false, startedAt: NOW - 60 }); // 非流式，新鲜
  await registerInflight(db as never, { requestId: 'route-dead', ...base, stream: false, startedAt: NOW - 301 }); // 非流式，超时
  await registerInflight(db as never, { requestId: 'stream-not-started', ...base, startedAt: NOW - 400 }); // stream=1 但还在 route 阶段 → 5min 档
  const { rows, reaped } = await listInflight(db as never);
  assert.deepEqual(rows.map((r) => r.request_id), ['stream-live', 'route-fresh']);
  assert.equal(reaped, 3);
});

test('D1 报错时静默：写操作不抛，list 返回空集', async () => {
  const broken = {
    DB: {
      prepare: () => { throw new Error('d1 down'); },
    },
  };
  await registerInflight(broken as never, { requestId: 'r1', ...base }); // 不得抛
  await updateInflight(broken as never, 'r1', { phase: 'stream' });
  await deleteInflight(broken as never, 'r1');
  const { rows } = await listInflight(broken as never);
  assert.deepEqual(rows, []);
});

/* ---------------------------------------------------------------- 运行 */

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`\n${tests.length} 个用例全部通过`);
