/**
 * 前端资源版本（SPA 构建号）。
 *
 * 必须与 `public/index.html` 里的 `const SPA_BUILD = '...'` 一致，
 * `test/spa-build.test.ts` 会钉住这一条。
 *
 * 为什么需要它：后台 SPA 是单文件 + hash 路由，页面一旦打开就不会再请求 HTML。
 * 标签页挂一整天（甚至几天）后，浏览器里跑的是旧 JS，而 Worker 已经是新代码——
 * 「旧页面调新接口」就会炸出 `Cannot read properties of undefined (reading 'slice')`
 * 这类事故（真实踩过：令牌接口不再回明文 key，旧页面还在读 `t.key.slice()`）。
 *
 * 机制：`/api/status` 把这个构建号回给前端，前端比对；不一致就自动重载一次
 * （再用 sessionStorage 防重载循环，仍然不一致就挂横幅让人硬刷新）。
 * 改前端行为时记得改这里 + index.html 的 SPA_BUILD，两处同步。
 */
export const SPA_BUILD = '2026-11-09.5';
