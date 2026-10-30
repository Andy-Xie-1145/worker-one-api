export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  /**
   * 唯一的管理员令牌（个人使用，无账号体系）。配置在 wrangler.jsonc 的 vars 里。
   * /api/* 管理面（除 /api/status）全部要求 `Authorization: Bearer <ADMIN_KEY>`；
   * 未配置时整个管理面返回 503，而不是敞开。
   */
  ADMIN_KEY?: string;
  /**
   * 企业微信群机器人（含 ?key=）。定时自检发现账本偏差时往这里告警。
   * 不配就只写系统日志——本地和预览环境不该因为少一个变量就报错。
   */
  WECOM_WEBHOOK_URL?: string;
  /**
   * 企业微信群机器人（含 ?key=），专收「路由缺口」（503 没有可用渠道）告警与恢复通知，
   * 见 lib/route-alert.ts。用 `wrangler secret put` 配置，不配就不发。
   */
  WECOM_HEALTH_WEBHOOK_URL?: string;
  /** 同一 model 的路由缺口告警冷却（分钟），默认 30。 */
  WECOM_HEALTH_ALERT_COOLDOWN_MIN?: string;
}

export interface UserRow {
  id: number;
  username: string;
  /** 历史遗留列，个人版不再有密码：owner 行固定为空串。 */
  password: string;
  display_name: string;
  role: number;
  status: number;
  email: string;
  quota: number;
  used_quota: number;
  request_count: number;
  aff_code: string;
  inviter_id: number;
  created_time: number;
}

export interface TokenRow {
  id: number;
  user_id: number;
  key: string;
  status: number;
  name: string;
  created_time: number;
  accessed_time: number;
  expired_time: number;
  remain_quota: number;
  unlimited_quota: number;
  used_quota: number;
  models: string;
}

export interface ChannelRow {
  id: number;
  type: string;
  key: string;
  status: number;
  name: string;
  weight: number;
  priority: number;
  created_time: number;
  test_time: number;
  response_time: number;
  base_url: string;
  balance: number;
  models: string;
  used_quota: number;
  model_mapping: string;
  config: string;
  system_prompt: string;
  /**
   * 这个渠道的**按模型价格覆盖**（JSON 文本，'' = 无覆盖）。
   *
   * 形状：`{ "<请求名>": PriceSpec }`，PriceSpec 每字段是常量或费率表达式
   * （见 lib/pricing/llm.ts）。**只按请求名命中**（渠道 models 里声明的那个名字，
   * 候选序列同全局解析）；查价优先级：渠道覆盖 > 全局覆盖 > 内置表 > 默认价/严格。
   * （Key 级价格已按决策删除：令牌混用渠道且会 fallback，在 Key 上定价没有意义。）
   */
  price_config: string;
}

export const RoleUser = 1;
export const RoleAdmin = 10;
export const RoleRoot = 100;

export const StatusEnabled = 1;
export const StatusDisabled = 2;

export const ChannelStatusEnabled = 1;
export const ChannelStatusManuallyDisabled = 2;
export const ChannelStatusAutoDisabled = 3;

export const TokenStatusEnabled = 1;
export const TokenStatusDisabled = 2;
export const TokenStatusExpired = 3;
export const TokenStatusExhausted = 4;

export const LogTypeTopup = 1;
export const LogTypeConsume = 2;
export const LogTypeManage = 3;
export const LogTypeSystem = 4;

/** Context set by auth middlewares. 管理面不再注入用户，仅保留占位。 */
export type Vars = Record<string, never>;
