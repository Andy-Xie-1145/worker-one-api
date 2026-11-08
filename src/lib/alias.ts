import { getOptions, type Options } from './options';
import type { Env } from '../types';

/**
 * 模型别名（轻量分组，无倍率语义）。
 *
 * options.AliasGroups = [["a","b"],["c"]]：每组是一串等价名字。并查集合并后，
 * 跨组重名自动联通（A,B + B,C → 一个块）。三个用途：
 *   1. 路由：请求块内任意名字 → 候选 = 拥有块内**任意**名字的渠道；
 *   2. 上游翻译：发给渠道的名字 = 该渠道自己拥有的那个成员（ability 行给出的）；
 *   3. 令牌模型白名单：拥有块内任一名字 = 拥有全块（models 检查按块展开）。
 *
 * 没有倍率语义——纯粹是「同一个模型的不同叫法」。
 */
export interface AliasIndex {
  /** 名字 → 所在联通块的全部成员（已排序，含自身）。不在任何组里的名字不在表中。 */
  byName: Map<string, string[]>;
}

/** Options.AliasGroups → 防御性解析（非法/畸形条目丢弃，全空 = 无别名）。 */
export function aliasGroupsFromOptions(opts: Options): string[][] {
  const raw = (opts as unknown as Record<string, unknown>)?.AliasGroups;
  if (!Array.isArray(raw)) return [];
  const out: string[][] = [];
  for (const g of raw) {
    if (!Array.isArray(g)) continue;
    const names = [...new Set(g.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim()))];
    if (names.length) out.push(names);
  }
  return out;
}

/** 并查集构建：组内名字两两合并，跨组重名自动联通。byName = 名字 → 排序后的块成员。 */
export function buildAliasIndex(groups: string[][]): AliasIndex {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const g of groups) for (let i = 1; i < g.length; i++) union(g[0], g[i]);

  const byName = new Map<string, string[]>();
  const comps = new Map<string, Set<string>>();
  for (const name of parent.keys()) {
    const root = find(name);
    if (!comps.has(root)) comps.set(root, new Set());
    comps.get(root)!.add(name);
  }
  for (const name of parent.keys()) {
    byName.set(name, [...comps.get(find(name))!].sort());
  }
  return { byName };
}

/** 名字所在联通块的全部成员（不在任何组里 = 只有它自己）。 */
export function componentOf(index: AliasIndex, name: string): string[] {
  return index.byName.get(name) ?? [name];
}

export async function getAliasIndex(env: Env): Promise<AliasIndex> {
  return buildAliasIndex(aliasGroupsFromOptions(await getOptions(env)));
}
