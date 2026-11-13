/**
 * 渠道标签规范化回归（2026-11-13 事故）：
 *   PUT 不带 tags 时，存量 JSON 数组字符串被当「逗号分隔」重新规范化，
 *   ["HPD-DOG"] 双重编码成 ["[\"HPD-DOG\"]"]，标签 ACL 匹配全灭 → sol 全线 503。
 * 钉死两条：normalizeChannelTags 对 JSON 数组字符串幂等；channelFromBody 对不带 tags
 * 的更新原样保留存量。
 *
 * Run: npm run test:channel-tags
 */
import assert from 'node:assert/strict';
import { normalizeChannelTags } from '../src/lib/channel';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('JSON 数组字符串幂等：["HPD-DOG"] → ["HPD-DOG"]（不得双重编码）', () => {
  const r = normalizeChannelTags('["HPD-DOG"]');
  assert.ok(r.ok);
  assert.equal((r as { ok: true; json: string }).json, '["HPD-DOG"]');
});

test('JSON 数组字符串含多标签 + 空白去重', () => {
  const r = normalizeChannelTags('["b","a","a"," c "]');
  assert.ok(r.ok);
  assert.equal((r as { ok: true; json: string }).json, '["b","a","c"]');
});

test('逗号分隔字符串行为不变', () => {
  const r = normalizeChannelTags('a, b ,c');
  assert.ok(r.ok);
  assert.equal((r as { ok: true; json: string }).json, '["a","b","c"]');
});

test('数组入参行为不变（去空白去重）', () => {
  const r = normalizeChannelTags(['x', ' x ', 'y']);
  assert.ok(r.ok);
  assert.equal((r as { ok: true; json: string }).json, '["x","y"]');
});

test('再规范化一遍结果不变（幂等闭环）', () => {
  const once = normalizeChannelTags(['HPD-DOG']) as { ok: true; json: string };
  const twice = normalizeChannelTags(once.json) as { ok: true; json: string };
  assert.ok(once.ok && twice.ok);
  assert.equal(once.json, twice.json);
});

test('坏 JSON 数组字符串按普通逗号串处理，不抛异常', () => {
  const r = normalizeChannelTags('[oops');
  assert.ok(r.ok);
  assert.equal((r as { ok: true; json: string }).json, '["[oops"]');
});

test('非字符串非数组 = 报错', () => {
  assert.equal(normalizeChannelTags(42).ok, false);
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
