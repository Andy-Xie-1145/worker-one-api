/**
 * 403 渠道回退 + 软熔断（lib/deny403.ts）。
 *
 * 403 的含义是「这个渠道不让你（这个机房、这个模型）这么调」，不是请求坏了、
 * 也不是渠道死了。所以行为分两层：
 *   1. 本次请求：403 记入 tried，继续按优先级选下一个渠道；全试完仍失败才把
 *      最终错误（可能是 403）交给客户端；
 *   2. 后续请求：channel+model+colo 组合写 30 分钟 KV 软熔断，选路直接绕开，
 *      不再每个请求都先撞一次已知的 403；候选**全部**处于有效熔断时 0 fetch
 *      直接回 403（复用缓存的上游 message），恢复探测只发生在最早熔断自然
 *      过期之后——熔断期内绝不重复撞墙。
 *
 * 与此同时其余语义一个不动：401 照旧渠道级自动禁用，429 照旧冷却，400/404
 * 照旧立刻停止。
 *
 * 断言都落在行为结果上：HTTP 状态、上游调用顺序（靠每家渠道不同的 base_url
 * 区分）、KV 里是否存在熔断键、渠道/abilities 之后的可用性。
 *
 * Run: npm run test:403-fallback
 */
import assert from 'node:assert/strict';
import worker from '../src/index';
import { deny403Key } from '../src/lib/deny403';
import { ChannelStatusAutoDisabled } from '../src/types';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const KEY = 'sk-' + 'a'.repeat(48);
const MODEL = 'gpt-a';
const MODEL_B = 'gpt-b';

/* ---------------------------------------------------------------- 测试替身 */

interface Ability {
  group: string;
  model: string;
  channel_id: number;
  enabled: number;
  priority: number;
  weight: number;
}

interface World {
  user: any;
  token: any;
  abilities: Ability[];
  channels: any[];
  credits: Array<{ delta: number; reason: string; ref: string }>;
  logs: any[][];
  events: any[][];
  clock: { forwardMs: number };
  kv: ReturnType<typeof makeKV>;
}

/**
 * 两个渠道的世界：A（id 6，优先级 10，base_url a.test）与 B（id 7，优先级 0，
 * base_url b.test）。优先级差足够大，选路是确定的：先 A，A 不可选时才轮到 B。
 * MODEL 两个渠道都接；MODEL_B 只有 A 接（给「熔断按模型隔离」用）。
 */
function makeWorld(): World {
  const clock = { forwardMs: 0 };
  return {
    user: { id: 1, username: 'u', group: 'default', status: 1, quota: 1_000_000, used_quota: 0, request_count: 0, email: '', plan_slug: '' },
    token: { id: 9, key: 'a'.repeat(48), user_id: 1, name: 't', status: 1, models: '', unlimited_quota: 0, remain_quota: 1_000_000, used_quota: 0, expired_time: -1 },
    abilities: [
      { group: 'default', model: MODEL, channel_id: 6, enabled: 1, priority: 10, weight: 1 },
      { group: 'default', model: MODEL, channel_id: 7, enabled: 1, priority: 0, weight: 1 },
      { group: 'default', model: MODEL_B, channel_id: 6, enabled: 1, priority: 10, weight: 1 },
    ],
    channels: [
      {
        id: 6, type: 'openai', key: 'key-a', status: 1, name: 'channel-a', weight: 1, priority: 10,
        base_url: 'https://a.test/api', models: `${MODEL},${MODEL_B}`, group: 'default', model_mapping: '', config: '', system_prompt: '',
      },
      {
        id: 7, type: 'openai', key: 'key-b', status: 1, name: 'channel-b', weight: 1, priority: 0,
        base_url: 'https://b.test/api', models: MODEL, group: 'default', model_mapping: '', config: '', system_prompt: '',
      },
    ],
    credits: [],
    logs: [],
    events: [],
    clock,
    kv: null as never,
  };
}

/**
 * 带 TTL 语义的 KV 替身：按 wall clock + 可推进的偏移判断过期，让
 * 「熔断 30 分钟后自愈」不用真等 30 分钟。还能直接预置/窥视底层条目。
 */
function makeKV(clock: { forwardMs: number }) {
  const store = new Map<string, { value: string; ttl: number; putAt: number }>();
  const now = () => Date.now() + clock.forwardMs;
  const kv = {
    get: async (k: string) => {
      const entry = store.get(k);
      if (!entry) return null;
      if (now() >= entry.putAt + entry.ttl * 1000) {
        store.delete(k);
        return null;
      }
      return entry.value;
    },
    put: async (k: string, v: string, opts?: any) => store.set(k, { value: v, ttl: opts?.expirationTtl ?? 60, putAt: now() }),
    delete: async (k: string) => store.delete(k),
    /**
     * 测试直通车：塞一条原始记录。ttlSec 必须与记录的 expiresAt 对齐——
     * getDenied403 用真实时钟比对 expiresAt，KV 层 TTL 用虚拟时钟，两边要
     * 一起过期才能模拟「自然到期后重新成为候选」。
     */
    _seed: (k: string, value: unknown, ttlSec = 1800) => store.set(k, { value: JSON.stringify(value), ttl: ttlSec, putAt: now() }),
    _has: (k: string) => kv.get(k).then((v: string | null) => v !== null),
  };
  return kv;
}

/** 按 SQL 形状应答的最小 D1 替身，抄自 auto-disable.test.ts。 */
function makeDB(w: World) {
  const route = (sql: string, binds: any[]): any => {
    const one = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT \* FROM tokens WHERE key/.test(one)) return w.token.key === binds[0] ? w.token : null;
    // authenticateToken → ensureOwner 用 username 找唯一账户；mock 世界里 w.user 就是它。
    if (/^SELECT \* FROM users WHERE username/.test(one)) return w.user;
    if (/^SELECT \* FROM users WHERE id/.test(one)) return w.user.id === binds[0] ? w.user : null;
    if (/^SELECT key, value FROM options/.test(one)) return { results: [] };
    if (/^SELECT 1 AS hit FROM credits WHERE ref/.test(one)) return w.credits.some((c) => c.ref === binds[0]) ? { hit: 1 } : null;
    if (/^SELECT quota FROM users WHERE id/.test(one)) return { quota: w.user.quota };

    if (/^UPDATE users SET quota = quota \+ \?1/.test(one)) {
      const [delta, id] = binds;
      if (w.user.id !== id) return null;
      w.user.quota += delta;
      return { quota: w.user.quota };
    }
    if (/^INSERT INTO credits/.test(one)) {
      if (binds[3] && w.credits.some((c) => c.ref === binds[3])) throw new Error('UNIQUE constraint failed: credits.ref');
      w.credits.push({ delta: binds[1], reason: binds[2], ref: binds[3] });
      return {};
    }

    if (/^SELECT DISTINCT model FROM abilities/.test(one)) {
      const models = [...new Set(w.abilities.filter((a) => a.enabled === 1).map((a) => a.model))].sort();
      return { results: models.map((model) => ({ model })) };
    }
    if (/FROM abilities WHERE model = \? AND enabled = 1/.test(one)) {
      return { results: w.abilities.filter((a) => a.model === binds[0] && a.enabled === 1) };
    }
    if (/^SELECT \* FROM channels WHERE id = \?/.test(one)) {
      return w.channels.find((ch) => ch.id === binds[0] && ch.status === binds[1]) ?? null;
    }

    if (/^UPDATE channels SET status = \? WHERE id = \? AND status = 1$/.test(one)) {
      const ch = w.channels.find((c) => c.id === binds[1] && c.status === 1);
      if (ch) ch.status = binds[0];
      return { meta: { changes: ch ? 1 : 0 } };
    }
    if (/^UPDATE abilities SET enabled = 0 WHERE channel_id = \?$/.test(one)) {
      for (const a of w.abilities) if (a.channel_id === binds[0]) a.enabled = 0;
      return { meta: { changes: w.abilities.filter((a) => a.channel_id === binds[0]).length } };
    }

    if (/^INSERT INTO logs/.test(one)) {
      w.logs.push(binds);
      return {};
    }
    if (/^INSERT INTO relay_events/.test(one)) {
      w.events.push(binds);
      return {};
    }
    if (/^UPDATE /.test(one)) return { meta: { changes: 1 } };
    throw new Error(`未预期的 SQL: ${one}`);
  };

  const stmt = (sql: string, binds: any[] = []) => ({
    bind: (...b: any[]) => stmt(sql, b),
    first: async () => route(sql, binds),
    all: async () => {
      const r = route(sql, binds);
      return r && 'results' in r ? r : { results: [] };
    },
    run: async () => route(sql, binds) ?? { meta: { changes: 0 } },
  });

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: any[]) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

/** 一次上游应答的脚本。应答按上游调用顺序消耗，与渠道顺序一一对应。 */
function scriptFetch(responses: Array<{ status: number; body: any }>) {
  const calls: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push(String(url));
    const next = responses.shift() ?? { status: 500, body: { error: { message: '脚本用完了' } } };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(Promise.resolve(p)), passThroughOnException: () => {} } as never;
const drain = async () => {
  while (pending.length) await pending.shift();
};

const chatBody = (model: string) => ({ model, messages: [{ role: 'user', content: 'hi' }] });
const ok = (model: string) => ({
  id: 'cmpl_1', object: 'chat.completion', model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const err = (message: string) => ({ error: { message } });

interface CallOpts {
  model?: string;
  colo?: string;
}

async function call(w: World, responses: Array<{ status: number; body: any }>, opts: CallOpts = {}) {
  if (!w.kv) w.kv = makeKV(w.clock);
  const env = { DB: makeDB(w), CACHE: w.kv, ASSETS: { fetch: async () => new Response('spa') } } as never;
  const script = scriptFetch(responses);
  let res: Response;
  try {
    const req = new Request('https://oneapi.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(chatBody(opts.model ?? MODEL)),
    });
    // Workers 的 cf 是平台注入的；测试里手动挂上去，好制造「换个机房」的请求。
    if (opts.colo) (req as any).cf = { colo: opts.colo };
    res = await worker.fetch(req, env, ctx);
    await drain();
  } finally {
    script.restore();
  }
  return { res, calls: script.calls.map((u) => new URL(u).host) };
}

const net = (w: World) => w.credits.reduce((sum, c) => sum + c.delta, 0);

/* ------------------------------------------------------------ 回退主链 */

test('A 403 + B 200：先试 A，被拒后换到 B，最终 200', async () => {
  const w = makeWorld();
  const { res, calls } = await call(w, [
    { status: 403, body: err('region restricted') },
    { status: 200, body: ok(MODEL) },
  ]);
  assert.equal(res.status, 200, '低优先级渠道顶上后，客户端应拿到成功');
  assert.deepEqual(calls, ['a.test', 'b.test'], '必须先试高优先级的 A，403 后才轮到 B');
  assert.equal(res.headers.get('X-OneAPI-Channel'), '7', '成功的应答由渠道 B 提供');
});

test('单渠道 403：没有下一个渠道，最终把 403 交给客户端', async () => {
  const w = makeWorld();
  w.abilities = w.abilities.filter((a) => a.channel_id === 6);
  w.channels = w.channels.filter((c) => c.id === 6);
  const { res, calls } = await call(w, [{ status: 403, body: err('not allowed') }]);
  assert.equal(res.status, 403, '全部渠道都 403 时，客户端应收到 403 自行提示');
  assert.deepEqual(calls, ['a.test']);
  assert.equal(net(w), 0, '失败的请求要全额退款');
});

test('A 403 + B 403：两个渠道都试过，最终 403', async () => {
  const w = makeWorld();
  const { res, calls } = await call(w, [
    { status: 403, body: err('a says no') },
    { status: 403, body: err('b says no') },
  ]);
  assert.equal(res.status, 403, '所有可用渠道都拒绝后，最终错误就是 403');
  assert.deepEqual(calls, ['a.test', 'b.test'], '两个渠道都要被尝试，而不是在 A 就停下');
  assert.equal(net(w), 0, '失败的请求要全额退款');
});

/* ------------------------------------------------------------- 软熔断 */

test('同一 colo+model 的下一个请求直接绕过 A，不再打 A', async () => {
  const w = makeWorld();
  const first = await call(w, [
    { status: 403, body: err('region restricted') },
    { status: 200, body: ok(MODEL) },
  ]);
  assert.equal(first.res.status, 200);
  assert.ok(await w.kv._has(deny403Key(6, MODEL, 'UNKNOWN')), 'A 的 403 应已写入软熔断（无 cf 时落到 UNKNOWN）');

  const second = await call(w, [{ status: 200, body: ok(MODEL) }]);
  assert.equal(second.res.status, 200);
  assert.deepEqual(second.calls, ['b.test'], '熔断期内选路应直接落在 B，不再先撞 A 的 403');
});

test('换 model 后 A 仍可被尝试：熔断按模型隔离', async () => {
  const w = makeWorld();
  const first = await call(w, [
    { status: 403, body: err('no gpt-a for you') },
    { status: 200, body: ok(MODEL) },
  ]);
  assert.equal(first.res.status, 200);

  // MODEL_B 只有渠道 A 能接：如果熔断误伤了整个渠道，这里就是 no_channel/503。
  const second = await call(w, [{ status: 200, body: ok(MODEL_B) }], { model: MODEL_B });
  assert.equal(second.res.status, 200);
  assert.deepEqual(second.calls, ['a.test'], 'A 只对 gpt-a 熔断，gpt-b 照常走 A');
});

test('换 colo 后 A 仍可被尝试：熔断按机房隔离', async () => {
  const w = makeWorld();
  const first = await call(w, [
    { status: 403, body: err('sjc says no') },
    { status: 200, body: ok(MODEL) },
  ], { colo: 'SJC' });
  assert.equal(first.res.status, 200);
  assert.ok(await w.kv._has(deny403Key(6, MODEL, 'SJC')));

  const second = await call(w, [{ status: 200, body: ok(MODEL) }], { colo: 'HKG' });
  assert.equal(second.res.status, 200);
  assert.deepEqual(second.calls, ['a.test'], 'SJC 的熔断不该牵连 HKG 的请求，A 照常首发');
});

test('熔断过期后 A 重新入选（KV TTL 兜底自愈）', async () => {
  const w = makeWorld();
  const first = await call(w, [
    { status: 403, body: err('region restricted') },
    { status: 200, body: ok(MODEL) },
  ]);
  assert.equal(first.res.status, 200);

  w.clock.forwardMs = 31 * 60 * 1000; // 熔断默认 30 分钟，拨到过期之后
  const second = await call(w, [{ status: 200, body: ok(MODEL) }]);
  assert.equal(second.res.status, 200);
  assert.deepEqual(second.calls, ['a.test'], '熔断过期后 A 应重新成为首选');
});

test('单渠道 403 后：熔断期内第二个请求 0 fetch 直接 403，且保留可识别的 message', async () => {
  const w = makeWorld();
  w.abilities = w.abilities.filter((a) => a.channel_id === 6);
  w.channels = w.channels.filter((c) => c.id === 6);
  const TOS = 'User violated OpenRouter ToS: prohibited usage pattern detected';
  const first = await call(w, [{ status: 403, body: err(TOS) }]);
  assert.equal(first.res.status, 403);

  // 熔断期内再来一个：一个上游请求都不许发（responses 为空，任何 fetch 都会露馅）。
  const second = await call(w, []);
  assert.equal(second.res.status, 403, '全渠道熔断时直接回 403，不是 503/no_channel');
  assert.equal(second.calls.length, 0, '熔断期内不得重复撞上游');
  const body = await second.res.json();
  assert.equal(body.error.message, TOS, '缓存的 403 应原样带回上次上游的可识别文案');
  assert.equal(net(w), 0, '直接 403 的请求要全额退款');
});

test('两个渠道都 403 后：下一次熔断期内同样 0 fetch 直接 403', async () => {
  const w = makeWorld();
  const first = await call(w, [
    { status: 403, body: err('msg-a') },
    { status: 403, body: err('msg-b') },
  ]);
  assert.equal(first.res.status, 403);

  const second = await call(w, []);
  assert.equal(second.res.status, 403);
  assert.equal(second.calls.length, 0, 'A、B 都在熔断中时不得再打任何上游');
  const body = await second.res.json();
  assert.ok(['msg-a', 'msg-b'].includes(body.error.message), '403 message 应复用缓存的上游文案');
});

test('候选全部熔断：0 fetch 直接 403；拨钟到最早到期后才产生一次探测', async () => {
  const w = makeWorld();
  const now = Date.now();
  // 手工预置：A 的熔断 61 秒后到期（KV TTL 同步 61s），B 的还有 30 分钟。
  w.kv = makeKV(w.clock);
  w.kv._seed(deny403Key(6, MODEL, 'SJC'), { expiresAt: now + 61_000, lastStatus: 403, message: 'a: TOS' }, 61);
  w.kv._seed(deny403Key(7, MODEL, 'SJC'), { expiresAt: now + 30 * 60_000, lastStatus: 403, message: 'b: TOS' });

  const blocked = await call(w, [], { colo: 'SJC' });
  assert.equal(blocked.res.status, 403, '全部熔断时直接 403，而不是 503 no_channel');
  assert.equal(blocked.calls.length, 0, '熔断期内一个上游请求都不发');
  const body = await blocked.res.json();
  assert.equal(body.error.message, 'a: TOS', 'message 应取最早到期（A）记录里缓存的文案');

  w.clock.forwardMs += 62_000; // A 的熔断自然过期（KV TTL 与 expiresAt 一起到点），B 还在
  const probe = await call(w, [{ status: 200, body: ok(MODEL) }], { colo: 'SJC' });
  assert.equal(probe.res.status, 200, '过期后 A 应作为恢复探测被选中');
  assert.deepEqual(probe.calls, ['a.test'], '探测应落在最早到期的 A 上');
  assert.equal(await w.kv._has(deny403Key(6, MODEL, 'SJC')), false, '探测成功即清除该组合的熔断');
  assert.equal(await w.kv._has(deny403Key(7, MODEL, 'SJC')), true, 'B 的熔断不受 A 探测成功影响');
});

test('恢复探测仍 403：重新熔断 30 分钟，之后的请求继续 0 fetch', async () => {
  const w = makeWorld();
  const now = Date.now();
  w.kv = makeKV(w.clock);
  // A 的记录已过期（KV TTL 给 -1 让替身立刻视其为过期），B 仍在熔断——
  // A 重新成为候选，被选为探测。
  w.kv._seed(deny403Key(6, MODEL, 'SJC'), { expiresAt: now - 1_000, lastStatus: 403, message: 'a: stale' }, -1);
  // B 给 29 分钟（严格早于探测失败后重新熔断的 30 分钟），「最早到期」没有平局。
  w.kv._seed(deny403Key(7, MODEL, 'SJC'), { expiresAt: now + 29 * 60_000, lastStatus: 403, message: 'b: TOS' });

  const probe = await call(w, [{ status: 403, body: err('a: still no') }], { colo: 'SJC' });
  assert.equal(probe.res.status, 403);
  assert.deepEqual(probe.calls, ['a.test'], '只探测 A 一次；B 仍在熔断，不再发请求');
  assert.ok(await w.kv._has(deny403Key(6, MODEL, 'SJC')), '探测失败的熔断要被重新写入');

  const after = await call(w, [], { colo: 'SJC' });
  assert.equal(after.res.status, 403);
  assert.equal(after.calls.length, 0, '重新熔断后继续 0 fetch');
  const body = await after.res.json();
  // A 是探测时刚重新熔断的（到期最晚），最早到期的是 B——message 按「最早到期」
  // 的既定规则取 B 缓存的文案。
  assert.equal(body.error.message, 'b: TOS', 'message 取最早到期（B）记录的缓存文案');
});

test('KV 写失败不影响正常回退（fail-open）', async () => {
  const w = makeWorld();
  const kv = makeKV(w.clock);
  // 只让 deny403 键写入失败：KV 其它用途（鉴权缓存等）的容错是各自的事，
  // 这里只证明熔断记录写不进去时中继本身不受影响。
  const goodPut = kv.put.bind(kv);
  kv.put = async (k: string, ...rest: any[]) => {
    if (String(k).startsWith('deny403:')) throw new Error('KV down');
    return goodPut(k, ...rest);
  };
  w.kv = kv;
  const { res, calls } = await call(w, [
    { status: 403, body: err('region restricted') },
    { status: 200, body: ok(MODEL) },
  ]);
  assert.equal(res.status, 200, '熔断写不进去时，请求照常 A→B 回退，网关不能挂');
  assert.deepEqual(calls, ['a.test', 'b.test']);
});

/* --------------------------------------------------------- 禁用边界 */

test('403 之后 A、B 都保持启用，abilities 不动', async () => {
  const w = makeWorld();
  await call(w, [
    { status: 403, body: err('a says no') },
    { status: 403, body: err('b says no') },
  ]);
  assert.equal(w.channels[0].status, 1, '403 不得禁用渠道 A');
  assert.equal(w.channels[1].status, 1, '403 不得禁用渠道 B');
  assert.equal(w.abilities.every((a) => a.enabled === 1), true, '403 不得下线任何 abilities');
  assert.equal(w.logs.length, 0, '不应出现「已自动禁用」的系统日志');
});

test('401 仍按渠道级自动禁用（禁用后换 B 继续），且不写 403 软熔断', async () => {
  const w = makeWorld();
  const { res, calls } = await call(w, [
    { status: 401, body: err('Invalid API key') },
    { status: 200, body: ok(MODEL) },
  ]);
  assert.equal(res.status, 200, 'A 的 key 失效应禁用 A 并由 B 顶上');
  assert.deepEqual(calls, ['a.test', 'b.test']);
  assert.equal(w.channels[0].status, ChannelStatusAutoDisabled, '401 后渠道 A 应被自动禁用');
  assert.equal(w.channels[1].status, 1, 'B 不受 A 的 401 牵连');
  assert.equal(w.abilities.filter((a) => a.channel_id === 6).every((a) => a.enabled === 0), true, 'A 的 abilities 应全部下线');
  assert.equal(await w.kv._has(deny403Key(6, MODEL, 'UNKNOWN')), false, '401 不写 403 软熔断');
});

/* ----------------------------------------------------- 其余 4xx 语义不放松 */

test('400 仍是调用方错误：在 A 就停下，且不写软熔断', async () => {
  const w = makeWorld();
  const { res, calls } = await call(w, [{ status: 400, body: err('bad request') }]);
  assert.equal(res.status, 400);
  assert.deepEqual(calls, ['a.test'], '400/404 等调用方错误不得触发渠道回退');
  assert.equal(await w.kv._has(deny403Key(6, MODEL, 'UNKNOWN')), false, '400 不得进入 403 软熔断');
});

test('A 健康时永远先走 A，不碰 B（优先级顺序不受影响）', async () => {
  const w = makeWorld();
  const { res, calls } = await call(w, [{ status: 200, body: ok(MODEL) }]);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['a.test'], '高优先级渠道可用时不应惊动低优先级渠道');
  assert.equal(res.headers.get('X-OneAPI-Channel'), '6');
});

/* ----------------------------------------- 403 与 RetryTimes 配额的关系 */

/** 在标准世界上再挂 C（id 8，优先级 2）、D（id 9，优先级 0），四级严格递减。 */
function fourChannelWorld(): World {
  const w = makeWorld();
  w.channels[1].priority = 5;
  w.abilities.find((a) => a.channel_id === 7)!.priority = 5;
  for (const [id, priority, host] of [[8, 2, 'c.test'], [9, 0, 'd.test']] as const) {
    w.channels.push({
      id, type: 'openai', key: `key-${id}`, status: 1, name: `channel-${host}`, weight: 1, priority,
      base_url: `https://${host}/api`, models: MODEL, group: 'default', model_mapping: '', config: '', system_prompt: '',
    });
    w.abilities.push({ group: 'default', model: MODEL, channel_id: id, enabled: 1, priority, weight: 1 });
  }
  return w;
}

test('403 不占 RetryTimes 配额：A/B/C 403、D 200，RetryTimes=3 也必须走到 D', async () => {
  const w = fourChannelWorld();
  const { res, calls } = await call(w, [
    { status: 403, body: err('a') },
    { status: 403, body: err('b') },
    { status: 403, body: err('c') },
    { status: 200, body: ok(MODEL) },
  ]);
  assert.equal(res.status, 200, '第 3 个 403 之后配额虽未耗尽也不能停在 C，D 必须被尝试');
  assert.deepEqual(calls, ['a.test', 'b.test', 'c.test', 'd.test'], '按优先级依次试到第 4 个渠道');
  assert.equal(res.headers.get('X-OneAPI-Channel'), '9', '成功的应答由 D 提供');
});

test('4 个渠道全 403：全部各试一次后返回 403，不因 RetryTimes=3 提前放弃', async () => {
  const w = fourChannelWorld();
  const { res, calls } = await call(w, [
    { status: 403, body: err('a') },
    { status: 403, body: err('b') },
    { status: 403, body: err('c') },
    { status: 403, body: err('d') },
  ]);
  assert.equal(res.status, 403);
  assert.deepEqual(calls, ['a.test', 'b.test', 'c.test', 'd.test'], '403 配额外，四个渠道都要试到');
  assert.equal(new Set(calls).size, calls.length, '任何渠道在一次请求中最多尝试一次');
});

test('4 个渠道全 5xx：仍只尝试前 3 个（RetryTimes 只对 403 放宽）', async () => {
  const w = fourChannelWorld();
  const { res, calls } = await call(w, [
    { status: 500, body: err('a') },
    { status: 500, body: err('b') },
    { status: 500, body: err('c') },
    { status: 500, body: err('d') },
  ]);
  assert.equal(res.status, 500);
  assert.deepEqual(calls, ['a.test', 'b.test', 'c.test'], '5xx 仍受 RetryTimes=3 限制，不因本特性放宽');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.stack ?? e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
