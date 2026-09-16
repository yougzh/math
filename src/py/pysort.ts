/**
 * Python `sorted()` 的等价物。
 *
 * 与 `Array.prototype.sort` 的三处差异都是**静默**的（写错了不报错、只排序不同）：
 *
 * 1. **默认比较是字符串序，不是数值序**。`[10, 9].sort()` 给 `[10, 9]`，
 *    Python 的 `sorted([10, 9])` 给 `[9, 10]`。所以这里刻意**不提供无 key 的排序**：
 *    `sortedStrings` 只接受字符串，`sortedBy` 必须显式给至少一个 key。
 *
 * 2. **比较的是 UTF-16 code unit，Python 比的是 Unicode code point**。
 *    两者对 BMP 内的字符完全一致，对代理对（emoji 等）会不同。
 *    内容里的排序键全是 `^[a-z0-9_]+$` 形式的 code，构建脚本会断言这一点
 *    （scripts/build-content.ts 的 assertSortKeysAscii），所以这里不引入
 *    代价更高的 code point 迭代。
 *
 * 3. **必须稳定**。Python 的 sorted 稳定，而 `Array.prototype.sort` 从 ES2019 起
 *    也保证稳定 —— 这条是"刚好一致"，不是"可以依赖"：真需要稳定性的地方
 *    （键全相等时保留原顺序）要能一眼看出来，所以 `sortedBy` 的注释里标了它。
 *
 * 绝不用 `localeCompare` —— 它依赖 locale，结果不可复现。
 */

/** Python `sorted(iterable)`（无 key）：升序、稳定 */
export function sortedStrings(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Python `sorted(iterable, key=...)` 的等价物，键按传入顺序依次比较
 * （等价 Python 的元组比较 `key=lambda x: (k1, k2, ...)`）。
 *
 * 与 Python 一样是稳定排序：键全部相等时保留原顺序。
 */
export function sortedBy<T>(
  items: Iterable<T>,
  ...keys: ReadonlyArray<(item: T) => number | string>
): T[] {
  return [...items].sort((a, b) => {
    for (const key of keys) {
      const ka = key(a);
      const kb = key(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
    }
    return 0;
  });
}
