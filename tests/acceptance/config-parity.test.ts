/**
 * 算法配置对拍 —— TS 的 AlgorithmConfig vs Python 的黄金语料。
 *
 * 与 cognitive 对拍恰好相反：这里**主要靠真实配置**。v0.yaml 有几十个阈值，
 * `AlgorithmConfig` 的每个访问器都会读到其中至少一个，所以拿真实配置跑一遍
 * 就是一次接近全量的覆盖 —— 不像认知规则那样"真实内容一条都不报"。
 *
 * 合成配置只用来补"真实配置里到不了"的分支：缺段、`weight=0`、`ceiling<=floor`、
 * 配了 0 秒…… 这些是**容错路径**，一旦走错就是静默取默认值，最难发现。
 *
 * ## 对拍方式：调用表达式即 key
 *
 * fixture 里的键是 `target_difficulty[null,1,5]` 这样的**调用表达式**，
 * 参数由 Python 侧序列化成 JSON 字面量，这里原样解析再调用。
 * 好处是两侧用的**是同一组参数** —— 不会出现"我以为你测的是 (0.5,1,5)"这类
 * 双方各自写一遍才会有的偏差。
 *
 * 代价是这里要有一张 Python 名 → TS 名的映射表（移植对应关系的显式声明）。
 * 映射漏了会**报错**而不是静默跳过（见 invoke 里的两个 throw）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AlgorithmConfig, loadConfig } from "@/src/engine/config";
import { canonical } from "../helpers/canonical";
import { invokeExpression, methodsUsedIn } from "../helpers/invoke";

interface SyntheticCase {
  name: string;
  raw: Record<string, unknown>;
  expressions: string[];
  values: Record<string, unknown>;
}

interface Fixture {
  real: Record<string, unknown>;
  expressions: string[];
  synthetic: SyntheticCase[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/config_parity.json",
);

const fixture = ((): Fixture => {
  try {
    return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;
  } catch (error) {
    throw new Error(
      `配置对拍基准读不到。\n  路径：${FIXTURE_PATH}\n` +
        `  重新生成：python3 scripts/oracle/dump_fixtures.py config\n` +
        `  原因：${String(error)}`,
    );
  }
})();

/**
 * Python 侧名字 → TS 侧名字。
 *
 * 只列**方法**：属性名两侧都是 snake_case（移植时刻意不改名），直接同名取。
 * Python 侧的名字多了会怎样？不会 —— fixture 里出现而这里没有的名字会 throw。
 * 这里多了会怎样？也不会 —— 见下面那条"映射表不留死键"的断言。
 */
const METHOD_NAMES: Record<string, string> = {
  section: "section",
  alpha_for: "alphaFor",
  level_label: "levelLabel",
  level_thresholds: "levelThresholds",
  mastery_sample: "masterySample",
  independence_sample: "independenceSample",
  fluency_score_for_ratio: "fluencyScoreForRatio",
  confidence_sample: "confidenceSample",
  upgrade_requires: "upgradeRequires",
  new_pattern_success_rule: "newPatternSuccessRule",
  fallback_triggers: "fallbackTriggers",
  scaffold_for_mastery: "scaffoldForMastery",
  default_avoid_recent: "defaultAvoidRecent",
  min_avoid_recent: "minAvoidRecent",
  max_difficulty_step_up: "maxDifficultyStepUp",
  target_difficulty: "targetDifficulty",
  fluency_threshold_ms: "fluencyThresholdMs",
  daily_plan: "dailyPlan",
  intent_config: "intentConfig",
  generic_error_rules: "genericErrorRules",
};

/** 逐表达式比较，返回可读的分歧列表 */
function compare(
  config: AlgorithmConfig,
  expressions: readonly string[],
  expected: Record<string, unknown>,
): string[] {
  const divergences: string[] = [];
  for (const expression of expressions) {
    const actual = invokeExpression(config, METHOD_NAMES, expression);
    if (canonical(actual) !== canonical(expected[expression])) {
      divergences.push(
        `   ${expression}\n` +
          `     期望：${canonical(expected[expression])}\n` +
          `     实际：${canonical(actual)}`,
      );
    }
  }
  return divergences;
}

describe("AlgorithmConfig（真实 v0 配置）", () => {
  const config = loadConfig(0);

  it("fixture 的表达式清单与结果键一一对应（没有只生成不比较的）", () => {
    expect([...fixture.expressions].sort()).toEqual(Object.keys(fixture.real).sort());
  });

  it(`${fixture.expressions.length} 个访问器结果全部一致`, () => {
    const divergences = compare(config, fixture.expressions, fixture.real);
    expect(
      divergences.join("\n"),
      `${divergences.length}/${fixture.expressions.length} 个访问器与 Python 不一致。`,
    ).toBe("");
  });

  it("METHOD_NAMES 里没有死键（fixture 用到的方法都被映射且能被调用）", () => {
    const used = methodsUsedIn(fixture.expressions);
    const dead = Object.keys(METHOD_NAMES).filter((name) => !used.has(name));
    expect(dead, "这些映射没有被任何 fixture 表达式用到 —— 要么删掉，要么补 fixture").toEqual(
      [],
    );
  });
});

describe("AlgorithmConfig（合成配置：真实配置到不了的分支）", () => {
  for (const synthetic of fixture.synthetic) {
    it(synthetic.name, () => {
      const config = new AlgorithmConfig(synthetic.raw);
      const divergences = compare(config, synthetic.expressions, synthetic.values);
      expect(divergences.join("\n"), "合成配置下的行为与 Python 不一致").toBe("");
    });
  }

  it("合成配置确实覆盖了真实配置覆盖不到的分支", () => {
    // 真实配置里 assessment.weight 是真值、difficulty_target 的 ceiling>floor，
    // 所以下面这两类分支只有合成配置能到达。没有这条断言，将来有人"精简"
    // 合成配置时可以悄悄删光它们而不自知。
    const covered = new Set(fixture.synthetic.flatMap((item) => item.expressions));
    expect(covered.has("assessment_blocks_upgrade")).toBe(true);
    expect(
      [...covered].some((expression) => expression.startsWith("target_difficulty[0.8")),
    ).toBe(true);
    expect(
      [...covered].some((expression) => expression.startsWith("fluency_threshold_ms[")),
    ).toBe(true);
  });
});
