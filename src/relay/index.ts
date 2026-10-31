import type { Adaptor } from './adaptor';
import { openaiAdaptor, OPENAI_COMPATIBLE_PRESETS } from './openai';
import { openaiResponsesAdaptor } from './responses';
import { anthropicAdaptor } from './anthropic';
import { geminiAdaptor } from './gemini';
import { azureAdaptor } from './azure';

/**
 * Decision API 专用类型：请求构造/鉴权复用 openai adaptor（Bearer + JSON），
 * 出站路径固定走决策路径（默认 /decide，config.decisions_path 可改）——
 * `decisionsSupport` 见到 type='decisions' 直接放行。chat 请求不会路由到它
 * （这类渠道上的模型自动按决策模型分诊，见 lib/capability.ts）。
 */
export const decisionsAdaptor: Adaptor = {
  ...openaiAdaptor,
  name: 'decisions',
  label: 'Decision API',
  defaultBaseURL: '',
};

export const ADAPTORS: Record<string, Adaptor> = {
  openai: openaiAdaptor,
  'openai-responses': openaiResponsesAdaptor,
  anthropic: anthropicAdaptor,
  gemini: geminiAdaptor,
  azure: azureAdaptor,
  decisions: decisionsAdaptor,
};

export function getAdaptor(type: string): Adaptor {
  return ADAPTORS[type] ?? openaiAdaptor;
}

export { OPENAI_COMPATIBLE_PRESETS };
export * from './adaptor';
export * from './sse';
