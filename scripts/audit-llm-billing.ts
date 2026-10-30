/**
 * LLM 计费 dry-run 审计。**只读**：每条 SQL 先过 assertReadOnlySql，只发 SELECT。
 *
 * 输出到 stdout：启用渠道上的未定价 (渠道, 模型) 组合 + 兜底价开关状态 +
 * 全局覆盖条数。严格计费（未设兜底价）下未定价组合不为空 = 部署后会拒绝请求，
 * 应当先补价再部署。
 *
 * Run: npm run audit:llm-billing            （默认 --remote）
 *      npm run audit:llm-billing -- --local
 *
 * 注意：用**全局安装的 wrangler**（不是 npx），符合本仓库的部署约定。
 */
import { execFileSync } from 'node:child_process';
import { assertReadOnlySql, AUDIT_SQL, findUnpricedChannelModels, fallbackActive } from './lib/billing-audit';
import { LLM_PRICING_VERSION } from '../src/lib/pricing/llm';
import type { ChannelRow } from '../src/types';
import type { Options } from '../src/lib/options';

const DB_NAME = 'oneapi';
const target = process.argv.includes('--local') ? '--local' : '--remote';

/** 唯一的取数口。先守卫，再执行；守卫不过直接抛，不会起任何进程。 */
function select<T>(sql: string): T[] {
  const safe = assertReadOnlySql(sql);
  const out = execFileSync('wrangler', ['d1', 'execute', DB_NAME, target, '--json', '--command', safe], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first?.success) throw new Error(`D1 查询失败：${safe.slice(0, 80)}`);
  return first.results as T[];
}

function main() {
  const channels = select<ChannelRow>(AUDIT_SQL.channels);
  const optionRows = select<{ key: string; value: string }>(AUDIT_SQL.options);
  const options: Options = {} as Options;
  for (const r of optionRows) {
    try {
      (options as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
    } catch {
      console.error(`[audit] 选项 ${r.key} 不是合法 JSON，忽略`);
    }
  }

  const unpriced = findUnpricedChannelModels(channels, options);
  const strict = !fallbackActive(options);

  console.log(`# LLM 计费审计（${target}，价格体系 ${LLM_PRICING_VERSION}）`);
  console.log(`- 启用渠道：${channels.filter((c) => c.status === 1).length} / ${channels.length}`);
  console.log(`- 全局价格覆盖：${Object.keys(options.ModelPriceOverride ?? {}).length} 条`);
  console.log(`- 兜底价：${options.DefaultPrice ? `已设（宽松计费，$${options.DefaultPrice.in}/$${options.DefaultPrice.out}）` : '未设（**严格计费**，未定价模型将被拒绝）'}`);
  console.log(`- 未定价 (渠道, 模型) 组合：${unpriced.length}`);
  if (unpriced.length) {
    for (const row of unpriced) {
      console.log(`  - 渠道 #${row.channelId}「${row.channelName}」(${row.channelType})：${row.requested}` +
        (row.upstream !== row.requested ? `（上游名 ${row.upstream}）` : '') +
        (strict ? ' → 将被 model_price_not_configured 拒绝' : ' → 将按兜底价记账'));
    }
    if (strict) {
      console.log('\n严格计费下这些组合会直接拒绝请求：先在「价格」页配全局覆盖，或给渠道补 model_mapping。');
      process.exitCode = 1;
    }
  } else {
    console.log('\n所有启用渠道的模型都有价，可以部署。');
  }
}

main();
