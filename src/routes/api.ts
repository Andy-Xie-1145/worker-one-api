import { Hono } from 'hono';
import {
  type Env, type Vars, type TokenRow, type ChannelRow,
  ChannelStatusEnabled, TokenStatusEnabled, LogTypeManage,
} from '../types';
import { randomKey } from '../lib/crypto';
import { requireAdmin, invalidateTokenCache, ensureOwner } from '../lib/auth';
import { getOptions, setOptions, DEFAULT_OPTIONS } from '../lib/options';
import { rebuildAbilities, deleteAbilities, listModels, csv } from '../lib/channel';
import { reconcile, applyCredit } from '../lib/ledger';
import { getHeartbeat, runWatchdog } from '../lib/watchdog';
import { listCooling, deriveState, percentiles, engineOf } from '../lib/health';
import { getAdaptor, ADAPTORS, OPENAI_COMPATIBLE_PRESETS } from '../relay';
import { PRICE_TABLE, DEFAULT_PRICE, ALIAS_PREFIXES, QUOTA_PER_USD, quotaToUSD, validatePriceSpec, isExprSpec, type Price, type PriceSpec } from '../lib/pricing';
import { runCli } from '../lib/cli';
import type { AdaptorContext } from '../relay/adaptor';

const api = new Hono<{ Bindings: Env; Variables: Vars }>();

const ok = (data: unknown = null, message = '') => ({ success: true, message, data });
const fail = (message: string) => ({ success: false, message, data: null });
const now = () => Math.floor(Date.now() / 1000);

function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/**
 * 规整一个 Key 的按模型价格配置（tokens.price_config）。
 * 接受对象或 JSON 字符串；空 / `{}` 归一为 ''；逐条走 validatePriceSpec。
 */
function normalizePriceConfig(input: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, json: '' };
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { ok: true, json: '' };
    try {
      input = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: 'price_config 不是合法 JSON' };
    }
  }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'price_config 必须是对象' };
  const out: Record<string, PriceSpec> = {};
  for (const [model, spec] of Object.entries(input as Record<string, unknown>)) {
    if (spec === null || spec === undefined) continue; // null 条目 = 删除该模型
    const v = validatePriceSpec(spec);
    if (!v.ok) return { ok: false, error: `模型 ${model} 的价格配置有误：${v.error}` };
    out[model] = v.spec;
  }
  return { ok: true, json: Object.keys(out).length ? JSON.stringify(out) : '' };
}

/** DB 里的 JSON 文本 → 响应对象（null = 无覆盖）。 */
function tokenPriceOut(row: TokenRow): Record<string, PriceSpec> | null {
  if (!row.price_config) return null;
  try {
    const parsed = JSON.parse(row.price_config);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- status（免鉴权）

api.get('/status', async (c) => {
  const options = await getOptions(c.env);
  return c.json(
    ok({
      system_name: options.SystemName,
      version: '0.2.0',
      quota_per_usd: QUOTA_PER_USD,
    }),
  );
});

/**
 * 公开状态页的数据源。**无鉴权**，所以每个字段都按"会被全世界看到"来选。
 *
 * 给出去的：引擎名、状态枚举、四舍五入的成功率、延迟档位、样本数、24 小时历史。
 * 不给的：渠道 id/名称、模型 id、分组名、上游报文、用户 id——那些是排障用的，
 * 在 /api/health/* 后面，要管理员令牌。
 *
 * 只回枚举不回中文/英文文案：翻译在前端做，加语言不用动 worker，也让这个接口对
 * 第三方保持语言中立。
 */
api.get('/status/public', async (c) => {
  const windowSec = windowSeconds(c.req.query('window'));
  // 键只由规范化后的窗口秒数决定，原始 query（大小写、乱序参数、`?window=60m` vs `1h`）
  // 一律折叠到同一个键上，外人凑不出无限多的缓存条目。
  const key = new Request(new URL(`/api/status/public?window_sec=${windowSec}`, c.req.url).toString());
  const edge = edgeCache();

  if (edge) {
    const hit = await edge.match(key).catch(() => undefined);
    if (hit) {
      // 命中时 Cloudflare 会按 zone 的 Browser Cache TTL（默认 4 小时）改写 Cache-Control，
      // 原样返回会让浏览器把状态页冻住几个小时。对客户端只给这一条的剩余寿命；
      // 条目本身何时失效由 put 时的 max-age=60 决定，不受这里影响。
      const age = Math.max(0, Math.floor(Number(hit.headers.get('Age')) || 0));
      const res = new Response(hit.body, hit);
      res.headers.set('Cache-Control', `public, max-age=${Math.max(0, PUBLIC_STATUS_TTL_SEC - age)}`);
      return res;
    }
  } else {
    const hit = memoryCache.get(windowSec);
    if (hit && Date.now() - hit.at < PUBLIC_STATUS_TTL_SEC * 1000) return publicStatusResponse(hit.body);
  }

  const body = JSON.stringify(await buildPublicStatus(c.env, windowSec));
  if (edge) {
    const put = edge.put(key, publicStatusResponse(body)).catch((e) => console.error('[status] cache put failed:', e));
    try {
      c.executionCtx.waitUntil(put);
    } catch {
      await put; // 没有 ExecutionContext（测试 / 非 Workers 运行时）
    }
  } else {
    if (memoryCache.size >= MEMORY_CACHE_MAX) memoryCache.clear();
    memoryCache.set(windowSec, { at: Date.now(), body });
  }
  return publicStatusResponse(body);
});

/*
 * 公开状态页每个打开的浏览器每分钟轮询一次，每次 5 条聚合查询扫 logs / relay_events。
 * 缓存 60 秒：数据本来就是分钟级的统计，晚一分钟看到没有区别。
 *
 * 主路径是 Cache API（caches.default）：同一机房的所有 isolate 共享，isolate 重启也不丢。
 * 只有运行时没有 caches 时（本地 node 测试）才退到进程内的小 Map。
 *
 * 只缓存这一个无鉴权、只读、不含用户数据的接口。计费、余额、鉴权、管理员的
 * /api/health/* 全都不经过这里，照旧每次直读 D1。查询抛错时不写缓存。
 */
const PUBLIC_STATUS_TTL_SEC = 60;
const MEMORY_CACHE_MAX = 16;
const memoryCache = new Map<number, { at: number; body: string }>();

function edgeCache(): Cache | undefined {
  try {
    return (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches?.default;
  } catch {
    return undefined;
  }
}

function publicStatusResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      // Cache API 按它决定条目寿命；浏览器 / CDN 也跟着少来几次
      'Cache-Control': `public, max-age=${PUBLIC_STATUS_TTL_SEC}`,
    },
  });
}

/** 仅供测试：清掉内存 fallback。 */
export function resetPublicStatusCache() {
  memoryCache.clear();
}

async function buildPublicStatus(env: Env, windowSec: number) {
  const since = now() - windowSec;
  const dayAgo = now() - 24 * 3600;

  const [successes, failures, latencies, okHours, errHours] = await Promise.all([
    env.DB.prepare('SELECT model_name, COUNT(*) AS n FROM logs WHERE type = 2 AND created_at >= ? GROUP BY model_name')
      .bind(since).all<{ model_name: string; n: number }>(),
    env.DB.prepare('SELECT model_name, SUM(final) AS finals FROM relay_events WHERE created_at >= ? GROUP BY model_name')
      .bind(since).all<{ model_name: string; finals: number }>(),
    env.DB.prepare('SELECT model_name, elapsed_ms FROM logs WHERE type = 2 AND created_at >= ? AND elapsed_ms > 0 ORDER BY created_at DESC LIMIT 1000')
      .bind(since).all<{ model_name: string; elapsed_ms: number }>(),
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%dT%H:00Z', created_at, 'unixepoch') AS hour, COUNT(*) AS n
       FROM logs WHERE type = 2 AND created_at >= ? GROUP BY hour`,
    ).bind(dayAgo).all<{ hour: string; n: number }>(),
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%dT%H:00Z', created_at, 'unixepoch') AS hour, SUM(final) AS n
       FROM relay_events WHERE created_at >= ? GROUP BY hour`,
    ).bind(dayAgo).all<{ hour: string; n: number }>(),
  ]);

  type Bucket = { id: string; label: string; successes: number; failures: number; ms: number[] };
  const engines = new Map<string, Bucket>();
  const bucket = (model: string) => {
    const { id, label } = engineOf(model);
    let b = engines.get(id);
    if (!b) engines.set(id, (b = { id, label, successes: 0, failures: 0, ms: [] }));
    return b;
  };
  for (const r of successes.results ?? []) bucket(r.model_name).successes += r.n;
  for (const r of failures.results ?? []) bucket(r.model_name).failures += r.finals ?? 0;
  for (const r of latencies.results ?? []) bucket(r.model_name).ms.push(r.elapsed_ms);

  const list = [...engines.values()]
    .filter((b) => b.id !== 'other' || b.successes + b.failures > 0)
    .map((b) => {
      const { p50 } = percentiles(b.ms);
      const samples = b.successes + b.failures;
      return {
        id: b.id,
        label: b.label,
        state: deriveState({ successes: b.successes, failures: b.failures, p50Ms: p50, slowMs: SLOW_MS }),
        // 只给档位，不给毫秒：具体延迟是供应商的经营信息，不该挂在公网上
        latency: p50 === 0 ? 'unknown' : p50 > SLOW_MS ? 'slow' : p50 > SLOW_MS / 2 ? 'normal' : 'fast',
        success_rate: samples ? Number((b.successes / samples).toFixed(3)) : null,
        samples,
      };
    })
    .sort((a, b) => b.samples - a.samples);

  const okByHour = new Map((okHours.results ?? []).map((r) => [r.hour, r.n]));
  const errByHour = new Map((errHours.results ?? []).map((r) => [r.hour, r.n ?? 0]));
  const history: Array<{ hour: string; state: string }> = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date((now() - i * 3600) * 1000);
    const hour = `${d.toISOString().slice(0, 13)}:00Z`;
    const good = okByHour.get(hour) ?? 0;
    const bad = errByHour.get(hour) ?? 0;
    history.push({ hour, state: deriveState({ successes: good, failures: bad }) });
  }

  const down = list.filter((e) => e.state === 'down').length;
  const known = list.filter((e) => e.state !== 'unknown').length;
  const overall = !known
    ? 'unknown'
    : down && down * 2 >= known
      ? 'down'
      : list.some((e) => e.state === 'down' || e.state === 'degraded')
        ? 'degraded'
        : 'ok';

  return ok({ generated_at: now(), window_minutes: Math.round(windowSec / 60), overall, engines: list, history, notice: '' });
}

// ---------------------------------------------------------------- tokens（管理令牌）

api.get('/tokens', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM tokens ORDER BY id DESC').all<TokenRow>();
  return c.json(ok((rows.results ?? []).map((t) => ({ ...t, price_config: tokenPriceOut(t) }))));
});

api.post('/tokens', requireAdmin, async (c) => {
  const b = await c.req.json<any>();
  const price = normalizePriceConfig(b.price_config);
  if (!price.ok) return c.json(fail(price.error), 400);

  const owner = await ensureOwner(c.env);
  const key = randomKey(24);
  const unlimited = b.unlimited_quota ? 1 : 0;
  await c.env.DB.prepare(
    'INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, models, price_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      owner.id, key, TokenStatusEnabled, String(b.name ?? '默认令牌'), now(), now(),
      Number.isFinite(b.expired_time) ? Number(b.expired_time) : -1,
      unlimited ? 0 : Math.max(0, Number(b.remain_quota) || 0),
      unlimited, String(b.models ?? ''), price.json,
    )
    .run();
  const token = await c.env.DB.prepare('SELECT * FROM tokens WHERE key = ?').bind(key).first<TokenRow>();
  return c.json(ok({ ...token!, price_config: tokenPriceOut(token!) }, '令牌已创建'));
});

api.put('/tokens/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const token = await c.env.DB.prepare('SELECT * FROM tokens WHERE id = ?').bind(id).first<TokenRow>();
  if (!token) return c.json(fail('令牌不存在'), 404);

  const b = await c.req.json<any>();
  // price_config 不出现 = 不修改；显式传 {} / '' / null = 清空。
  let priceJson = token.price_config;
  if (b.price_config !== undefined) {
    const price = normalizePriceConfig(b.price_config);
    if (!price.ok) return c.json(fail(price.error), 400);
    priceJson = price.json;
  }

  const unlimited = b.unlimited_quota !== undefined ? (b.unlimited_quota ? 1 : 0) : token.unlimited_quota;
  await c.env.DB.prepare('UPDATE tokens SET name = ?, status = ?, expired_time = ?, remain_quota = ?, unlimited_quota = ?, models = ?, price_config = ? WHERE id = ?')
    .bind(
      String(b.name ?? token.name),
      Number(b.status ?? token.status),
      b.expired_time !== undefined ? Number(b.expired_time) : token.expired_time,
      b.remain_quota !== undefined ? Math.max(0, Number(b.remain_quota) || 0) : token.remain_quota,
      unlimited,
      b.models !== undefined ? String(b.models) : token.models,
      priceJson,
      id,
    )
    .run();
  await invalidateTokenCache(c.env, token.key);
  return c.json(ok(null, '已保存'));
});

api.delete('/tokens/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const token = await c.env.DB.prepare('SELECT * FROM tokens WHERE id = ?').bind(id).first<TokenRow>();
  if (!token) return c.json(fail('令牌不存在'), 404);
  await c.env.DB.prepare('DELETE FROM tokens WHERE id = ?').bind(id).run();
  await invalidateTokenCache(c.env, token.key);
  return c.json(ok(null, '已删除'));
});

// ---------------------------------------------------------------- pricing（管理令牌）

/** 内置价格表外显 + 全局覆盖现状。每个 Key 的生效视图在 `GET /v1/pricing`（sk- 鉴权）。 */
api.get('/pricing', requireAdmin, async (c) => {
  const options = await getOptions(c.env);
  return c.json(
    ok({
      built_in: PRICE_TABLE,
      default_price: options.DefaultPrice ?? DEFAULT_PRICE,
      global_overrides: options.ModelPriceOverride ?? {},
      alias_prefixes: ALIAS_PREFIXES,
      quota_per_usd: QUOTA_PER_USD,
    }),
  );
});

/**
 * 全局价格配置，**整包替换**：
 *
 *   { "overrides": {"模型名": PriceSpec | null}, "default_price"?: Price }
 *
 * - overrides 里值为 null 的条目 = 删除该模型的覆盖（回到内置价）；
 *   不出现的模型同样视为无覆盖——所以「恢复默认」就是把它从包里去掉。
 * - default_price（可选，只支持固定价）= 未知模型的兜底价，改它不动 overrides。
 * 每条都校验（固定价形状 / 表达式编译+冒烟），任何一条不合法整包拒绝。
 * 每个 Key 还可以在「令牌」里再覆盖一层（tokens.price_config），优先级更高。
 */
api.put('/pricing/overrides', requireAdmin, async (c) => {
  const body = await c.req.json<{ overrides?: Record<string, unknown>; default_price?: unknown }>().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json(fail('body 必须是 {"overrides": {...}, "default_price"?: {...}}'), 400);
  }
  const out: Record<string, PriceSpec> = {};
  if (body.overrides !== undefined) {
    if (typeof body.overrides !== 'object' || body.overrides === null || Array.isArray(body.overrides)) {
      return c.json(fail('overrides 必须是 {"模型名": PriceSpec | null} 对象'), 400);
    }
    for (const [model, spec] of Object.entries(body.overrides)) {
      if (spec === null || spec === undefined) continue;
      const v = validatePriceSpec(spec);
      if (!v.ok) return c.json(fail(`模型 ${model} 的价格配置有误：${v.error}`), 400);
      out[model] = v.spec;
    }
  }

  const patch: Record<string, unknown> = { ModelPriceOverride: out };
  let defaultPrice: Price | undefined;
  if (body.default_price !== undefined) {
    if (body.default_price === null || typeof body.default_price !== 'object' || Array.isArray(body.default_price)
      || typeof (body.default_price as any).expr === 'string') {
      return c.json(fail('default_price 只支持固定价 {"in":..,"out":..,"cached_in"?:..}，不支持表达式'), 400);
    }
    const v = validatePriceSpec(body.default_price);
    if (!v.ok) return c.json(fail(`default_price 有误：${v.error}`), 400);
    if (isExprSpec(v.spec)) return c.json(fail('default_price 只支持固定价'), 400);
    defaultPrice = v.spec;
    patch.DefaultPrice = defaultPrice;
  }

  await setOptions(c.env, patch);
  return c.json(ok({ overrides: out, default_price: defaultPrice ?? (await getOptions(c.env)).DefaultPrice }, '已保存'));
});

// ---------------------------------------------------------------- owner（管理令牌）

/** 唯一账户（owner）的余额与消耗。 */
api.get('/owner', requireAdmin, async (c) => {
  const user = await ensureOwner(c.env);
  return c.json(
    ok({
      id: user.id,
      username: user.username,
      quota: user.quota,
      usd: quotaToUSD(user.quota),
      used_quota: user.used_quota,
      used_usd: quotaToUSD(user.used_quota),
      request_count: user.request_count,
    }),
  );
});

/** 调整预算。正数充值、负数扣减；guard 关闭——扣成负数是管理员明确要求的口径。 */
api.post('/owner/adjust', requireAdmin, async (c) => {
  const b = await c.req.json<{ usd?: number }>().catch(() => ({}) as { usd?: number });
  const usd = Number(b.usd);
  if (!Number.isFinite(usd) || usd === 0) return c.json(fail('usd 必填且不为 0（正=充值，负=扣减）'), 400);
  const user = await ensureOwner(c.env);
  const delta = Math.round(usd * QUOTA_PER_USD);
  const result = await applyCredit(c.env, {
    userId: user.id,
    delta,
    reason: 'adjust',
    guard: false,
    also: [
      c.env.DB.prepare('INSERT INTO logs (user_id, created_at, type, content, username, quota) VALUES (?, ?, ?, ?, ?, ?)').bind(
        user.id, now(), LogTypeManage, `调整预算 ${usd > 0 ? '+' : ''}$${usd.toFixed(2)}`, user.username, delta,
      ),
    ],
  });
  if (!result.ok) return c.json(fail(`调整失败：${result.reason}`), 400);
  return c.json(ok({ balance: result.balance, usd: quotaToUSD(result.balance) }, '已调整'));
});

// ---------------------------------------------------------------- channels（管理令牌）

api.get('/channels', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM channels ORDER BY id DESC').all<ChannelRow>();
  return c.json(ok((rows.results ?? []).map((ch) => ({ ...ch, key: maskKey(ch.key) }))));
});

api.get('/channels/meta', requireAdmin, (c) =>
  c.json(
    ok({
      adaptors: Object.values(ADAPTORS).map((a) => ({ name: a.name, label: a.label, default_base_url: a.defaultBaseURL })),
      presets: OPENAI_COMPATIBLE_PRESETS,
      known_models: Object.keys(PRICE_TABLE).sort(),
    }),
  ),
);

function channelFromBody(b: any, existing?: ChannelRow): Omit<ChannelRow, 'id' | 'created_time' | 'test_time' | 'response_time' | 'balance' | 'used_quota'> {
  return {
    type: String(b.type ?? existing?.type ?? 'openai'),
    key: b.key !== undefined && b.key !== '' && !String(b.key).includes('****') ? String(b.key) : (existing?.key ?? ''),
    status: b.status !== undefined ? Number(b.status) : (existing?.status ?? ChannelStatusEnabled),
    name: String(b.name ?? existing?.name ?? ''),
    weight: Math.max(1, Number(b.weight ?? existing?.weight ?? 1)),
    priority: Number(b.priority ?? existing?.priority ?? 0),
    base_url: String(b.base_url ?? existing?.base_url ?? ''),
    models: String(b.models ?? existing?.models ?? ''),
    model_mapping: String(b.model_mapping ?? existing?.model_mapping ?? ''),
    config: String(b.config ?? existing?.config ?? ''),
    system_prompt: String(b.system_prompt ?? existing?.system_prompt ?? ''),
  };
}

api.post('/channels', requireAdmin, async (c) => {
  const b = await c.req.json<any>();
  const ch = channelFromBody(b);
  if (!ch.name) return c.json(fail('渠道名称不能为空'), 400);
  if (!ch.models) return c.json(fail('至少填写一个模型'), 400);

  await c.env.DB.prepare(
    'INSERT INTO channels (type, key, status, name, weight, priority, created_time, base_url, models, model_mapping, config, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(ch.type, ch.key, ch.status, ch.name, ch.weight, ch.priority, now(), ch.base_url, ch.models, ch.model_mapping, ch.config, ch.system_prompt)
    .run();

  const created = await c.env.DB.prepare('SELECT * FROM channels ORDER BY id DESC LIMIT 1').first<ChannelRow>();
  await rebuildAbilities(c.env, created!);
  return c.json(ok({ ...created!, key: maskKey(created!.key) }, '渠道已创建'));
});

api.put('/channels/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
  if (!existing) return c.json(fail('渠道不存在'), 404);

  const ch = channelFromBody(await c.req.json<any>(), existing);
  await c.env.DB.prepare(
    'UPDATE channels SET type = ?, key = ?, status = ?, name = ?, weight = ?, priority = ?, base_url = ?, models = ?, model_mapping = ?, config = ?, system_prompt = ? WHERE id = ?',
  )
    .bind(ch.type, ch.key, ch.status, ch.name, ch.weight, ch.priority, ch.base_url, ch.models, ch.model_mapping, ch.config, ch.system_prompt, id)
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
  await rebuildAbilities(c.env, updated!);
  return c.json(ok({ ...updated!, key: maskKey(updated!.key) }, '已保存'));
});

api.delete('/channels/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(id).run();
  await deleteAbilities(c.env, id);
  return c.json(ok(null, '已删除'));
});

/** Sends a 1-token chat completion straight at the channel to check credentials. */
api.post('/channels/:id/test', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const channel = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
  if (!channel) return c.json(fail('渠道不存在'), 404);

  const model = c.req.query('model') || csv(channel.models)[0];
  if (!model) return c.json(fail('渠道未配置模型'), 400);

  const adaptor = getAdaptor(channel.type);
  const ctx: AdaptorContext = {
    channel,
    upstreamModel: model,
    requestedModel: model,
    mode: 'chat',
    path: 'chat/completions',
    config: (() => { try { return JSON.parse(channel.config || '{}'); } catch { return {}; } })(),
  };

  const started = Date.now();
  try {
    const built = adaptor.buildRequest({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }, ctx);
    const resp = await fetch(built.url, { method: 'POST', headers: built.headers, body: built.body, signal: AbortSignal.timeout(30_000) });
    const elapsed = Date.now() - started;
    const text = await resp.text();
    await c.env.DB.prepare('UPDATE channels SET test_time = ?, response_time = ? WHERE id = ?').bind(now(), elapsed, id).run();
    if (!resp.ok) return c.json(fail(`测试失败 (${resp.status}): ${text.slice(0, 500)}`), 200);
    return c.json(ok({ elapsed_ms: elapsed, model }, `测试成功，耗时 ${elapsed}ms`));
  } catch (e: any) {
    return c.json(fail(`测试失败: ${e?.message ?? e}`), 200);
  }
});

// ---------------------------------------------------------------- health（管理令牌）

/*
 * 健康度 = logs 里 type=2 的成功行 ∪ relay_events 里的失败行。
 *
 * 两个数据源是因为保留期不同（见 migrations/0009）。窗口默认 60 分钟：够长到
 * 有样本，够短到"刚坏"能立刻看见。
 */
const windowSeconds = (raw: string | undefined, fallback = 3600) => {
  const m = /^(\d+)([mh])$/.exec(raw ?? '');
  if (!m) return fallback;
  const n = Number(m[1]);
  return Math.min(7 * 86400, Math.max(300, m[2] === 'h' ? n * 3600 : n * 60));
};

/** oneapi 侧的「慢」线。字幕 worker 按它自己的超时另算。 */
const SLOW_MS = 20_000;

api.get('/health/channels', requireAdmin, async (c) => {
  const windowSec = windowSeconds(c.req.query('window'));
  const since = now() - windowSec;

  const [channels, successes, failures, latencies, lastErrors, cooling] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM channels ORDER BY priority DESC, id').all<ChannelRow>(),
    c.env.DB.prepare('SELECT channel_id, COUNT(*) AS n FROM logs WHERE type = 2 AND created_at >= ? GROUP BY channel_id')
      .bind(since).all<{ channel_id: number; n: number }>(),
    c.env.DB.prepare('SELECT channel_id, COUNT(*) AS n, SUM(final) AS finals FROM relay_events WHERE created_at >= ? GROUP BY channel_id')
      .bind(since).all<{ channel_id: number; n: number; finals: number }>(),
    c.env.DB.prepare('SELECT channel_id, elapsed_ms FROM logs WHERE type = 2 AND created_at >= ? AND elapsed_ms > 0 ORDER BY created_at DESC LIMIT 1000')
      .bind(since).all<{ channel_id: number; elapsed_ms: number }>(),
    c.env.DB.prepare(
      `SELECT channel_id, MAX(created_at) AS at, stage, status, model_name, error_text
       FROM relay_events WHERE created_at >= ? AND channel_id > 0 GROUP BY channel_id`,
    ).bind(since).all<any>(),
    listCooling(c.env),
  ]);

  const okBy = new Map((successes.results ?? []).map((r) => [r.channel_id, r.n]));
  const errBy = new Map((failures.results ?? []).map((r) => [r.channel_id, r]));
  const errAt = new Map((lastErrors.results ?? []).map((r) => [r.channel_id, r]));
  const msBy = new Map<number, number[]>();
  for (const row of latencies.results ?? []) {
    const list = msBy.get(row.channel_id) ?? [];
    list.push(row.elapsed_ms);
    msBy.set(row.channel_id, list);
  }

  const data = (channels.results ?? []).map((ch) => {
    const good = okBy.get(ch.id) ?? 0;
    const err = errBy.get(ch.id);
    const cool = cooling.get(ch.id);
    const { p50, p95 } = percentiles(msBy.get(ch.id) ?? []);
    const finals = err?.finals ?? 0;
    const last = errAt.get(ch.id);

    return {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      priority: ch.priority,
      status: ch.status,
      requests: good + finals,
      successes: good,
      failures: finals,
      // 含重试中间态，用来解释「这个渠道被跳过了多少次」
      attempts_failed: err?.n ?? 0,
      success_rate: good + finals ? Number((good / (good + finals)).toFixed(4)) : null,
      p50_ms: p50,
      p95_ms: p95,
      state: deriveState({
        successes: good,
        failures: finals,
        p50Ms: p50,
        disabled: ch.status !== ChannelStatusEnabled,
        cooling: cool?.cooling,
        slowMs: SLOW_MS,
      }),
      cooldown: cool ?? { cooling: false, secondsLeft: 0, strike: 0 },
      test_time: ch.test_time,
      response_time: ch.response_time,
      last_error: last ? { at: last.at, stage: last.stage, status: last.status, model: last.model_name, text: last.error_text } : null,
    };
  });

  return c.json(ok({ window_sec: windowSec, channels: data }));
});

api.get('/health/models', requireAdmin, async (c) => {
  const windowSec = windowSeconds(c.req.query('window'), 24 * 3600);
  const since = now() - windowSec;

  const [successes, failures, gaps] = await Promise.all([
    c.env.DB.prepare('SELECT model_name, COUNT(*) AS n FROM logs WHERE type = 2 AND created_at >= ? GROUP BY model_name')
      .bind(since).all<{ model_name: string; n: number }>(),
    c.env.DB.prepare('SELECT model_name, COUNT(*) AS n, SUM(final) AS finals FROM relay_events WHERE created_at >= ? GROUP BY model_name')
      .bind(since).all<{ model_name: string; n: number; finals: number }>(),
    /*
     * 路由缺口：请求了但一个渠道都匹配不上的模型。
     *
     * 这就是本次事故的形状——OneAPI 只回一句「没有可用渠道」，而那句话里的模型名
     * 从来没被记下来过。LEFT JOIN abilities 的两个计数把「这个分组下真的一个都
     * 没有」和「有但都被禁用了」分开，因为两者的修法完全不同。
     */
    c.env.DB.prepare(
      `SELECT e.model_name, COUNT(*) AS n, MAX(e.created_at) AS last_at,
              (SELECT COUNT(*) FROM abilities a WHERE a.model = e.model_name) AS declared,
              (SELECT COUNT(*) FROM abilities a WHERE a.model = e.model_name AND a.enabled = 1) AS enabled
       FROM relay_events e
       WHERE e.stage = 'no_channel' AND e.created_at >= ?
       GROUP BY e.model_name ORDER BY n DESC`,
    ).bind(since).all<any>(),
  ]);

  const okBy = new Map((successes.results ?? []).map((r) => [r.model_name, r.n]));
  const errBy = new Map((failures.results ?? []).map((r) => [r.model_name, r]));
  const models = new Set([...okBy.keys(), ...errBy.keys()]);

  const data = [...models]
    .filter(Boolean)
    .map((model) => {
      const good = okBy.get(model) ?? 0;
      const finals = errBy.get(model)?.finals ?? 0;
      return {
        model,
        requests: good + finals,
        successes: good,
        failures: finals,
        success_rate: good + finals ? Number((good / (good + finals)).toFixed(4)) : null,
        state: deriveState({ successes: good, failures: finals }),
      };
    })
    .sort((a, b) => b.requests - a.requests);

  return c.json(ok({ window_sec: windowSec, models: data, missing: gaps.results ?? [] }));
});

api.get('/health/events', requireAdmin, async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 100));
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);

  const filters: string[] = [];
  const binds: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    filters.push(sql);
    binds.push(value);
  };
  if (c.req.query('channel_id')) add('channel_id = ?', Number(c.req.query('channel_id')));
  if (c.req.query('model')) add('model_name = ?', c.req.query('model'));
  if (c.req.query('stage')) add('stage = ?', c.req.query('stage'));
  if (c.req.query('status')) add('status = ?', Number(c.req.query('status')));
  if (c.req.query('since')) add('created_at >= ?', Number(c.req.query('since')));
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';

  const rows = await c.env.DB.prepare(`SELECT * FROM relay_events${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all();
  return c.json(ok(rows.results ?? []));
});

// ---------------------------------------------------------------- logs / dashboard（管理令牌）

api.get('/logs', requireAdmin, async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 100));
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  const rows = await c.env.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
  return c.json(ok(rows.results ?? []));
});

api.get('/dashboard', requireAdmin, async (c) => {
  const since = now() - 7 * 86400;

  const daily = await c.env.DB.prepare(
    `SELECT date(created_at, 'unixepoch') AS day, model_name, COUNT(*) AS count, SUM(quota) AS quota,
            SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens
     FROM logs WHERE type = 2 AND created_at >= ?
     GROUP BY day, model_name ORDER BY day`,
  ).bind(since).all();

  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(quota), 0) AS quota FROM logs WHERE type = 2 AND created_at >= ?`,
  ).bind(since).first<{ requests: number; quota: number }>();

  const owner = await ensureOwner(c.env);
  return c.json(
    ok({
      daily: daily.results ?? [],
      totals: { ...totals, usd: quotaToUSD(totals?.quota ?? 0) },
      self: { quota: owner.quota, used_quota: owner.used_quota, usd: quotaToUSD(owner.quota) },
    }),
  );
});

api.get('/available-models', requireAdmin, async (c) => c.json(ok(await listModels(c.env))));

// ---------------------------------------------------------------- options（管理令牌）

api.get('/options', requireAdmin, async (c) => c.json(ok({ current: await getOptions(c.env), defaults: DEFAULT_OPTIONS })));

api.put('/options', requireAdmin, async (c) => {
  const patch = await c.req.json<Record<string, unknown>>();
  const allowed = new Set(Object.keys(DEFAULT_OPTIONS));
  const filtered = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.has(k)));
  if (!Object.keys(filtered).length) return c.json(fail('没有可保存的配置项'), 400);
  await setOptions(c.env, filtered);
  return c.json(ok(null, '已保存'));
});

// ---------------------------------------------------------------- 自检（管理令牌）

/**
 * 自检的现状与手动触发。
 *
 * 定时任务只在**有偏差时**写日志，所以"没有告警"既可能是一切正常、也可能是 cron 根本
 * 没跑。心跳把这两者分开：`lastRun` 是空的或者很旧，就说明该去看 cron 而不是庆幸。
 */
api.get('/watchdog', requireAdmin, async (c) => c.json(ok({ lastRun: await getHeartbeat(c.env) })));

/** 不想等到明天凌晨时用。和 cron 走同一个函数，免得两条路的行为漂开。 */
api.post('/watchdog/run', requireAdmin, async (c) => c.json(ok(await runWatchdog(c.env))));

/**
 * Compares the owner's materialized balance against the sum of the ledger
 * entries. Non-empty output means some write bypassed applyCredit() — the
 * drift is a symptom, the bypassing write is the bug.
 */
api.get('/reconcile', requireAdmin, async (c) => {
  const drifts = await reconcile(c.env);
  return c.json(ok({ ok: drifts.length === 0, drifts }, drifts.length ? `${drifts.length} 个账户与账本不一致` : '账本一致'));
});

/**
 * D1 的 batch 到底是不是一个事务？
 *
 * 流式计费的整个正确性论证都绕着这个问题走：`applyCreditGated()` 把「抢状态、记账、
 * 动钱」放进一个 batch，如果它原子，中间态压根不存在。而 **Cloudflare 的类型声明里
 * 对 `batch()` 的原子性只字未提**——本地 miniflare 确实包了事务
 * （`state.storage.transactionSync`），生产那段逻辑在 D1 服务端，本地无从证实。
 *
 * 与其一直挂着这个假设，不如去问一次：发一个**故意在第二条撞主键**的 batch，然后看
 * 第一条的效果还在不在。
 *
 *   n 没变  → 回滚了，batch 是原子的
 *   n 变了  → 不原子，前面的语句已经落地
 *
 * 只碰自己那张草稿表，不靠近 users / credits 一步。留着不删：重跑一次很便宜，D1 平台
 * 以后有变化能立刻发现。结论请连同日期记进 README。
 */
api.get('/diagnostics/d1-batch', requireAdmin, async (c) => {
  await c.env.DB.prepare('CREATE TABLE IF NOT EXISTS _d1_probe (id INTEGER PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)').run();
  await c.env.DB.prepare('INSERT INTO _d1_probe (id, n) VALUES (1, 0) ON CONFLICT(id) DO UPDATE SET n = 0').run();

  let threw = '';
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE _d1_probe SET n = n + 1 WHERE id = 1'),
      // 主键冲突，必抛。抛之前上面那条已经执行过了。
      c.env.DB.prepare('INSERT INTO _d1_probe (id, n) VALUES (1, 0)'),
    ]);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }

  const row = await c.env.DB.prepare('SELECT n FROM _d1_probe WHERE id = 1').first<{ n: number }>();
  const n = row?.n ?? -1;
  await c.env.DB.prepare('DELETE FROM _d1_probe WHERE id = 1').run();

  if (!threw) {
    // 第二条没抛就说明这个探针本身失效了（比如主键约束没生效），结论不可信。
    return c.json(ok({ atomic: null, n, threw }, '探针失效：故意冲突的那条语句没有报错'));
  }
  const atomic = n === 0;
  return c.json(
    ok(
      { atomic, n, threw },
      atomic ? 'batch 是原子的：失败时前面的语句被回滚了' : '⚠️ batch 不原子：失败时前面的语句已经落地',
    ),
  );
});

// ---------------------------------------------------------------- CLI（管理令牌）

/**
 * 内置命令行：POST /api/cli {"command": "channel list"} → {output: 纯文本}。
 * 命令语言见 lib/cli.ts 的 help；SPA 终端页和终端里的 curl 走同一套解析。
 * 失败的命令也返回 success:true（output 里带错误），HTTP 层只对请求本身出错报错。
 */
api.post('/cli', requireAdmin, async (c) => {
  const body = await c.req.json<{ command?: string }>().catch(() => null);
  const command = String(body?.command ?? '').trim();
  if (!command) return c.json(fail('command 必填'), 400);
  const result = await runCli(c.env, command);
  return c.json(ok({ output: result.output, ok: result.ok }));
});

export default api;
