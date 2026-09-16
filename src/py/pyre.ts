/**
 * Python `re` 的等价物 —— 只处理内容校验用到的那几个模式。
 *
 * 为什么不"用 TS 的习惯重新写一遍正则"
 * ------------------------------------
 * 这些模式的**每一处细节都影响输出**，而且错了不会报错、只会少匹配：
 *
 * 1. **alternation 的顺序**。Python 与 JS 都是"最左优先"而非"最长优先"。
 *    `cognitive.py` 的 `_OP_PATTERN` 是
 *    `sorted((re.escape(k) for k in _OP_ALIASES), key=len, reverse=True)`——
 *    注意 `key=len` 作用在**转义后**的字符串上，所以 `\+`/`\-`/`\*`（转义后 2 字符）
 *    被排到了和「加上/减去/除以」同一档，实际顺序是：
 *        \+  加上  \-  减去  \*  除以  加  减  ×  乘  ÷  /
 *    源码里的注释写的是"最长优先"，但转义把 `+ - *` 顶了上来 —— 这不是 bug
 *    （`+` 和 `加上` 之间不存在前缀歧义），但**移植时必须逐字照抄这个顺序**。
 *
 * 2. **`\d` 的宽度**。Python 3 的 `\d` 匹配所有 Unicode 十进制数字（全角 ３、阿拉伯 ٣），
 *    JS 的 `\d` 只匹配 ASCII。这里一律写成 `[0-9]`，把差异变窄而不是变宽，
 *    并由构建脚本断言内容里不含非 ASCII 十进制数字（见 build-content.ts）。
 *
 * 3. **`str.findall` 的返回形态**。有两个以上捕获组时 Python 返回元组列表，
 *    JS 要自己从 `matchAll` 里取 `[1]`、`[2]` —— 取错一个索引会静默错位。
 */

/**
 * 运算符别名表。顺序即 `_OP_ALIASES` 的字面量顺序（`_OP_PATTERN` 的排序建立在它之上）。
 */
export const OP_ALIASES: ReadonlyMap<string, string> = new Map([
  ["+", "+"],
  ["加", "+"],
  ["加上", "+"],
  ["-", "-"],
  ["减", "-"],
  ["减去", "-"],
  ["×", "*"],
  ["*", "*"],
  ["乘", "*"],
  ["÷", "/"],
  ["/", "/"],
  ["除以", "/"],
]);

/**
 * `_OP_PATTERN` —— 由 `sorted(key=len(escaped), reverse=True)` 定序。
 * 派生过程见本文件头部说明；这是 Python 实测输出的逐字拷贝：
 *   '\\+|加上|\\-|减去|\\*|除以|加|减|×|乘|÷|/'
 * 唯一的改写是把 `\-` 写成 `-`（在 alternation 里两者等价，而 JS 的
 * identity escape 在 `u` 模式下会报错，不写反斜杠更安全）。
 */
const OP_PATTERN = String.raw`\+|加上|-|减去|\*|除以|加|减|×|乘|÷|/`;

/**
 * 捕获 "10 + 3 = 13" / "8 - 5 ＝ 3" / "13 减去 3 = 10" 这样的等式，支持连算。
 * 对应 `cognitive.py` 的 `_EQUALITY`（`\d` → `[0-9]`）。
 */
export const EQUALITY_RE = new RegExp(
  String.raw`([0-9]+(?:\s*(?:${OP_PATTERN})\s*[0-9]+)+)\s*[=＝]\s*([0-9]+)`,
  "g",
);

/** `_TOKEN` —— 算式里的数字或运算符，按出现顺序切分 */
export const ARITH_TOKEN_RE = new RegExp(String.raw`[0-9]+|${OP_PATTERN}`, "g");

/** `_NUMBER_TOKEN` —— 只取数字（`\d` → `[0-9]`） */
export const NUMBER_TOKEN_RE = /[0-9]+/g;

/**
 * 取出一段文本里出现的所有整数（对应 `{int(tok) for tok in _NUMBER_TOKEN.findall(text)}`）。
 *
 * 用 `matchAll` 而不是 `exec` 循环：`exec` 会共享 `lastIndex`，
 * 一旦中途 return 就会把状态留给下一次调用 —— 那是最难查的一类"时好时坏"。
 */
export function numberTokensIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const match of text.matchAll(NUMBER_TOKEN_RE)) {
    out.add(Number.parseInt(match[0], 10));
  }
  return out;
}
