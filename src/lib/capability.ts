import type { Options } from './options';
import { stripAliasPrefix } from './pricing/llm';

/**
 * 模型能力分诊。
 *
 * 起因是 Jev：它在 OpenRouter 上只接受 Decisions API（`/api/alpha/decisions`），
 * 请求体是 state/questions 而不是 messages，根本没有 chat/completions 这条路。
 * 可 /v1/models 是一个扁平的名字列表，没有任何地方能表达"这个名字只能这么用"——
 * 于是任何一个照着列表选模型的普通客户端都会把 Jev 发去 chat/completions，
 * 拿回一个来自上游、语焉不详的 404。
 *
 * 这个模块就是那张缺失的表，而且**只有这一张**：能力规则写在这里，
 * /v1/models 的过滤、chat/completions 的拒绝、/v1/decisions 的准入都问它。
 * 规则散到三处的下场是它们迟早各走各的——列表里藏起来了，请求却还放行。
 *
 * 第一版不动数据库：能力是**模型固有属性**（Jev 在哪个渠道上都只会决策），
 * 不是渠道配置，所以它属于代码里的常量表，和价格表同一个性质。真要给运维留口子，
 * options.DecisionOnlyModels 可以不发版就追加名字。
 */
export type Capability = 'chat' | 'decisions';

/**
 * 内置的 decision-only 模型前缀，匹配前先剥厂商前缀（见 stripAliasPrefix）。
 * 所以 `~typesafe/jev-latest`、`typesafe/jev-1.13`、`jev-latest` 都命中同一条。
 */
const DECISION_ONLY_PREFIXES = ['jev'];

/** 这个模型是不是只能走 /v1/decisions。 */
export function isDecisionOnlyModel(model: string, options?: Options): boolean {
  const name = (model ?? '').trim();
  if (!name) return false;
  // 运维追加的名字按原样匹配：写进配置的是客户端实际发来的那个串。
  // Array.isArray 不是多余的——配置是运维手写的 JSON，写成字符串的话
  // String.prototype.includes 会变成子串匹配，把一整批模型静悄悄地判成决策模型。
  const extra = Array.isArray(options?.DecisionOnlyModels) ? options!.DecisionOnlyModels : [];
  if (extra.includes(name)) return true;
  const bare = stripAliasPrefix(name);
  if (extra.includes(bare)) return true;
  return DECISION_ONLY_PREFIXES.some((prefix) => bare.startsWith(prefix));
}

export function modelCapability(model: string, options?: Options): Capability {
  return isDecisionOnlyModel(model, options) ? 'decisions' : 'chat';
}

/** 按能力筛一份模型名单。/v1/models 默认只给 'chat'。 */
export function filterByCapability(models: string[], capability: Capability, options?: Options): string[] {
  return models.filter((m) => modelCapability(m, options) === capability);
}
