/**
 * SSE 空闲超时回归（2026-11-13 废除 120s 一刀切）：
 *   健康的长流每秒都在吐字，网关绝不因「跑得太久」主动切——
 *   只在连续 idleMs 毫秒没有任何字节（连接假死）时才判死。
 *
 * Run: npm run test:sse-idle
 */
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { readSSE, UpstreamIdleTimeoutError } from '../src/relay/sse';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sse = (obj: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);

test('慢滴流：总时长超过 idleMs 也不许切（只认空闲，不认墙钟）', async () => {
  // 8 个块、每块 25ms 一滴 → 总时长 ~200ms，远超 idleMs=60；但从不空闲 → 必须完整读完
  let n = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (n >= 8) { controller.close(); return; }
      n++;
      await sleep(25);
      controller.enqueue(sse({ choices: [{ delta: { content: String(n) } }] }));
    },
  });
  const seen: string[] = [];
  for await (const ev of readSSE(body as never, { idleMs: 60 })) {
    try { seen.push(JSON.parse(ev.data).choices[0].delta.content); } catch { /* ignore */ }
  }
  assert.deepEqual(seen, ['1', '2', '3', '4', '5', '6', '7', '8']);
});

test('停滞流：连续 idleMs 无字节 → 抛 UpstreamIdleTimeoutError', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(sse({ choices: [{ delta: { content: '头一块' } }] }));
      // 之后永远不 enqueue、不 close —— 模拟连接假死
    },
  });
  let threw: unknown;
  try {
    for await (const ev of readSSE(body as never, { idleMs: 60 })) { void ev; }
  } catch (e) { threw = e; }
  assert.ok(threw instanceof UpstreamIdleTimeoutError, `应抛 UpstreamIdleTimeoutError，实际 ${String(threw)}`);
});

test('不带 idleMs 行为不变：无看门狗', async () => {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(sse({ choices: [{ delta: { content: 'x' } }] })); controller.close(); },
  });
  const seen: string[] = [];
  for await (const ev of readSSE(body as never)) {
    try { seen.push(JSON.parse(ev.data).choices[0].delta.content); } catch { /* ignore */ }
  }
  assert.deepEqual(seen, ['x']);
});

test('正常读完后再 cancel 也不抛（幂等收尾）', async () => {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(sse({ choices: [{ delta: { content: 'x' } }] })); controller.close(); },
  });
  for await (const ev of readSSE(body as never, { idleMs: 1000 })) { void ev; }
  // 上面的循环正常结束即断言通过（finally 里 cancel 已执行且未抛）
});

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`\n${tests.length} 个用例全部通过`);
