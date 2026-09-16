/**
 * 移植原语对拍 —— `src/py/` 下的 Python 语义等价物 vs 黄金语料。
 *
 * 为什么单独给这两个文件建一套穷举边界表
 * ------------------------------------
 * 它们的错误**不会响**，只会静默地少匹配或截断：
 *   `parseInt("1_000")` 给 1（Python 的 int 给 1000）；
 *   正则少一个 alternation 只是"有些式子再也不被校验"。
 * 等业务对拍撞上这类错误时，症状已经离原因很远了。所以这里把边界一次铺开。
 *
 * 表里几条**反直觉但必须一致**的行为（都是 Python 正则的自然结果）：
 *   - `"3.5 + 1 = 4"` 会匹配出 `["5 + 1", "4"]` —— `\d+` 从 "3.5" 里取到了 "5"；
 *   - `"8 + 5 = 12 = 13"` 只匹配一对 —— finditer 从上一处匹配的末尾继续；
 *   - `"008 + 005 = 13"` 的表达式原样保留前导零（求值时才变成 8 和 5）。
 *
 * 刻意**不测**的两处已知差异（理由写在 src/py/pyint.ts 里）：
 *   - 全角 / 阿拉伯-印度数字（`int("３")`）；
 *   - 小数形式的整数常量（`int("3.0")`）与 `-0.0`。
 * 把它们写进 fixture 等于把"已知差异"固化成"期望行为"，将来真修好了反而报红。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { pyInt, pyIntFromText } from "@/src/py/pyint";
import { pyRound } from "@/src/py/pyround";
import { pyStr } from "@/src/py/pyvalue";
import { ARITH_TOKEN_RE, EQUALITY_RE, OP_ALIASES, numberTokensIn } from "@/src/py/pyre";

interface Case {
  input: unknown;
  expect: unknown;
}

interface RoundCase {
  value: number;
  ndigits: number | null;
  expect: number;
}

interface Fixture {
  op_pattern: string;
  op_aliases: Record<string, string>;
  py_int_from_text: Array<{ input: string; expect: number | null }>;
  py_int: Case[];
  py_str: Case[];
  equality: Record<string, string[][]>;
  arith_tokens: Record<string, string[]>;
  number_tokens: Record<string, number[]>;
  py_round: RoundCase[];
  py_round_fuzz: { seed: number; cases: RoundCase[] };
}

const FIXTURE_PATH = path.resolve(import.meta.dirname, "../oracle/fixtures/py_parity.json");

const fixture = ((): Fixture => {
  try {
    return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;
  } catch (error) {
    throw new Error(
      `原语对拍基准读不到。\n  路径：${FIXTURE_PATH}\n` +
        `  重新生成：python3 scripts/oracle/dump_fixtures.py py\n` +
        `  原因：${String(error)}`,
    );
  }
})();

describe("pyInt", () => {
  it("pyIntFromText 与 Python 的 int(str.strip()) 一致", () => {
    const divergences = fixture.py_int_from_text
      .filter((testCase) => pyIntFromText(testCase.input) !== testCase.expect)
      .map(
        (testCase) =>
          `   ${JSON.stringify(testCase.input)}：期望 ${testCase.expect}，` +
          `实际 ${pyIntFromText(testCase.input)}`,
      );
    expect(divergences.join("\n")).toBe("");
  });

  it("pyInt 与 Python 的 _int 一致（含 bool / null / float 的拒绝）", () => {
    const divergences = fixture.py_int
      .filter((testCase) => pyInt(testCase.input) !== testCase.expect)
      .map(
        (testCase) =>
          `   ${JSON.stringify(testCase.input)}：期望 ${testCase.expect}，` +
          `实际 ${pyInt(testCase.input)}`,
      );
    expect(divergences.join("\n")).toBe("");
  });

  it('int("-0") 必须是 0 而不是 JS 的 -0', () => {
    // -0 会一路静默传播：`-0 === 0` 为真，但 Object.is / 1÷-0 / Map 键都不同。
    // 它不在这批 fixture 的"非平凡"结果里，所以单独钉一条。
    expect(Object.is(pyIntFromText("-0"), -0)).toBe(false);
    expect(Object.is(pyIntFromText("-0"), 0)).toBe(true);
  });
});

describe("pyStr", () => {
  it("与 Python 的 str() 一致（bool → True/False，None → None）", () => {
    const divergences = fixture.py_str
      .filter((testCase) => pyStr(testCase.input) !== testCase.expect)
      .map(
        (testCase) =>
          `   ${JSON.stringify(testCase.input)}：期望 ${JSON.stringify(testCase.expect)}，` +
          `实际 ${JSON.stringify(pyStr(testCase.input))}`,
      );
    expect(divergences.join("\n")).toBe("");
  });
});

describe("pyRound", () => {
  /** 用 Object.is 而不是 ===：`round(-0.0, 2)` 必须是 -0.0，而 `-0 === 0` 为真 */
  function divergencesOf(cases: readonly RoundCase[]): string[] {
    return cases
      .filter((testCase) => !Object.is(pyRound(testCase.value, testCase.ndigits), testCase.expect))
      .map(
        (testCase) =>
          `   value=${testCase.value} ndigits=${String(testCase.ndigits)}：` +
          `期望 ${Object.is(testCase.expect, -0) ? "-0" : testCase.expect}，` +
          `实际 ${Object.is(pyRound(testCase.value, testCase.ndigits), -0) ? "-0" : pyRound(testCase.value, testCase.ndigits)}`,
      );
  }

  it("边界表与 Python 的 round() 一致（half-even，含 large / subnormal / 负零）", () => {
    expect(divergencesOf(fixture.py_round).join("\n")).toBe("");
  });

  it(`随机 fuzz（种子 ${fixture.py_round_fuzz.seed}）与 Python 一致`, () => {
    expect(divergencesOf(fixture.py_round_fuzz.cases).join("\n")).toBe("");
  });

  it("三处边界行为单独钉住（fixture 里太容易被扫过去）", () => {
    // ① half-even，不是"取较大"
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(1.5)).toBe(2);
    // ② double 真值偏下的"假半值"—— 先乘后取整的实现会给 2.68
    expect(pyRound(2.675, 2)).toBe(2.67);
    expect(pyRound(1.005, 2)).toBe(1);
    // ③ Python 的 int 没有负零、float 有：同样是"舍入到 0"，
    //    无 ndigits 给 +0（int），带 ndigits 保住符号（float 的 -0.0）
    expect(Object.is(pyRound(-0.0), -0)).toBe(false);
    expect(Object.is(pyRound(-0.4), -0)).toBe(false);
    expect(Object.is(pyRound(-0.0, 2), -0)).toBe(true);
    expect(Object.is(pyRound(-0.004, 2), -0)).toBe(true);
    expect(Object.is(pyRound(-0.004, 0), -0)).toBe(true);
  });

  it("inf / nan 原样返回（Python 不抛异常）", () => {
    expect(pyRound(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
    expect(pyRound(Number.NEGATIVE_INFINITY, 2)).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(pyRound(Number.NaN, 2))).toBe(true);
    expect(Number.isNaN(pyRound(Number.NaN))).toBe(true);
  });
});

describe("pyre 的模式", () => {
  it("OP_ALIASES 与 Python 的 _OP_ALIASES 逐键一致", () => {
    expect(Object.fromEntries(OP_ALIASES)).toEqual(fixture.op_aliases);
  });

  it("EQUALITY_RE 的捕获组与 Python 的 _EQUALITY 一致", () => {
    const divergences: string[] = [];
    for (const [text, expected] of Object.entries(fixture.equality)) {
      const actual = [...text.matchAll(EQUALITY_RE)].map((match) => [match[1], match[2]]);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        divergences.push(
          `   ${JSON.stringify(text)}\n` +
            `     期望：${JSON.stringify(expected)}\n` +
            `     实际：${JSON.stringify(actual)}`,
        );
      }
    }
    expect(divergences.join("\n")).toBe("");
  });

  it("ARITH_TOKEN_RE 的切分与 Python 的 _TOKEN 一致", () => {
    const divergences: string[] = [];
    for (const [text, expected] of Object.entries(fixture.arith_tokens)) {
      const actual = [...text.matchAll(ARITH_TOKEN_RE)].map((match) => match[0]);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        divergences.push(
          `   ${JSON.stringify(text)}：期望 ${JSON.stringify(expected)}，` +
            `实际 ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(divergences.join("\n")).toBe("");
  });

  it("numberTokensIn 与 Python 的 {int(t) for t in _NUMBER_TOKEN.findall(text)} 一致", () => {
    const divergences: string[] = [];
    for (const [text, expected] of Object.entries(fixture.number_tokens)) {
      const actual = [...numberTokensIn(text)].sort((a, b) => a - b);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        divergences.push(
          `   ${JSON.stringify(text)}：期望 ${JSON.stringify(expected)}，` +
            `实际 ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(divergences.join("\n")).toBe("");
  });
});
