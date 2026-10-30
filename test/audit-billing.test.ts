/**
 * 计费审计工具的纯逻辑（scripts/lib/billing-audit.ts）。
 *
 * 只读守卫宁可误拒：审计脚本拿的是生产 D1 凭据，一条非 SELECT 都不能溜出去。
 *
 * Run: npm run test:audit-billing
 */
import assert from 'node:assert/strict';
import { assertReadOnlySql, AUDIT_SQL, findUnpricedChannelModels, fallbackActive } from '../scripts/lib/billing-audit';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('只读守卫：SELECT / WITH 放行，多余分号剥掉', () => {
  assert.equal(assertReadOnlySql('SELECT 1'), 'SELECT 1');
  assert.equal(assertReadOnlySql('  select 1 ;  '), 'select 1');
  assert.ok(assertReadOnlySql('WITH t AS (SELECT 1) SELECT * FROM t'));
});

test('只读守卫：写 / DDL / 事务 / 多语句 / 非 SELECT 一律拒绝', () => {
  for (const sql of [
    'UPDATE users SET quota = 0',
    'DELETE FROM logs',
    'INSERT INTO logs VALUES (1)',
    'ALTER TABLE logs ADD COLUMN x TEXT',
    'DROP TABLE logs',
    'PRAGMA case_sensitive_like = true',
    'SELECT 1; SELECT 2',
    'EXPLAIN SELECT 1',
  ]) {
    assert.throws(() => assertReadOnlySql(sql), undefined, `应当拒绝：${sql}`);
  }
});

test('脚本自带的 SQL 全部能过守卫，且不含 key 列', () => {
  for (const sql of Object.values(AUDIT_SQL)) assertReadOnlySql(sql as string);
  assert.ok(!AUDIT_SQL.channels.includes('key'));
  assert.ok(!AUDIT_SQL.channels.includes('base_url'));
});

test('findUnpricedChannelModels：只看启用渠道；映射救得了别名', () => {
  const channels = [
    { id: 1, name: 'a', type: 'openai', status: 1, models: 'glm-5.2, mystery', model_mapping: '', priority: 0 },
    { id: 2, name: 'b', type: 'gemini', status: 0, models: 'also-mystery', model_mapping: '', priority: 0 },
    { id: 3, name: 'c', type: 'openai', status: 1, models: 'flash-lite-latest', model_mapping: '{"flash-lite-latest":"gemini-3.1-flash-lite"}', priority: 0 },
  ] as never[];
  const rows = findUnpricedChannelModels(channels, { DefaultPrice: null } as never);
  // 渠道 2 停用不计；flash-lite-latest 靠映射命中内置价，不算未定价
  assert.deepEqual(rows.map((r) => `${r.channelId}:${r.requested}`), ['1:mystery']);
});

test('fallbackActive：设了兜底价 = 宽松', () => {
  assert.equal(fallbackActive({ DefaultPrice: null } as never), false);
  assert.equal(fallbackActive({ DefaultPrice: { in: 1, out: 3 } } as never), true);
  assert.equal(fallbackActive(undefined), false);
});

// ---------------------------------------------------------------- runner

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
console.log(`\naudit-billing: ${tests.length} passed`);
