/**
 * 用渠道的 key 请求上游的模型列表（「从上游拉取」按钮的数据源）。
 *
 * 按 5 种渠道类型适配各自的真实端点与鉴权头；只读、只取名字。名字一律做
 * trim / 去空 / 去重 / 截断（上限 5000），Gemini 还要剥 `models/` 前缀——
 * 我们全链路的模型名都是裸名，带前缀存进渠道 models 会让查价和选路双双落空。
 *
 * 错误语义：任何失败都抛 Error，message 已净化（含 HTTP 状态 + 截断的响应文本），
 * 由调用方转成 4xx/5xx——上游错误里可能回显 key，绝不能整段透传。
 */
import { joinURL } from '../relay/adaptor';

const LIST_TIMEOUT_MS = 15_000;
const MAX_MODELS = 5_000;
const MAX_GEMINI_PAGES = 20;

export interface UpstreamListingInput {
  type: string;
  baseUrl: string;
  key: string;
  config?: Record<string, unknown>;
}

function requireBase(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('缺少 base_url');
  if (!/^https?:\/\//i.test(base)) throw new Error('base_url 必须以 http(s):// 开头');
  return base;
}

function clean(names: string[]): string[] {
  return [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))].slice(0, MAX_MODELS);
}

/** 拉一次列表并取出 JSON；非 2xx 抛净化后的错误。 */
async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch (e: any) {
    throw new Error(`请求上游失败：${e?.message ?? e}`);
  }
  if (!resp.ok) {
    let text = '';
    try {
      text = await resp.text();
    } catch {
      text = '';
    }
    // 只取上游自己整理的 error.message（供应商会 curated 这段文案）；整个响应体
    // 可能回显请求头/key，一个字都不透传。
    let detail = '';
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error?.message === 'string') detail = parsed.error.message.slice(0, 200);
      else if (typeof parsed?.message === 'string') detail = parsed.message.slice(0, 200);
    } catch {
      detail = '';
    }
    throw new Error(`上游返回 ${resp.status}${detail ? `：${detail}` : ''}`);
  }
  try {
    return await resp.json<any>();
  } catch {
    throw new Error(`上游返回的不是合法 JSON`);
  }
}

/** 单类型列表器。返回原始名字数组（未清洗）。 */
async function listByType(input: UpstreamListingInput): Promise<string[]> {
  const base = requireBase(input.baseUrl);
  const config = input.config ?? {};
  switch (input.type) {
    case 'openai':
    case 'openai-responses': {
      // OpenAI 形状：GET /v1/models（Bearer）。base 已带 /v1 的渠道也不受影响
      //（joinURL 前会去尾斜杠，但 /v1 重复由用户配置决定——与 relay 的 apiPrefix 行为一致，
      // 这里保守地不在 base 以 /v\d+ 结尾时再加前缀）。
      const prefix = /\/v\d+$/.test(base) ? '' : 'v1/';
      const json = await getJson(joinURL(base, `${prefix}models`), { Authorization: `Bearer ${input.key}` });
      return (json?.data ?? []).map((m: any) => m?.id);
    }
    case 'anthropic': {
      const version = typeof config.api_version === 'string' && config.api_version ? config.api_version : '2023-06-01';
      const json = await getJson(joinURL(base, 'v1/models'), {
        'x-api-key': input.key,
        'anthropic-version': version,
      });
      return (json?.data ?? []).map((m: any) => m?.id);
    }
    case 'gemini': {
      // Gemini：GET /v1beta/models，分页取全（nextPageToken），剥 models/ 前缀。
      const names: string[] = [];
      let pageToken = '';
      for (let page = 0; page < MAX_GEMINI_PAGES; page++) {
        const url = joinURL(base, `v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
        const json = await getJson(url, { 'x-goog-api-key': input.key });
        for (const m of json?.models ?? []) {
          const name = String(m?.name ?? '');
          names.push(name.startsWith('models/') ? name.slice('models/'.length) : name);
        }
        pageToken = typeof json?.nextPageToken === 'string' ? json.nextPageToken : '';
        if (!pageToken) break;
      }
      return names;
    }
    case 'azure': {
      // Azure：deployment 名即模型名（与 relay/azure.ts 的 config.deployment 语义一致）。
      const apiVersion = typeof config.api_version === 'string' && config.api_version ? config.api_version : '2024-10-21';
      const json = await getJson(joinURL(base, `openai/deployments?api-version=${encodeURIComponent(apiVersion)}`), {
        'api-key': input.key,
      });
      const rows: any[] = json?.data ?? json?.value ?? [];
      return rows.map((r) => r?.id ?? r?.deployment ?? r?.name);
    }
    default:
      throw new Error(`不支持的渠道类型：${input.type}`);
  }
}

/** 拉取并清洗（trim/去空/去重/截断）。 */
export async function listUpstreamModels(input: UpstreamListingInput): Promise<string[]> {
  return clean(await listByType(input));
}
