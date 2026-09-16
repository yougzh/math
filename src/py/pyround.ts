/**
 * Python `round()` 的等价物 —— 银行家舍入（half-even），不是 JS 的"取较大"。
 *
 * 为什么不能用 `Math.round` / `toFixed`：
 *
 *   Python              | JS 的错误答案
 *   --------------------|--------------------------------
 *   round(0.5) == 0     | Math.round(0.5) === 1        ❌
 *   round(2.5) == 2     | Math.round(2.5) === 3        ❌
 *   round(-0.5) == 0    | Math.round(-0.5) === -0      ✅（都是 0 值）
 *   round(1.5) == 2     | Math.round(1.5) === 2        ✅
 *   round(2.675, 2)     | (2.675).toFixed(2) !== "2.67" ❌ 见下
 *
 * `round(2.675, 2)` 是**必错**的那一类：2.675 的 double 真值是
 * 2.67499999999999982236431605997495353221893310546875，所以 Python 给 2.67。
 * 任何"先乘 100 再取整"的实现都会先把这个值变成 267.49999999999997 或
 * 267.50000000000006（乘法的再次舍入），结果不稳定。
 *
 * 做法（与 Python 的 `float.__round__` 同语义，不做乘法近似）：
 *   1. 把 double 拆成 `m × 2^e` 的**精确**形式（BigInt，无任何误差）；
 *   2. 在 BigInt 上做"精确值 ÷ 10^ndigits"的除法，用余数判 half-even；
 *   3. 把结果拼成十进制**字符串**，交回 `Number()` —— JS 的字符串转数字
 *      是正确舍入的（等价于 C 的 strtod），这一步与 Python 的 dtoa → strtod 同构。
 *
 * 为什么第 3 步不能省成"除以 10^n"：`q / 10n ** BigInt(n)` 会引入一次 double
 * 除法，而 Python 是"精确十进制 → 最近 double"。两者对边界值给出不同的 double。
 */

/**
 * double 的精确二进制分解 `value = ±magnitude × 2^e`。
 *
 * 符号**必须单独返回**，不能靠 `m < 0n` 反推：BigInt 没有负零（`-0n === 0n`），
 * `-0.0` 的尾数与指数全 0，用符号位的 BigInt 取负会把它变成正零 ——
 * 而 Python 的 `round(-0.0, 2)` 是 `-0.0`。
 */
function exactParts(value: number): { magnitude: bigint; e: number; negative: boolean } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = (bits >> 63n) === 1n;
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  // 阶码全 0 是次正规数：没有隐含的前导 1，指数固定为 -1074
  const magnitude = rawExponent === 0 ? fraction : fraction | (1n << 52n);
  const exponent = rawExponent === 0 ? -1074 : rawExponent - 1075;
  return { magnitude, e: exponent, negative };
}

/** `q × 10^-ndigits` 的十进制写法（q 非负）。ndigits 可正可负可零 */
function decimalString(q: bigint, ndigits: number): string {
  if (ndigits === 0) return q.toString();
  if (ndigits < 0) return q.toString() + "0".repeat(-ndigits);
  // padStart 保证留得下整数部分的那个 "0"（q = 5、ndigits = 2 时给 "0.05" 而不是 ".05"）
  const digits = q.toString().padStart(ndigits + 1, "0");
  return `${digits.slice(0, -ndigits)}.${digits.slice(-ndigits)}`;
}

/** 精确值 `A / B` 的 half-even 取整（A、B 均非负，B > 0） */
function divHalfEven(A: bigint, B: bigint): bigint {
  const quotient = A / B;
  const remainder = A % B;
  if (remainder === 0n) return quotient;
  const twice = remainder * 2n;
  if (twice > B) return quotient + 1n;
  if (twice < B) return quotient;
  // 恰好一半：取偶数
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/**
 * Python `round(value)` / `round(value, ndigits)`。
 *
 * - `ndigits` 省略或传 `null` → `round(value)`：等价 Python 返回 **int** 的那个重载。
 * - `ndigits` 是数字 → `round(value, ndigits)`：等价 Python 返回 **float** 的重载。
 *
 * ⚠️ **JS 表达不了 int / float 的区别**，所以两种重载在这里都返回 number。
 * 数值完全一致，但**序列化不一致**：`json.dumps(round(2.5))` 给 `"2"`，
 * `json.dumps(round(2.5, 0))` 给 `"2.0"`。replay 的 `_state_fingerprint` 用的是
 * `json.dumps(..., sort_keys=True)`，所以到了 S3 那条链上必须另做区分 ——
 * 那需要在 `pyjson` 里带"这是不是一个整数值的 float"的信息，不能只靠 number。
 *
 * 三处与 Python 对齐的边界行为（都有对拍用例）：
 *   - `round(inf, n)` / `round(nan, n)` 原样返回（Python 不抛异常）；
 *   - `round(-0.0, n)` 给 `-0.0`，而 `round(-0.4)`（无 ndigits）给 `0`
 *     —— Python 的 int 没有负零；
 *   - `ndigits >= 1075` 一定是空操作（double 的精确展开最多 1074 位小数），
 *     直接返回原值，避免为一次空操作去构造几千位的 BigInt。
 */
export function pyRound(value: number, ndigits: number | null = null): number {
  if (!Number.isFinite(value)) return value;

  const noDigits = ndigits === null;
  const n = noDigits ? 0 : ndigits;

  // double 的精确小数展开最长 1074 位（次正规数的最小指数是 -1074），
  // 所以 n >= 1075 时舍入位之后全是 0 —— 空操作，直接短路。
  if (n >= 1075) return value;
  // 反过来，double 的绝对值最大约 1.8e308，在 10^400 这一位上舍入必然是 0。
  if (n < -400) return value < 0 || Object.is(value, -0) ? -0 : 0;

  const { magnitude, e, negative } = exactParts(value);

  // 要算的是 round_half_even(value × 10^n)，用 BigInt 精确表示成 A / B：
  //   n >= 0  →  分子带 10^n、分母不带
  //   n <  0  →  分母带 10^(-n)
  //   e >= 0  →  精确值本来就是整数，2^e 进分子
  //   e <  0  →  2^(-e) 进分母
  // 四条是**互相独立**的：早先把 e >= 0 当成"不需要除法"直接跳过分母，
  // 结果 1e21 这种大整数根本没乘 2^17，输出 7629394531250000（被对拍抓住）。
  let numerator = n >= 0 ? magnitude * 10n ** BigInt(n) : magnitude;
  let denominator = n < 0 ? 10n ** BigInt(-n) : 1n;
  if (e >= 0) numerator <<= BigInt(e);
  else denominator <<= BigInt(-e);

  const rounded = denominator === 1n ? numerator : divHalfEven(numerator, denominator);

  // 无 ndigits 的重载返回 Python 的 int —— int 没有负零
  if (noDigits && rounded === 0n) return 0;

  return Number(`${negative ? "-" : ""}${decimalString(rounded, n)}`);
}
