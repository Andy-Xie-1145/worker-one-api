import { type Adaptor, type AdaptorContext, type ChatRequest, joinURL } from './adaptor';
import { openaiAdaptor } from './openai';

const DEFAULT_API_VERSION = '2024-10-21';

/** Azure OpenAI: same payloads as OpenAI, different URL shape and auth header. */
export const azureAdaptor: Adaptor = {
  ...openaiAdaptor,
  name: 'azure',
  label: 'Azure OpenAI',
  defaultBaseURL: '',

  buildRequest(req: ChatRequest, ctx: AdaptorContext) {
    const base = ctx.channel.base_url;
    if (!base) throw new Error('Azure 渠道必须填写 base_url（形如 https://<resource>.openai.azure.com）');
    const apiVersion = ctx.config.api_version || DEFAULT_API_VERSION;
    // The deployment name is the mapped model name.
    const deployment = ctx.config.deployment || ctx.upstreamModel;

    const body: ChatRequest = { ...req, model: ctx.upstreamModel };
    if (body.stream) body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };

    return {
      url: `${joinURL(base, `openai/deployments/${deployment}/${ctx.path}`)}?api-version=${encodeURIComponent(apiVersion)}`,
      headers: { 'Content-Type': 'application/json', 'api-key': ctx.channel.key },
      body: JSON.stringify(body),
    };
  },
};
