import type { Env, TokenRow, ChannelRow } from '../types';
import { getOptions, setOptions, DEFAULT_OPTIONS } from './options';
import { ensureOwner, invalidateTokenCache } from './auth';
import { applyCredit, reconcile } from './ledger';
import { rebuildAbilities, deleteAbilities, listModels } from './channel';
import { getHeartbeat, runWatchdog } from './watchdog';
import { randomKey } from './crypto';
import {
  PRICE_TABLE, DEFAULT_PRICE, ALIAS_PREFIXES, QUOTA_PER_USD, quotaToUSD,
  validatePriceSpec, resolvePrice, type PriceSpec,
} from './pricing/llm';
import { TokenStatusEnabled, TokenStatusDisabled, ChannelStatusEnabled, ChannelStatusManuallyDisabled, LogTypeManage } from '../types';

/** channel set 允许修改的字段 → 归一化（返回 null 表示值非法）。 */
const CHANNEL_FIELDS: Record<string, (v: string) => unknown> = {
  name: (v) => v,
  type: (v) => ['openai', 'openai-responses', 'anthropic', 'gemini', 'azure'].includes(v) ? v : null,
  base_url: (v) => v,
  key: (v) => v,
  models: (v) => v,
  priority: (v) => Number(v),
  weight: (v) => Math.max(1, Number(v)),
  status: (v) => ({ '1': 1, on: 1, enable: 1, '2': 2, off: 2, disable: 2 })[v] ?? null,
  model_mapping: (v) => v,
  config: (v) => v,
  system_prompt: (v) => v,
};

/** token set 允许修改的字段 → SQL 列名 + 归一化（usd 是 CLI 别名，落在 remain_quota 上）。 */
const TOKEN_FIELDS: Record<string, { column: string; norm: (v: string) => unknown }> = {
  name: { column: 'name', norm: (v) => v },
  models: { column: 'models', norm: (v) => v },
  usd: { column: 'remain_quota', norm: (v) => Math.max(0, Math.round((Number(v.replace(/^\$/, '')) || 0) * QUOTA_PER_USD)) },
  unlimited: { column: 'unlimited_quota', norm: (v) => (['1', 'true', 'on', 'yes'].includes(v.toLowerCase()) ? 1 : 0) },
  status: { column: 'status', norm: (v) => ({ '1': 1, on: 1, enable: 1, '2': 2, off: 2, disable: 2 })[v] ?? null },
  expired: { column: 'expired_time', norm: (v) => Number(v) },
};

/**
 * 内置命令行界面（服务端）。
 *
 * `POST /api/cli` 把一整行命令交给 runCli()，返回纯文本输出。REST 能做的配置
 * 这里都能做，反过来 CLI 也是 REST 的语法糖——每个命令最终都走同一个库函数，
 * 不存在两套行为。
 *
 * 设计规则：
 *   - 命令 = 子命令空格分隔，参数用 `key=value`，布尔开关用 `--flag`；
 *   - 带引号的值支持空格（`expr="p * 3 + c * 15"`）；
 *   - 输出是人类可读的纯文本表格，第一行是结论；
 *   - 任何失败都以非零 exit 语义返回（ok:false），错误信息可直接照着修。
 */

export interface CliResult {
  ok: boolean;
  output: string;
}

const now = () => Math.floor(Date.now() / 1000);

/** 把一行命令拆成 token：token 开头的引号包裹空格；其余位置的引号是字面量（JSON 参数）。 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if ((ch === '"' || ch === "'") && cur === '') {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) tokens.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** key=value 参数表（首个 token 是命令字，不参与）。 */
function kvOf(tokens: string[]): Map<string, string> {
  const kv = new Map<string, string>();
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq > 0) kv.set(t.slice(0, eq), t.slice(eq + 1));
  }
  return kv;
}

/** `--flag value` / `--flag=value` 参数表；孤立的开关值为空串。 */
function flagsOf(tokens: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('--')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      flags.set(t.slice(0, eq), t.slice(eq + 1));
    } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
      flags.set(t, tokens[++i]);
    } else {
      flags.set(t, '');
    }
  }
  return flags;
}

/** 对齐的纯文本表格。 */
function table(headers: string[], rows: string[][]): string {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length), 1));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(w[i])).join('  ').trimEnd();
  return [line(headers), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n');
}

const usd = (quota: number) => `$${quotaToUSD(quota).toFixed(4)}`;

export async function runCli(env: Env, line: string): Promise<CliResult> {
  const tokens = tokenize(line);
  if (!tokens.length) return { ok: true, output: '' };
  try {
    return await dispatch(env, tokens);
  } catch (e: any) {
    return { ok: false, output: `错误：${e?.message ?? e}` };
  }
}

async function dispatch(env: Env, tokens: string[]): Promise<CliResult> {
  const [head, sub] = tokens;
  switch (head) {
    case 'help': return { ok: true, output: helpText(sub) };
    case 'status': return status(env);
    case 'models': {
      const models = await listModels(env);
      return { ok: true, output: `${models.length} 个可用模型：\n${models.join('\n')}` };
    }
    case 'owner': return owner(env, tokens.slice(1));
    case 'channel': return channelCmd(env, tokens.slice(1));
    case 'token': return tokenCmd(env, tokens.slice(1));
    case 'price': return priceCmd(env, tokens.slice(1));
    case 'opt': return optCmd(env, tokens.slice(1));
    case 'logs': return logs(env, Number(tokens[1]) || 10);
    case 'health': return health(env);
    case 'reconcile': {
      const drifts = await reconcile(env);
      return { ok: drifts.length === 0, output: drifts.length ? table(['user_id', 'username', 'drift'], drifts.map((d) => [String(d.user_id), d.username, String(d.drift)])) : '账本一致，无漂移' };
    }
    case 'watchdog': {
      const result = sub === 'run' ? await runWatchdog(env) : await getHeartbeat(env);
      return { ok: true, output: '```json\n' + JSON.stringify(result, null, 2) + '\n```' };
    }
    default:
      return { ok: false, output: `未知命令 "${head}"。输入 help 查看用法。` };
  }
}

// ---------------------------------------------------------------- status / owner

async function status(env: Env): Promise<CliResult> {
  const options = await getOptions(env);
  const owner = await ensureOwner(env);
  const channels = await env.DB.prepare('SELECT COUNT(*) AS n FROM channels').first<{ n: number }>();
  const models = await listModels(env);
  return {
    ok: true,
    output: [
      `站点：${options.SystemName}`,
      `余额：${usd(owner.quota)}（已用 ${usd(owner.used_quota)}，请求数 ${owner.request_count}）`,
      `渠道：${channels?.n ?? 0} 个；可用模型 ${models.length} 个`,
      `兜底价：$${options.DefaultPrice?.in ?? DEFAULT_PRICE.in} / $${options.DefaultPrice?.out ?? DEFAULT_PRICE.out} per 1M`,
    ].join('\n'),
  };
}

async function owner(env: Env, args: string[]): Promise<CliResult> {
  const user = await ensureOwner(env);
  const [op, amountRaw] = args;
  if (!op || op === 'show') {
    return { ok: true, output: `余额 ${usd(user.quota)} · 已用 ${usd(user.used_quota)} · 请求 ${user.request_count} 次` };
  }
  const usdAmount = Number((amountRaw ?? '').replace(/^\$/, ''));
  if ((op !== 'add' && op !== 'sub') || !Number.isFinite(usdAmount) || usdAmount <= 0) {
    return { ok: false, output: '用法：owner show | owner add <美元> | owner sub <美元>' };
  }
  const delta = Math.round((op === 'sub' ? -usdAmount : usdAmount) * QUOTA_PER_USD);
  const result = await applyCredit(env, {
    userId: user.id, delta, reason: 'adjust', guard: false,
    also: [env.DB.prepare('INSERT INTO logs (user_id, created_at, type, content, username, quota) VALUES (?, ?, ?, ?, ?, ?)').bind(user.id, now(), LogTypeManage, `CLI 调整预算 ${delta > 0 ? '+' : ''}$${usdAmount.toFixed(2)}`, user.username, delta)],
  });
  if (!result.ok) return { ok: false, output: `调整失败：${result.reason}` };
  return { ok: true, output: `已调整，当前余额 ${usd(result.balance)}` };
}

// ---------------------------------------------------------------- channel

async function channelCmd(env: Env, args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined: case 'list': {
      const rows = await env.DB.prepare('SELECT * FROM channels ORDER BY id').all<ChannelRow>();
      const table2 = table(['ID', '状态', '类型', '名称', '优先级/权重', '模型'], (rows.results ?? []).map((ch) => [
        String(ch.id), ch.status === 1 ? '启用' : `停用(${ch.status})`, ch.type, ch.name, `${ch.priority}/${ch.weight}`, ch.models,
      ]));
      return { ok: true, output: table2 || '（还没有渠道）' };
    }
    case 'add': {
      // channel add <type> <name> <base_url> <api_key> --models a,b,c [--priority N] [--weight N]
      const [type, name, baseUrl, apiKey] = rest;
      const flags = flagsOf(rest);
      const models = flags.get('--models') ?? '';
      if (!type || !name || !models) {
        return { ok: false, output: '用法：channel add <类型:openai|openai-responses|anthropic|gemini|azure> <名称> <base_url> <api_key> --models m1,m2 [--priority 0] [--weight 1]' };
      }
      await env.DB.prepare(
        'INSERT INTO channels (type, key, status, name, weight, priority, created_time, base_url, models) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(type, apiKey ?? '', ChannelStatusEnabled, name, Math.max(1, Number(flags.get('--weight')) || 1), Number(flags.get('--priority')) || 0, now(), baseUrl ?? '', models)
        .run();
      const created = await env.DB.prepare('SELECT * FROM channels ORDER BY id DESC LIMIT 1').first<ChannelRow>();
      await rebuildAbilities(env, created!);
      return { ok: true, output: `渠道 #${created!.id}「${name}」已创建（${models}）` };
    }
    case 'show': {
      const id = Number(rest[0]);
      const ch = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
      if (!ch) return { ok: false, output: `渠道 #${rest[0]} 不存在` };
      const { key, ...safe } = ch;
      return { ok: true, output: '```json\n' + JSON.stringify({ ...safe, key: key ? `${key.slice(0, 4)}****${key.slice(-4)}` : '' }, null, 2) + '\n```' };
    }
    case 'on': case 'off': {
      const id = Number(rest[0]);
      const status2 = sub === 'on' ? ChannelStatusEnabled : ChannelStatusManuallyDisabled;
      const ch = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
      if (!ch) return { ok: false, output: `渠道 #${rest[0]} 不存在` };
      await env.DB.prepare('UPDATE channels SET status = ? WHERE id = ?').bind(status2, id).run();
      await rebuildAbilities(env, { ...ch, status: status2 });
      return { ok: true, output: `渠道 #${id} 已${sub === 'on' ? '启用' : '停用'}` };
    }
    case 'del': {
      const id = Number(rest[0]);
      await env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(id).run();
      await deleteAbilities(env, id);
      return { ok: true, output: `渠道 #${id} 已删除` };
    }
    case 'set': {
      const id = Number(rest[0]);
      const ch = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
      if (!ch) return { ok: false, output: `渠道 #${rest[0]} 不存在` };
      const kv = kvOf(rest.slice(1));
      if (!kv.size) return { ok: false, output: `用法：channel set <id> name=新名称 type=openai base_url=... key=... models=a,b priority=0 weight=1 status=1 model_mapping=... config=... system_prompt=...\n可改字段：${Object.keys(CHANNEL_FIELDS).join(', ')}` };
      const sets: string[] = [];
      const binds: unknown[] = [];
      for (const [field, raw2] of kv) {
        const norm = CHANNEL_FIELDS[field];
        if (!norm) return { ok: false, output: `不可修改的字段 "${field}"。可改：${Object.keys(CHANNEL_FIELDS).join(', ')}` };
        const value = norm(raw2);
        if (value === null || (typeof value === 'number' && !Number.isFinite(value))) {
          return { ok: false, output: `字段 ${field} 的值 "${raw2}" 非法` };
        }
        sets.push(`${field} = ?`);
        binds.push(value);
      }
      if (!sets.length) return { ok: false, output: '没有可保存的修改' };
      binds.push(id);
      await env.DB.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      const updated = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
      await rebuildAbilities(env, updated!);
      return { ok: true, output: `渠道 #${id}「${updated!.name}」已更新（模型：${updated!.models || '—'}，状态=${updated!.status}）` };
    }
    case 'test': {
      // 复用管理接口的测试逻辑太重（要 fetch 上游）；这里只报告渠道状态。
      const id = Number(rest[0]);
      const ch = await env.DB.prepare('SELECT id, name, status, response_time, test_time FROM channels WHERE id = ?').bind(id).first<any>();
      if (!ch) return { ok: false, output: `渠道 #${rest[0]} 不存在` };
      return { ok: true, output: `渠道 #${ch.id}「${ch.name}」状态=${ch.status} 上次响应=${ch.response_time || '—'}ms 测试时间=${ch.test_time ? new Date(ch.test_time * 1000).toISOString() : '—'}（在线测试请用后台「渠道」页的测试按钮）` };
    }
    default:
      return { ok: false, output: '用法：channel list | add <类型> <名称> <base_url> <api_key> --models a,b | set <id> name=... models=... | show <id> | on <id> | off <id> | del <id>' };
  }
}

// ---------------------------------------------------------------- token

async function tokenCmd(env: Env, args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  const owner = await ensureOwner(env);
  switch (sub) {
    case undefined: case 'list': {
      const rows = await env.DB.prepare('SELECT * FROM tokens ORDER BY id').all<TokenRow>();
      const table2 = table(['ID', '名称', '状态', '剩余', '已用', '模型限制', '定制价'], (rows.results ?? []).map((t) => [
        String(t.id), t.name, t.status === 1 ? '启用' : `停用(${t.status})`,
        t.unlimited_quota ? '无限' : usd(t.remain_quota), usd(t.used_quota), t.models || '全部',
        t.price_config ? `${Object.keys(JSON.parse(t.price_config || '{}')).length} 条` : '—',
      ]));
      return { ok: true, output: table2 || '（还没有令牌）' };
    }
    case 'new': {
      const name = rest[0];
      if (!name) return { ok: false, output: '用法：token new <名称> [--usd 10 | --unlimited] [--models a,b] [--price {"模型":{"in":1,"out":2}}]' };
      const flags = flagsOf(rest);
      const priceRaw = flags.get('--price');
      let priceJson = '';
      if (priceRaw) {
        const parsed = JSON.parse(priceRaw);
        for (const [model, spec] of Object.entries(parsed)) {
          const v = validatePriceSpec(spec);
          if (!v.ok) return { ok: false, output: `模型 ${model} 的价格配置有误：${v.error}` };
        }
        priceJson = JSON.stringify(parsed);
      }
      const key = randomKey(24);
      const unlimited = flags.has('--unlimited') ? 1 : 0;
      const usdAmount = Number((flags.get('--usd') ?? '').replace(/^\$/, ''));
      await env.DB.prepare(
        'INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, models, price_config) VALUES (?, ?, ?, ?, ?, ?, -1, ?, ?, ?, ?)',
      )
        .bind(owner.id, key, TokenStatusEnabled, name, now(), now(), unlimited ? 0 : Math.round((Number.isFinite(usdAmount) ? usdAmount : 0) * QUOTA_PER_USD), unlimited, flags.get('--models') ?? '', priceJson)
        .run();
      return { ok: true, output: `令牌已创建：sk-${key}${unlimited ? '（无限额度）' : Number.isFinite(usdAmount) ? `（$${usdAmount}）` : '（0 额度，可用 --usd/--unlimited 调整）'}\n请立即保存，密钥只显示这一次。` };
    }
    case 'set': {
      const id = Number(rest[0]);
      const t = await env.DB.prepare('SELECT * FROM tokens WHERE id = ?').bind(id).first<TokenRow>();
      if (!t) return { ok: false, output: `令牌 #${rest[0]} 不存在` };
      const kv = kvOf(rest.slice(1));
      if (!kv.size) return { ok: false, output: `用法：token set <id> name=新名称 models=a,b usd=10 unlimited=1|0 status=1|2 expired=-1\n可改字段：${Object.keys(TOKEN_FIELDS).join(', ')}（价格用 token price 子命令）` };
      const sets: string[] = [];
      const binds: unknown[] = [];
      for (const [field, raw2] of kv) {
        const def = TOKEN_FIELDS[field];
        if (!def) return { ok: false, output: `不可修改的字段 "${field}"。可改：${Object.keys(TOKEN_FIELDS).join(', ')}；价格请用 token price` };
        const value = def.norm(raw2);
        if (value === null || (typeof value === 'number' && !Number.isFinite(value))) {
          return { ok: false, output: `字段 ${field} 的值 "${raw2}" 非法` };
        }
        sets.push(`${def.column} = ?`);
        binds.push(value);
      }
      if (!sets.length) return { ok: false, output: '没有可保存的修改' };
      binds.push(id);
      await env.DB.prepare(`UPDATE tokens SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      await invalidateTokenCache(env, t.key);
      const updated = await env.DB.prepare('SELECT * FROM tokens WHERE id = ?').bind(id).first<TokenRow>();
      return {
        ok: true,
        output: `令牌 #${id}「${updated!.name}」已更新（${updated!.unlimited_quota ? '无限' : usd(updated!.remain_quota)}，模型：${updated!.models || '全部'}，状态=${updated!.status}）`,
      };
    }
    case 'key': {
      const id = Number(rest[0]);
      const t = await env.DB.prepare('SELECT * FROM tokens WHERE id = ?').bind(id).first<TokenRow>();
      if (!t) return { ok: false, output: `令牌 #${rest[0]} 不存在` };
      return { ok: true, output: `sk-${t.key}` };
    }
    case 'on': case 'off': {
      const id = Number(rest[0]);
      const t = await env.DB.prepare('SELECT * FROM tokens WHERE id = ?').bind(id).first<TokenRow>();
      if (!t) return { ok: false, output: `令牌 #${rest[0]} 不存在` };
      await env.DB.prepare('UPDATE tokens SET status = ? WHERE id = ?').bind(sub === 'on' ? TokenStatusEnabled : TokenStatusDisabled, id).run();
      await invalidateTokenCache(env, t.key);
      return { ok: true, output: `令牌 #${id} 已${sub === 'on' ? '启用' : '停用'}` };
    }
    case 'del': {
      const id = Number(rest[0]);
      const t = await env.DB.prepare('SELECT * FROM tokens WHERE id = ?').bind(id).first<TokenRow>();
      if (!t) return { ok: false, output: `令牌 #${rest[0]} 不存在` };
      await env.DB.prepare('DELETE FROM tokens WHERE id = ?').bind(id).run();
      await invalidateTokenCache(env, t.key);
      return { ok: true, output: `令牌 #${id} 已删除` };
    }
    case 'price': {
      const id = Number(rest[0]);
      const t = await env.DB.prepare('SELECT * FROM tokens WHERE id = ?').bind(id).first<TokenRow>();
      if (!t) return { ok: false, output: `令牌 #${rest[0]} 不存在` };
      const raw2 = rest.slice(1).join(' ');
      if (!raw2) {
        const cfg = t.price_config ? JSON.parse(t.price_config) : {};
        return { ok: true, output: Object.keys(cfg).length ? '```json\n' + JSON.stringify(cfg, null, 2) + '\n```' : '（该令牌没有定制价）' };
      }
      let priceJson = '';
      if (raw2 === '--clear') {
        priceJson = '';
      } else {
        const parsed = JSON.parse(raw2);
        for (const [model, spec] of Object.entries(parsed)) {
          const v = validatePriceSpec(spec);
          if (!v.ok) return { ok: false, output: `模型 ${model} 的价格配置有误：${v.error}` };
        }
        priceJson = Object.keys(parsed).length ? JSON.stringify(parsed) : '';
      }
      await env.DB.prepare('UPDATE tokens SET price_config = ? WHERE id = ?').bind(priceJson, id).run();
      await invalidateTokenCache(env, t.key);
      return { ok: true, output: priceJson ? `令牌 #${id} 定制价已更新` : `令牌 #${id} 定制价已清空` };
    }
    default:
      return { ok: false, output: '用法：token list | new <名称> [--usd N|--unlimited] [--models a,b] [--price JSON] | set <id> name=... models=... usd=N | key <id> | on <id> | off <id> | del <id> | price <id> [JSON|--clear]' };
  }
}

// ---------------------------------------------------------------- price

/** 单个费率字段的展示：数字直接显示，表达式截断显示。 */
function fmtRate(v: number | string | undefined): string {
  if (v === undefined) return '—';
  return typeof v === 'number' ? `$${v}` : `「${v.length > 24 ? v.slice(0, 24) + '…' : v}」`;
}

async function priceCmd(env: Env, args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  const options = await getOptions(env);
  switch (sub) {
    case undefined: case 'list': {
      const filter = rest[0]?.toLowerCase();
      const overrides = options.ModelPriceOverride ?? {};
      const names = [...new Set([...Object.keys(PRICE_TABLE), ...Object.keys(overrides)])].sort();
      const rows: string[][] = [];
      for (const name of names) {
        if (filter && !name.toLowerCase().includes(filter)) continue;
        const { spec, source } = resolvePrice(name, options);
        rows.push([
          name,
          fmtRate(spec.in),
          fmtRate(spec.out),
          fmtRate(spec.cached_in),
          spec.cache_write_5m !== undefined || spec.cache_write_1h !== undefined
            ? `${fmtRate(spec.cache_write_5m)}/${fmtRate(spec.cache_write_1h)}`
            : '—',
          source === 'key' ? 'key' : source === 'global' ? '覆盖' : source === 'builtin' ? '内置' : '默认',
        ]);
      }
      return {
        ok: true,
        output: `${rows.length} 个模型（美元 / 1M tokens；缓存写入=5m/1h）：\n` +
          table(['模型', '输入', '输出', '缓存命中', '缓存写入', '来源'], rows),
      };
    }
    case 'get': {
      const model = rest[0];
      if (!model) return { ok: false, output: '用法：price get <模型名>' };
      const { spec, source } = resolvePrice(model, options);
      const sourceLabel = source === 'key' ? 'key' : source === 'global' ? '覆盖' : source === 'builtin' ? '内置' : '默认';
      const parts = [
        `输入 ${fmtRate(spec.in)}`,
        `输出 ${fmtRate(spec.out)}`,
        `缓存命中 ${fmtRate(spec.cached_in)}`,
        `缓存写入5m ${fmtRate(spec.cache_write_5m)}`,
        `缓存写入1h ${fmtRate(spec.cache_write_1h)}`,
      ];
      return { ok: true, output: `${model}（${sourceLabel}）：${parts.join(' / ')}` };
    }
    case 'set': {
      const model = rest[0];
      const kv = kvOf(rest.slice(1));
      if (!model || !kv.size) {
        return { ok: false, output: '用法：price set <模型> in=1.32 out=3.96 [cached=0.044] [cw5=1.65] [cw1=2.64]，字段也可以写费率表达式，如 in="4 * (context > 272k ? 2 : 1)"' };
      }
      const overrides = { ...(options.ModelPriceOverride ?? {}) };
      // 旧版整笔表达式语法（expr="..."）已在 v2 移除：明确指路，不要让用户对着
      // 「缺少字段 in」猜原因。
      if (kv.has('expr')) {
        return { ok: false, output: '旧版整笔 {expr} 已移除：v2 按字段写费率表达式，如 price set m in="4 * (context > 272k ? 0.5 : 1)" out=20' };
      }
      const spec: PriceSpec = { in: kv.get('in')!, out: kv.get('out')! };
      if (kv.has('cached')) spec.cached_in = kv.get('cached')!;
      if (kv.has('cw5')) spec.cache_write_5m = kv.get('cw5')!;
      if (kv.has('cw1')) spec.cache_write_1h = kv.get('cw1')!;
      const v = validatePriceSpec(spec);
      if (!v.ok) return { ok: false, output: `价格配置有误：${v.error}` };
      // 存**归一化后**的 spec：CLI 提交的都是文本，纯数字要落成数字而不是表达式
      overrides[model] = v.spec;
      await setOptions(env, { ModelPriceOverride: overrides });
      return { ok: true, output: `模型 ${model} 的价格已覆盖（对全部 Key 生效；单个 Key 可用 token price 再覆盖）` };
    }
    case 'rm': {
      const model = rest[0];
      if (!model) return { ok: false, output: '用法：price rm <模型>（清除覆盖，回到内置价）' };
      const overrides = { ...(options.ModelPriceOverride ?? {}) };
      if (!(model in overrides)) return { ok: true, output: `模型 ${model} 没有覆盖，无需清除` };
      delete overrides[model];
      await setOptions(env, { ModelPriceOverride: overrides });
      return { ok: true, output: `模型 ${model} 的覆盖已清除，回到内置价` };
    }
    case 'default': {
      const kv = kvOf(rest);
      if (!kv.has('in') || !kv.has('out')) return { ok: false, output: '用法：price default in=1 out=3（未知模型的兜底价，只支持常量）' };
      const v = validatePriceSpec({ in: Number(kv.get('in')), out: Number(kv.get('out')) });
      if (!v.ok) return { ok: false, output: `兜底价有误：${v.error}` };
      await setOptions(env, { DefaultPrice: v.spec });
      return { ok: true, output: `兜底价已设为 $${v.spec.in} / $${v.spec.out}` };
    }
    case 'aliases': {
      return { ok: true, output: `别名前缀（查价前剥掉）：${ALIAS_PREFIXES.join('  ')}` };
    }
    default:
      return { ok: false, output: '用法：price list [过滤] | get <模型> | set <模型> in=X out=Y [cached=Z] [cw5=A] [cw1=B] | rm <模型> | default in=X out=Y | aliases' };
  }
}

// ---------------------------------------------------------------- opt / logs / health

const OPT_KEYS = new Set(Object.keys(DEFAULT_OPTIONS));

async function optCmd(env: Env, args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  if (sub === 'list' || sub === undefined) {
    const options = await getOptions(env);
    return { ok: true, output: table(['配置项', '当前值'], Object.keys(DEFAULT_OPTIONS).map((k) => [k, JSON.stringify((options as any)[k])])) };
  }
  if (sub === 'set') {
    const kv = kvOf(rest);
    if (!kv.size) return { ok: false, output: '用法：opt set RetryTimes=3 SystemName=我的网关' };
    const patch: Record<string, unknown> = {};
    for (const [k, raw2] of kv) {
      if (!OPT_KEYS.has(k)) return { ok: false, output: `未知或不可改的配置项 "${k}"。可改：${[...OPT_KEYS].join(', ')}` };
      // JSON 值优先（数组/对象/布尔），否则按字符串。
      try { patch[k] = JSON.parse(raw2); } catch { patch[k] = raw2; }
    }
    await setOptions(env, patch);
    return { ok: true, output: `已保存：${Object.keys(patch).join(', ')}` };
  }
  return { ok: false, output: '用法：opt list | opt set key=value...' };
}

async function logs(env: Env, n: number): Promise<CliResult> {
  const rows = await env.DB.prepare('SELECT created_at, type, model_name, quota, content FROM logs ORDER BY id DESC LIMIT ?').bind(Math.min(50, Math.max(1, n))).all<any>();
  const TYPE: Record<number, string> = { 1: '充值', 2: '消费', 3: '管理', 4: '系统' };
  const table2 = table(['时间', '类型', '模型', '消耗', '详情'], (rows.results ?? []).map((l) => [
    new Date(l.created_at * 1000).toISOString().slice(5, 16).replace('T', ' '), TYPE[l.type] ?? l.type, l.model_name || '—', usd(l.quota), String(l.content).slice(0, 60),
  ]));
  return { ok: true, output: table2 || '（暂无日志）' };
}

async function health(env: Env): Promise<CliResult> {
  const since = now() - 3600;
  const [okRows, errRows] = await Promise.all([
    env.DB.prepare('SELECT channel_id, COUNT(*) AS n FROM logs WHERE type = 2 AND created_at >= ? GROUP BY channel_id').bind(since).all<{ channel_id: number; n: number }>(),
    env.DB.prepare('SELECT channel_id, SUM(final) AS finals FROM relay_events WHERE created_at >= ? GROUP BY channel_id').bind(since).all<{ channel_id: number; finals: number | null }>(),
  ]);
  const okBy = new Map((okRows.results ?? []).map((r) => [r.channel_id, r.n]));
  const errBy = new Map((errRows.results ?? []).map((r) => [r.channel_id, Number(r.finals) || 0]));
  const ids = [...new Set([...okBy.keys(), ...errBy.keys()])].filter((i) => i > 0);
  if (!ids.length) return { ok: true, output: '近 1 小时没有流量。' };
  const names = await env.DB.prepare(`SELECT id, name FROM channels WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: number; name: string }>();
  const nameBy = new Map((names.results ?? []).map((r) => [r.id, r.name]));
  return {
    ok: true,
    output: '近 1 小时各渠道：\n' + table(['ID', '渠道', '成功', '最终失败'], ids.map((id) => [String(id), nameBy.get(id) ?? '?', String(okBy.get(id) ?? 0), String(errBy.get(id) ?? 0)])),
  };
}

// ---------------------------------------------------------------- help

function helpText(command?: string): string {
  const intro = [
    '个人 API 聚合网关 · 内置命令行',
    '用法：在终端页输入命令；同样的命令也可以用 curl -X POST /api/cli -H "Authorization: Bearer <管理令牌>" -d \'{"command":"..."}\' 使用。',
    '',
  ];
  const sections: Record<string, string> = {
    general: [
      'status                      站点概览（余额 / 渠道数 / 模型数）',
      'models                      列出全部可用模型',
      'owner [show]                查看余额',
      'owner add <美元> / sub <美元>  调整预算',
      'logs [n]                    最近 n 条日志（默认 10）',
      'health                      近 1 小时各渠道成败',
      'reconcile                   账本对账',
      'watchdog [run]              查看心跳 / 立即自检',
    ].join('\n'),
    channel: [
      'channel list                             渠道列表',
      'channel add <类型> <名称> <base_url> <key> --models m1,m2 [--priority N] [--weight N]',
      '                                         类型：openai | openai-responses | anthropic | gemini | azure',
      'channel set <id> name=... type=... base_url=... key=... models=a,b priority=N weight=N status=1',
      '                                         按字段修改渠道（改 models 自动重建路由索引）',
      'channel show <id>                        渠道详情（密钥打码）',
      'channel on <id> / off <id> / del <id>    启用 / 停用 / 删除',
    ].join('\n'),
    token: [
      'token list                               令牌列表',
      'token new <名称> [--usd N | --unlimited] [--models a,b] [--price {"模型":{"in":1,"out":2}}]',
      'token set <id> name=... models=a,b usd=N unlimited=1|0 status=1|2 expired=<unix>',
      'token key <id>                           显示完整密钥',
      'token on <id> / off <id> / del <id>      启用 / 停用 / 删除',
      'token price <id> [JSON | --clear]        查看设置清除该 Key 的按模型价格',
    ].join('\n'),
    price: [
      'price list [过滤]                        价格表（含来源：内置/覆盖）',
      'price get <模型>                         查看一个模型的价格',
      'price set <模型> in=X out=Y [cached=Z]   固定价覆盖（美元/1M）',
      'price set <模型> expr="p * 3 + c * 15"   表达式覆盖（微美元，见价格页文档）',
      'price rm <模型>                          清除覆盖，回到内置价',
      'price default in=X out=Y                 未知模型的兜底价',
      'price aliases                            别名前缀列表',
    ].join('\n'),
    opt: [
      'opt list                                 全部配置项与当前值',
      'opt set RetryTimes=3 SystemName=我的网关   修改配置（JSON 值直接写，如 DecisionOnlyModels=["a"]）',
    ].join('\n'),
  };
  if (command && sections[command]) return sections[command];
  return [
    ...intro,
    '命令分组：general(默认) | channel | token | price | opt',
    'help <分组名> 查看该组命令。',
    '',
    sections.general,
    '',
    sections.channel,
    '',
    sections.token,
    '',
    sections.price,
    '',
    sections.opt,
  ].join('\n');
}
