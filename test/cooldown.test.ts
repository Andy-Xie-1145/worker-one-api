/**
 * 429 冷却与递增退避。
 *
 * 这段逻辑决定的是「免费额度耗尽之后，请求还能不能落到付费渠道」。写错了不会报错，
 * 表现是用户偶尔看到"上游渠道全部失败"，而付费渠道其实一直好好的——所以每条规则
 * 单独钉一个用例。
 *
 * Run: npm run test:cooldown
 */
import assert from 'node:assert/strict';
import { backoffSeconds, getCooling, markRateLimited, clearRateLimit } from '../src/lib/cooldown';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** 最小 KV 替身。`fail` 打开后所有操作抛错，用来验证降级。 */
const makeKV = (fail = false) => {
  const store = new Map<string, string>();
  const boom = () => {
    throw new Error('KV unavailable');
  };
  return {
    _store: store,
    get: async (k: string) => (fail ? boom() : (store.get(k) ?? null)),
    put: async (k: string, v: string) => {
      if (fail) boom();
      store.set(k, v);
    },
    delete: async (k: string) => {
      if (fail) boom();
      store.delete(k);
    },
  };
};
const envWith = (kv: any) => ({ CACHE: kv }) as any;

const BASE = 60;
const MAX = 1800;

test('退避按 2 的幂递增', () => {
  assert.equal(backoffSeconds(1, BASE, MAX), 60);
  assert.equal(backoffSeconds(2, BASE, MAX), 120);
  assert.equal(backoffSeconds(3, BASE, MAX), 240);
  assert.equal(backoffSeconds(4, BASE, MAX), 480);
});

test('退避封顶，不会无限增长', () => {
  assert.equal(backoffSeconds(10, BASE, MAX), MAX);
  // 指数很大时也不能溢出成 Infinity/NaN
  assert.equal(backoffSeconds(999, BASE, MAX), MAX);
});

test('strike 小于 1 时按第一次算，不会返回 0 或负数', () => {
  assert.equal(backoffSeconds(0, BASE, MAX), 60);
  assert.equal(backoffSeconds(-5, BASE, MAX), 60);
});

test('标记 429 之后该渠道进入冷却', async () => {
  const env = envWith(makeKV());
  await markRateLimited(env, 7, BASE, MAX);
  const cooling = await getCooling(env, [7, 8]);
  assert.ok(cooling.has(7), '被限流的渠道应在冷却中');
  assert.ok(!cooling.has(8), '没被限流的渠道不受影响');
});

test('连续 429 让冷却时长翻倍', async () => {
  const env = envWith(makeKV());
  assert.equal(await markRateLimited(env, 7, BASE, MAX), 60);
  assert.equal(await markRateLimited(env, 7, BASE, MAX), 120);
  assert.equal(await markRateLimited(env, 7, BASE, MAX), 240);
});

test('一次成功即清零退避档位', async () => {
  const env = envWith(makeKV());
  await markRateLimited(env, 7, BASE, MAX);
  await markRateLimited(env, 7, BASE, MAX); // 已经爬到第 2 档
  await clearRateLimit(env, 7);
  assert.equal(await markRateLimited(env, 7, BASE, MAX), 60, '清零后应从第一档重新开始');
});

test('各渠道的退避计数互相独立', async () => {
  const env = envWith(makeKV());
  await markRateLimited(env, 7, BASE, MAX);
  await markRateLimited(env, 7, BASE, MAX);
  assert.equal(await markRateLimited(env, 8, BASE, MAX), 60, '渠道 8 不该继承渠道 7 的档位');
});

test('KV 挂掉时读取降级成「没有冷却」，不抛异常', async () => {
  const env = envWith(makeKV(true));
  const cooling = await getCooling(env, [7, 8, 9]);
  assert.equal(cooling.size, 0, '读不到就当都可用，宁可撞一次 429 也不能让请求失败');
});

test('KV 挂掉时写入不抛异常，返回 0 表示没冷却成功', async () => {
  const env = envWith(makeKV(true));
  assert.equal(await markRateLimited(env, 7, BASE, MAX), 0);
  await clearRateLimit(env, 7); // 不应抛
});

test('空渠道列表直接返回空集合，不打 KV', async () => {
  let touched = false;
  const env = envWith({
    get: async () => {
      touched = true;
      return null;
    },
    put: async () => {},
    delete: async () => {},
  });
  const cooling = await getCooling(env, []);
  assert.equal(cooling.size, 0);
  assert.equal(touched, false);
});

test('冷却 TTL 不低于 KV 允许的最小值 60 秒', async () => {
  const kv = makeKV();
  const ttls: number[] = [];
  const env = envWith({
    ...kv,
    put: async (k: string, v: string, opts?: any) => {
      ttls.push(opts?.expirationTtl);
      kv._store.set(k, v);
    },
  });
  // 基数取 1 秒：退避算出来是 1 秒，但 KV 写不进小于 60 的 TTL
  await markRateLimited(env, 7, 1, 10);
  assert.ok(
    ttls.every((t) => t >= 60),
    `所有 TTL 都应 >= 60，实际 ${ttls.join(',')}`,
  );
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
