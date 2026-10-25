import type { Adaptor } from './adaptor';
import { openaiAdaptor, OPENAI_COMPATIBLE_PRESETS } from './openai';
import { openaiResponsesAdaptor } from './responses';
import { anthropicAdaptor } from './anthropic';
import { geminiAdaptor } from './gemini';
import { azureAdaptor } from './azure';

export const ADAPTORS: Record<string, Adaptor> = {
  openai: openaiAdaptor,
  'openai-responses': openaiResponsesAdaptor,
  anthropic: anthropicAdaptor,
  gemini: geminiAdaptor,
  azure: azureAdaptor,
};

export function getAdaptor(type: string): Adaptor {
  return ADAPTORS[type] ?? openaiAdaptor;
}

export { OPENAI_COMPATIBLE_PRESETS };
export * from './adaptor';
export * from './sse';
