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

/**
 * choice 题的选项有三套写法，方向不同、形状也不同：
 *
 *   OpenAI Decisions 入站（Simple Work Agent 这类客户端）：`choices: [{value, description}]`
 *   OpenAI Decisions 文档写法：                            `options: [{value, description}]`
 *   System One（上游，也是 docs.typesafe.ai 的定义）：      `criteria: { 选项名: 描述 }`
 *
 * 上游对 criteria 的形状是**硬校验**的，实测报错原文：
 *   `question 'q0': choice needs a non-empty "criteria" object (option name -> description)`
 * ——所以「把数组原样改名成 criteria」是不行的（曾经就是这么错的，全部 choice 请求 400）。
 */

/** 任意写法 → System One 的 criteria 对象（值 → 描述）。拿不准返回 null。 */
function toCriteria(value: unknown): Record<string, string> | null {
  const out: Record<string, string> = {};
  const put = (name: unknown, description: unknown) => {
    if (typeof name !== 'string' || !name) return;
    out[name] = typeof description === 'string' && description ? description : name;
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') put(item, item);
      else if (item && typeof item === 'object') {
        const it = item as Record<string, unknown>;
        put(it.value ?? it.name ?? it.key ?? it.id, it.description ?? it.desc ?? it.label ?? it.criteria);
      }
    }
  } else if (value && typeof value === 'object') {
    for (const [name, description] of Object.entries(value as Record<string, unknown>)) put(name, description);
  }
  return Object.keys(out).length ? out : null;
}

/** 任意写法 → OpenAI Decisions 的选项数组（[{value, description}]）。拿不准返回 null。 */
function toOptionList(value: unknown): Array<{ value: string; description: string }> | null {
  const criteria = toCriteria(value);
  if (!criteria) return null;
  return Object.entries(criteria).map(([value, description]) => ({ value, description }));
}

function mapQuestionToOpenAI(q: unknown, name: string): unknown {
  if (!q || typeof q !== 'object') return q;
  const out: Record<string, unknown> = { ...(q as Record<string, unknown>) };
  if (typeof out.type === 'string' && TO_OPENAI[out.type]) out.type = TO_OPENAI[out.type];
  // System One 用 questions 的键承载题名，OpenAI Decisions 的数组项要显式 name。
  if (out.name === undefined) out.name = name;
  // criteria 对象 → options 数组（客户端若本来就用 choices，就不动它）。
  if (out.criteria !== undefined && out.options === undefined && out.choices === undefined) {
    const list = toOptionList(out.criteria);
    if (list) out.options = list;
    delete out.criteria;
  }
  return out;
}

function mapQuestionToSystemOne(q: unknown): unknown {
  if (!q || typeof q !== 'object') return q;
  const out: Record<string, unknown> = { ...(q as Record<string, unknown>) };
  if (typeof out.type === 'string' && TO_SYSTEMONE[out.type]) out.type = TO_SYSTEMONE[out.type];
  // choices / options / 数组版 criteria → criteria 对象；name 由 questions 的键承载。
  const src = out.choices ?? out.options ?? out.criteria;
  const criteria = toCriteria(src);
  delete out.choices;
  delete out.options;
  delete out.name;
  if (criteria) out.criteria = criteria;
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
    return { body: { ...rest, input: state, questions: keys.map((k) => mapQuestionToOpenAI(qObj[k], k)) }, keys };
  }
  // openai → systemone
  const { input: input, questions: questionsArr, ...rest } = body;
  const arr = Array.isArray(questionsArr) ? questionsArr : [];
  const qObj: Record<string, unknown> = {};
  // 键优先用题目自带的 name（客户端会用它认答案），没有才合成 q0/q1…
  const keys = arr.map((q, i) => {
    const name = q && typeof q === 'object' ? (q as Record<string, unknown>).name : undefined;
    return typeof name === 'string' && name ? name : `q${i}`;
  });
  keys.forEach((k, i) => (qObj[k] = mapQuestionToSystemOne(arr[i])));
  return { body: { ...rest, state: stateFromInput(input), questions: qObj }, keys };
}

/**
 * OpenAI 方言的 `input` 通常是一段 JSON 文本，而 System One 的 `state` 是结构化对象。
 * 能解析成对象就给出对象（分类器看到的是结构，不是被转义的字符串）；解析不了保持原样
 * ——**绝不猜**，纯文本照样能过。
 */
function stateFromInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const text = input.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return input;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : input;
  } catch {
    return input;
  }
}

/** OpenAI Decisions 的答案字段（choice 型）：多一个少一个客户端都会判为非法响应。 */
const OPENAI_CHOICE_ANSWER_KEYS = ['type', 'name', 'choice', 'confidence', 'probabilities'];

function answerToOpenAI(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object') return value;
  const a: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (a.type === 'noul') a.type = 'predicate';
  // System One 的 probabilities 是 {选项: 概率}，OpenAI 是 [{value, probability}]
  if (a.probabilities && typeof a.probabilities === 'object' && !Array.isArray(a.probabilities)) {
    a.probabilities = Object.entries(a.probabilities as Record<string, unknown>).map(([v, p]) => ({ value: v, probability: p }));
  }
  if (a.type === 'choice') {
    const out: Record<string, unknown> = { name };
    for (const k of OPENAI_CHOICE_ANSWER_KEYS) if (a[k] !== undefined) out[k] = a[k];
    out.type = 'choice';
    return out;
  }
  // 非 choice 题型：字段集各家不同，只改名/加 name，其余透传。
  if (a.name === undefined) a.name = name;
  return a;
}

function answerToSystemOne(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object') return value;
  const a: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (a.type === 'predicate') a.type = 'noul';
  if (Array.isArray(a.probabilities)) {
    const obj: Record<string, unknown> = {};
    for (const p of a.probabilities as any[]) {
      if (p && typeof p === 'object' && typeof p.value === 'string') obj[p.value] = p.probability;
    }
    a.probabilities = obj;
  }
  delete a.name;
  void name;
  return a;
}

/** 响应体翻译：answers 数组↔对象（按请求翻译记录的键序），答案形状按方言改写；usage 与其余字段原样。 */
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
    return { ...rest, answers: order.map((k) => answerToOpenAI(obj[k], k)) };
  }
  // openai → systemone
  const arr = Array.isArray(answers) ? answers : [];
  const order = keys ?? arr.map((_, i) => `q${i}`);
  const obj: Record<string, unknown> = {};
  order.forEach((k, i) => {
    if (arr[i] !== undefined) obj[k] = answerToSystemOne(arr[i], k);
  });
  return { ...rest, answers: obj };
}
