/**
 * 上游缺 finish_reason 时由网关补发终止 chunk（HPD sol/terra，2026-11-15 实测）。
 *
 * 复现形态：SSE 里有 tool_calls 增量、有 [DONE]，但整条流 `finish_reason` 恒为 null；
 * 同一个请求改非流式则正常返回 `finish_reason: "tool_calls"`。
 * 客户端靠 finish_reason（Anthropic/Gemini 客户端靠 stop_reason / finishReason）判断
 * "为什么结束"，缺了就等于流没有结束标记。
 *
 * 钉死：流收尾前若全程未见 finish_reason，网关补一个标准终止 chunk——
 *   有工具调用 → tool_calls；撞 max_tokens → length；否则 stop；
 * 且上游本来给了 finish_reason 时**不得**重复补发。
 *
 * Run: npm run test:stream-finish-reason
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
    get: async (k: string, type?: string) => (map.has(k) ? (type === 'json' ? JSON.parse(map.get(k)!) : map.get(k)!) : null),
    put: async (k: string, v: unknown) => { map.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k: string) => { map.delete(k); },
  };
}
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
      try { const out = stmts.map((s) => ({ results: s._exec(), success: true, meta: {} })); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

const MODEL = 'm-a';
function setup(channelType = 'openai') {
  const db = freshDB();
  db.exec(`INSERT INTO users (id, username, password, display_name, role, status, quota, used_quota, request_count, created_time) VALUES (1, 'owner', '', 'Owner', 100, 1, 10000000, 0, 0, 0)`);
  db.exec(`INSERT INTO channels (id, type, key, status, name, weight, priority, base_url, models) VALUES (1, '${channelType}', 'k', 1, 'A', 1, 10, 'https://a.test', '${MODEL}')`);
  db.exec(`INSERT INTO abilities (model, channel_id, enabled, priority, weight) VALUES ('${MODEL}', 1, 1, 10, 1)`);
  db.prepare(`INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, used_quota, models) VALUES (1, ?, 1, 't', 0, 0, -1, 0, 1, 0, '')`).run('a'.repeat(48));
  return {
    db,
    env: { DB: asD1(db), CACHE: kvMock(), ASSETS: { fetch: async () => new Response('spa') }, ADMIN_KEY: 'x' } as never,
  };
}

/** 上游 SSE：tool_calls 增量 + usage 尾块 + [DONE]，全程 finish_reason=null（HPD 形态）。 */
function sseWithNullFinish(opts: { withToolCall?: boolean; withFinish?: string } = {}): string {
  const { withToolCall = true, withFinish } = opts;
  const lines = [
    `data: {"id":"c1","object":"chat.completion.chunk","model":"up","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
  ];
  if (withToolCall) {
    lines.push(`data: {"id":"c1","object":"chat.completion.chunk","model":"up","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Beijing\\"}"}}]},"finish_reason":null}]}`);
  } else {
    lines.push(`data: {"id":"c1","object":"chat.completion.chunk","model":"up","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}`);
  }
  if (withFinish) {
    lines.push(`data: {"id":"c1","object":"chat.completion.chunk","model":"up","choices":[{"index":0,"delta":{},"finish_reason":"${withFinish}"}]}`);
  }
  lines.push(`data: {"id":"c1","object":"chat.completion.chunk","model":"up","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":8,"total_tokens":28}}`);
  lines.push('data: [DONE]');
  return lines.join('\n\n') + '\n\n';
}

function mockUpstreamSSE(raw: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const bytes = new TextEncoder().encode(raw);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        // 分两半投喂，顺带验证跨块重组
        c.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
        c.enqueue(bytes.slice(Math.floor(bytes.length / 2)));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as any;
  return { restore: () => (globalThis.fetch = original) };
}

async function call(env: never, path: string, body: unknown) {
  return worker.fetch(
    new Request('https://oneapi.test' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'a'.repeat(48) },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
}

const sseEvents = (raw: string): any[] =>
  raw
    .split('\n\n')
    .map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
    .filter(Boolean)
    .map((l) => l!.slice(6))
    .filter((d) => d !== '[DONE]')
    .map((d) => { try { return JSON.parse(d); } catch { return null; } })
    .filter(Boolean);

test('OpenAI 流：上游 finish_reason 恒 null 时，网关补 tool_calls 终止 chunk（在 [DONE] 之前）', async () => {
  const { env } = setup();
  const mock = mockUpstreamSSE(sseWithNullFinish());
  try {
    const res = await call(env, '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(raw.includes('data: [DONE]'), '客户端必须收到 [DONE]');
    const evs = sseEvents(raw);
    const finishes = evs.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean);
    assert.deepEqual(finishes, ['tool_calls'], `应恰好补一个 tool_calls，实际 ${JSON.stringify(finishes)}`);
    const idxFinish = raw.indexOf('"finish_reason":"tool_calls"');
    const idxDone = raw.indexOf('data: [DONE]');
    assert.ok(idxFinish >= 0 && idxFinish < idxDone, '终止 chunk 必须在 [DONE] 之前');
  } finally { mock.restore(); }
});

test('Anthropic 流：同一个上游（无 finish_reason）→ message_delta.stop_reason = tool_use', async () => {
  const { env } = setup();
  const mock = mockUpstreamSSE(sseWithNullFinish());
  try {
    const res = await call(env, '/v1/messages', { model: MODEL, max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const raw = await res.text();
    const delta = raw.split('\n\n').find((b) => b.includes('event: message_delta'));
    assert.ok(delta, '必须发出 message_delta（Anthropic 的结束标记载体）');
    assert.match(delta!, /"stop_reason":"tool_use"/, `stop_reason 应为 tool_use，实际 ${delta}`);
  } finally { mock.restore(); }
});

test('纯文本流（无工具调用）→ 补 stop', async () => {
  const { env } = setup();
  const mock = mockUpstreamSSE(sseWithNullFinish({ withToolCall: false }));
  try {
    const res = await call(env, '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true });
    const evs = sseEvents(await res.text());
    const finishes = evs.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean);
    assert.deepEqual(finishes, ['stop']);
  } finally { mock.restore(); }
});

test('上游已给 finish_reason → 不重复补发', async () => {
  const { env } = setup();
  const mock = mockUpstreamSSE(sseWithNullFinish({ withFinish: 'stop' }));
  try {
    const res = await call(env, '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true });
    const evs = sseEvents(await res.text());
    const finishes = evs.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean);
    assert.deepEqual(finishes, ['stop'], '上游给过就不能再补，避免重复终止');
  } finally { mock.restore(); }
});

test('openai-responses 渠道：Responses 事件流同样要补（HPD GPT 的真实形态）', async () => {
  // 上游发的是 Responses 事件（response.created / output_item.added / arguments.delta /
  // response.completed），adaptor 翻成 chat chunk 后全程没有 finish_reason。
  // 曾经的 bug：合成 chunk 被回灌 adaptor.convertStreamEvent，Responses adaptor 按
  // `type` 分派认不出 chat chunk → chunks: [] → 静默丢弃，线上永远补不出来。
  const { env } = setup('openai-responses');
  const ev = (type: string, payload: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(payload as object) })}\n\n`;
  const raw =
    ev('response.created', { response: { id: 'resp_1', created_at: 1794729000 } }) +
    ev('response.output_item.added', { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } }) +
    ev('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"city":"Beijing"}' }) +
    ev('response.completed', { response: { usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } } });
  const mock = mockUpstreamSSE(raw);
  try {
    const res = await call(env, '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(res.status, 200);
    const text = await res.text();
    const finishes = sseEvents(text).map((e) => e.choices?.[0]?.finish_reason).filter(Boolean);
    assert.deepEqual(finishes, ['tool_calls'], `Responses 渠道也必须补 tool_calls，实际 ${JSON.stringify(finishes)}`);
    assert.ok(text.indexOf('"finish_reason":"tool_calls"') < text.indexOf('data: [DONE]'), '终止 chunk 在 [DONE] 之前');
  } finally { mock.restore(); }
});

/* ---------------------------------------------------------------- runner */
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (error) { failed++; console.error(`  FAIL ${name}`); console.error(error); }
  }
  if (failed > 0) { console.error(`\n${failed}/${tests.length} failed`); process.exit(1); }
  console.log(`\n${tests.length} passed`);
  process.exit(0);
})();
