/**
 * 失败事件记录器。
 *
 * 这里钉两件事：脱敏必须真的脱掉密钥（这张表会被管理页原样显示，BYOK 的上游报文
 * 经常回显 key），以及记录器**永远不能抛**——它挂了最多少一条运维数据，绝不能让
 * 用户的请求跟着失败。
 *
 * Run: npm run test:health
 */
import assert from 'node:assert/strict';
import { sanitize, recordRelayEvents, pruneRelayEvents, deriveState, percentiles, engineOf, type RelayEvent } from '../src/lib/health';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** 最小 D1 替身，把 bind() 的参数记下来供断言。`fail` 打开后 batch 抛错。 */
const makeDB = (fail = false) => {
  const calls: any[][] = [];
  return {
    calls,
    prepare: (_sql: string) => ({
      bind: (...args: any[]) => {
        calls.push(args);
        return { _args: args };
      },
    }),
    batch: async (_stmts: any[]) => {
      if (fail) throw new Error('D1 unavailable');
      return [];
    },
  };
};
const envWith = (db: any) => ({ DB: db }) as any;

test('sk- 开头的密钥被抹掉', () => {
  assert.ok(!sanitize('bad key: sk-proj-abcdefghijklmnop').includes('abcdefghijklmnop'));
});

test('Google 的 AIza 密钥被抹掉', () => {
  assert.ok(!sanitize('x-goog-api-key: AIzaSyA1234567890abcdefghij').includes('AIzaSyA1234567890abcdefghij'));
});

test('Bearer 令牌被抹掉', () => {
  assert.ok(!sanitize('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9').includes('eyJhbGciOiJIUzI1NiJ9'));
});

test('json/query 里的 api_key 字段被抹掉', () => {
  assert.ok(!sanitize('{"api_key":"tokentokentoken"}').includes('tokentokentoken'));
  assert.ok(!sanitize('https://x.test/v1?key=tokentokentoken').includes('tokentokentoken'));
});

test('报文截断到 300 字，不会把整个上游响应搬进数据库', () => {
  assert.equal(sanitize('x'.repeat(5000)).length, 300);
});

test('空串安全', () => {
  assert.equal(sanitize(''), '');
});

test('no_channel 事件带着请求的模型串落库', async () => {
  const db = makeDB();
  const event: RelayEvent = {
    stage: 'no_channel',
    status: 503,
    modelName: 'gemini-does-not-exist',
    groupName: 'default',
    final: true,
  };
  await recordRelayEvents(envWith(db), [event]);
  assert.equal(db.calls.length, 1);
  const args = db.calls[0];
  assert.ok(args.includes('gemini-does-not-exist'), '模型串必须在 bind 参数里——这就是这张表存在的理由');
  assert.ok(args.includes('default'));
  assert.ok(args.includes('no_channel'));
});

test('final 转成 1/0，省略的字段走默认值', async () => {
  const db = makeDB();
  await recordRelayEvents(envWith(db), [{ stage: 'upstream' }]);
  const args = db.calls[0];
  assert.equal(args[10], 0, 'final 未设时应为 0');
  assert.equal(args[3], '', 'modelName 未设时应为空串而不是 undefined');
});

test('一次请求的多条事件合成一个 batch', async () => {
  const db = makeDB();
  let batches = 0;
  const env = envWith({ ...db, batch: async () => (batches++, []) });
  await recordRelayEvents(env, [{ stage: 'upstream' }, { stage: 'upstream' }, { stage: 'no_channel' }]);
  assert.equal(batches, 1);
});

test('空数组不打 D1', async () => {
  let touched = false;
  const env = envWith({
    prepare: () => {
      touched = true;
      return { bind: () => ({}) };
    },
    batch: async () => [],
  });
  await recordRelayEvents(env, []);
  assert.equal(touched, false);
});

test('D1 挂掉时记录器不抛——请求不能因为记日志而失败', async () => {
  await recordRelayEvents(envWith(makeDB(true)), [{ stage: 'no_channel' }]);
});

test('写入前脱敏，密钥不会进 bind 参数', async () => {
  const db = makeDB();
  await recordRelayEvents(envWith(db), [{ stage: 'upstream', errorText: 'invalid key sk-proj-SECRETSECRET' }]);
  assert.ok(!JSON.stringify(db.calls[0]).includes('SECRETSECRET'));
});

test('清理失败时返回 0 而不是抛', async () => {
  const env = envWith({
    prepare: () => ({
      bind: () => ({
        run: async () => {
          throw new Error('D1 unavailable');
        },
      }),
    }),
  });
  assert.equal(await pruneRelayEvents(env), 0);
});

// ---- 状态判定：这套口径决定状态页可不可信 ----

test('样本不足时返回 unknown，绝不判故障', () => {
  assert.equal(deriveState({ successes: 1, failures: 2 }), 'unknown', '3 个样本错 2 个也只是样本不足');
  assert.equal(deriveState({ successes: 0, failures: 4 }), 'unknown');
});

test('错误率分档', () => {
  assert.equal(deriveState({ successes: 200, failures: 1 }), 'ok');
  assert.equal(deriveState({ successes: 90, failures: 10 }), 'degraded');
  assert.equal(deriveState({ successes: 50, failures: 50 }), 'down');
});

test('延迟只把正常降成降级，不会判故障', () => {
  const slow = { successes: 100, failures: 0, p50Ms: 30000, slowMs: 20000 };
  assert.equal(deriveState(slow), 'degraded', 'gemini 全成功但 p50 30s，用户体感就是不能用');
  assert.equal(deriveState({ ...slow, p50Ms: 11600 }), 'ok', 'gpt-4o-mini 的 11.6s 是正常的');
  // 错误率已经到故障了，延迟不该把它拉回降级
  assert.equal(deriveState({ successes: 10, failures: 90, p50Ms: 30000, slowMs: 20000 }), 'down');
});

test('近超时率超过 20% 也算降级', () => {
  assert.equal(deriveState({ successes: 100, failures: 0, nearTimeoutRate: 0.31 }), 'degraded');
  assert.equal(deriveState({ successes: 100, failures: 0, nearTimeoutRate: 0.05 }), 'ok');
});

test('禁用直接是故障，冷却中是降级', () => {
  assert.equal(deriveState({ successes: 999, failures: 0, disabled: true }), 'down');
  assert.equal(deriveState({ successes: 100, failures: 0, cooling: true }), 'degraded');
  // 样本不足但正在冷却：冷却是确定的事实，不受样本量影响
  assert.equal(deriveState({ successes: 1, failures: 0, cooling: true }), 'degraded');
});

test('分位数取值', () => {
  assert.deepEqual(percentiles([]), { p50: 0, p95: 0 });
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentiles(v).p50, 51);
  assert.equal(percentiles(v).p95, 96);
});

// ---- 引擎归类：公开页按这个说话 ----

test('按模型名归类到用户认得的引擎', () => {
  assert.equal(engineOf('gemini-flash-lite-latest').id, 'gemini');
  assert.equal(engineOf('gemini-flash-lite-latest').label, 'Google Gemini');
  assert.equal(engineOf('gpt-4o-mini').id, 'openai');
  assert.equal(engineOf('o3-mini').id, 'openai');
  assert.equal(engineOf('deepseek-v4-flash').id, 'deepseek');
  assert.equal(engineOf('glm-5.3').id, 'zhipu');
  assert.equal(engineOf('anthropic/claude-sonnet-5').id, 'anthropic');
  assert.equal(engineOf('qwen/qwen3.8-flash').id, 'qwen');
});

test('认不出的模型落到 other，不会串到别的引擎名下', () => {
  assert.equal(engineOf('definitely-not-a-model').id, 'other');
  assert.equal(engineOf('').id, 'other');
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
