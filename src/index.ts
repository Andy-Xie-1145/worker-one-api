import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { Env, Vars } from './types';
import relay, { anthropicRoute, geminiRoute } from './routes/relay';
import api from './routes/api';
import { runWatchdog, runSweeper, SWEEP_CRON } from './lib/watchdog';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/*
 * 维护栅栏（迁移窗口设计见 devlog/migration-plan-2026-11-08.md §3-B）。
 *
 * MAINTENANCE 是**部署期**环境变量："on" + redeploy = 冻结，移除 + redeploy = 恢复。
 * 特意不用 KV/D1 当开关：KV 值不随数据迁移且最终一致（漏挡窗口），D1 options 行会被
 * 快照导入覆盖；env 随版本原子生效、无缓存层，翻转必留部署审计记录。
 *
 * 挡住全部**写入口**：/v1/*（OpenAI/Anthropic/Gemini 兼容中继）、/api/*（管理面 +
 * CLI + /api/anthropic，含唯一有隐式写的鉴权 GET /api/tokens/:id/key）、独立挂载的
 * /gemini/*。放行 /api/status（免鉴权状态）与 /health（零 D1 依赖的观测口）；SPA
 * 静态资源只读，不挡。
 *
 * 注册在 CORS 之前：维护期连预检一起挡，行为确定，不依赖中间件顺序。
 *
 * scheduled 入口**不受此门控**：回收 cron（每 5 分钟）冻结期必须继续跑——排空断言依赖
 * 它补 fin: 结算行；新端则不部署 cron（配置层移除），无 scheduled 入口。
 */
const maintenanceGate: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.env.MAINTENANCE !== 'on') return next();
  const path = c.req.path;
  if (path === '/api/status' || path.startsWith('/api/status/')) return next();
  const message = '服务维护中（迁移窗口），请稍后重试';
  return c.json(
    { success: false, message, error: { message, type: 'maintenance' } },
    503,
    { 'Retry-After': '30', 'Cache-Control': 'no-store' },
  );
};
app.use('/v1/*', maintenanceGate);
app.use('/api/*', maintenanceGate);
app.use('/gemini/*', maintenanceGate);

// The relay is an API surface for third-party clients, so it is open CORS.
// The admin API is cookie-authenticated and therefore same-origin only.
const relayCors = cors({
  origin: '*',
  allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'x-api-key', 'anthropic-version', 'anthropic-beta'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  maxAge: 86400,
});
app.use('/v1/*', relayCors);
app.use('/api/anthropic/*', relayCors);
/*
 * 公开状态接口是唯一开 CORS 的管理面路径：它的载荷本来就是设计给全世界看的
 * （只有引擎名和状态枚举），而且要让浏览器扩展页面能直接读。
 * 其余 /api/* 仍然是 cookie 鉴权 + 同源，规矩没变。
 */
app.use('/api/status/*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], maxAge: 300 }));

app.route('/v1', relay);
app.route('/api/anthropic', anthropicRoute);
app.route('/gemini', geminiRoute);
app.route('/api', api);

app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

// Everything else is the admin SPA served from Workers Assets.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error('unhandled', err);
  return c.json({ success: false, message: `服务器内部错误: ${err.message}`, error: { message: err.message, type: 'internal_error' } }, 500);
});

/**
 * Workers 的两个入口。
 *
 * 以前这里直接 `export default app`（Hono 应用本身就带 fetch），加定时任务就必须展开成
 * 对象形式——`scheduled` 挂不到 Hono 上，它不是 HTTP 请求。
 */
export default {
  fetch: app.fetch,

  /**
   * 两个定时任务，见 wrangler.jsonc 的 triggers.crons，按 cron 表达式分派。
   *
   *   0 19 * * *   账本自检（一天一次够了，偏差是持续状态不是突发故障）
   *   SWEEP_CRON   回收过期的授权窗口（必须很频繁，见 watchdog.ts 的说明）
   *
   * 用 waitUntil 而不是 await：cron 的执行窗口有限，而自检里有网络调用（企业微信告警）。
   * 真正要保证跑完的是 D1 那几步，它们在各自函数内部已经 await 过了。
   */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const job = controller.cron === SWEEP_CRON ? runSweeper(env) : runWatchdog(env);
    const label = controller.cron === SWEEP_CRON ? 'sweeper' : 'watchdog';
    ctx.waitUntil(
      job.catch((error) => {
        // 抛出去只会变成一条看不见的 cron 失败记录，这里至少留个日志
        console.error(`[${label}] 定时任务异常：`, error);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
