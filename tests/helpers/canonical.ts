/**
 * 规范化序列化 —— **对象键排序、数组顺序保留**。
 *
 * 为什么必须有：fixture 是 `json.dump(..., sort_keys=True)` 的规范形式，
 * 而 TS 侧返回的对象保留 YAML/JSON 源里的原始键序。两边内容完全相同时，
 * 裸的 `JSON.stringify` 会把它们报成不一致 —— 这类误报会让真正的差异
 * 淹没在一屏"看起来一模一样"的 diff 里（迁移期已经在 content 和 config
 * 两处各踩过一次）。
 *
 * ⚠️ 只对**对象**排序，数组一律原样。数组顺序恰恰是最有价值的那类断言
 * （items 的排序、story beats 的 sequence、规则表的报错顺序）——
 * 一起排掉等于把它们变成空断言。
 *
 * 用 JSON.stringify 的 replacer 而不是手写递归：字符串转义、数字格式化、
 * undefined / 循环引用这些边界直接交给原生实现，少一处自己维护的坑。
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, node: unknown) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      sorted[key] = (node as Record<string, unknown>)[key];
    }
    return sorted;
  });
}
