/**
 * 认知校验的**变异对拍** —— TS 的 check_all / lint_all vs Python 的黄金语料。
 *
 * 为什么不能拿真实内容对拍
 * ------------------------
 * 实测：真实内容的 1373 道题在 `check_all` / `lint_all` 下**一条报错都没有**。
 * 也就是说，"拿真实内容对拍"在这里的约束力是**零** —— TS 侧哪怕把 13 条规则
 * 全删光、只剩 `return []`，对拍依然全绿，而畸形的题目会一路教歪孩子。
 *
 * 所以 `cognitive_parity.json` 里的每一道题都是**为触发某个分支而构造的**，
 * 并且带上三条断言，缺一条这套对拍就退化成摆设：
 *
 *   ① 规则表逐字段一致 —— 顺序、competency、patterns、label 一个字都不能差。
 *      只比"结果"是不够的：规则表本身错了（比如把 make_ten 的 patterns 写漏一个），
 *      在这批 case 上可能照样能对上，但真实内容里那个结构就永远不受检。
 *   ② 每条 case 的 check/lint 输出与 Python 逐条一致（含**顺序**）。
 *   ③ fixture 自身有约束力 —— 每条规则都至少被某条 case 触发过。
 *      没有这条，将来有人"精简" CASES 时可以把覆盖率削到 0 而不自知。
 *
 * 顺便钉死一条 Python 的**死分支**：`_rule_make_ten` 的第三段
 * （`10 - a >= b`）在前一段 `a + b <= 10` 之后恒不可达 —— 见
 * `make_ten.和恰为10` 这条 case。移植时保留它（逐字照抄），但不假装它有覆盖。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { STRUCTURE_RULES, checkAll, lintAll } from "@/src/content/cognitive";
import type { Item } from "@/src/content/types";

interface FixtureRule {
  competency: string | null;
  patterns: string[] | null;
  label: string;
}

interface FixtureCase {
  name: string;
  note: string;
  item: Item;
  check: string[];
  lint: string[];
}

interface Fixture {
  rules: FixtureRule[];
  cases: FixtureCase[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/cognitive_parity.json",
);

const fixture = ((): Fixture => {
  try {
    return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;
  } catch (error) {
    throw new Error(
      `变异对拍基准读不到。\n  路径：${FIXTURE_PATH}\n` +
        `  重新生成：python3 scripts/oracle/dump_fixtures.py cognitive\n` +
        `  原因：${String(error)}`,
    );
  }
})();

/** 数组逐项比较（顺序敏感）—— 报错文案的顺序本身就是断言的一部分 */
function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}

describe("规则表（STRUCTURE_RULES）", () => {
  it("与 Python 逐字段一致：顺序 / competency / patterns / label", () => {
    const actual: FixtureRule[] = STRUCTURE_RULES.map((rule) => ({
      competency: rule.competency,
      patterns: rule.patterns === null ? null : [...rule.patterns],
      label: rule.label,
    }));
    expect(
      actual,
      "规则表与 Python 不一致。\n" +
        "注意**顺序也是契约**：同一道题命中多条规则时，报错顺序由它决定。",
    ).toEqual(fixture.rules);
  });
});

describe("check_all / lint_all 的分支覆盖", () => {
  it("每条 case 的输出与 Python 逐条一致", () => {
    const divergences: string[] = [];
    for (const testCase of fixture.cases) {
      const actualCheck = checkAll(testCase.item);
      const actualLint = lintAll(testCase.item);
      if (!sameStrings(actualCheck, testCase.check)) {
        divergences.push(
          `${testCase.name}（${testCase.note}）\n` +
            `    check 期望：${JSON.stringify(testCase.check)}\n` +
            `    check 实际：${JSON.stringify(actualCheck)}`,
        );
      }
      if (!sameStrings(actualLint, testCase.lint)) {
        divergences.push(
          `${testCase.name}（${testCase.note}）\n` +
            `    lint 期望：${JSON.stringify(testCase.lint)}\n` +
            `    lint 实际：${JSON.stringify(actualLint)}`,
        );
      }
    }
    expect(
      divergences.join("\n"),
      `共 ${divergences.length} 处分歧（${fixture.cases.length} 条 case）。\n` +
        "报错文案要逐字一致 —— 包括全角括号、空格、≥ 这类符号。",
    ).toBe("");
  });

  it("fixture 有约束力：13 条规则每条都至少被触发过一次", () => {
    const triggered = new Set<string>();
    for (const testCase of fixture.cases) {
      for (const message of testCase.check) {
        const matched = /^\[认知有效性·(.+?)\]/.exec(message);
        if (matched?.[1] !== undefined) triggered.add(matched[1]);
      }
    }
    const uncovered = STRUCTURE_RULES.map((rule) => rule.label).filter(
      (label) => !triggered.has(label),
    );
    expect(
      uncovered,
      "这些规则在 fixture 里从未被触发 —— 对它们而言这套对拍是空转的。\n" +
        "给每条规则补一条能触发它的 case（见 scripts/oracle/dump_fixtures.py 的 CASES）。",
    ).toEqual([]);
  });

  it("至少有一条 case 同时命中两条规则（钉住多规则时的报错顺序）", () => {
    const multi = fixture.cases.filter((testCase) => testCase.check.length >= 2);
    expect(
      multi.map((testCase) => testCase.name),
      "没有一条 case 命中两条以上规则 —— 规则顺序的契约没有被任何输入检验到。",
    ).not.toEqual([]);
  });
});
