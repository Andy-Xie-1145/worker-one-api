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
  /**
   * 维护栅栏（迁移窗口用，见 index.ts 的 maintenanceGate 与 devlog 迁移计划 §3-B）。
   * 部署期环境变量：字符串 "on" 时 /v1/*、/api/*（除 /api/status）、/gemini/* 一律
   * 503 + Retry-After；不设或其他值 = 正常服务。唯一翻转方式 = redeploy（留审计）。
   * KV/D1 不能当这个开关：KV 值不迁移且最终一致，D1 options 行会被快照导入覆盖。
   * scheduled（回收 cron）不受影响——冻结期它正是结算写入者。
   */
  MAINTENANCE?: string;
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
  /** 渠道访问控制 JSON：{"mode":"whitelist|blacklist","channels":[id…]}；空串 = 不限制。 */
  channel_acl: string;
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
  /**
   * 轻量分组标签（多值，JSON 字符串数组；无任何倍率语义）。
   * 供令牌渠道 ACL 按标签匹配：ACL 条目里的字符串出现在标签数组中即命中。
   * （迁移自 0019；旧单值 "group" 列保留为惰性遗留，不再读写。）
   */
  tags: string;
  /** 惰性遗留列（0015）：单值分组，已被 tags 取代，代码不再读写（仅 SELECT * 会带出）。 */
  group?: string;
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
