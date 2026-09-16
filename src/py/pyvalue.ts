/**
 * Python 值语义的等价物：`dict.get` / `str()` / `format(x, ".1f")`。
 *
 * 这几处单独成文件，是因为它们的差异都是**静默**的 —— 写错了不会报错，
 * 只会让某个分支永远走不到，然后表现为"校验少报了一条"或"文案差一个字"。
 *
 * 这是 S2/S3 引擎层会反复用到的几个原语（Python 代码里 `.get(k, default)`
 * 出现频率极高），所以放在 `py/` 而不是某个具体模块内部。
 */

/**
 * Python 的 `dict.get(key, fallback)` —— **只有键不存在**时才返回 fallback；
 * 键存在但值是 `null` 时返回 `null`。
 *
 * 为什么必须区分：Python 里 `item.problem.get("op", "add")` 在内容写了
 * `op:`（空值）时拿到的是 `None`（然后 `str(None)` = `"None"`，与 `"add"` 不同）。
 * JS 的 `?? "add"` 会给出 `"add"` —— "作者写了个空值"这件事实被悄悄抹平，
 * 而这类空值往往是内容写错的第一现场。
 *
 * 用 `Object.hasOwn` 而不是 `in`：JSON/YAML 解析出来的对象继承 Object.prototype，
 * `"toString" in obj` 是 true —— 那样 `get("toString")` 会返回一个函数而不是"缺失"。
 *
 * 参数类型是 `object` 而不是 `Record<string, unknown>`：移植里会拿它去读
 * 已经定型的接口（`ErrorRule` 之类），那些接口没有索引签名。放宽到 `object`
 * 省掉调用点的双重强转，语义不变。
 */
export function pyGet(node: object, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(node, key) ? (node as Record<string, unknown>)[key] : fallback;
}

/**
 * Python 的 `str(value)`。
 *
 * 覆盖移植里真正用得到的形态：字符串恒等、bool 给 `"True"/"False"`、
 * `None` 给 `"None"`、数字给十进制。
 *
 * 容器/对象在 Python 里 `str()` 会给 repr（`"{'a': 1}"`），这里给 `String(value)`。
 * 这是一处**已知且被说明的**差异：本函数的调用点都是"与某个字面量比较"
 * （例如 `op(item) == "sub"`），容器走哪条都不可能相等，所以结果相同。
 * 若将来要拿它做输出，必须先把这一条补上。
 */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  if (typeof value === "number") return String(value);
  return String(value);
}

/**
 * Python `str([1, 2, 3])` —— 数字列表的 repr。
 *
 * 只处理数字列表，因为那是实际用到的形态（校验文案里的 `sorted(sequences)`、
 * `sorted(param_numbers)`）。完整的 Python repr 还要管字符串（`'a'` 带引号）、
 * dict（`{'k': 1}`）、嵌套容器 —— 那些形态在本项目里没出现过，
 * 真要用到再补，别提前实现一半。
 *
 * 分隔符是 `", "`（逗号 + 空格）：JS 的 `Array.prototype.toString()` 给 `1,2,3`，
 * 而 Python 给 `1, 2, 3` —— 一个字之差，但对拍时就是一个红。
 */
export function pyNumberListRepr(values: readonly number[]): string {
  return `[${values.map((value) => pyStr(value)).join(", ")}]`;
}

/**
 * Python `format(value, ".Nf")` —— 定点 N 位小数。
 *
 * ⚠️ **不能直接用 `value.toFixed(N)`**：两者对"恰好 .x5"的舍入规则不同 ——
 * Python 是 half-even（`format(0.25, ".1f")` → `"0.2"`），
 * JS 是"两个候选里取较大的"（`(0.25).toFixed(1)` → `"0.3"`）。
 * 实测 `n / 60`（n = 0..600）里有 **10 个值**落在分歧点上（0.25 / 1.25 / … / 9.25），
 * 而故事时长恰好是 `estimated_seconds / 60` —— 一个 15 秒的槽位在 lint 文案里
 * 写 "0.2 分钟" 还是 "0.3 分钟"，完全取决于用哪个实现。
 *
 * 做法：先用 `toFixed(30)` 拿到足够精确的十进制展开，再手工做 half-even。
 * 30 位够用的理由：double 尾数 53 位，对 `|value| < 1e21` 这个量级，
 * 相邻可表示值之间的距离远大于 `10^-30` —— 也就是说，值要么**精确**等于
 * 某个 N 位小数（那么第 N 位之后全是 0，字符串比较能认出来），
 * 要么与它相差至少一个可表示的间隔（`toFixed(30)` 展开出的非零位会让
 * 字符串比较直接判出"偏离"）。实测 613 个值（n/60 与一批手工挑的进位边界）
 * 与 Python 输出**零差异**。
 *
 * `signal_summary` 的 `{:.2f}` 与 lint 文案的 `{:.1f}` 走的是同一个实现 ——
 * 分歧点只跟"位数"有关，逻辑完全相同，所以这里是 `digits` 参数而不是两个函数。
 *
 * 已知边界：`|value| >= 1e21` 时 JS 的 `toFixed` 返回科学计数法，本实现失效
 * （Python 会输出完整整数部分）。调用点是"分钟数"与"信号值"这个量级，碰不到；
 * 真要用于大数，先把它改成基于 `pyRound` 的 BigInt 版。
 */
export function pyFormatFixed(value: number, digits: number): string {
  // 上界 20 而不是 30：`rest`（用于判断 half-even 的剩余位）必须非空，
  // 而 `toFixed(30)` 只给 30 位小数。真要更大位数，先把这里的 30 一起调大。
  if (!Number.isInteger(digits) || digits < 0 || digits > 20) {
    throw new RangeError(`pyFormatFixed 只支持 0~20 位小数，收到 ${digits}`);
  }

  // -0.0 也要带符号：Python 的 format(-0.0, ".1f") 是 "-0.0"，而 -0.0 < 0 为假
  const negative = value < 0 || Object.is(value, -0);
  const text = Math.abs(value).toFixed(30);
  const dot = text.indexOf(".");
  const intPart = text.slice(0, dot);
  const fracPart = text.slice(dot + 1);

  const kept = fracPart.slice(0, digits);
  const rest = fracPart.slice(digits);
  // 等长数字串的字典序 = 数值序，所以直接比字符串
  const half = "5" + "0".repeat(rest.length - 1);

  let rounded = kept === "" ? 0 : Number(kept);
  if (rest > half) rounded += 1;
  else if (rest === half && rounded % 2 === 1) rounded += 1;

  let whole = intPart;
  if (rounded === 10 ** digits) {
    // 进位溢出到整数部分：0.999 + 0.001 → 1.000
    rounded = 0;
    // BigInt 而不是 Number：整数部分可能有几十位，Number 会丢精度
    whole = String(BigInt(intPart) + 1n);
  }
  const fraction = digits === 0 ? "" : `.${String(rounded).padStart(digits, "0")}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** Python `format(value, ".1f")` —— 定点一位小数（lint 文案用） */
export function pyFormat1f(value: number): string {
  return pyFormatFixed(value, 1);
}
