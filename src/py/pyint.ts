/**
 * Python `int()` 的等价物 —— 只覆盖"数字/字符串 → 整数"这一条路径。
 *
 * 为什么不能直接用 JS 的 `parseInt` / `Number`：Python 的 int() 比它们
 * **既宽又严**，两个方向都会静默出错：
 *
 *   Python                     | JS 的错误答案
 *   ---------------------------|---------------------------------
 *   int("  3  ")  == 3         | parseInt(" 3 ") === 3        ✅
 *   int("+3")     == 3         | parseInt("+3") === 3         ✅
 *   int("-3")     == -3        | parseInt("-3") === -3        ✅
 *   int("1_000")  == 1000      | parseInt("1_000") === 1      ❌ 静默截断
 *   int("3abc")   → ValueError | parseInt("3abc") === 3       ❌ 静默截断
 *   int("3.0")    → ValueError | parseInt("3.0") === 3        ❌ 静默截断
 *   int("0x10")   → ValueError | parseInt("0x10") === 16      ❌
 *   int(3.0)      == 3         | —（JS 不分 int/float）
 *   int(3.5)      → ValueError | Math.trunc(3.5) === 3        ❌
 *
 * 「静默截断」是最要命的一类差异：`"3.0"` 在 Python 里是**错误**（配置/内容写错了），
 * 在 JS 里会变成一个看起来正常的 3，问题就此消失。
 */

/**
 * Python `int(str)` 接受的文本形式：可选正负号 + 数字（数字之间允许单个下划线）。
 *
 * 只认 ASCII 数字。Python 的 `int("３")`（全角）也能通过，但那需要一张
 * Unicode 十进制数字表 —— 与其为一个永不出现的分支引入 200 行映射，
 * 不如把它变成一条**被检查的前置条件**：构建脚本会断言内容里不含非 ASCII 十进制数字
 * （见 scripts/build-content.ts 的字符集断言）。
 */
const PY_INT_TEXT = /^[+-]?[0-9](?:_?[0-9])*$/;

/** `int(str)`：不合法返回 null（对应 Python 的 ValueError） */
export function pyIntFromText(text: string): number | null {
  const trimmed = text.trim();
  if (!PY_INT_TEXT.test(trimmed)) return null;
  const negative = trimmed.startsWith("-");
  const digits = trimmed.replace(/^[+-]/, "").replace(/_/g, "");
  const value = Number.parseInt(digits, 10);
  // Python 的 int 不产生 -0（int("-0") == 0），JS 的 -x 会。
  // 不挡的话 -0 会顺着这里漏出去：`-0 === 0` 为真，但 Object.is(-0, 0) 为假、
  // 1 / -0 === -Infinity、做 Map 键时也可能被当成不同的键 ——
  // 属于"只在某一条路径上炸"的典型坑。
  return negative && value !== 0 ? -value : value;
}

/**
 * Python 的 `int(x)`，失败返回 null（等价 `(TypeError, ValueError)` 两个分支）。
 *
 * 与 Python 的一处**已知且已确认无害的**差异：
 *   Python 里 `3.0` 是 float，`isinstance(3.0, int)` 为 False，
 *   于是走 `int(str(3.0))` = `int("3.0")` → ValueError → None。
 *   JS 从 JSON/YAML 解析出来的 `3.0` 就是 `3`，分不出"作者写的是 3.0"。
 *   所以这里把它当整数接受。
 *
 * 影响面：`_hint_leaks_answer`（hint 里的数字集合）与 `check_answer`
 * （答案复核）会用 `_int` 判"是不是整数"。要在这两处产生实际差异，
 * 需要内容里出现**小数**形式的整数常量。构建脚本断言内容里没有小数常量
 * （见 scripts/build-content.ts），届时这条差异就是空的。
 *
 * 第二处已知差异（同类，同样在 tests/acceptance/py-parity.test.ts 里)**故意不测**）：
 *   Python 的 `int()` 无上界（`int("9"*30)` 是精确值），JS 的 Number 是 double。
 *   30 位以上会丢精度 —— 但两边 dump 到同一份 JSON 里再比较时**丢得一样**，
 *   所以对拍看不见它。真要用大整数得换 BigInt，内容层不可能出现。
 */
export function pyInt(value: unknown): number | null {
  // Python 先判 bool：True 是 int 的子类，不排掉会算出 1
  if (typeof value === "boolean") return null;
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    // JS 没有 int/float 之分，用"是不是整数值"代替 isinstance(value, int)
    return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  }
  if (typeof value === "string") return pyIntFromText(value);
  // Python 的 int(其他对象) 走的是 __int__/__index__，内容层不会用到
  return null;
}
