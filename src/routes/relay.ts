import { Hono } from 'hono';
import { type Env, type Vars, type ChannelRow, type TokenRow, type UserRow, ChannelStatusAutoDisabled } from '../types';
import { authenticateToken, parseTokenPriceConfig } from '../lib/auth';
import { getOptions, type Options } from '../lib/options';
import { preConsume, postConsume, refund, type Usage } from '../lib/billing';
import { calcQuota, resolvePrice, isExprSpec, quotaToUSD, QUOTA_PER_USD, type PriceSpec } from '../lib/pricing';
import { selectChannel, mapModel, parseConfig, listModels, csv } from '../lib/channel';
import { markRateLimited, clearRateLimit } from '../lib/cooldown';
import {
  markDenied403, clearDenied403, extractDeniedMessage, UNKNOWN_COLO, DENY_403_FALLBACK_MESSAGE,
} from '../lib/deny403';
import { recordRelayEvents, type RelayEvent } from '../lib/health';
import { alertRouteGap } from '../lib/route-alert';
import { getAdaptor } from '../relay';
import { type AdaptorContext, type ChatRequest, type RelayMode, newStreamState } from '../relay/adaptor';
import { readSSE, sseChunk, SSE_DONE, SSE_HEADERS } from '../relay/sse';
import { estimateUsage } from '../relay/openai';
import { DECISIONS_PATH, decisionsPromptPayload, decisionsSupport, estimateDecisionsUsage } from '../relay/decisions';
import {
  ResponsesInboundError, responsesToChatRequest, chatResponseToResponses,
  newResponsesEncoder, encodeResponsesChunk, finishResponsesStream, responsesErrorEvent,
} from '../relay/responses-inbound';
import {
  GeminiInboundError, geminiToChatRequest, chatResponseToGemini,
  newGeminiEncoder, encodeGeminiChunk, finishGeminiStream, geminiErrorEvent,
} from '../relay/gemini-inbound';
import { filterByCapability, isDecisionOnlyModel } from '../lib/capability';
import {
  type AnthropicRequest,
  anthropicToChatRequest,
  chatResponseToAnthropic,
  encodeAnthropicChunk,
  finishAnthropicStream,
  newAnthropicEncoder,
  anthropicError,
} from '../relay/anthropic-inbound';

const relay = new Hono<{ Bindings: Env; Variables: Vars }>();

const UPSTREAM_TIMEOUT_MS = 120_000;

function errorBody(message: string, type = 'one_api_error', code?: string) {
  return { error: { message, type, code: code ?? null } };
}

/**
 * GET /v1/models — the model list across all enabled channels.
 *
 * 默认只列 chat 能力的模型。decision-only 的（Jev）**必须**被挡在外面：这份列表
 * 是各种客户端的模型选择器直接消费的，露出去就等于邀请它们把 Jev 发去
 * chat/completions。想要那份名单的，带 ?capability=decisions 显式来问。
 */
relay.get('/models', async (c) => {
  const auth = await authenticateToken(c.env, c.req.header('Authorization') ?? '');
  if ('error' in auth) return c.json(errorBody(auth.error), auth.status as 401 | 403);
  const capability = c.req.query('capability') === 'decisions' ? 'decisions' : 'chat';
  const options = await getOptions(c.env);
  const models = filterByCapability(await listModels(c.env), capability, options);
  const allowed = csv(auth.token.models);
  const visible = allowed.length ? models.filter((m) => allowed.includes(m)) : models;
  return c.json({
    object: 'list',
    data: visible.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'one-api' })),
  });
});

relay.get('/models/:model', (c) =>
  c.json({ id: c.req.param('model'), object: 'model', created: 1700000000, owned_by: 'one-api' }),
);

/**
 * GET /v1/pricing — 用这把 Key 调用时的**实际价格表**。
 *
 * 内置价格表在这里外显：四级优先（Key 覆盖 > 全局覆盖 > 内置表 > 默认价）解析后的
 * 每个模型都带 `source` 标注来源。客户端/脚本可以据此在调用前算出成本；
 * 管理端的全量视图（含内置表原文与全局覆盖）在 `GET /api/pricing`。
 */
relay.get('/pricing', async (c) => {
  const auth = await authenticateToken(c.env, c.req.header('Authorization') ?? '');
  if ('error' in auth) return c.json(errorBody(auth.error), auth.status as 401 | 403);
  const capability = c.req.query('capability') === 'decisions' ? 'decisions' : 'chat';
  const options = await getOptions(c.env);
  const keyOverrides = parseTokenPriceConfig(auth.token);
  const models = filterByCapability(await listModels(c.env), capability, options);
  const allowed = csv(auth.token.models);
  const visible = allowed.length ? models.filter((m) => allowed.includes(m)) : models;
  return c.json({
    object: 'list',
    quota_per_usd: QUOTA_PER_USD,
    unit: 'USD per 1M tokens',
    data: visible.map((model) => {
      const { spec, source } = resolvePrice(model, options, undefined, keyOverrides);
      return {
        model,
        object: 'model_pricing',
        source,
        price: isExprSpec(spec) ? { expr: spec.expr } : { in: spec.in, out: spec.out, ...(spec.cached_in !== undefined ? { cached_in: spec.cached_in } : {}) },
      };
    }),
  });
});

/**
 * User-facing balance, in money.
 *
 * The launcher's usage panel reads this. The legacy relay reported raw token
 * counts, which stopped meaning anything once models had different prices —
 * this reports the amount actually charged instead.
 */
relay.get('/usage', async (c) => {
  const auth = await authenticateToken(c.env, c.req.header('Authorization') ?? '');
  if ('error' in auth) return c.json(errorBody(auth.error, 'authentication_error'), auth.status as 401 | 403);
  const { user, token } = auth;

  const since = Math.floor(Date.now() / 1000) - 86400;
  const day = await c.env.DB.prepare(
    'SELECT COUNT(*) AS requests, COALESCE(SUM(quota),0) AS quota, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens FROM logs WHERE user_id = ? AND type = 2 AND created_at >= ?',
  )
    .bind(user.id, since)
    .first<{ requests: number; quota: number; tokens: number }>();

  return c.json({
    user_id: user.id,
    email: user.email || null,
    currency: 'USD',
    quota_per_usd: QUOTA_PER_USD,
    // Balance is the user's; the token may additionally cap what this key can spend.
    balance: user.quota,
    balance_usd: quotaToUSD(user.quota),
    used_quota: user.used_quota,
    used_usd: quotaToUSD(user.used_quota),
    token_name: token.name,
    token_unlimited: !!token.unlimited_quota,
    token_remaining: token.unlimited_quota ? null : token.remain_quota,
    token_remaining_usd: token.unlimited_quota ? null : quotaToUSD(token.remain_quota),
    request_count: user.request_count,
    last_24h: {
      requests: day?.requests ?? 0,
      quota: day?.quota ?? 0,
      usd: quotaToUSD(day?.quota ?? 0),
      tokens: day?.tokens ?? 0,
    },
  });
});

relay.post('/chat/completions', (c) => handleRelay(c, 'chat', 'chat/completions'));
relay.post('/completions', (c) => handleRelay(c, 'completions', 'completions'));
relay.post('/embeddings', (c) => handleRelay(c, 'embeddings', 'embeddings'));

/**
 * POST /v1/decisions — OpenRouter Decisions API（Jev）。
 *
 * 形状归 relay/decisions.ts，其余一个字节都不另起炉灶：鉴权、令牌模型权限、
 * 预扣、选渠道、429 冷却、重试、结算/退款、relay_events 全走 handleRelay。
 * 单独实现一遍的代价不是多写几行，是两套计费逻辑从第二次改动起就开始漂移。
 */
relay.post('/decisions', (c) => handleRelay(c, 'decisions', DECISIONS_PATH));

/**
 * Native Anthropic Messages API.
 *
 * 个人客户端把 Claude Code / OpenClaw 指到这里（ANTHROPIC_BASE_URL），所以
 * 请求和响应都必须是 Anthropic 形状——但选路、计费、重试与 /v1 是同一套机器，
 * 只在边缘换协议。
 */
export const anthropicRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
anthropicRoute.post('/v1/messages', (c) => handleRelay(c, 'chat', 'chat/completions', 'anthropic'));

/**
 * 入站 OpenAI Responses API（协议翻译器）。
 *
 * 客户端说 Responses，网关翻成中枢 chat 形状去选路/计费/重试，再把响应翻回
 * Responses——上游渠道是什么方言与客户端无关（翻译器语义见 relay/responses-inbound.ts）。
 */
relay.post('/responses', (c) => handleRelay(c, 'chat', 'chat/completions', 'responses'));

/**
 * 入站 Google Gemini generateContent（协议翻译器）。
 *
 * URL：`/gemini/v1beta/models/{model}:generateContent`（或 `:streamGenerateContent?alt=sse`）；
 * 也接受 `/v1/gemini/v1beta/models/...` 变体。鉴权用 `x-goog-api-key` 头
 * （也接受 Authorization Bearer）。模型名在 URL 里，请求体没有 model 字段——
 * 从路径解析出来塞进 ChatRequest。
 */
export function geminiHandler(c: any) {
  const tail = c.req.path.replace(/^\/(?:v1\/)?gemini\/v1beta\/models\//, '');
  const colon = tail.lastIndexOf(':');
  const model = colon > 0 ? tail.slice(0, colon) : '';
  const action = colon > 0 ? tail.slice(colon + 1) : '';
  if (!model || (action !== 'generateContent' && action !== 'streamGenerateContent')) {
    return c.json({ error: { code: 404, message: `未知的 Gemini 端点：${tail}`, status: 'NOT_FOUND' } }, 404);
  }
  if (action === 'streamGenerateContent' && new URL(c.req.url).searchParams.get('alt') !== 'sse') {
    return c.json({ error: { code: 400, message: '流式仅支持 streamGenerateContent?alt=sse（官方 SDK 的默认走法）', status: 'INVALID_ARGUMENT' } }, 400);
  }
  return handleRelay(c, 'chat', 'chat/completions', 'gemini', { urlModel: model, forceStream: action === 'streamGenerateContent' });
}

relay.post('/gemini/v1beta/models/*', geminiHandler);

/** 根级挂载（index.ts）：README 写的 /gemini/v1beta/... 走这里。 */
export const geminiRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
geminiRoute.post('/v1beta/models/*', geminiHandler);

type Protocol = 'openai' | 'anthropic' | 'responses' | 'gemini';

async function handleRelay(
  c: any,
  mode: RelayMode,
  path: string,
  protocol: Protocol = 'openai',
  via?: { urlModel?: string; forceStream?: boolean },
): Promise<Response> {
  const started = Date.now();
  const fail = (message: string, type: string, status: number) => {
    if (protocol === 'anthropic') return c.json(anthropicError(message, type), status);
    if (protocol === 'gemini') {
      const statusText = status === 400 ? 'INVALID_ARGUMENT' : status === 401 ? 'UNAUTHENTICATED' : status === 503 ? 'UNAVAILABLE' : 'INTERNAL';
      return c.json({ error: { code: status, message, status: statusText } }, status);
    }
    return c.json(errorBody(message, type), status);
  };

  // Anthropic clients authenticate with x-api-key; OpenAI ones with Authorization;
  // Gemini ones with x-goog-api-key.
  const credential =
    c.req.header('Authorization') ?? c.req.header('x-api-key') ?? c.req.header('x-goog-api-key') ?? '';
  const auth = await authenticateToken(c.env, credential);
  if ('error' in auth) return fail(auth.error, 'authentication_error', auth.status);
  const { token, user } = auth;

  let body: ChatRequest;
  let inbound: AnthropicRequest | null = null;
  try {
    const raw = await c.req.json();
    if (protocol === 'anthropic') {
      inbound = raw as AnthropicRequest;
      body = anthropicToChatRequest(inbound);
    } else if (protocol === 'responses') {
      body = responsesToChatRequest(raw);
    } else if (protocol === 'gemini') {
      body = geminiToChatRequest(raw, via?.urlModel ?? '');
    } else {
      body = raw;
    }
  } catch (e) {
    if (e instanceof ResponsesInboundError || e instanceof GeminiInboundError) return fail(e.message, 'invalid_request_error', 400);
    return fail('请求体不是合法的 JSON', 'invalid_request_error', 400);
  }
  if (via?.urlModel) body.model = via.urlModel;
  if (via?.forceStream) body.stream = true;

  const requestedModel = String(body.model ?? '');
  if (!requestedModel) return fail('缺少 model 字段', 'invalid_request_error', 400);

  const allowed = csv(token.models);
  if (allowed.length && !allowed.includes(requestedModel)) {
    return fail(`令牌无权访问模型 ${requestedModel}`, 'permission_error', 403);
  }

  const options = await getOptions(c.env);
  /*
   * 这个 Key 的按模型价格配置。查价优先级：Key 覆盖 > 全局覆盖 > 内置表 > 默认价，
   * 见 lib/pricing/llm.ts 的 resolvePrice()。预扣和结算必须用同一份，否则找平会错。
   */
  const keyOverrides = parseTokenPriceConfig(token);

  /*
   * 能力分诊，在花掉任何额度之前。
   *
   * 两个方向都要拦：decision-only 模型走 chat/completions 会在上游拿到一个
   * 语焉不详的 404，而普通模型走 /v1/decisions 会被 OpenRouter 拒；两种都是
   * 客户端选错了门，说清楚是哪扇门比转发一个上游错误有用得多。
   */
  const decisionOnly = isDecisionOnlyModel(requestedModel, options);
  if (mode === 'decisions' && !decisionOnly) {
    return fail(`模型 ${requestedModel} 不是决策模型，请改用 /v1/chat/completions`, 'invalid_request_error', 400);
  }
  if (mode !== 'decisions' && decisionOnly) {
    return fail(`模型 ${requestedModel} 只支持决策接口，请改用 POST /v1/decisions`, 'invalid_request_error', 400);
  }
  /*
   * Decisions 不是流式接口，`stream: true` 就是调用错误，明说。
   *
   * 早先这里是静默 `delete body.stream`。那样请求确实能成，但客户端会一直以为自己
   * 拿到的是流——它等的那个 SSE 永远不来，而网关这边一切正常，没有任何一处会记下
   * 「有人在按流式用一个非流式接口」。改写客户端的请求是在替它把 bug 藏起来。
   */
  if (mode === 'decisions' && body.stream) {
    return fail('决策接口不支持流式（stream），请去掉该字段后重试', 'invalid_request_error', 400);
  }

  /*
   * Pre-charge an estimate so concurrent requests cannot overdraw the balance.
   *
   * 两个 ref 是一对：预留写 `pre:…`，结束时（无论结算还是退款）写同后缀的 `fin:…`。
   * 于是「有 pre 没有 fin」= 这笔预留没人认领，回收器据此把钱退回去
   * （lib/watchdog.ts 的 reclaimAbandonedReservations）。客户端半路断开时整个请求
   * 会被运行时拆掉，postConsume / refund 都没机会执行——那种情况只能事后对账。
   *
   * tokenId 编进 ref 里，是因为退款还要还 tokens.remain_quota，而 credits 行里没有
   * 任何一列能找回是哪个令牌。
   *
   * 估算本身不改：它发生在选渠道之前，还不知道上游模型是谁，因此查不到别名的真实
   * 价格，最后多半落到 PreConsumedQuota 那个下限上。偏小是安全的——postConsume 会
   * 按真实价找平。
   */
  const preConsumed = estimatePreConsume(body, requestedModel, options, mode, keyOverrides);
  const reserveRef = `pre:${token.id}:${crypto.randomUUID()}`;
  const settleRef = `fin:${reserveRef.slice(4)}`;
  const pre = await preConsume(c.env, token, user, preConsumed, reserveRef);
  if (!pre.ok) return fail(pre.message ?? '额度不足', 'insufficient_quota', 403);

  const tried: number[] = [];
  /*
   * RetryTimes 是**消耗配额的尝试**（5xx/408/429/401）的上限，不是循环轮次上限。
   * 403 换渠道不占配额：它语义上是「这家拒了，下一家可能就过」，第 4、5 个可用
   * 渠道不该因为 RetryTimes=3 被漏掉。配额计数（quotaAttempts）与轮次计数
   * （round）分开推进；死循环不存在——每个真正尝试过的渠道都进 tried，
   * selectChannel 绝不重复给出，候选耗尽/全部熔断时循环必然退出。
   */
  const maxAttempts = Math.max(1, options.RetryTimes ?? 3);
  let quotaAttempts = 0;
  let round = 0;
  let lastError: { status: number; body: unknown } | null = null;

  /*
   * 403 软熔断的第三维度：机房（colo）。同一个渠道在不同机房面对的地区策略可以
   * 完全不同，所以熔断 key 必须带上它。本地/测试环境没有 cf，统一落到 UNKNOWN
   * 这个共享命名空间——宁可少熔断一阵，也不能因为取不到机房就把 key 拼歪。
   */
  const colo = typeof (c.req.raw as any)?.cf?.colo === 'string' ? (c.req.raw as any).cf.colo : UNKNOWN_COLO;

  /*
   * 失败事件攒在这里，退出前一次性写（lib/health.ts）。
   *
   * 攒起来而不是每个分支各写一次：一个用满重试的请求会产生 3~4 条事件，逐条写
   * 就是逐条往 D1 打一个往返。成功路径一条都不产生，postConsume 那边已经记过了。
   */
  const events: RelayEvent[] = [];
  const flushEvents = (): Promise<void> | undefined => {
    if (!events.length || options.HealthEventsEnabled === false) return;
    const written = recordRelayEvents(c.env, events.splice(0));
    c.executionCtx?.waitUntil?.(written);
    return written;
  };

  while (quotaAttempts < maxAttempts) {
    const attempt = round++;
    const selection = await selectChannel(c.env, requestedModel, tried, colo);
    if (!selection) {
      /*
       * 「没有可用渠道」必须带着**客户端请求的那个模型串**落库。
       *
       * 这条 503 的报文里一直有模型名，但它只存在于那一次 HTTP 响应里，没人记。
       * 结果就是线上 72% 的请求在这里失败了整晚，事后却查不出到底是哪个模型没配
       * ——只能开 tail 蹲现场。这一行就是为了让那种蹲守再也不必发生。
       */
      events.push({
        stage: 'no_channel',
        status: 503,
        modelName: requestedModel,
        userId: user.id,
        attempt,
        final: attempt === 0,
        errorCode: 'no_channel',
      });

      if (attempt === 0) {
        const written = flushEvents();
        /*
         * 路由缺口告警（lib/route-alert.ts）。排在事件落库之后，「近 1 小时次数」才含本次；
         * 挂 waitUntil，不占这条 503 的响应时间。alertRouteGap 自己吞异常、自己冷却去重。
         */
        c.executionCtx?.waitUntil?.(
          Promise.resolve(written).then(() => alertRouteGap(c.env, { model: requestedModel })),
        );
        await refund(c.env, token, user, preConsumed, settleRef);
        return fail(`没有可用于模型 ${requestedModel} 的渠道`, 'invalid_request_error', 503);
      }
      break;
    }

    /*
     * 候选全部处于**仍有效**的 403 软熔断：一个上游请求都不发，直接回 403。
     *
     * message 复用最早到期记录缓存的上次上游文案——客户端靠它识别「OpenRouter
     * TOS 拒绝」这类可读原因；没有缓存就用中性文案，不猜原因、也不谎称一定是
     * 地区限制。注意这不是 no_channel（503）：模型配置着呢，只是这一阵全被拒。
     */
    if (selection.kind === 'all_denied_403') {
      events.push({
        stage: 'deny403',
        status: 403,
        modelName: requestedModel,
        userId: user.id,
        attempt,
        final: true,
        errorCode: 'all_channels_denied_403',
        errorText: selection.earliest.message ?? '',
      });
      flushEvents();
      await refund(c.env, token, user, preConsumed, settleRef);
      return fail(selection.earliest.message ?? DENY_403_FALLBACK_MESSAGE, 'permission_error', 403);
    }

    const channel = selection.channel;
    tried.push(channel.id);

    const attemptStarted = Date.now();
    const result = await attemptUpstream(c, {
      channel, body, requestedModel, mode, path, token, user, options, keyOverrides, preConsumed, settleRef, started, protocol,
    });
    if (result.kind === 'ok') {
      // 成功即清掉退避计数，否则偶发限流会让这个渠道一直踩着上次的档位往上爬
      c.executionCtx?.waitUntil?.(clearRateLimit(c.env, channel.id));
      // 403 软熔断同理：这个组合又能用了（探测成功或正常成功），立刻恢复
      c.executionCtx?.waitUntil?.(clearDenied403(c.env, channel.id, requestedModel, colo));
      flushEvents(); // 前几次尝试的失败照记：用户拿到了结果，但那些渠道确实坏着
      return result.response;
    }

    /*
     * 每次尝试各记一条，带 channel_id。渠道健康度就是从这里来的——
     * 只记最终失败的话，「3 个渠道试了 2 个才成功」这种半坏状态永远看不见。
     */
    events.push({
      stage: result.stage,
      status: result.status,
      modelName: requestedModel,
      upstreamModel: mapModel(channel, requestedModel),
      channelId: channel.id,
      channelType: channel.type,
      userId: user.id,
      attempt,
      final: false,
      elapsedMs: Date.now() - attemptStarted,
      errorText: result.errorText,
    });

    lastError = { status: result.status, body: result.body };
    if (shouldAutoDisable(result.status)) {
      // 401 与其它有限重试的错误一样占配额：key 失效重试几个渠道就该到头了。
      quotaAttempts++;
      await autoDisableChannel(c.env, channel, result.status);
    } else if (result.status === 403) {
      /*
       * 403 软熔断（lib/deny403.ts）：记下 channel+model+colo 这个组合被拒，
       * 30 分钟内同组合的选路直接绕开；本次请求继续走循环里的下一个渠道。
       *
       * **不占 RetryTimes 配额**：拒掉的渠道再多，只要还有未尝试且未熔断的候选
       * 就继续试——配额耗尽时的「漏掉第 4 个可用渠道」正是这里要避免的。
       *
       * 必须 await：紧接着的下一个请求要立刻看到这条记录，异步写会跟它赛跑，
       * 让熔断在最需要它的头几秒里形同虚设。KV 写失败在 markDenied403 内部
       * 已经 fail-open，await 不会把网关打挂。403 也不下线 abilities——渠道
       * 对别的模型/机房可能完全正常。
       */
      await markDenied403(c.env, channel.id, requestedModel, colo, extractDeniedMessage(result.body));
    } else if (result.status === 429) {
      /*
       * 限流不是渠道坏了，只是这一阵不能用，所以按住一段时间而不是永久禁用。
       * 必须 await：本次请求的后续重试要立刻看到这条冷却，否则同一个循环里
       * selectChannel 还会把它算作可用。
       */
      const seconds = await markRateLimited(c.env, channel.id, options.ChannelCooldownBaseSec, options.ChannelCooldownMaxSec);
      if (seconds) console.log(`[cooldown] 渠道 ${channel.id}「${channel.name}」返回 429，冷却 ${seconds}s`);
      quotaAttempts++; // 429 占配额：冷却重试是有限次退避，不是无限换渠道
    }
    /*
     * 其余 4xx（400/404…）是调用方的错，换渠道无济于事，立刻停止（无需占配额，
     * 循环马上就要退出了）。
     */
    else if (result.status < 500 && result.status !== 408 && result.status !== 403) break;
    // 5xx/408：上游侧/超时问题，占配额的有限重试。
    else quotaAttempts++;
  }

  // 走到这里 = 所有渠道都试过了还是失败，这条就是用户看到的那次。
  if (lastError) {
    events.push({
      stage: 'upstream',
      status: lastError.status,
      modelName: requestedModel,
      userId: user.id,
      attempt: tried.length,
      final: true,
      elapsedMs: Date.now() - started,
      errorCode: 'all_channels_failed',
      errorText: typeof (lastError.body as any)?.error?.message === 'string' ? (lastError.body as any).error.message : '',
    });
  }
  flushEvents();

  await refund(c.env, token, user, preConsumed, settleRef);
  if (protocol === 'anthropic') {
    const message = typeof (lastError?.body as any)?.error?.message === 'string' ? (lastError!.body as any).error.message : '上游渠道全部失败';
    return c.json(anthropicError(message, 'api_error'), (lastError?.status ?? 502) as any);
  }
  return c.json(lastError?.body ?? errorBody('上游渠道全部失败', 'upstream_error'), (lastError?.status ?? 502) as any);
}

interface AttemptArgs {
  channel: ChannelRow;
  body: ChatRequest;
  requestedModel: string;
  mode: RelayMode;
  path: string;
  token: TokenRow;
  user: UserRow;
  options: Options;
  /** 这个 Key 的按模型价格配置，见 handleRelay 里的说明。 */
  keyOverrides: Record<string, PriceSpec>;
  preConsumed: number;
  /** 结算/退款共用的账本标识，见上面 reserveRef 那段注释。 */
  settleRef: string;
  started: number;
  protocol: Protocol;
}

/*
 * 失败变体多带两个字段，专门给 relay_events 用。
 *
 * 不这么做的话，调用方只能拿着 status 和一个 unknown body 反过来猜「这次是渠道
 * 配置错了、网络断了，还是上游真的返回了错误」——三种情况的处理完全不同，猜是猜
 * 不出来的，而这里本来就知道。
 */
type AttemptResult =
  | { kind: 'ok'; response: Response }
  | { kind: 'error'; status: number; body: unknown; stage: 'build' | 'network' | 'upstream'; errorText: string };

async function attemptUpstream(c: any, args: AttemptArgs): Promise<AttemptResult> {
  const { channel, body, requestedModel, mode, path, token, user, options, keyOverrides, preConsumed, settleRef, started, protocol } = args;

  const upstreamModel = mapModel(channel, requestedModel);
  const config = parseConfig(channel);
  const ctx: AdaptorContext = { channel, upstreamModel, requestedModel, mode, path, config };
  const adaptor = getAdaptor(channel.type);

  /*
   * 决策能力在**发出任何请求之前**核一遍，而且是按渠道核，不是按 adaptor 类型。
   *
   * 500 这个状态码是有意的：handleRelay 只在 <500 时停止重试，所以一个配错的渠道
   * 会被跳过、循环继续去试下一个候选（真正的 OpenRouter 渠道通常优先级更低，排在
   * 后面）。若这里回 4xx，一次配置错误就会把整条模型路径打死。
   */
  if (mode === 'decisions') {
    const support = !adaptor.supportsDecisions
      ? { ok: false as const, reason: `渠道类型 ${channel.type} 不是 OpenAI 形状` }
      : decisionsSupport(channel, config);
    if (!support.ok) {
      const message = `渠道 ${channel.name} 不支持决策接口：${support.reason}`;
      return { kind: 'error', status: 500, body: errorBody(message), stage: 'build', errorText: message };
    }
    // 路径由渠道决定（config.decisions_path 可覆盖），不用路由里写死的那个。
    ctx.path = support.path;
  }

  let built;
  try {
    built = adaptor.buildRequest(body, ctx);
  } catch (e: any) {
    const message = `渠道 ${channel.name} 配置错误: ${e?.message ?? e}`;
    return { kind: 'error', status: 500, body: errorBody(message), stage: 'build', errorText: message };
  }

  let upstream: Response;
  try {
    upstream = await fetch(built.url, {
      method: 'POST',
      headers: built.headers,
      body: built.body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e: any) {
    const message = `请求渠道 ${channel.name} 失败: ${e?.message ?? e}`;
    return { kind: 'error', status: 502, body: errorBody(message, 'upstream_error'), stage: 'network', errorText: message };
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = errorBody(text.slice(0, 2000) || `上游返回 ${upstream.status}`, 'upstream_error');
    }
    return { kind: 'error', status: upstream.status, body: parsed, stage: 'upstream', errorText: text };
  }

  if (!body.stream || !upstream.body) {
    const json = await upstream.json<any>();
    const { body: converted, usage } = adaptor.convertResponse(json, ctx);
    /*
     * 上游没报 usage 时的兜底。Decisions 走自己的估算：它的提示词在 state/
     * questions 里，chat 那版会把它看成空串，于是 Jev 每次都按 0 token 免费结算。
     */
    const finalUsage =
      usage.prompt_tokens || usage.completion_tokens
        ? usage
        : mode === 'decisions'
          ? estimateDecisionsUsage(body)
          : estimateUsage(body, newStreamState());
    c.executionCtx.waitUntil(
      postConsume(c.env, {
        token, user, channelId: channel.id, modelName: requestedModel, upstreamModel: ctx.upstreamModel,
        usage: finalUsage, preConsumed, options, keyOverrides, elapsedMs: Date.now() - started, settleRef,
      }),
    );
    const payload =
      protocol === 'anthropic' ? chatResponseToAnthropic(converted, requestedModel)
      : protocol === 'responses' ? chatResponseToResponses(converted, requestedModel)
      : protocol === 'gemini' ? chatResponseToGemini(converted, requestedModel)
      : converted;
    return {
      kind: 'ok',
      response: new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-OneAPI-Channel': String(channel.id) },
      }),
    };
  }

  return { kind: 'ok', response: streamResponse(c, upstream, adaptor, ctx, args) };
}

/**
 * Pipes the upstream SSE through the adaptor's converter without buffering,
 * accumulating usage so billing can be settled once the stream ends.
 */
function streamResponse(c: any, upstream: Response, adaptor: ReturnType<typeof getAdaptor>, ctx: AdaptorContext, args: AttemptArgs): Response {
  const { channel, body, requestedModel, token, user, options, keyOverrides, preConsumed, settleRef, started, protocol } = args;
  const encoder = new TextEncoder();
  const state = newStreamState();
  // Anthropic's stream is explicitly bracketed, so it needs its own state
  // across chunks; the OpenAI path just forwards what the adaptor produced.
  // 入站 Responses 同理：chat chunk 要翻成 response.* SSE 事件序列。
  const anthropic = protocol === 'anthropic' ? newAnthropicEncoder() : null;
  const responsesEnc = protocol === 'responses' ? newResponsesEncoder() : null;
  const geminiEnc = protocol === 'gemini' ? newGeminiEncoder() : null;
  let usage: Usage | undefined;
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    const finalUsage = usage ?? estimateUsage(body, state);
    c.executionCtx.waitUntil(
      postConsume(c.env, {
        token, user, channelId: channel.id, modelName: requestedModel, upstreamModel: ctx.upstreamModel,
        usage: finalUsage, preConsumed, options, keyOverrides, elapsedMs: Date.now() - started, settleRef,
      }),
    );
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of readSSE(upstream.body!)) {
          const out = adaptor.convertStreamEvent(event, ctx, state);
          if (out.usage && (out.usage.prompt_tokens || out.usage.completion_tokens)) usage = out.usage;
          for (const chunk of out.chunks) {
            const text = anthropic
              ? encodeAnthropicChunk(chunk, requestedModel, anthropic)
              : responsesEnc
                ? encodeResponsesChunk(responsesEnc, chunk, requestedModel)
                : geminiEnc
                  ? encodeGeminiChunk(geminiEnc, chunk, requestedModel)
                  : sseChunk(chunk);
            controller.enqueue(encoder.encode(text));
          }
          if (out.done) break;
        }
        const tail = anthropic
          ? finishAnthropicStream(anthropic, usage)
          : responsesEnc
            ? finishResponsesStream(responsesEnc, requestedModel, usage)
            : geminiEnc
              ? finishGeminiStream(geminiEnc, requestedModel, usage)
              : SSE_DONE;
        controller.enqueue(encoder.encode(tail));
      } catch (e: any) {
        const message = `流式传输中断: ${e?.message ?? e}`;
        /*
         * 客户端早就拿到 200 了，所以这次不算进用户可见的失败率（final=0），
         * 但渠道确实断在半路上，健康度必须看得见。
         */
        if (options.HealthEventsEnabled !== false) {
          c.executionCtx?.waitUntil?.(
            recordRelayEvents(c.env, [{
              stage: 'stream',
              status: 200,
              modelName: requestedModel,
              channelId: channel.id,
              channelType: channel.type,
              userId: user.id,
              final: false,
              elapsedMs: Date.now() - started,
              errorCode: 'stream_interrupted',
              errorText: message,
            }]),
          );
        }
        if (anthropic) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(anthropicError(message))}\n\n`));
          controller.enqueue(encoder.encode(finishAnthropicStream(anthropic, usage)));
        } else if (responsesEnc) {
          controller.enqueue(encoder.encode(responsesErrorEvent(requestedModel, message)));
        } else if (geminiEnc) {
          controller.enqueue(encoder.encode(geminiErrorEvent(message)));
        } else {
          controller.enqueue(encoder.encode(sseChunk({ error: { message, type: 'upstream_error' } })));
          controller.enqueue(encoder.encode(SSE_DONE));
        }
      } finally {
        controller.close();
        settle();
      }
    },
    cancel() {
      // Client hung up mid-stream: still bill for what was produced.
      settle();
    },
  });

  return new Response(stream, { status: 200, headers: { ...SSE_HEADERS, 'X-OneAPI-Channel': String(channel.id) } });
}

/** Estimates the pre-charge from prompt size, floored by the configured minimum. */
function estimatePreConsume(body: ChatRequest, model: string, options: Options, mode: RelayMode = 'chat', keyOverrides: Record<string, PriceSpec> = {}): number {
  // a free model must stay free —— 只对固定价成立；表达式的"免费"要等求值才知道，
  // 预扣按估算走正常下限（500 quota = $0.001，结算时找平）。
  const resolved = resolvePrice(model, options, undefined, keyOverrides);
  if (!isExprSpec(resolved.spec) && resolved.spec.in === 0 && resolved.spec.out === 0) return 0;
  // Decisions 请求没有 messages/input，提示词在 state/questions 里；按 messages
  // 估的话每次都算出 0 字符，预扣永远落到下限上，并发就不再受额度约束。
  const promptSource = mode === 'decisions' ? decisionsPromptPayload(body) : (body.messages ?? body.input ?? '');
  const promptChars = JSON.stringify(promptSource ?? '').length;
  const promptTokens = Math.ceil(promptChars / 3);
  const maxOut = Math.min(body.max_tokens ?? body.max_completion_tokens ?? 0, 4096);
  const estimate = calcQuota(model, { prompt_tokens: promptTokens, completion_tokens: maxOut }, options, undefined, keyOverrides);
  return Math.max(options.PreConsumedQuota ?? 500, estimate);
}

/*
 * 只有 401 能确认「这个渠道的 key 失效了」——换一个渠道是唯一出路，禁掉才合理。
 *
 * 403 不能这么判。真实场景：OpenRouter 在受限地区调 OpenAI/Claude 等模型时，会按
 * 上游的地区规则回 403，key 本身和其他模型、其他地区都还是好的。把 403 也当成渠道
 * 失效，等于让一个地区的策略永久关掉整个渠道。所以 403 只记 relay_events、不禁用，
 * 渠道保持启用；请求本身则记入 tried 后继续试下一个渠道（见循环里的分支）。
 */
export function shouldAutoDisable(status: number): boolean {
  return status === 401;
}

async function autoDisableChannel(env: Env, channel: ChannelRow, status: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE channels SET status = ? WHERE id = ? AND status = 1').bind(ChannelStatusAutoDisabled, channel.id),
    env.DB.prepare('UPDATE abilities SET enabled = 0 WHERE channel_id = ?').bind(channel.id),
    env.DB.prepare('INSERT INTO logs (user_id, created_at, type, content, channel_id) VALUES (0, ?, 4, ?, ?)').bind(
      Math.floor(Date.now() / 1000),
      `渠道「${channel.name}」返回 ${status}，已自动禁用`,
      channel.id,
    ),
  ]);
}

export default relay;
