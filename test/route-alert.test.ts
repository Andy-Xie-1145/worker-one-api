/**
 * 路由缺口 → 企业微信告警（lib/route-alert.ts）。
 *
 * 钉住四件事：首次会发、冷却期内不重复发、发送失败不影响那条 503、没配 webhook
 * 时什么都不做也不报错。外加恢复通知只在「真的有渠道可选」时才发。
 *
 * Run: npm run test:route-alert
 */
import assert from 'node:assert/strict';
import worker from '../src/index';
import {
  alertRouteGap,
  checkRouteGapRecovery,
  describeReason,
  gapKey,
  resetRouteAlertMemo,
} from '../src/lib/route-alert';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const WEBHOOK = 'https://wecom.test/cgi-bin/webhook/send?key=test-placeholder-key';
const KEY = 'sk-' + 'a'.repeat(48);
// 聊天接口能走到选路的普通模型名（~typesafe/jev-latest 是决策专用，聊天接口会先 400）
const MODEL = 'gpt-missing';
const MODEL2 = 'gpt-also-missing';

/* ---------------------------------------------------------------- 测试替身 */

interface World {
  user: any;
  token: any;
  abilities: Array<{ model: string; channel_id: number; enabled: number }>;
  channels: Array<{ id: number; status: number }>;
  events: any[][];
  credits: Array<{ delta: number; ref: string }>;
}

function makeWorld(): World {
  return {
    user: { id: 1, username: 'u', status: 1, quota: 1_000_000, used_quota: 0, request_count: 0, email: '' },
    token: { id: 9, key: 'a'.repeat(48), user_id: 1, name: 't', status: 1, models: '', unlimited_quota: 0, remain_quota: 1_000_000, used_quota: 0, expired_time: -1 },
    abilities: [],
    channels: [],
    events: [],
    credits: [],
  };
}

function makeKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string, type?: string) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    }),
  };
}

/** 按 SQL 形状应答。不认识的 SQL 一律给空结果——这里只关心告警链路。 */
function makeDB(w: World) {
  const route = (sql: string, binds: any[]): any => {
    const one = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT \* FROM tokens WHERE key/.test(one)) return w.token.key === binds[0] ? w.token : null;
    // authenticateToken → ensureOwner 用 username 找唯一账户；mock 世界里 w.user 就是它。
    if (/^SELECT \* FROM users WHERE username/.test(one)) return w.user;
    if (/^SELECT \* FROM users WHERE id/.test(one)) return w.user.id === binds[0] ? w.user : null;
    if (/^SELECT 1 AS hit FROM credits WHERE ref/.test(one)) return w.credits.some((c) => c.ref === binds[0]) ? { hit: 1 } : null;
    if (/^SELECT quota FROM users WHERE id/.test(one)) return { quota: w.user.quota };
    if (/^UPDATE users SET quota = quota \+ \?/.test(one)) {
      w.user.quota += binds[0];
      return { quota: w.user.quota };
    }
    if (/^INSERT INTO credits/.test(one)) {
      w.credits.push({ delta: binds[1], ref: binds[3] });
      // applyCreditGated 的账本行是 INSERT ... SELECT ... RETURNING id——回行让「已插入」判定成立。
      if (/RETURNING id/.test(one)) return { results: [{ id: 1 }] };
      return {};
    }
    if (/FROM abilities WHERE model = \? AND enabled = 1/.test(one)) {
      return { results: w.abilities.filter((a) => a.model === binds[0] && a.enabled === 1) };
    }
    if (/^SELECT \* FROM channels WHERE id = \?/.test(one)) {
      return w.channels.find((ch) => ch.id === binds[0] && ch.status === binds[1]) ?? null;
    }
    if (/^INSERT INTO relay_events/.test(one)) {
      w.events.push(binds);
      return {};
    }
    if (/AS declared/.test(one)) {
      const [model, since] = binds;
      const rows = w.abilities.filter((a) => a.model === model);
      const enabled = rows.filter((a) => a.enabled === 1);
      const live = enabled.filter((a) => w.channels.some((c) => c.id === a.channel_id && c.status === 1));
      const recent = w.events.filter((e) => e[2] === 'no_channel' && e[10] === 1 && e[3] === model && e[0] >= since);
      return { declared: rows.length, enabled: enabled.length, live: live.length, recent: recent.length };
    }
    if (/^SELECT COUNT\(\*\) AS n FROM relay_events/.test(one)) {
      const [model, since] = binds;
      return { n: w.events.filter((e) => e[2] === 'no_channel' && e[3] === model && e[0] >= since).length };
    }
    return null;
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
    batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())),
  };
}

type Hook = (url: string, body: any) => Response | Promise<Response>;
/** 截获所有 fetch。企业微信的调用记下来，默认回 errcode=0。 */
function stubFetch(hook: Hook = () => Response.json({ errcode: 0, errmsg: 'ok' })) {
  const sent: Array<{ url: string; content: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init?.body ?? '{}');
    sent.push({ url: String(url), content: body?.markdown?.content ?? '' });
    return hook(String(url), body);
  }) as any;
  return { sent, restore: () => (globalThis.fetch = original) };
}

/** console.error 也截下来：断言日志里从没出现过 webhook。 */
function captureErrors() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: any[]) => void lines.push(args.map(String).join(' '));
  return { lines, restore: () => (console.error = original) };
}

const envOf = (w: World, kv: ReturnType<typeof makeKV>, extra: Record<string, string> = {}) =>
  ({ DB: makeDB(w), CACHE: kv, ASSETS: { fetch: async () => new Response('spa') }, ...extra }) as any;

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(Promise.resolve(p)), passThroughOnException: () => {} } as never;
const drain = async () => {
  while (pending.length) await pending.shift();
};

async function relay(env: any) {
  const res = await worker.fetch(
    new Request('https://oneapi.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
    }),
    env,
    ctx,
  );
  await drain();
  return res;
}

/* ---------------------------------------------------------------- 告警 */

test('首次路由缺口：503 照常返回，并发出一条带模型/原因的告警', async () => {
  resetRouteAlertMemo();
  const w = makeWorld();
  const kv = makeKV();
  const f = stubFetch();
  try {
    const res = await relay(envOf(w, kv, { WECOM_HEALTH_WEBHOOK_URL: WEBHOOK }));
    assert.equal(res.status, 503);
    assert.equal(f.sent.length, 1, '首次必须发');
    const msg = f.sent[0].content;
    assert.match(msg, /One API 健康告警/);
    assert.ok(msg.includes(MODEL));
    assert.match(msg, /HTTP 503/);
    assert.match(msg, /declared=0/);
    assert.match(msg, /近 1 小时：1 次/, '事件先落库再告警，次数含本次');
    assert.ok(kv.store.has(gapKey(MODEL)), '写下 active 标记，供冷却与恢复使用');
  } finally {
    f.restore();
  }
});

test('冷却期内：同一 model 不重复发，换 isolate（清内存）也不发', async () => {
  resetRouteAlertMemo();
  const w = makeWorld();
  const kv = makeKV();
  const f = stubFetch();
  try {
    const env = envOf(w, kv, { WECOM_HEALTH_WEBHOOK_URL: WEBHOOK });
    for (let i = 0; i < 5; i++) assert.equal((await relay(env)).status, 503);
    assert.equal(f.sent.length, 1, '5 次 503 只发 1 条');

    resetRouteAlertMemo(); // 另一个 isolate：只剩 KV 可依据
    assert.equal(await alertRouteGap(env, { model: MODEL }), 'cooldown');
    assert.equal(f.sent.length, 1);

    // 另一个模型是另一件事，照发
    assert.equal(await alertRouteGap(env, { model: MODEL2 }), 'sent');
    assert.equal(f.sent.length, 2);
  } finally {
    f.restore();
  }
});

test('冷却过后再发一条，标注「持续中」；冷却可配置', async () => {
  resetRouteAlertMemo();
  const w = makeWorld();
  const kv = makeKV();
  const f = stubFetch();
  try {
    const env = envOf(w, kv, { WECOM_HEALTH_WEBHOOK_URL: WEBHOOK, WECOM_HEALTH_ALERT_COOLDOWN_MIN: '10' });
    const t0 = Date.now();
    assert.equal(await alertRouteGap(env, { model: MODEL }, t0), 'sent');
    assert.equal(await alertRouteGap(env, { model: MODEL }, t0 + 9 * 60_000), 'cooldown');
    assert.equal(await alertRouteGap(env, { model: MODEL }, t0 + 11 * 60_000), 'sent');
    assert.match(f.sent[1].content, /持续中/);
  } finally {
    f.restore();
  }
});

test('企业微信发送失败（HTTP 500 / errcode / 抛异常）：503 不受影响，日志里没有 webhook', async () => {
  const hooks: Hook[] = [
    () => new Response('boom', { status: 500 }),
    () => Response.json({ errcode: 93000, errmsg: 'invalid webhook url' }),
    (url) => {
      throw new TypeError(`fetch failed: ${url}`);
    },
  ];
  for (const hook of hooks) {
    resetRouteAlertMemo();
    const w = makeWorld();
    const kv = makeKV();
    const f = stubFetch(hook);
    const errs = captureErrors();
    try {
      const res = await relay(envOf(w, kv, { WECOM_HEALTH_WEBHOOK_URL: WEBHOOK }));
      assert.equal(res.status, 503, '告警失败绝不改变主流程');
      const body = (await res.json()) as any;
      assert.match(body.error.message, /没有可用于模型/);
      assert.equal(w.credits.reduce((s, c) => s + c.delta, 0), 0, '预扣照常退回');
      assert.equal(f.sent.length, 1);
      assert.ok(errs.lines.length > 0, '失败要留日志');
      assert.ok(errs.lines.every((l) => !l.includes('test-placeholder-key') && !l.includes(WEBHOOK)), '日志不得含 webhook');
    } finally {
      errs.restore();
      f.restore();
    }
  }
});

test('发送失败后 1 分钟可重试，而不是被整段冷却吞掉', async () => {
  resetRouteAlertMemo();
  const w = makeWorld();
  const kv = makeKV();
  let fail = true;
  const f = stubFetch(() => (fail ? new Response('x', { status: 502 }) : Response.json({ errcode: 0 })));
  const errs = captureErrors();
  try {
    const env = envOf(w, kv, { WECOM_HEALTH_WEBHOOK_URL: WEBHOOK });
    const t0 = Date.now();
    assert.equal(await alertRouteGap(env, { model: MODEL }, t0), 'failed');
    assert.equal(await alertRouteGap(env, { model: MODEL }, t0 + 30_000), 'cooldown');
    fail = false;
    assert.equal(await alertRouteGap(env, { model: MODEL }, t0 + 61_000), 'sent');
  } finally {
    errs.restore();
    f.restore();
  }
});

test('未配置 webhook：503 照常，不发请求、不写 KV、不报错', async () => {
  resetRouteAlertMemo();
  const w = makeWorld();
  const kv = makeKV();
  const f = stubFetch();
  const errs = captureErrors();
  try {
    const env = envOf(w, kv);
    assert.equal((await relay(env)).status, 503);
    assert.equal(f.sent.length, 0);
    assert.ok(![...kv.store.keys()].some((k) => k.startsWith('alert:')), '不写告警标记');
    assert.equal(errs.lines.length, 0);
    assert.equal(await checkRouteGapRecovery(env), 0);
  } finally {
    errs.restore();
    f.restore();
  }
});

test('KV 故障：告警流程吞掉异常，503 照常', async () => {
  resetRouteAlertMemo();
  const w = makeWorld();
  const kv = makeKV();
  const get = kv.get;
  kv.get = async (k: string, type?: string) => {
    if (k.startsWith('alert:')) throw new Error('KV down');
    return get(k, type);
  };
  const f = stubFetch();
  const errs = captureErrors();
  try {
    assert.equal((await relay(envOf(w, kv, { WECOM_HEALTH_WEBHOOK_URL: WEBHOOK }))).status, 503);
  } finally {
    errs.restore();
    f.restore();
  }
});

/* ---------------------------------------------------------------- 原因 */

test('原因区分 declared=0 / 全部禁用 / 渠道本身非启用', () => {
  assert.match(describeReason({ declared: 0, enabled: 0, live: 0, recent: 3 }), /^declared=0/);
  assert.match(describeReason({ declared: 2, enabled: 0, live: 0, recent: 3 }), /declared=2 but enabled=0/);
  assert.match(describeReason({ declared: 2, enabled: 1, live: 0, recent: 3 }), /渠道本身非启用/);
  assert.match(describeReason(null), /原因未知/);
});

/* ---------------------------------------------------------------- 恢复 */

test('恢复：有可选渠道且 5 分钟内没有新缺口 → 发一条恢复并清掉标记', async () => {
  resetRouteAlertMemo();
  const w = makeWorld();
  const kv = makeKV();
  const f = stubFetch();
  try {
    const env = envOf(w, kv, { WECOM_HEALTH_WEBHOOK_URL: WEBHOOK });
    const t0 = Date.now();
    assert.equal(await alertRouteGap(env, { model: MODEL }, t0), 'sent');

    // 还没修：不发恢复
    assert.equal(await checkRouteGapRecovery(env, t0 + 10 * 60_000), 0);

    // 声明了但被禁用：仍不算恢复
    w.abilities.push({ model: MODEL, channel_id: 3, enabled: 0 });
    w.channels.push({ id: 3, status: 2 });
    assert.equal(await checkRouteGapRecovery(env, t0 + 10 * 60_000), 0);

    // 修好了
    w.abilities[0].enabled = 1;
    w.channels[0].status = 1;
    assert.equal(await checkRouteGapRecovery(env, t0 + 10 * 60_000), 1);
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1].content, /One API 健康恢复/);
    assert.ok(f.sent[1].content.includes(MODEL));
    assert.ok(!kv.store.has(gapKey(MODEL)));

    // 只发一次
    assert.equal(await checkRouteGapRecovery(env, t0 + 20 * 60_000), 0);
    assert.equal(f.sent.length, 2);
  } finally {
    f.restore();
  }
});

test('恢复：最近 5 分钟内仍有 no_channel 就先不发', async () => {
  resetRouteAlertMemo();
  const w = makeWorld();
  const kv = makeKV();
  const f = stubFetch();
  try {
    const env = envOf(w, kv, { WECOM_HEALTH_WEBHOOK_URL: WEBHOOK });
    assert.equal((await relay(env)).status, 503); // 落下一条 no_channel 事件 + 告警
    w.abilities.push({ model: MODEL, channel_id: 3, enabled: 1 });
    w.channels.push({ id: 3, status: 1 });
    assert.equal(await checkRouteGapRecovery(env), 0, '刚刚还在 503，等下一轮');
    assert.equal(await checkRouteGapRecovery(env, Date.now() + 6 * 60_000), 1);
  } finally {
    f.restore();
  }
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
