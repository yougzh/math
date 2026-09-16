/**
 * pyrandom 对拍 —— TS 的 MT19937 vs CPython `random.Random` 的黄金语料。
 *
 * `tests/oracle/fixtures/pyrandom_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py pyrandom` 产出。
 *
 * ## 三层结构，少一层都验不出"消耗顺序"
 *
 *   1. `seed_state` —— 播种算完后的 625 个整数（624 状态字 + index）。
 *      只比这一层能验种子算法，但验不了取值；
 *   2. `raw_words` / `getrandbits` / `randbelow` / `randint` / `choice` /
 *      `random_float` —— 每个原语在各自的新实例上跑，比"取出来的是什么"。
 *      这些**都验不了消耗顺序**：每个 case 都从一个新种子开始，
 *      "多取或少取一个状态字"在单原语层看不出差别；
 *   3. `mixed` —— 交错调用 + 跑完后的状态。这才是抓"消耗顺序"的那一层，
 *      也是唯一能挡住"拒绝采样漏写"的地方。
 *
 * ## 大整数用字符串编码
 *
 * fixture 里 seed 与 `getrandbits` 的值是**十进制字符串**：`2**64`、`10**30`
 * 这类值 `JSON.parse` 读回来会被截断成最近的 double。见 dump 脚本里的注释。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PyRandom, bitLength } from "@/src/py/pyrandom";

interface SeedCase {
  seed: string;
  state: number[];
}

interface RawWordsCase {
  seed: string;
  words: number[];
  state: number[];
}

interface GetrandbitsCase {
  seed: string;
  k: number;
  values: string[];
}

interface RandbelowCase {
  seed: string;
  n: number;
  values: number[];
  getrandbits_calls: number;
  bit_length: number;
}

interface RandintCase {
  seed: string;
  low: number;
  high: number;
  values: number[];
}

interface ChoiceCase {
  seed: string;
  seq: (string | number)[];
  values: (string | number)[];
}

interface FloatCase {
  seed: string;
  values: number[];
}

interface MixedOp {
  op: "randint" | "choice" | "getrandbits" | "random";
  low?: number;
  high?: number;
  k?: number;
  seq?: (string | number)[];
  value: number | string;
}

interface MixedCase {
  id: string;
  seed: string;
  results: MixedOp[];
  state: number[];
}

interface Fixture {
  seed_state: SeedCase[];
  raw_words: RawWordsCase[];
  getrandbits: GetrandbitsCase[];
  randbelow: RandbelowCase[];
  randint: RandintCase[];
  choice: ChoiceCase[];
  random_float: FloatCase[];
  mixed: MixedCase[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/pyrandom_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

/** fixture 里的 seed 是十进制字符串（可能是 30 位数字），必须走 BigInt */
function rngOf(seed: string): PyRandom {
  return new PyRandom(BigInt(seed));
}

// ══════════════════════════════════════════════════════════
describe("pyrandom 对拍：前置一致性", () => {
  it("三层都非空（少一层就是一个原语完全没被验）", () => {
    expect(fixture.seed_state.length).toBeGreaterThan(0);
    expect(fixture.mixed.length).toBeGreaterThan(0);
    for (const key of [
      "raw_words",
      "getrandbits",
      "randbelow",
      "randint",
      "choice",
      "random_float",
    ] as const) {
      expect(fixture[key].length, key).toBeGreaterThan(0);
    }
  });

  it("每个种子的状态都是 624 个状态字 + index", () => {
    for (const c of fixture.seed_state) {
      expect(c.state.length, `seed=${c.seed}`).toBe(625);
    }
  });

  it("mixed 里每种 op 都出现过（有一种没覆盖 = 那条分支没人验）", () => {
    const ops = new Set<string>();
    for (const c of fixture.mixed) for (const r of c.results) ops.add(r.op);
    expect([...ops].sort()).toEqual(["choice", "getrandbits", "randint", "random"]);
  });

  it("getrandbits 的 k 跨过了 32 位边界与 32 的整倍数", () => {
    const ks = new Set(fixture.getrandbits.map((c) => c.k));
    for (const k of [1, 32, 33, 64, 65, 128]) {
      expect(ks.has(k), `缺少 k=${k}`).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════
describe("pyrandom 对拍：fixture 自证", () => {
  it("**拒绝采样真的发生过** —— 多出的 getrandbits 调用次数就是证据", () => {
    const rejected = fixture.randbelow.filter((c) => c.getrandbits_calls > c.values.length);
    expect(rejected.length, "没有任何一条 case 触发过拒绝采样 —— 那个 while 循环没被验").toBeGreaterThan(0);
    // n 是 2 的幂时取不满，拒绝率低；n=1 时约 50% 拒绝 → 这里应该远超
    const nOnes = fixture.randbelow.find((c) => c.n === 1)!;
    expect(nOnes.getrandbits_calls).toBeGreaterThan(nOnes.values.length);
  });

  it("bit_length 与 n 的关系覆盖了「n 是 2 的幂」与「不是」两类", () => {
    for (const c of fixture.randbelow) {
      // Python 是 n.bit_length()，对 2 的幂会"多一位"（n=4 → 3），
      // 这正是 k 的取值来源 —— 写成 (n-1).bit_length() 就错了
      expect(bitLength(BigInt(c.n)), `n=${c.n}`).toBe(c.bit_length);
    }
    const powersOfTwo = fixture.randbelow.filter((c) => (c.n & (c.n - 1)) === 0 && c.n > 0);
    const others = fixture.randbelow.filter((c) => (c.n & (c.n - 1)) !== 0);
    expect(powersOfTwo.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
  });

  it("种子覆盖了 0 / 负数 / 超过 2^53 的大整数", () => {
    const seeds = fixture.seed_state.map((c) => BigInt(c.seed));
    expect(seeds.some((s) => s === 0n)).toBe(true);
    expect(seeds.some((s) => s < 0n)).toBe(true);
    expect(seeds.some((s) => s > 9007199254740991n)).toBe(true);
  });

  it("**负数种子与它的绝对值同解**（CPython 的 PyNumber_Absolute）", () => {
    const bySeed = new Map(fixture.seed_state.map((c) => [c.seed, c.state]));
    expect(bySeed.get("-5")).toStrictEqual(bySeed.get("5"));
    expect(bySeed.get("-12345")).toStrictEqual(bySeed.get("12345"));
    // 而 -1 与 1 同解，所以"负数走另一条路"的写法会在这里露出来
    expect(bySeed.get("-1")).toStrictEqual(bySeed.get("1"));
  });

  it("seed_state 的 index 恒为 624（未 twists）", () => {
    for (const c of fixture.seed_state) {
      expect(c.state[624], `seed=${c.seed}`).toBe(624);
    }
  });

  it("mixed 里出现了 k>32 的 getrandbits（多状态字的那条路）", () => {
    const big = fixture.mixed.flatMap((c) => c.results).filter((r) => (r.k ?? 0) > 32);
    expect(big.length).toBeGreaterThan(0);
  });

  it("random_float 的值都落在 [0, 1) 且互不相同", () => {
    const all = fixture.random_float.flatMap((c) => c.values);
    expect(all.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });
});

// ══════════════════════════════════════════════════════════
describe("pyrandom 对拍：第 1 层 —— 播种后的状态", () => {
  for (const c of fixture.seed_state) {
    it(`seed(${c.seed}) 的 625 个整数逐位一致`, () => {
      expect(rngOf(c.seed).getState()).toStrictEqual(c.state);
    });
  }
});

// ══════════════════════════════════════════════════════════
describe("pyrandom 对拍：第 2 层 —— 单原语", () => {
  for (const c of fixture.raw_words) {
    it(`seed(${c.seed}) 连取 40 个状态字，且跑完后的状态一致`, () => {
      const rng = rngOf(c.seed);
      const words = Array.from({ length: 40 }, () => rng.genrandUint32());
      expect(words).toStrictEqual(c.words);
      expect(rng.getState()).toStrictEqual(c.state);
    });
  }

  for (const c of fixture.getrandbits) {
    it(`seed(${c.seed}) getrandbits(${c.k}) × ${c.values.length}`, () => {
      const rng = rngOf(c.seed);
      const got = Array.from({ length: c.values.length }, () => rng.getrandbits(c.k).toString());
      expect(got).toStrictEqual(c.values);
    });
  }

  for (const c of fixture.randbelow) {
    it(`seed(${c.seed}) randbelow(${c.n}) × ${c.values.length}`, () => {
      const rng = rngOf(c.seed);
      const got = Array.from({ length: c.values.length }, () => rng.randbelow(c.n));
      expect(got).toStrictEqual(c.values);
    });
  }

  for (const c of fixture.randint) {
    it(`seed(${c.seed}) randint(${c.low}, ${c.high}) × ${c.values.length}`, () => {
      const rng = rngOf(c.seed);
      const got = Array.from({ length: c.values.length }, () => rng.randint(c.low, c.high));
      expect(got).toStrictEqual(c.values);
    });
  }

  for (const c of fixture.choice) {
    it(`seed(${c.seed}) choice(${JSON.stringify(c.seq)}) × ${c.values.length}`, () => {
      const rng = rngOf(c.seed);
      const got = Array.from({ length: c.values.length }, () => rng.choice(c.seq));
      expect(got).toStrictEqual(c.values);
    });
  }

  for (const c of fixture.random_float) {
    it(`seed(${c.seed}) random() × ${c.values.length}（浮点逐位一致）`, () => {
      const rng = rngOf(c.seed);
      const got = Array.from({ length: c.values.length }, () => rng.random());
      expect(got).toStrictEqual(c.values);
    });
  }
});

// ══════════════════════════════════════════════════════════
describe("pyrandom 对拍：第 3 层 —— 交错调用序列（验消耗顺序）", () => {
  for (const c of fixture.mixed) {
    it(`${c.id}：${c.results.length} 次混调用逐个一致，且跑完后状态一致`, () => {
      const rng = rngOf(c.seed);
      const got = c.results.map((step) => {
        switch (step.op) {
          case "randint":
            return rng.randint(step.low!, step.high!);
          case "choice":
            return rng.choice(step.seq!);
          case "getrandbits":
            return rng.getrandbits(step.k!).toString();
          case "random":
            return rng.random();
        }
      });
      expect(got).toStrictEqual(c.results.map((step) => step.value));
      // 状态也要一致 —— 只比取值的话，"多取一个字但恰好没影响本步结果"
      // 这种情况会溜过去，而它必然污染后续所有取值
      expect(rng.getState()).toStrictEqual(c.state);
    });
  }
});
