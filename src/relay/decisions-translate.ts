/*
 * TypeSafe System One 与 OpenAI Decisions 两种方言的双向翻译。
 *
 * 事实（2026-11-01 核对，docs.typesafe.ai / apidog / learn.microsoft.com）：
 *   TypeSafe System One：POST /v1/systemone，{model, state, questions:{名字:题}}，
 *     题型 noul/choice/score，answers 按名字键控，choice 的选项描述叫 criteria。
 *   OpenAI Decisions：POST /v1/decisions，{model, input, questions:[题]}，
 *     题型 predicate/choice/score，answers 按顺序数组（可含 refusal），
 *     choice 的选项描述叫 options。
 *
 * 翻译原则：**只翻有把握的结构差异，未知字段一律透传**——决策 API 还在快速演化，
 * 宁可让上游见到多出来的字段（它自己忽略），也不能丢字段或猜语义。
 * 结构映射：state↔input、questions 对象↔数组、noul↔predicate、criteria↔options；
 * answers 按请求翻译时记录的键序回翻（对象插入序在 JSON/JS 里稳定）。
 */
import type { ChannelRow } from '../types';

export type DecisionsDialect = 'systemone' | 'openai';

/** 从请求体识别客户端说的方言；识别不了回 null（调用方按不翻译透传处理）。 */
export function detectDecisionsDialect(body: unknown): DecisionsDialect | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.state !== undefined) return 'systemone';
  if (b.input !== undefined) return 'openai';
  return null;
}

/** 渠道的上游方言：decisions 类型说 OpenAI 方言，systemone 与 openai 兼容渠道
 * （OpenRouter alpha/decisions，Jev 那条老路）说 TypeSafe 方言。 */
export function decisionsDialectOf(channel: Pick<ChannelRow, 'type'>): DecisionsDialect {
  return channel.type === 'decisions' ? 'openai' : 'systemone';
}

/** 已知的题型名与 choice 选项描述字段映射；其余字段透传。 */
const TO_OPENAI: Record<string, string> = { noul: 'predicate' };
const TO_SYSTEMONE: Record<string, string> = { predicate: 'noul' };

function mapQuestionToOpenAI(q: unknown): unknown {
  if (!q || typeof q !== 'object') return q;
  const out: Record<string, unknown> = { ...(q as Record<string, unknown>) };
  if (typeof out.type === 'string' && TO_OPENAI[out.type]) out.type = TO_OPENAI[out.type];
  if (out.criteria !== undefined && out.options === undefined) {
    out.options = out.criteria;
    delete out.criteria;
  }
  return out;
}

function mapQuestionToSystemOne(q: unknown): unknown {
  if (!q || typeof q !== 'object') return q;
  const out: Record<string, unknown> = { ...(q as Record<string, unknown>) };
  if (typeof out.type === 'string' && TO_SYSTEMONE[out.type]) out.type = TO_SYSTEMONE[out.type];
  if (out.options !== undefined && out.criteria === undefined) {
    out.criteria = out.options;
    delete out.options;
  }
  return out;
}

export interface TranslatedRequest {
  body: Record<string, unknown>;
  /**
   * 请求翻译时的键序（SystemOne 侧的问题名）。answers 回翻全靠它：
   * 客户端是 SystemOne 方言时是它发来的真名；客户端是 OpenAI 方言时是合成的 q0/q1…。
   * 方言相同（不翻译）时为 null。
   */
  keys: string[] | null;
}

/** 请求体翻译：from → to。方言相同原样返回。 */
export function translateDecisionsRequest(body: Record<string, unknown>, from: DecisionsDialect, to: DecisionsDialect): TranslatedRequest {
  if (from === to) return { body, keys: null };
  if (from === 'systemone' && to === 'openai') {
    const { state: state, questions: questions, ...rest } = body;
    const qObj = (questions && typeof questions === 'object' && !Array.isArray(questions) ? questions : {}) as Record<string, unknown>;
    const keys = Object.keys(qObj);
    return { body: { ...rest, input: state, questions: keys.map((k) => mapQuestionToOpenAI(qObj[k])) }, keys };
  }
  // openai → systemone
  const { input: input, questions: questionsArr, ...rest } = body;
  const arr = Array.isArray(questionsArr) ? questionsArr : [];
  const qObj: Record<string, unknown> = {};
  arr.forEach((q, i) => (qObj[`q${i}`] = mapQuestionToSystemOne(q)));
  return { body: { ...rest, state: input, questions: qObj }, keys: arr.map((_, i) => `q${i}`) };
}

/** 响应体翻译：answers 数组↔对象（按请求翻译记录的键序）；usage 与其余字段原样。 */
export function translateDecisionsResponse(
  json: unknown,
  from: DecisionsDialect,
  to: DecisionsDialect,
  keys: string[] | null,
): unknown {
  if (!json || typeof json !== 'object' || from === to) return json;
  const { answers, ...rest } = json as Record<string, unknown>;
  if (answers === undefined) return json;
  if (from === 'systemone' && to === 'openai') {
    const obj = (answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {}) as Record<string, unknown>;
    const order = keys ?? Object.keys(obj);
    return { ...rest, answers: order.map((k) => obj[k]) };
  }
  // openai → systemone
  const arr = Array.isArray(answers) ? answers : [];
  const order = keys ?? arr.map((_, i) => `q${i}`);
  const obj: Record<string, unknown> = {};
  order.forEach((k, i) => {
    if (arr[i] !== undefined) obj[k] = arr[i];
  });
  return { ...rest, answers: obj };
}
