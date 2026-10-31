/**
 * 前后端构建号握手（防「旧页面调新接口」）。
 *
 * 真实事故：令牌接口改成不再回明文 key（只回 key_masked），但浏览器里挂了几小时的
 * 旧 SPA 还在读 `t.key.slice()` —— 报 `Cannot read properties of undefined (reading
 * 'slice')`，还往剪贴板写了 `sk-undefined`。SPA 是单文件 + hash 路由，切页签不会
 * 重新请求 HTML，所以这种「旧 JS 常驻」是常态，必须有握手机制。
 *
 * 钉住：
 *   1. public/index.html 的 SPA_BUILD 与 src/lib/version.ts 一致；
 *   2. GET /api/status 把 spa_build 回给前端（前端靠它判断自己是否过期）；
 *   3. 前端确实在 boot 时对账（guardBuild），且没有旧的回显/复制写法；
 *   4. 取回密钥前做形状校验，拒绝把非 sk- 值写进剪贴板。
 *
 * Run: npm run test:spa-build
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import worker from '../src/index';
import { SPA_BUILD } from '../src/lib/version';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const resolve = (rel: string): string => {
  const candidates = [join(process.cwd(), rel), join(process.cwd(), 'worker-one-api', rel)];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
};
const HTML = readFileSync(resolve('public/index.html'), 'utf8');

function statusEnv() {
  const cache = new Map<string, unknown>();
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({ results: /FROM options/.test(sql) ? [] : [] }),
          first: async () => null,
          run: async () => ({ meta: { changes: 1 } }),
        }),
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    },
    CACHE: {
      get: async (k: string) => (cache.has(k) ? cache.get(k) : null),
      put: async (k: string, v: unknown) => void cache.set(k, v),
      delete: async (k: string) => void cache.delete(k),
    },
    ASSETS: { fetch: async () => new Response('spa') },
    ADMIN_KEY: 'x',
  } as never;
}

/* ---------------------------------------------------------------- 常量同步 */

test('SPA_BUILD：index.html 与 src/lib/version.ts 一致', () => {
  const m = /const SPA_BUILD = '([^']+)'/.exec(HTML);
  assert.ok(m, 'index.html 里必须有 const SPA_BUILD');
  assert.equal(m![1], SPA_BUILD, `前端 ${m![1]} ≠ 后端 ${SPA_BUILD}：改前端行为时两处都要同步`);
});

test('/api/status 回 spa_build（前端靠它对账）', async () => {
  const res = await worker.fetch(
    new Request('https://oneapi.test/api/status'),
    statusEnv(),
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
  assert.equal(res.status, 200);
  const json = (await res.json()) as any;
  assert.equal(json.data.spa_build, SPA_BUILD);
});

/* ---------------------------------------------------------------- 前端守卫 */

test('boot 时会做构建号对账（guardBuild），不一致就重载/挂横幅', () => {
  assert.match(HTML, /if \(await guardBuild\(state\.status\.spa_build\)\) return;/);
  assert.match(HTML, /function guardBuild\(/);
  assert.match(HTML, /const flag = 'spa-build:' \+ theirs/);
  assert.match(HTML, /sessionStorage\.setItem\(flag, '1'\)/, '重载一次，防无限循环');
  assert.match(HTML, /function watchBuild\(/, '切回标签页/定时也要查一次');
});

test('没有旧写法：不回显明文、不读裸 key、不往剪贴板写未校验值', () => {
  assert.doesNotMatch(HTML, /sk-'\s*\+\s*t\.key/, '不允许「sk- + t.key」这种旧复制写法');
  assert.doesNotMatch(HTML, /data-copy="\$\{esc\(t\.key\)\}"/, '不允许把明文 key 塞进 DOM 属性');
  assert.match(HTML, /sk-\[0-9a-z\]\{16,\}/i, '取回后要校验形状再写剪贴板');
  assert.match(HTML, /接口没有返回完整密钥/, '形状不对要显式报错，而不是写 sk-undefined');
});

/* ---------------------------------------------------------------- runner */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(error);
  }
}
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
