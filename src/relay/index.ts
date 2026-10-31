import type { Adaptor } from './adaptor';
import { openaiAdaptor, OPENAI_COMPATIBLE_PRESETS } from './openai';
import { openaiResponsesAdaptor } from './responses';
import { anthropicAdaptor } from './anthropic';
import { geminiAdaptor } from './gemini';
import { azureAdaptor } from './azure';

/**
 * Decision API 双类型（两种方言）：
 * - `decisions`（OpenAI 方言）：出站 `{base_url}/decisions`，{model, input, questions:[]}，
 *   题型 predicate/choice/score，answers 按序数组；
 * - `systemone`（TypeSafe 方言）：出站 `{base_url}/systemone`，{model, state, questions:{}}，
 *   题型 noul/choice/score，answers 按名键控。
 *
 * **版本段属于 base_url**（v1/v2/v3 由运维填，如 https://api.typesafe.ai/v1），
 * 网关只往后拼端点名——不注入、不剥除任何 /vN，与 chat/completions 同待遇。
 *
 * 请求构造/鉴权复用 openai adaptor；方言翻译见 decisions-translate.ts——
 * 任一入站方言可调任一上游（与 chat 翻译器同一哲学）。chat 请求不会路由到它们
 * （这两类渠道上的模型自动按决策模型分诊，见 lib/capability.ts）。
 */
export const decisionsAdaptor: Adaptor = {
  ...openaiAdaptor,
  name: 'decisions',
  label: 'Decision API',
  defaultBaseURL: 'https://api.openai.com/v1',
};

export const systemoneAdaptor: Adaptor = {
  ...openaiAdaptor,
  name: 'systemone',
  label: 'System One（TypeSafe）',
  defaultBaseURL: 'https://api.typesafe.ai/v1',
};

export const ADAPTORS: Record<string, Adaptor> = {
  openai: openaiAdaptor,
  'openai-responses': openaiResponsesAdaptor,
  anthropic: anthropicAdaptor,
  gemini: geminiAdaptor,
  azure: azureAdaptor,
  decisions: decisionsAdaptor,
  systemone: systemoneAdaptor,
};

export function getAdaptor(type: string): Adaptor {
  return ADAPTORS[type] ?? openaiAdaptor;
}

export { OPENAI_COMPATIBLE_PRESETS };
export * from './adaptor';
export * from './sse';
