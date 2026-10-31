import type { Env, TokenRow, ChannelRow } from '../types';
import { getOptions, setOptions, DEFAULT_OPTIONS } from './options';
import { ensureOwner, invalidateTokenCache } from './auth';
import { applyCredit, reconcile } from './ledger';
import { rebuildAbilities, deleteAbilities, listModels, resolveTestModel, parseConfig } from './channel';
import { getHeartbeat, runWatchdog } from './watchdog';
import { randomKey } from './crypto';
import { getAdaptor } from '../relay';
import type { AdaptorContext } from '../relay/adaptor';
import { listUpstreamModels } from './upstream-models';
import { loadModelBilling, findUnpricedChannelModels, fallbackActive } from './model-billing';
import {
  PRICE_TABLE, DEFAULT_PRICE, ALIAS_PREFIXES, PRICE_ALIASES, QUOTA_PER_USD, quotaToUSD,
  validatePriceSpec, resolvePrice, stripAliasPrefix, type PriceSpec,
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
    case 'billing': return billingCmd(env, tokens.slice(1));
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
      // price_config 回显成对象（和读 JSON 文件一样直观），没有就省略。
      const display = { ...safe, key: key ? `${key.slice(0, 4)}****${key.slice(-4)}` : '' } as Record<string, unknown>;
      if (ch.price_config) {
        try { display.price_config = JSON.parse(ch.price_config); } catch { /* 原样保留 */ }
      }
      return { ok: true, output: '```json\n' + JSON.stringify(display, null, 2) + '\n```' };
    }
    case 'price': {
      // 渠道级价格覆盖：路由到这个渠道就按这里的价（渠道 > 全局 > 内置表）。
      // 键是请求名（渠道 models 里声明的那个名字）。
      const id = Number(rest[0]);
      const ch = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
      if (!ch) return { ok: false, output: `渠道 #${rest[0]} 不存在` };
      const raw2 = rest.slice(1).join(' ');
      if (!raw2) {
        const cfg = ch.price_config ? JSON.parse(ch.price_config) : {};
        return { ok: true, output: Object.keys(cfg).length ? '```json\n' + JSON.stringify(cfg, null, 2) + '\n```' : '（该渠道没有价格覆盖，按全局价计）' };
      }
      let priceJson = '';
      if (raw2 !== '--clear') {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw2);
        } catch {
          return { ok: false, output: '不是合法 JSON（形状：{"请求名":{"in":1,"out":2}}，字段可写费率表达式）' };
        }
        const out: Record<string, unknown> = {};
        for (const [model, spec] of Object.entries(parsed)) {
          if (spec === null) continue; // null 条目 = 删除该模型
          const v = validatePriceSpec(spec);
          if (!v.ok) return { ok: false, output: `模型 ${model} 的价格配置有误：${v.error}` };
          out[model] = v.spec;
        }
        priceJson = Object.keys(out).length ? JSON.stringify(out) : '';
      }
      await env.DB.prepare('UPDATE channels SET price_config = ? WHERE id = ?').bind(priceJson, id).run();
      return { ok: true, output: priceJson ? `渠道 #${id}「${ch.name}」价格覆盖已更新（仅该渠道生效）` : `渠道 #${id}「${ch.name}」价格覆盖已清空（回到全局价）` };
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
      // 真测试：与后台按钮同一语义——显式 model 必须 ∈ 渠道 models（堵 key 后门），
      // 直连上游发一个 1-token 请求，回写 test_time / response_time。
      const id = Number(rest[0]);
      const ch = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
      if (!ch) return { ok: false, output: `渠道 #${rest[0]} 不存在` };
      const picked = resolveTestModel(ch, rest[1]);
      if ('error' in picked) return { ok: false, output: picked.error };
      const model = picked.model;

      const adaptor = getAdaptor(ch.type);
      const ctx: AdaptorContext = {
        channel: ch,
        upstreamModel: model,
        requestedModel: model,
        mode: 'chat',
        path: 'chat/completions',
        config: (() => { try { return JSON.parse(ch.config || '{}'); } catch { return {}; } })(),
      };
      const started = Date.now();
      try {
        const built = adaptor.buildRequest({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }, ctx);
        const resp = await fetch(built.url, { method: 'POST', headers: built.headers, body: built.body, signal: AbortSignal.timeout(30_000) });
        const elapsed = Date.now() - started;
        const text = await resp.text().catch(() => '');
        await env.DB.prepare('UPDATE channels SET test_time = ?, response_time = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), elapsed, id).run();
        if (!resp.ok) return { ok: false, output: `测试失败 (${resp.status})：${text.slice(0, 300)}` };
        return { ok: true, output: `测试成功：模型 ${model}，耗时 ${elapsed}ms` };
      } catch (e: any) {
        return { ok: false, output: `测试失败：${e?.message ?? e}` };
      }
    }
    case 'pull': {
      // 从上游拉取模型列表：用库存 key 请求上游 /models（5 种类型各自适配）。
      // 默认只打印；--add 把列表合并进渠道 models（与现有项去重，手工项保留）。
      const id = Number(rest[0]);
      const ch = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
      if (!ch) return { ok: false, output: `渠道 #${rest[0]} 不存在` };
      let models: string[];
      try {
        models = await listUpstreamModels({ type: ch.type, baseUrl: ch.base_url ?? '', key: ch.key, config: parseConfig(ch) });
      } catch (e: any) {
        return { ok: false, output: `拉取失败：${e?.message ?? e}` };
      }
      if (!models.length) return { ok: false, output: '上游返回空列表' };
      if (rest.includes('--add')) {
        const existing = (ch.models ?? '').split(',').map((m) => m.trim()).filter(Boolean);
        const merged = [...new Set([...existing, ...models])];
        await env.DB.prepare('UPDATE channels SET models = ? WHERE id = ?').bind(merged.join(','), id).run();
        const updated = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
        await rebuildAbilities(env, updated!);
        const added = merged.length - existing.length;
        return { ok: true, output: `已合并 ${models.length} 个上游模型（新增 ${added}，去重后共 ${merged.length}）；路由索引已重建` };
      }
      return { ok: true, output: `上游模型 ${models.length} 个（--add 合并进渠道 models）：\n` + models.join(', ') };
    }
    default:
      return { ok: false, output: '用法：channel list | add <类型> <名称> <base_url> <api_key> --models a,b | set <id> name=... models=... | show <id> | test <id> [模型] | pull <id> [--add] | price <id> [JSON|--clear] | on <id> | off <id> | del <id>' };
  }
}

// ---------------------------------------------------------------- token

async function tokenCmd(env: Env, args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  const owner = await ensureOwner(env);
  switch (sub) {
    case undefined: case 'list': {
      const rows = await env.DB.prepare('SELECT * FROM tokens ORDER BY id').all<TokenRow>();
      const table2 = table(['ID', '名称', '状态', '剩余', '已用', '模型限制'], (rows.results ?? []).map((t) => [
        String(t.id), t.name, t.status === 1 ? '启用' : `停用(${t.status})`,
        t.unlimited_quota ? '无限' : usd(t.remain_quota), usd(t.used_quota), t.models || '全部',
      ]));
      return { ok: true, output: table2 || '（还没有令牌）' };
    }
    case 'new': {
      const name = rest[0];
      if (!name) return { ok: false, output: '用法：token new <名称> [--usd 10 | --unlimited] [--models a,b]' };
      const flags = flagsOf(rest);
      const key = randomKey(24);
      const unlimited = flags.has('--unlimited') ? 1 : 0;
      const usdAmount = Number((flags.get('--usd') ?? '').replace(/^\$/, ''));
      await env.DB.prepare(
        'INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, models) VALUES (?, ?, ?, ?, ?, ?, -1, ?, ?, ?)',
      )
        .bind(owner.id, key, TokenStatusEnabled, name, now(), now(), unlimited ? 0 : Math.round((Number.isFinite(usdAmount) ? usdAmount : 0) * QUOTA_PER_USD), unlimited, flags.get('--models') ?? '')
        .run();
      return { ok: true, output: `令牌已创建：sk-${key}${unlimited ? '（无限额度）' : Number.isFinite(usdAmount) ? `（$${usdAmount}）` : '（0 额度，可用 --usd/--unlimited 调整）'}\n请立即保存，密钥只显示这一次。` };
    }
    case 'set': {
      const id = Number(rest[0]);
      const t = await env.DB.prepare('SELECT * FROM tokens WHERE id = ?').bind(id).first<TokenRow>();
      if (!t) return { ok: false, output: `令牌 #${rest[0]} 不存在` };
      const kv = kvOf(rest.slice(1));
      if (!kv.size) return { ok: false, output: `用法：token set <id> name=新名称 models=a,b usd=10 unlimited=1|0 status=1|2 expired=-1\n可改字段：${Object.keys(TOKEN_FIELDS).join(', ')}` };
      const sets: string[] = [];
      const binds: unknown[] = [];
      for (const [field, raw2] of kv) {
        const def = TOKEN_FIELDS[field];
        if (!def) return { ok: false, output: `不可修改的字段 "${field}"。可改：${Object.keys(TOKEN_FIELDS).join(', ')}` };
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
    case 'price':
      // Key 级价格已按决策删除（令牌混用渠道 + fallback，在 Key 上定价没有意义）。
      // 渠道级价格在 channel price —— 引过去，别让人对着报错猜。
      return { ok: false, output: 'Key 级价格已移除：按渠道定价请用 channel price <渠道ID> [JSON|--clear]（路由到谁就按谁的价）' };
    default:
      return { ok: false, output: '用法：token list | new <名称> [--usd N|--unlimited] [--models a,b] | set <id> name=... models=... usd=N | key <id> | on <id> | off <id> | del <id>' };
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
          source === 'global' ? '覆盖' : source === 'builtin' ? '内置' : '默认',
        ]);
      }
      return {
        ok: true,
        output: `${rows.length} 个模型（美元 / 1M tokens；缓存写入=5m/1h；基础价，不含渠道覆盖）：\n` +
          table(['模型', '输入', '输出', '缓存命中', '缓存写入', '来源'], rows),
      };
    }
    case 'get': {
      const model = rest[0];
      if (!model) return { ok: false, output: '用法：price get <模型名>' };
      const { spec, source } = resolvePrice(model, options);
      const sourceLabel = source === 'global' ? '覆盖' : source === 'builtin' ? '内置' : '默认';
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
      // 无参数 = 查看当前模式；--clear = 清除兜底价（严格计费）；in=/out= = 设置。
      if (rest.includes('--clear') || rest.includes('off')) {
        await setOptions(env, { DefaultPrice: null });
        return { ok: true, output: '已清除兜底价：严格计费启用——查不到价的请求将以 503 model_price_not_configured 拒绝（价格页或 price default in=X out=Y 可随时设回）' };
      }
      if (!rest.length) {
        const dp = options.DefaultPrice;
        return { ok: true, output: dp ? `当前兜底价 $${dp.in} / $${dp.out}（宽松计费：未定价模型按它记账）` : '未设兜底价：严格计费（未定价模型 503 model_price_not_configured）' };
      }
      const kv = kvOf(rest);
      if (!kv.has('in') || !kv.has('out')) return { ok: false, output: '用法：price default in=1 out=3（未知模型的兜底价，只支持常量）| price default --clear（清除，启用严格计费）' };
      const v = validatePriceSpec({ in: Number(kv.get('in')), out: Number(kv.get('out')) });
      if (!v.ok) return { ok: false, output: `兜底价有误：${v.error}` };
      await setOptions(env, { DefaultPrice: v.spec });
      return { ok: true, output: `兜底价已设为 $${v.spec.in} / $${v.spec.out}（宽松计费）` };
    }
    case 'aliases': {
      const prefixPart = `厂商前缀（查价前剥掉）：${ALIAS_PREFIXES.join('  ')}`;
      const aliasRows = Object.entries(PRICE_ALIASES).map(([from, to]) => [from, '→', to]);
      const aliasPart = aliasRows.length
        ? '\n拼写别名（显式映射到规范名，不做自动猜测）：\n' + table(['别名', '', '规范名'], aliasRows)
        : '\n（无拼写别名）';
      return { ok: true, output: prefixPart + aliasPart };
    }
    default:
      return { ok: false, output: '用法：price list [过滤] | get <模型> | set <模型> in=X out=Y [cached=Z] [cw5=A] [cw1=B] | rm <模型> | default in=X out=Y | aliases' };
  }
}

// ---------------------------------------------------------------- billing（模型计费）

async function billingCmd(env: Env, args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  const options = await getOptions(env);

  if (sub === 'check') {
    // 部署前自检：严格/宽松模式 + 启用渠道上的未定价组合。与 npm run audit:llm-billing 同源。
    const channels = await env.DB.prepare('SELECT id, name, type, status, models, model_mapping FROM channels ORDER BY id').all<ChannelRow>();
    const unpriced = findUnpricedChannelModels(channels.results ?? [], options);
    const strict = !fallbackActive(options);
    const lines = [
      strict
        ? '严格计费：未定价模型的请求会被 503 model_price_not_configured 拒绝'
        : `宽松计费：未定价模型按兜底价 $${options.DefaultPrice?.in}/$${options.DefaultPrice?.out} 记账（price default --clear 可切换）`,
      `未定价 (渠道, 模型) 组合：${unpriced.length}`,
    ];
    for (const r of unpriced) {
      // 名字带斜杠却没被任何已登记前缀剥掉 → 大概率是厂商 slug 没登记（ALIAS_PREFIXES），
      // 直接点名，省得对着「未定价」三个字猜。
      const prefixHint = r.requested.includes('/') && stripAliasPrefix(r.requested) === r.requested
        ? ' ⚠ 前缀未登记（ALIAS_PREFIXES，price aliases 可查）'
        : '';
      lines.push(`  - 渠道 #${r.channelId}「${r.channelName}」(${r.channelType})：${r.requested}${r.upstream !== r.requested ? `（上游 ${r.upstream}）` : ''}${prefixHint}`);
    }
    return { ok: unpriced.length === 0 || !strict, output: lines.join('\n') };
  }

  if (sub === 'get') {
    const model = rest[0];
    if (!model) return { ok: false, output: '用法：billing get <模型名>' };
    const report = await loadModelBilling(env.DB, options);
    const row = report.models.find((m) => m.model === model);
    if (!row) return { ok: false, output: `模型 ${model} 不在报表里（未被启用渠道声明，近 7 天也没有日志）` };
    const lines = [
      `${model}：${row.configured ? '已配置' : row.partially_configured ? '部分配置' : '未配置'}${row.active ? '' : '（无启用渠道声明，仅近 7 天日志）'}`,
      `价格：输入 ${fmtRate(row.price?.in)} / 输出 ${fmtRate(row.price?.out)} / 缓存读 ${fmtRate(row.price?.cached_in)} / 写5m ${fmtRate(row.price?.cache_write_5m)} / 写1h ${fmtRate(row.price?.cache_write_1h)}${row.price_varies ? '（⚠ 各渠道价格不一致）' : ''}`,
      `规则：${row.rules.length ? row.rules.join('；') : '—'}`,
      `7 天：${row.usage.requests} 次 / ${row.usage.prompt_tokens}+${row.usage.completion_tokens} tokens / $${row.usage.cost_usd.toFixed(4)}` +
        (row.usage.cache_hit_rate !== null ? ` / 缓存命中 ${(row.usage.cache_hit_rate * 100).toFixed(1)}%` : ' / 缓存未知'),
      ...row.channels.map((ch) =>
        `  - #${ch.id}「${ch.name}」${ch.type} ${ch.enabled ? '启用' : '停用'}${ch.declared ? '' : '（仅日志）'} 上游=${ch.upstream_model} 有价=${ch.configured ? '是' : '否'} 来源=${ch.source ?? '—'}（按${ch.via === 'upstream' ? '上游名' : '请求名'}）`),
    ];
    return { ok: true, output: lines.join('\n') };
  }

  if (sub === undefined || sub === 'list') {
    const filter = rest[0]?.toLowerCase();
    const report = await loadModelBilling(env.DB, options);
    const rows: string[][] = [];
    for (const m of report.models) {
      if (filter && !m.model.toLowerCase().includes(filter)) continue;
      rows.push([
        m.model,
        m.configured ? '✓' : m.partially_configured ? '部分' : '✗',
        fmtRate(m.price?.in),
        fmtRate(m.price?.cached_in),
        m.usage.requests ? String(m.usage.requests) : '—',
        m.usage.requests ? `$${m.usage.cost_usd.toFixed(4)}` : '—',
        (m.sources ?? []).join('/') || '—',
      ]);
    }
    const head =
      `模型 ${report.totals.models} 个，未配置 ${report.totals.unconfigured}；近 7 天 ${report.totals.requests} 次 / $${report.totals.cost_usd.toFixed(4)}；` +
      (report.strict_billing ? '严格计费（未定价拒绝）' : '宽松计费（有兜底价）');
    return { ok: true, output: `${head}\n` + table(['模型', '状态', '输入', '缓存读', '7天请求', '7天消费', '来源'], rows) };
  }

  return { ok: false, output: '用法：billing list [过滤] | billing get <模型名> | billing check' };
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

/*
 * 帮助文本按「每条命令一块」组织：命令行 → 行为 → 示例。
 * help（无参数）输出全部分组 + 通用规则 + 计费速览；help <分组> 只出该组。
 * 改命令时这里必须同步改——帮助与实现漂移比没有帮助更糟。
 */
function helpText(command?: string): string {
  const intro = [
    '个人 API 聚合网关 · 内置命令行',
    '用法：在终端页输入命令；同样的命令也可以用 curl -X POST /api/cli -H "Authorization: Bearer <管理令牌>" -d \'{"command":"..."}\' 使用。',
    '',
    '通用规则：',
    '  · 子命令空格分隔；参数 key=value；开关 --flag value；带空格的值用引号包裹，如 in="4 * (context > 272k ? 2 : 1)"。',
    '  · JSON 参数原样内联（整个作为一个参数），如 channel price 1 \'{"m":{"in":1,"out":2}}\'。',
    '  · <id> 一律是列表第一列的数字编号。',
  ];

  const general = [
    '──────── 通用（general）',
    '',
    'status',
    '  站点概览：余额（美元）、渠道数、可用模型数。',
    'models',
    '  列出全部可用模型（所有启用渠道声明模型的并集，按字母排序）。',
    'owner [show]',
    '  查看 owner 账户余额与用量。',
    'owner add <美元> / owner sub <美元>',
    '  增加 / 扣减预算，写进账本（例：owner add 20）。',
    'logs [n]',
    '  最近 n 条日志，默认 10；含时间、类型、模型、用量、消耗与详情。',
    'health',
    '  近 1 小时各渠道的成功 / 最终失败计数。',
    'reconcile',
    '  账本对账：比对余额与账本流水，报告一切绕过账本的写入。',
    'watchdog [run]',
    '  不带参数看自检心跳；run 立即跑一次自检（对账 + 未定价模型扫描 + 路由缺口恢复探测）。',
  ].join('\n');

  const channel = [
    '──────── 渠道（channel）',
    '',
    'channel list',
    '  渠道列表：ID / 状态 / 类型 / 名称 / 优先级/权重 / 模型。',
    '',
    'channel add <类型> <名称> <base_url> <key> --models m1,m2 [--priority N] [--weight N]',
    '  新建渠道。类型：openai | openai-responses | anthropic | gemini | azure。',
    '  priority 大者优先路由；weight 是同优先级内的随机权重。',
    '  例：channel add openai deepseek https://api.deepseek.com sk-xxx --models deepseek-v4-pro --priority 5',
    '',
    'channel set <id> name=... type=... base_url=... key=... models=a,b priority=N weight=N status=1|2 model_mapping=... config=... system_prompt=...',
    '  按字段修改（一次可改多个）；改 models 自动重建路由索引。',
    '',
    'channel show <id>',
    '  渠道详情 JSON（密钥打码；price_config 回显成对象）。',
    '',
    'channel test <id> [模型]',
    '  直连上游发一个 1-token 请求测连通性，回写测试时间/耗时。',
    '  不传模型 = 该渠道列表第一个；显式传的模型必须属于该渠道（测试带渠道 key，',
    '  不允许变成"拿这把 key 调任意模型"的后门）。',
    '  例：channel test 3 deepseek-v4-pro',
    '',
    'channel pull <id> [--add]',
    '  用渠道 key 请求上游 /models（5 种类型各自适配：OpenAI/Anthropic /v1/models、',
    '  Gemini /v1beta/models 分页并剥 models/ 前缀、Azure 取 deployment 名）。',
    '  默认只打印列表；--add 把列表合并进渠道 models（与现有项去重，手工项保留）。',
    '  例：channel pull 1 --add',
    '',
    'channel price <id> [JSON | --clear]',
    '  该渠道的价格覆盖，仅此渠道生效。优先级：渠道 > 全局覆盖 > 内置表 > 兜底价。',
    '  JSON 形状：{"请求名": {"in":X,"out":Y,"cached_in"?:Z,"cache_write_5m"?:A,"cache_write_1h"?:B}}',
    '  键是渠道 models 里写的名字（请求名）；字段值可写费率表达式（见 help price）。',
    '  路由到本渠道就按这里的价；换渠道时预扣自动退旧开新，渠道间价差不串账。',
    '  不带参数查看当前覆盖；--clear 清空（回到全局价）。',
    '  例：channel price 1 \'{"z-ai/glm-5.3-flash":{"in":0.1,"out":0.5,"cached_in":0.02}}\'',
    '      channel price 1 --clear',
    '',
    'channel on <id> / channel off <id> / channel del <id>',
    '  启用 / 停用 / 删除渠道（off 是手工停用；自动禁用是 status=3）。',
  ].join('\n');

  const token = [
    '──────── 令牌（token）',
    '',
    'token list',
    '  令牌列表：ID / 名称 / 状态 / 剩余额度 / 已用 / 模型限制。',
    '',
    'token new <名称> [--usd N | --unlimited] [--models a,b]',
    '  创建令牌并显示完整密钥（只显示这一次）。--usd 设额度；--unlimited 不限额；',
    '  --models 限制这把 Key 只能调指定模型（逗号分隔，留空 = 全部）。',
    '  例：token new 笔记本 --unlimited --models deepseek-v4-pro,gpt-4o',
    '',
    'token set <id> name=... models=a,b usd=N unlimited=1|0 status=1|2 expired=<unix>',
    '  按字段修改（一次可改多个）；expired 为 unix 秒，-1 = 永不过期。',
    '',
    'token key <id>',
    '  显示完整密钥（sk- 前缀）。',
    '',
    'token on <id> / token off <id> / token del <id>',
    '  启用 / 停用 / 删除令牌。',
    '',
    '  ※ 没有 Key 级价格（曾有，已删）：令牌混用各渠道且渠道间会故障转移，',
    '    在 Key 上定价没有意义——价格跟着渠道走，见 channel price。',
  ].join('\n');

  const price = [
    '──────── 价格（price，美元 / 1M tokens）',
    '',
    '价格优先级：渠道覆盖（channel price）> 全局覆盖（本组命令）> 内置表 > 兜底价。',
    '',
    'price list [过滤]',
    '  价格总表（内置 + 全局覆盖），列：输入/输出/缓存读/缓存写 5m与1h/来源。',
    '  这是**基础价**——不含渠道覆盖；过滤为子串匹配。',
    '',
    'price get <模型>',
    '  查一个模型的生效基础价；表达式字段截断显示（price list 同理）。',
    '',
    'price set <模型> in=X out=Y [cached=Z] [cw5=A] [cw1=B]',
    '  设全局覆盖（对全部渠道生效，直到被渠道价盖住）。字段也可写费率表达式：',
    '  price set my-model in="4 * (context > 272k ? 2 : 1)" out=20',
    '',
    'price rm <模型>',
    '  清除该模型的全局覆盖，回到内置价。',
    '',
    'price default',
    '  查看当前兜底价与计费模式（宽松 / 严格）。',
    'price default in=X out=Y',
    '  设兜底价（宽松计费：未定价模型按它记账，默认 $1/$3）。',
    'price default --clear',
    '  清除兜底价 = 启用严格计费：查不到价的请求直接 503 model_price_not_configured',
    '  （不调上游、不预扣）。补价或设回兜底价即可恢复。',
    '',
    'price aliases',
    '  查两张别名表：厂商前缀（查价前剥掉，如 openai/ deepseek-ai/ z-ai/）和',
    '  拼写别名（显式映射到规范名，如 claude-opus-5.5 → claude-opus-5-5）。',
    '',
    '  费率表达式速查：变量 context（别名 len，输入长度）/ n（数量）；',
    '  探针 param("路径") / header("名") / has(s,子串)；时间 hour/minute/weekday/day/month("时区")；',
    '  数字后缀 272k / 1.5m；运算 + - * / %、比较、&& || !、?:（短路）；',
    '  函数 min/max/abs/ceil/floor/tier("档名",值)。结果 = 该字段的 $/1M 费率。',
  ].join('\n');

  const billing = [
    '──────── 模型计费（billing）',
    '',
    'billing list [过滤]',
    '  模型计费报表：每个模型的状态（已配置/部分/未配置）、费率、近 7 天用量与消费、',
    '  来源（内置/别名/映射/全局/渠道/兜底）。未配置的排最前；过滤为子串匹配。',
    '',
    'billing get <模型>',
    '  单模型详情：生效价格与特殊规则、7 天用量（含缓存命中率）、每个渠道的',
    '  明细（上游模型、有价与否、按请求名还是上游名计费）。',
    '',
    'billing check',
    '  部署前自检：当前是宽松还是严格计费；列出启用渠道上查不到价的',
    '  (渠道, 模型) 组合（渠道价算有价；名字带未登记厂商前缀会点名提示）。',
    '  严格计费下存在未定价组合时以非零退出——CI/脚本可据此拦住部署。',
  ].join('\n');

  const opt = [
    '──────── 系统设置（opt）',
    '',
    'opt list',
    '  全部配置项与当前值（含默认值对照）。',
    'opt set Key=Value [Key=Value ...]',
    '  修改配置，一次可改多项；JSON 值直接写。',
    '  常用项：SystemName（站名）、RetryTimes（消耗配额的重试上限，默认 3）、',
    '  PreConsumedQuota（预扣下限）、ChannelCooldownBaseSec/MaxSec（429 冷却）、',
    '  HealthEventsEnabled（失败事件记录）、DecisionOnlyModels（追加的决策专用模型）。',
    '  例：opt set RetryTimes=5 SystemName=我的网关',
  ].join('\n');

  const sections: Record<string, string> = { general, channel, token, price, billing, opt };
  if (command && sections[command]) return sections[command];
  return [
    ...intro,
    '',
    '命令分组：general(默认) | channel | token | price | billing | opt',
    'help <分组名> 查看该组的详细说明与示例。',
    '',
    general,
    '',
    channel,
    '',
    token,
    '',
    price,
    '',
    billing,
    '',
    opt,
  ].join('\n');
}
