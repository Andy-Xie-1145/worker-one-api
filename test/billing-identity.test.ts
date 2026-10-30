/**
 * 严格计费与计费身份（lib/pricing/llm.ts 的 resolveBillableModel + relay 的预扣重构）。
 *
 * 钉死的行为：
 *   - 计费身份的解析顺序（请求名 → 上游名 → 兜底价判定），via/billingModel 语义；
 *   - 严格计费（DefaultPrice = null）：查不到价的渠道被跳过——0 上游调用、0 预扣，
 *     全部渠道跳过时最终响应如实回 503 model_price_not_configured；
 *   - 宽松计费（设了兜底价）：同一请求照常出账；
 *   - Anthropic usage 的缓存三拆（读 / 写 5m / 写 1h）与归一化。
 *
 * Run: npm run test:billing-identity
 */
import assert from 'node:assert/strict';
import worker from '../src/index';
import { resolveBillableModel, sameBillingIdentity, strictBillingEnabled, DEFAULT_PRICE } from '../src/lib/pricing/llm';
import { anthropicAdaptor } from '../src/relay/anthropic';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/* ------------------------------------------------------- 身份解析（纯逻辑） */

const opts = (over: Record<string, unknown>) => over as never;

test('请求名直接命中 → via=requested；别名剥前缀也算 requested', () => {
  const id = resolveBillableModel('gpt-4o', 'gpt-4o-unknown-upstream');
  assert.ok(id);
  assert.equal(id.via, 'requested');
  assert.equal(id.source, 'builtin');
  const alias = resolveBillableModel('openai/gpt-4o', 'gpt-4o');
  assert.ok(alias);
  assert.equal(alias.via, 'requested');
});

test('请求名查不到、映射后的上游名查得到 → via=upstream', () => {
  const id = resolveBillableModel('gemini-flash-lite-latest', 'gemini-3.1-flash-lite');
  assert.ok(id);
  assert.equal(id.via, 'upstream');
  assert.equal(id.billingModel, 'gemini-3.1-flash-lite');
  assert.equal(id.source, 'builtin');
});

test('严格计费：查不到价 → null；宽松：兜底价身份', () => {
  assert.equal(resolveBillableModel('mystery', 'mystery'), null, 'DefaultPrice 未设 → fail-closed');
  assert.equal(strictBillingEnabled({} as never), true);
  const loose = resolveBillableModel('mystery', 'mystery', opts({ DefaultPrice: { in: 2, out: 4 } }));
  assert.ok(loose);
  assert.equal(loose.source, 'default');
  assert.equal(loose.spec.in, 2);
  assert.equal(strictBillingEnabled(opts({ DefaultPrice: null })), true, '显式 null = 严格');
  assert.equal(strictBillingEnabled(opts({ DefaultPrice: DEFAULT_PRICE })), false);
  // 完全没有 options 对象 = 没有兜底价 = 严格（生产里 getOptions 总会合并出默认兜底价，所以线上默认宽松）
  assert.equal(strictBillingEnabled(undefined), true);
});

test('sameBillingIdentity：名字/来源/via/spec 任一不同都不等', () => {
  const a = resolveBillableModel('gpt-4o', 'gpt-4o')!;
  const b = resolveBillableModel('gpt-4o', 'gpt-4o')!;
  assert.ok(sameBillingIdentity(a, b));
  const mapped = resolveBillableModel('alias-x', 'gpt-4o')!;
  assert.ok(!sameBillingIdentity(a, mapped), 'via 不同');
  const priced = resolveBillableModel('gpt-4o', 'gpt-4o', opts({ ModelPriceOverride: { 'gpt-4o': { in: 9, out: 9 } } }))!;
  assert.ok(!sameBillingIdentity(a, priced), 'spec 不同');
});

/* ------------------------------------------------------- relay 集成 */

const KEY = 'sk-' + 'a'.repeat(48);
const ADMIN = 'admin-key-123';

interface World {
  user: any;
  token: any;
  abilities: any[];
  channels: any[];
  optionRows: Array<{ key: string; value: string }>;
  credits: Array<{ delta: number; reason: string; ref: string }>;
  logs: any[][];
  events: any[][];
  kv: Map<string, string>;
}

function makeWorld(over: Partial<World> = {}): World {
  return {
    user: { id: 1, username: 'u', group: 'default', status: 1, quota: 1_000_000, used_quota: 0, request_count: 0, email: '', plan_slug: '' },
    token: { id: 9, key: 'a'.repeat(48), user_id: 1, name: 't', status: 1, models: '', unlimited_quota: 0, remain_quota: 1_000_000, used_quota: 0, expired_time: -1 },
    abilities: [
      { group: 'default', model: 'gpt-a', channel_id: 6, enabled: 1, priority: 10, weight: 1 },
      { group: 'default', model: 'mystery', channel_id: 6, enabled: 1, priority: 10, weight: 1 },
    ],
    channels: [
      {
        id: 6, type: 'openai', key: 'key-a', status: 1, name: 'channel-a', weight: 1, priority: 10,
        base_url: 'https://a.test/api', models: 'gpt-a,mystery', group: 'default', model_mapping: '', config: '', system_prompt: '',
      },
    ],
    optionRows: [],
    credits: [],
    logs: [],
    events: [],
    kv: new Map(),
    ...over,
  };
}

function makeDB(w: World) {
  const route = (sql: string, binds: any[]): any => {
    const one = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT \* FROM tokens WHERE key/.test(one)) return w.token.key === binds[0] ? w.token : null;
    if (/^SELECT \* FROM users WHERE username/.test(one)) return w.user;
    if (/^SELECT \* FROM users WHERE id/.test(one)) return w.user.id === binds[0] ? w.user : null;
    if (/^SELECT key, value FROM options/.test(one)) return { results: w.optionRows };
    if (/^SELECT 1 AS hit FROM credits WHERE ref/.test(one)) return w.credits.some((c) => c.ref === binds[0]) ? { hit: 1 } : null;
    if (/^SELECT quota FROM users WHERE id/.test(one)) return { quota: w.user.quota };
    if (/^UPDATE users SET quota = quota \+ \?/.test(one)) {
      const [delta, id] = binds;
      if (w.user.id !== id) return null;
      w.user.quota += delta;
      return { quota: w.user.quota };
    }
    if (/^INSERT INTO credits/.test(one)) {
      if (binds[3] && w.credits.some((c) => c.ref === binds[3])) throw new Error('UNIQUE constraint failed: credits.ref');
      w.credits.push({ delta: binds[1], reason: binds[2], ref: binds[3] });
      if (/RETURNING id/.test(one)) return { results: [{ id: 1 }] };
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

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(Promise.resolve(p)), passThroughOnException: () => {} } as never;
const drain = async () => {
  while (pending.length) await pending.shift();
};

async function call(w: World, model: string, responses: Array<{ status: number; body: any }>) {
  const env = { DB: makeDB(w), CACHE: w.kv, ASSETS: { fetch: async () => new Response('spa') }, ADMIN_KEY: ADMIN } as never;
  const calls: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), key: (init?.headers as any)?.Authorization ?? (init?.headers as any)?.['x-api-key'] ?? (init?.headers as any)?.['api-key'] });
    const next = responses.shift() ?? { status: 500, body: { error: { message: '脚本用完了' } } };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  try {
    const res = await worker.fetch(
      new Request('https://oneapi.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
      }),
      env,
      ctx,
    );
    await drain();
    return { res, calls, body: await res.json() as any };
  } finally {
    globalThis.fetch = original;
  }
}

test('严格计费：未定价模型 0 上游调用、0 预扣，最终 503 model_price_not_configured', async () => {
  const w = makeWorld({ optionRows: [{ key: 'DefaultPrice', value: 'null' }] });
  const { res, calls, body } = await call(w, 'mystery', []);
  assert.equal(res.status, 503);
  assert.equal(body.error?.code, 'model_price_not_configured');
  assert.equal(calls.length, 0, '一个上游请求都不发');
  assert.equal(w.credits.length, 0, '一分钱都不预扣');
  // 健康事件里有 pricing 阶段的记录，能看见是哪个模型没配价
  const pricingEvent = w.events.find((e) => JSON.stringify(e).includes('pricing'));
  assert.ok(pricingEvent, 'relay_events 里有 pricing 阶段');
});

test('宽松计费：同一请求按兜底价正常出账', async () => {
  const w = makeWorld();
  const { res, calls, body } = await call(w, 'mystery', [{ status: 200, body: { id: 'c1', object: 'chat.completion', model: 'mystery', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } }]);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(w.credits.some((c) => c.reason === 'consume' && c.ref.startsWith('pre:')), true, '有预扣');
  assert.equal(w.credits.some((c) => c.ref.startsWith('fin:')), true, '有结算找平');
  // 兜底价 $1/$3：10 fresh × $1 + 5 out × $3 = $0.000025 → ceil = 13 quota
  assert.equal(body.usage?.prompt_tokens, 10);
});

test('定价模型照常：预扣 → 上游 → 结算，费率钉住不再重查', async () => {
  const w = makeWorld();
  const { res } = await call(w, 'gpt-a', [{ status: 200, body: { id: 'c2', object: 'chat.completion', model: 'gpt-a', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } } }]);
  assert.equal(res.status, 200);
  const pre = w.credits.find((c) => c.ref.startsWith('pre:'));
  const fin = w.credits.find((c) => c.ref.startsWith('fin:'));
  assert.ok(pre && fin, '一对 pre/fin ref');
  // gpt-a 没在价格表 → 兜底 $1/$3：1000×$1 + 100×$3 = $0.0013 → 650 quota
  assert.equal(pre.delta + fin.delta, -650, '净扣 650 quota');
});

/* ------------------------------------------------------- Anthropic 缓存三拆 */

test('anthropic usage：读/写5m/写1h 三拆并归一化进 prompt_tokens', () => {
  const { usage } = anthropicAdaptor.convertResponse(
    {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 100, output_tokens: 20,
        cache_read_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 50 },
      },
      stop_reason: 'end_turn',
    },
    { requestedModel: 'claude-x', upstreamModel: 'claude-x' } as never,
  );
  assert.equal(usage.prompt_tokens, 100 + 500 + 200 + 50, 'prompt = input + 读 + 写5m + 写1h');
  assert.equal(usage.cached_tokens, 500);
  assert.equal(usage.cache_write_5m_tokens, 200);
  assert.equal(usage.cache_write_1h_tokens, 50);
});

test('anthropic usage：上游只报写缓存总数时整体归入 5m 桶', () => {
  const { usage } = anthropicAdaptor.convertResponse(
    {
      id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 300 },
      stop_reason: 'end_turn',
    },
    { requestedModel: 'claude-x', upstreamModel: 'claude-x' } as never,
  );
  assert.equal(usage.prompt_tokens, 10 + 300);
  assert.equal(usage.cache_write_5m_tokens, 300);
  assert.equal(usage.cache_write_1h_tokens ?? 0, 0);
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
console.log(`\nbilling-identity: ${tests.length} passed`);
