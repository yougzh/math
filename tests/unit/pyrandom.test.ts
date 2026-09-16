/**
 * pyrandom 的合成数据单测 —— 对拍 fixture 覆盖不到的那些点。
 *
 * 对拍已经证明了"与 CPython 逐位一致"，所以这里**不再重复对拍**，只补四类：
 *
 * ① **边界与错误**：k=0、n=0、空序列、空区间 —— fixture 里全是正常输入；
 * ② **接口契约**：`getState()` 返回副本、两个实例互不影响、重新播种等价于新建；
 * ③ **数学性质**：取值恒在 `[0, n)`、`getrandbits(k) < 2^k`、
 *    `randint(a, a)` 恒为 a（但**仍然消耗状态**，这条与对拍呼应）；
 * ④ **JS 特有的坑**：number/bigint 两种 seed 等价、超出 2^53 的 n 要炸而不是
 *    静默丢精度。
 */
import { describe, expect, it } from "vitest";

import {
  IndexErrorPyRandom,
  MAX_SAFE,
  PyRandom,
  ValueErrorPyRandom,
  bitLength,
} from "@/src/py/pyrandom";

// ══════════════════════════════════════════════════════════
describe("bitLength", () => {
  it("等价 Python 的 int.bit_length()", () => {
    // (输入, Python 的 n.bit_length())
    const cases: Array<[bigint, number]> = [
      [0n, 0],
      [1n, 1],
      [2n, 2],
      [3n, 2],
      [4n, 3],
      [7n, 3],
      [8n, 4],
      [255n, 8],
      [256n, 9],
      [4294967295n, 32],
      [4294967296n, 33],
      [BigInt(MAX_SAFE), 53],
      [2n ** 53n, 54],
      [2n ** 64n, 65],
      [10n ** 30n, 100],
    ];
    for (const [value, expected] of cases) {
      expect(bitLength(value), `bitLength(${value})`).toBe(expected);
    }
  });

  it("负数取绝对值 —— Python 的 int.bit_length() 也是", () => {
    expect(bitLength(-1n)).toBe(1);
    expect(bitLength(-255n)).toBe(8);
    expect(bitLength(-(2n ** 53n))).toBe(54);
  });
});

// ══════════════════════════════════════════════════════════
describe("PyRandom 的接口契约", () => {
  it("同一个 seed 给同一串数；两个实例互不影响", () => {
    const a = new PyRandom(42);
    const b = new PyRandom(42);
    const c = new PyRandom(43);
    expect(a.randint(1, 100)).toBe(b.randint(1, 100));
    expect(new PyRandom(42).randint(1, 100)).not.toBe(c.randint(1, 100));
  });

  it("number 与 bigint 两种 seed 完全等价", () => {
    expect(new PyRandom(5n).getState()).toStrictEqual(new PyRandom(5).getState());
    expect(new PyRandom(0n).getState()).toStrictEqual(new PyRandom(0).getState());
    expect(new PyRandom(-7n).getState()).toStrictEqual(new PyRandom(-7).getState());
  });

  it("**负数 seed 与它的绝对值同解**（CPython 的 PyNumber_Absolute）", () => {
    expect(new PyRandom(-5).getState()).toStrictEqual(new PyRandom(5).getState());
    expect(new PyRandom(-(2 ** 40)).getState()).toStrictEqual(new PyRandom(2 ** 40).getState());
  });

  it("`seed()` 重新播种 == 新建一个", () => {
    const rng = new PyRandom(1);
    rng.randint(1, 1000); // 推进状态
    rng.seed(7);
    expect(rng.getState()).toStrictEqual(new PyRandom(7).getState());
    expect(rng.randint(1, 1000)).toBe(new PyRandom(7).randint(1, 1000));
  });

  it("`getState()` 返回的是**副本**：改它不影响生成器", () => {
    const rng = new PyRandom(5);
    const snapshot = rng.getState();
    snapshot[0] = 0;
    snapshot[624] = 0;
    expect(rng.getState()).toStrictEqual(new PyRandom(5).getState());
  });

  it("`getState()` 的长度恒为 625（624 状态字 + index）", () => {
    const rng = new PyRandom(5);
    expect(rng.getState()).toHaveLength(625);
    rng.randint(1, 10);
    expect(rng.getState()).toHaveLength(625);
    // 取满 624 个以上会 twists，长度不变、index 回绕
    for (let i = 0; i < 700; i += 1) rng.genrandUint32();
    expect(rng.getState()).toHaveLength(625);
  });

  it("twists 是真的发生的：index 会回绕到 0 附近", () => {
    const rng = new PyRandom(5);
    for (let i = 0; i < 623; i += 1) rng.genrandUint32();
    expect(rng.getState()[624]).toBe(623);
    rng.genrandUint32(); // 第 624 个：仍是种子状态
    expect(rng.getState()[624]).toBe(624);
    rng.genrandUint32(); // 第 625 个：触发 twists，index 归 0 再自增
    expect(rng.getState()[624]).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════
describe("getrandbits 的取值域与边界", () => {
  it("结果恒在 [0, 2^k)", () => {
    const rng = new PyRandom(12345);
    for (let k = 1; k <= 40; k += 1) {
      const limit = 1n << BigInt(k);
      for (let i = 0; i < 20; i += 1) {
        const v = rng.getrandbits(k);
        expect(v >= 0n, `k=${k}`).toBe(true);
        expect(v < limit, `k=${k}`).toBe(true);
      }
    }
  });

  it("k 很大时仍精确（bigint，不经过 number）", () => {
    const rng = new PyRandom(5);
    const v = rng.getrandbits(128);
    expect(v < 1n << 128n).toBe(true);
    // 与"取 4 个状态字再拼"逐位一致 —— 顺带证明 128 位没有精度损失
    const rng2 = new PyRandom(5);
    const parts = [0, 1, 2, 3].map(() => BigInt(rng2.genrandUint32()));
    const manual = (parts[3]! << 96n) | (parts[2]! << 64n) | (parts[1]! << 32n) | parts[0]!;
    expect(v).toBe(manual);
  });

  it("k=32 与裸的 genrandUint32() 完全一致", () => {
    const a = new PyRandom(9);
    const b = new PyRandom(9);
    for (let i = 0; i < 10; i += 1) {
      expect(a.getrandbits(32)).toBe(BigInt(b.genrandUint32()));
    }
  });

  it("k=1 只给 0 或 1；多次取样两种都出现过", () => {
    const rng = new PyRandom(5);
    const seen = new Set<bigint>();
    for (let i = 0; i < 50; i += 1) seen.add(rng.getrandbits(1));
    expect([...seen].sort()).toStrictEqual([0n, 1n]);
  });

  it("k=33 时最后一个状态字**要右移**（`k % 32 !== 0` 的那条路）", () => {
    // 33 位 = 1 个字 + 末字的高 1 位；末字不移的话位宽会变成 64
    const rng = new PyRandom(5);
    const v = rng.getrandbits(33);
    expect(v < 1n << 33n).toBe(true);
    expect(v >> 32n).toBeLessThanOrEqual(1n);
  });

  it("k 不是整数或 ≤ 0 时抛错", () => {
    const rng = new PyRandom(5);
    expect(() => rng.getrandbits(0)).toThrow(ValueErrorPyRandom);
    expect(() => rng.getrandbits(-1)).toThrow(ValueErrorPyRandom);
    expect(() => rng.getrandbits(1.5)).toThrow(ValueErrorPyRandom);
    expect(() => rng.getrandbits(Number.NaN)).toThrow(ValueErrorPyRandom);
  });
});

// ══════════════════════════════════════════════════════════
describe("randbelow / randint 的边界", () => {
  it("randbelow 的结果恒在 [0, n)", () => {
    const rng = new PyRandom(2024);
    for (const n of [1, 2, 3, 10, 100, 1000]) {
      for (let i = 0; i < 30; i += 1) {
        const v = rng.randbelow(n);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(n);
      }
    }
  });

  it("randbelow(1) 恒给 0，且消耗的字数与「一直取到 0 为止」逐字一致", () => {
    const rng = new PyRandom(5);
    const ref = new PyRandom(5);
    for (let i = 0; i < 10; i += 1) expect(rng.randbelow(1)).toBe(0);
    // 对照：手动取 getrandbits(1)，取到 0 才计数（这正是 randbelow(1) 的循环）
    let zeros = 0;
    while (zeros < 10) {
      if (ref.getrandbits(1) === 0n) zeros += 1;
    }
    expect(rng.getState()).toStrictEqual(ref.getState());
  });

  it("n 是 2^53 时允许（返回值全都能精确表示）", () => {
    const rng = new PyRandom(5);
    const v = rng.randbelow(2 ** 53);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(2 ** 53);
  });

  it("n 超过 2^53 时**炸**，而不是静默丢精度", () => {
    const rng = new PyRandom(5);
    // ⚠️ 只能这么写：JS 的 number 在 2^53 之后有**空隙**，
    // `2 ** 53 + 1` 根本求不出 2^53+1 —— 它求值为 2^53（ties-to-even），
    // 于是那一条是**合法**输入，不会抛错。相邻的可表示值是 +2。
    expect(2 ** 53 + 1).toBe(2 ** 53);
    expect(() => rng.randbelow(2 ** 53 + 2)).toThrow(ValueErrorPyRandom);
    expect(() => rng.randbelow(2 ** 54)).toThrow(ValueErrorPyRandom);
  });

  it("n 非正或非整数时抛错", () => {
    const rng = new PyRandom(5);
    for (const n of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => rng.randbelow(n), `n=${n}`).toThrow(ValueErrorPyRandom);
    }
  });

  it("randint 是**闭区间**：两端都能取到，且不越界", () => {
    const rng = new PyRandom(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const v = rng.randint(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toStrictEqual([3, 4, 5, 6]);
  });

  it("`randint(a, a)` 恒给 a —— 但**仍然消耗状态**（不能短路）", () => {
    const rng = new PyRandom(5);
    const fresh = new PyRandom(5);
    expect(rng.randint(7, 7)).toBe(7);
    // 短路返回的话这条会相等，随后整个序列错位
    expect(rng.getState()).not.toStrictEqual(fresh.getState());
    // 且与"先取一次 randbelow(1)"完全同步
    const manual = new PyRandom(5);
    manual.randbelow(1);
    expect(rng.getState()).toStrictEqual(manual.getState());
  });

  it("空区间与倒置区间抛错", () => {
    const rng = new PyRandom(5);
    expect(() => rng.randint(5, 4)).toThrow(ValueErrorPyRandom);
    expect(() => rng.randint(1, 0)).toThrow(ValueErrorPyRandom);
    expect(() => rng.randint(1.5, 3)).toThrow(ValueErrorPyRandom);
  });
});

// ══════════════════════════════════════════════════════════
describe("choice", () => {
  it("取到的元素恒来自序列，且每个元素都能被取到", () => {
    const rng = new PyRandom(11);
    const seq = ["a", "b", "c"];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(rng.choice(seq));
    expect([...seen].sort()).toStrictEqual(["a", "b", "c"]);
  });

  it("单元素序列恒给那个元素（但仍然消耗状态）", () => {
    const rng = new PyRandom(5);
    const fresh = new PyRandom(5);
    expect(rng.choice(["only"])).toBe("only");
    expect(rng.getState()).not.toStrictEqual(fresh.getState());
  });

  it("空序列抛 IndexError（**不是** ValueError —— Python 换过一次）", () => {
    const rng = new PyRandom(5);
    expect(() => rng.choice([])).toThrow(IndexErrorPyRandom);
    // 两个错误类型是分开的，别让上层 catch 错
    expect(() => rng.choice([])).not.toThrow(ValueErrorPyRandom);
  });

  it("接受 readonly 数组（真实调用点传的是常量表）", () => {
    const KINDS = ["step", "alternate", "growing_step"] as const;
    const rng = new PyRandom(3);
    const v = rng.choice(KINDS);
    expect(KINDS).toContain(v);
  });

  it("与 Python 的 `seq[_randbelow(len(seq))]` 同步（不是自己实现一套索引）", () => {
    const a = new PyRandom(13);
    const b = new PyRandom(13);
    const seq = [10, 20, 30, 40];
    for (let i = 0; i < 10; i += 1) {
      expect(a.choice(seq)).toBe(seq[b.randbelow(seq.length)]);
    }
  });
});

// ══════════════════════════════════════════════════════════
describe("random() 的取值域", () => {
  it("恒在 [0, 1)，且一次消耗**两个**状态字", () => {
    const rng = new PyRandom(5);
    for (let i = 0; i < 100; i += 1) {
      const v = rng.random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const counted = new PyRandom(5);
    for (let i = 0; i < 5; i += 1) counted.random();
    expect(counted.getState()[624]).toBe(10);
  });

  it("首个值等于「取两个字再按公式算」的结果", () => {
    const rng = new PyRandom(0);
    const raw = new PyRandom(0);
    const a = raw.genrandUint32() >>> 5;
    const b = raw.genrandUint32() >>> 6;
    expect(rng.random()).toBe((a * 67108864.0 + b) * (1.0 / 9007199254740992.0));
  });
});
