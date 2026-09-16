/**
 * CPython `random.Random` 的 MT19937 复刻 —— 只做迁移真正用到的那一层。
 *
 * ## 为什么必须**逐位**对齐
 *
 * `engine/detective.py` 的谜题生成器用 `random.Random(seed * 7919 + 13)`，
 * 同一个 `puzzle_id` 必须永远生成同一份谜面：孩子看到的是昨天那道题、
 * 提交的答案要能对上、重放要确定。**只要序列错一位，谜面就换了**。
 *
 * 更糟的是这是**静默**错误：`Puzzle.validate()` 只查自洽性（答案在候选里、
 * 线索能排掉干扰项），错位的谜面照样"合法"，两道 API 都正常返回 200，
 * 只是和刚才展示给孩子的那道题不是同一道。所以这里不靠"看着差不多"，
 * 靠 `tests/acceptance/pyrandom-parity.test.ts` 对 19 个种子逐位对拍。
 *
 * ## 覆盖范围（CPython `_randommodule.c` 的子集）
 *
 *   seed(int) → `init_by_array`，genrand_uint32，getrandbits(k)，
 *   `_randbelow_with_getrandbits`（**含拒绝采样**），randint，choice，random
 *
 * **不覆盖**：`seed(str/bytes)`、`getstate/setstate`、`shuffle`、`sample`、
 * `gauss`、`_randbelow_without_getrandbits`（只在子类覆盖了 `random()` 时走）。
 * 这些在 backend 与 tools 里都没有调用点；真要加的时候照 CPython 补，
 * 并且必须同时扩 fixture。
 *
 * ## 三处**刻意的**表示法决策
 *
 * ① 整数走 `bigint` 而不是 `number`。
 *    Python 的 int 是任意精度：`getrandbits(128)` 给一个 39 位十进制数，
 *    `seed(10**30)` 也是合法输入。用 number 会在 2^53 之后**静默丢精度**，
 *    而且丢在哪一步非常难查（同一个 seed 在 Python 侧对、TS 侧不对，
 *    但两边"看起来"都在算同一个公式）。所以：
 *      - `PyRandom` 的构造参数与 `seed()` 收 `number | bigint`；
 *      - `getrandbits(k)` 返回 `bigint`（忠实：任意 k）；
 *      - `randbelow` / `randint` / `choice` 返回 `number` —— 它们的 n ≤ 2^53
 *        （`randint` 的区间、序列长度），bigint 只用在内部的比较上。
 *    唯一的上限写在 `randbelow` 里：n 必须是 ≤ 2^53 的整数，因为返回值要落回
 *    number。真实调用点（detective 的候选数 ≤ 100、序列长度 ≤ 10）离得很远。
 *
 * ② 所有右移一律用 `>>>`（逻辑右移），不是 `>>`。
 *    C 侧的状态字是 `uint32_t`，`>>` 是逻辑移位；JS 的 number 在 `>>` 下会按
 *    有符号 32 位**符号扩展**。`mt[i] >> 30` 与 `mt[i] >>> 30` 在最高位为 1 时
 *    结果完全不同 —— 这类错误只在"某个状态字的最高位恰好是 1"时才显形，
 *    也就是**偶发**，最难定位。配套纪律：凡是 `& | ^` 组合过的值都接一个
 *    `>>> 0` 转回无符号，别让负数在数组里过夜。
 *
 * ③ 乘法一律用 `Math.imul`。
 *    `1812433253 * x` 用普通 `*` 会超出 2^53 丢低位；`Math.imul` 的语义正是
 *    C 的 32 位截断乘法。
 *
 * ## 一处**不可观测**的差异（照抄但记录在案）
 *
 * `seed()` 里 `mt[0] = 0x80000000` 之后我把 `index` 设为 624（= N，等价于
 * "该 twists 了"）。CPython 的 `init_by_array` 不碰 index，而 `Random.__init__`
 * 里 index 初值也是 0 —— 但 `seed()` 走的 C 路径 `random_seed()` 之后
 * `self->index = N`。所以 624 是对的；写成 0 会让第一次 `genrand()` 直接用
 * 未经 twist 的种子状态，序列完全不同 —— 这一条**有**对拍（seed_state 里的
 * index 字段）。
 */
const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

/** number 能**精确**表示的最大整数 —— 超过它就得走 BigInt */
export const MAX_SAFE = 9007199254740991; // 2^53 - 1

/**
 * Python `int.bit_length()`：`abs(n)` 的二进制位数（0 → 0）。
 *
 * 不能写成 `n.toString(2).length` —— 那是 BigInt 的方法（`Number` 的
 * `toString(2)` 对小数会给二进制小数）。这里收 bigint，统一走一条路。
 */
export function bitLength(value: bigint): number {
  const n = value < 0n ? -value : value;
  return n === 0n ? 0 : n.toString(2).length;
}

/**
 * Python 的 `int` 拆成 32 位小端字数组（CPython `random_seed` 里那一段）。
 *
 * `n = PyNumber_Absolute(arg)` —— **负数取绝对值**，所以 `seed(-5)` 与
 * `seed(5)` 生成同一串随机数。这条容易漏，且漏了以后"负种子"这一类输入
 * 全错而正种子全对。
 *
 * `keyused = bits == 0 ? 1 : (bits - 1) // 32 + 1` —— 注意 0 → **1 个字**，
 * 不是空数组（空数组会让 `init_by_array` 里的 `key[j]` 越界）。
 */
function keyFromInt(seed: number | bigint): number[] {
  const value = typeof seed === "bigint" ? seed : BigInt(seed);
  const a = value < 0n ? -value : value;
  if (a === 0n) return [0];
  const words: number[] = [];
  let rest = a;
  while (rest > 0n) {
    words.push(Number(rest & 0xffffffffn));
    rest >>= 32n;
  }
  return words;
}

/**
 * MT19937 —— 与 CPython `random.Random` 逐位一致。
 *
 * 用法与 Python 对称：`const rng = new PyRandom(seed)` 然后 `randint` / `choice`。
 * 每次取值都推进内部状态，**同一个实例的调用顺序会影响后续所有取值** ——
 * 这正是需要它的原因，也是为什么不能"就地重算"。
 */
export class PyRandom {
  private readonly mt: Uint32Array;
  private index: number;

  constructor(seed: number | bigint) {
    this.mt = new Uint32Array(N);
    this.index = N;
    this.seed(seed);
  }

  /** 重新播种（等价 Python 的 `rng.seed(x)`） */
  seed(seed: number | bigint): void {
    this.initByArray(keyFromInt(seed));
  }

  /** 当前内部状态：624 个状态字 + index（对应 `getstate()[1]`） */
  getState(): number[] {
    return [...this.mt, this.index];
  }

  /**
   * `init_by_array` —— MT19937 原作者给出的数组播种（CPython 的处理）：
   * 先用 19650218 做一次 Knuth 初始化，再两轮把 key 混进去。
   *
   * 两轮的乘数不同（1664525 / 1566083941），第二轮是 `- i` 而不是 `+ j` ——
   * 这四个常数与加减号都对不上就全错，别凭记忆改。
   */
  private initByArray(key: readonly number[]): void {
    const mt = this.mt;
    mt[0] = 19650218;
    for (let i = 1; i < N; i += 1) {
      mt[i] = (Math.imul(1812433253, mt[i - 1]! ^ (mt[i - 1]! >>> 30)) + i) >>> 0;
    }

    let i = 1;
    let j = 0;
    // k = max(key_length, N)：**两者取大**，所以 key 短于 624 时会被循环重复使用
    for (let k = Math.max(key.length, N); k > 0; k -= 1) {
      mt[i] = ((mt[i]! ^ Math.imul(1664525, mt[i - 1]! ^ (mt[i - 1]! >>> 30))) + key[j]! + j) >>> 0;
      i += 1;
      j += 1;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }

    for (let k = N - 1; k > 0; k -= 1) {
      mt[i] = ((mt[i]! ^ Math.imul(1566083941, mt[i - 1]! ^ (mt[i - 1]! >>> 30))) - i) >>> 0;
      i += 1;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
    }

    // MSB 置 1：保证初始数组不全是 0（全 0 是不动点）
    mt[0] = 0x80000000;
    // 见模块头：CPython 在 random_seed() 之后把 index 设成 N，即"该 twists 了"
    this.index = N;
  }

  /** `genrand_uint32` —— 一次一个 32 位状态字，取满 624 个就整体 twists */
  genrandUint32(): number {
    const mt = this.mt;
    if (this.index >= N) {
      let kk = 0;
      for (; kk < N - M; kk += 1) {
        const y = ((mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N - 1; kk += 1) {
        const y = ((mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      const y = ((mt[N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK)) >>> 0;
      mt[N - 1] = (mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      this.index = 0;
    }

    let y = mt[this.index]!;
    this.index += 1;
    // tempering —— 四个位移/掩码都对不上就全错；右移一律 >>>
    y = (y ^ (y >>> 11)) >>> 0;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y;
  }

  /**
   * `getrandbits(k)` —— k 个随机位（0 ≤ 结果 < 2^k）。
   *
   * 返回 bigint 的理由见模块头 ①。实现要点：
   *   - k ≤ 32：一个状态字，`>>> (32 - k)` 取高位（**不是**低位）；
   *   - k > 32：取 `ceil(k / 32)` 个字，**只有最后一个字要右移** `32 - k % 32`，
   *     然后把字按小端拼起来。`k % 32 === 0` 时不移（C 里移 32 位是 UB）。
   */
  getrandbits(k: number): bigint {
    if (!Number.isInteger(k) || k <= 0) {
      throw new ValueErrorPyRandom("number of bits must be greater than zero");
    }
    if (k <= 32) {
      return BigInt(this.genrandUint32() >>> (32 - k));
    }
    const words = Math.floor((k - 1) / 32) + 1;
    const parts: bigint[] = [];
    for (let i = 0; i < words; i += 1) {
      parts.push(BigInt(this.genrandUint32()));
    }
    const rem = k % 32;
    if (rem !== 0) {
      parts[words - 1] = parts[words - 1]! >> BigInt(32 - rem);
    }
    let out = 0n;
    for (let i = words - 1; i >= 0; i -= 1) {
      out = (out << 32n) | parts[i]!;
    }
    return out;
  }

  /**
   * `_randbelow_with_getrandbits(n)` —— `[0, n)` 内的均匀整数。
   *
   * ⚠️ **拒绝采样**：取 `ceil(log2(n))` 位（Python 用 `n.bit_length()`，
   * 注意 n = 1 时是 1 不是 0），落在 `[n, 2^k)` 就**整个重取**。
   * 于是消耗的状态字数不固定 —— n = 1 时约一半的调用要多取一次。
   *
   * 少写这个循环（直接用 `r % n` 或一次 `getrandbits(k)` 硬取）的后果不是
   * "分布略偏"，而是**状态消耗位置全错**：谜题生成器一次要取十几个数，
   * 从第一次拒绝开始后面全歪。
   *
   * n 的上限（≤ 2^53）见模块头 ①：返回值要落回 number。
   */
  randbelow(n: number): number {
    if (!Number.isInteger(n) || n <= 0) {
      throw new ValueErrorPyRandom("_randbelow 要求 n 是正整数");
    }
    if (n - 1 > MAX_SAFE) {
      // 判据是"最大可能的返回值能不能精确表示"：n = 2^53 允许
      // （返回值 ≤ 2^53 - 1，全都能精确表示），再大就不行。
      //
      // 注意这个守卫**只能被 n >= 2^53 + 2 触发**：JS 的 number 在 2^53 之后
      // 有间隔为 2 的空隙，`2 ** 53 + 1` 求值就是 2^53（ties-to-even），
      // 根本表达不出 2^53 + 1 这个数。也就是说"刚刚越界一点点"的输入
      // 在 JS 里不存在 —— 这不是守卫写松了，是那一带的数轴本身是稀疏的。
      throw new ValueErrorPyRandom(
        `_randbelow 的 n 超过 2^53（${n}）—— 返回值超出 number 的精确范围；` +
          "真实调用点到不了这里，若确实需要请先把返回类型改成 bigint",
      );
    }
    const k = bitLength(BigInt(n));
    const limit = BigInt(n);
    let r = this.getrandbits(k);
    while (r >= limit) {
      r = this.getrandbits(k);
    }
    return Number(r);
  }

  /**
   * Python 的 `randint(a, b)`（**闭区间**，与 `randrange` 的半开区间不同）。
   *
   * CPython 是 `randrange(a, b + 1)`，而 randrange 在 `step == 1` 时走
   * `istart + _randbelow(width)` —— 所以这里是 `a + randbelow(b - a + 1)`。
   *
   * ⚠️ **`a === b` 时不能短路返回 a**。写 `if (high === low) return low;` 看起来
   * 是"省一次无用取值"，实则**吞掉了一次状态推进**：Python 照样调
   * `_randbelow(1)`，而 n = 1 时它至少要取一个状态字（约一半的情况要取两个，
   * 因为 `getrandbits(1)` 给 1 就得重取）。吞掉之后本次返回值仍然正确，
   * 但**后面所有取值全部错位** —— 而且错得"看起来合法"。
   * 这一条是被 `mixed_rejection_pressure` 那条交错用例抓出来的：
   * 单原语层的 8 个 `randint(0, 0)` 值全是 0，怎么错都对。
   */
  randint(low: number, high: number): number {
    if (!Number.isInteger(low) || !Number.isInteger(high)) {
      throw new ValueErrorPyRandom("randint 的参数必须是整数");
    }
    const width = high - low + 1;
    if (width <= 0) {
      // Python 的文案：empty range for randrange() (istart, istop, width)
      throw new ValueErrorPyRandom(`empty range for randrange() (${low}, ${high + 1}, ${width})`);
    }
    return low + this.randbelow(width);
  }

  /**
   * Python 的 `choice(seq)`：空序列抛 IndexError（**不是** ValueError），
   * 因为 `_randbelow(0)` 抛的是 ValueError，被 `except` 换成了 IndexError。
   */
  choice<T>(seq: readonly T[]): T {
    if (seq.length === 0) {
      throw new IndexErrorPyRandom("Cannot choose from an empty sequence");
    }
    return seq[this.randbelow(seq.length)]!;
  }

  /**
   * Python 的 `random()` —— `[0.0, 1.0)` 的浮点数。
   *
   * CPython 不是"取 53 位再除"：它取**两个**状态字，第一个只用高 27 位
   * （`>> 5`）、第二个用高 26 位（`>> 6`），拼成 53 位后乘 `1/2^53`。
   * 两次取值的顺序与位数都不能改 —— 它决定状态消耗与浮点结果的最后一位。
   */
  random(): number {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }
}

/** Python 里对应 `ValueError` 的场景（n 非正、区间为空、k 非正） */
export class ValueErrorPyRandom extends Error {
  override readonly name = "ValueErrorPyRandom";
}

/** Python 里对应 `IndexError` 的场景（`choice` 空序列） */
export class IndexErrorPyRandom extends Error {
  override readonly name = "IndexErrorPyRandom";
}
