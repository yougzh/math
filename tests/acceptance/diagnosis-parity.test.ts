/**
 * diagnosis 对拍 —— TS 的错误诊断 vs Python 的黄金语料。
 *
 * fixture 的 `diagnosis` 段由 `python3 scripts/oracle/dump_fixtures.py engine` 产出。
 *
 * ## 三层各自对拍的理由
 *
 * `rule_matches` ⊂ `match_rules` ⊂ `diagnose` 是层层包含的，只测最外层
 * 也能"覆盖"内层的代码 —— 但**失败模式不同**：
 *   - `ruleMatches` 错 → 某条规则该命中没命中（归因丢失，静默）；
 *   - `matchRules` 错 → 去重/保序/空 code 的处理不对（归因串味，静默）；
 *   - `diagnose` 错 → 优先级搞反（内容规则与通用规则互相顶掉，静默）。
 * 三种都是"不报错、只是诊断结果不对"，而诊断结果又只影响"下一步练什么" ——
 * 从现象往回查要穿过 Planner、Selector 两层。所以这里逐层钉。
 *
 * ## fixture 自证里最要紧的三条
 *
 * 诊断模块有三处**反直觉**行为（写在 diagnosis.ts 的模块头）：
 *   ① 四个 match 键是独立 if —— 同时写就是"都要满足"；
 *   ② 认不出的 match 键返回 **True**；
 *   ③ `answer_off_by_multiple_of` 的 step=0 要挡。
 * 这三条如果被"顺手改成看起来更对的样子"，逐条对拍会红，但光看 diff
 * 很难判断是"实现错了"还是"fixture 过时了"。所以自证段直接把它们的**真值**
 * 写进断言，让改动者先看到"这是刻意为之"。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "@/src/engine/config";
import { diagnose, matchRules, ruleMatches } from "@/src/engine/diagnosis";
import {
  diagnoseAttemptFromDesc,
  itemFromDesc,
} from "../helpers/engine-probes";
import type { EngineDiagnoseDesc, EngineItemDesc } from "../helpers/engine-probes";

interface RuleMatchCase {
  id: string;
  match: Record<string, unknown>;
  submitted: unknown;
  expected: unknown;
  result: boolean;
}

interface MatchRulesCase {
  id: string;
  rules: Array<{ code?: unknown; match?: unknown }>;
  submitted: unknown;
  expected: unknown;
  codes: string[];
}

interface Diagnosis {
  rule_matches: RuleMatchCase[];
  match_rules: MatchRulesCase[];
  diagnose: EngineDiagnoseDesc[];
}

interface Fixture {
  config_version: number;
  diagnosis: Diagnosis;
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/engine_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
const diagnosis = fixture.diagnosis;

const cfg = loadConfig(fixture.config_version);

/** 按 id 取 `rule_matches` 的固化结果 —— 自证段用它读"刻意的真值" */
function resultOf(id: string): boolean {
  const hit = diagnosis.rule_matches.find((c) => c.id === id);
  if (hit === undefined) throw new Error(`fixture 里没有 rule_matches case：${id}`);
  return hit.result;
}

function expectOf(id: string): string[] {
  const hit = diagnosis.diagnose.find((c) => c.id === id);
  if (hit === undefined) throw new Error(`fixture 里没有 diagnose case：${id}`);
  return hit.expect;
}

// ══════════════════════════════════════════════════════════
describe("diagnosis 对拍：fixture 自证", () => {
  it("20 条 diagnose case 里 item=None 与 item 非空都有", () => {
    expect(diagnosis.diagnose.some((c) => c.item === null)).toBe(true);
    expect(diagnosis.diagnose.some((c) => c.item !== null)).toBe(true);
  });

  it("rule_matches 的真假两侧数量相当（只有一侧就是一维的）", () => {
    const trues = diagnosis.rule_matches.filter((c) => c.result).length;
    expect(trues).toBeGreaterThanOrEqual(10);
    expect(diagnosis.rule_matches.length - trues).toBeGreaterThanOrEqual(10);
  });

  it("① 两键同时写是「都要满足」，不是「先命中谁算谁」", () => {
    // {answer_off_by: 1, answer_equals: 12} 对 12 vs 13：两个都成立 → true
    expect(resultOf("two_keys_both_hold")).toBe(true);
    // {answer_off_by: 1, answer_equals: 13}：off_by 成立但 equals 不成立 → false
    expect(resultOf("two_keys_one_fails")).toBe(false);
  });

  it("② 认不出的 match 键命中**所有**错误答案（非空 dict 恒真）", () => {
    expect(resultOf("unknown_key_matches_everything")).toBe(true);
    // 对照组：空 match 恒不命中
    expect(resultOf("empty_match_never_hits")).toBe(false);
    // 落到诊断层也一样：写错键名的规则会吞掉所有错误
    expect(expectOf("unknown_key_rule_swallows")).toEqual(["typo_rule"]);
  });

  it("③ answer_off_by_multiple_of 的 step=0 要挡（不是「差 0 就是全中」）", () => {
    expect(resultOf("multiple_of_step_zero")).toBe(false);
    // 对照组：step 正常且差得正好是倍数 → 命中
    expect(resultOf("multiple_of_hit")).toBe(true);
  });

  it("answer_in 的字符串形态按字符拆（Python 的集合推导会迭代字符串）", () => {
    expect(resultOf("in_string_value_splits_chars")).toBe(true);
    // 全都转不成整数的列表 → 集合里只有 None → 不匹配
    expect(resultOf("in_all_uncoercible")).toBe(false);
  });

  it("三处 `null` 守卫各有一条「去掉守卫就会漏成 true」的区分输入", () => {
    // 少了 `sub === null`，`null !== asInt("x")` 即 `null !== null` 为假 → 落到 return true
    expect(resultOf("equals_null_vs_uncoercible")).toBe(false);
    // 少了 `sub === null`，集合会是 {null}，`has(null)` 为真 → 落到 return true
    expect(resultOf("in_null_vs_uncoercible_set")).toBe(false);
    // 少了 `exp === null`，`Math.abs(12 - null)` 把 None 当 0 恰好等于 delta → return true
    expect(resultOf("off_by_null_expected_masquerades_as_zero")).toBe(false);
  });

  it("submitted 是 bool / 列表时转不成整数（不是 1 / 不是元素）", () => {
    expect(resultOf("equals_submitted_bool")).toBe(false);
    expect(resultOf("equals_submitted_list")).toBe(false);
  });

  it("matchRules 的去重保序：命中的按规则顺序，重复的留在首次位置", () => {
    // 规则顺序 a(multiple_of 命中) → b(equals 命中) → a(equals 重复)
    const first = diagnosis.match_rules.find((c) => c.id === "dedup_keeps_first_position")!;
    expect(first.codes).toEqual(["a", "b"]);
    // 首条 a 不命中、第二条 b 才命中、第三条 a 命中 —— 顺序仍是规则顺序
    const later = diagnosis.match_rules.find(
      (c) => c.id === "dedup_when_second_hits_first_misses",
    )!;
    expect(later.codes).toEqual(["b", "a"]);
  });

  it("diagnose 的优先级链：内容规则 > 通用规则 > 调用方挂的 codes", () => {
    // 内容规则命中 → 只用它
    expect(expectOf("item_rule_hits")).toEqual(["counting_dependency"]);
    // 内容规则没命中 → 通用规则
    expect(expectOf("item_rule_misses_then_generic")).toEqual(["place_value_confusion"]);
    // 调用方挂的 codes 追加在最后
    expect(expectOf("carried_codes_appended")).toEqual([
      "place_value_confusion",
      "carry_forgot",
    ]);
    // 已经在命中列表里的不重复
    expect(expectOf("carried_codes_deduped")).toEqual(["place_value_confusion"]);
  });

  it("correct=True 时完全不看 item（连会命中的规则也不看）", () => {
    // item 的规则本来会命中（submitted=99 与 answer_equals:99 相等）
    expect(expectOf("correct_answer_short_circuits")).toEqual([]);
    // item 里会命中的 generic_look_alike 不该出现，只剩调用方挂的那个
    expect(expectOf("correct_with_carried_codes")).toEqual(["question_structure_missed"]);
  });

  it("item=None 时通用规则拿不到 expected，两条规则都不匹配", () => {
    // 通用规则（差整十 / 差 1）都依赖 expected —— 这是个真实的能力边界
    expect(expectOf("item_null_generic_needs_expected")).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════
describe("diagnosis 对拍：逐条比较", () => {
  it("ruleMatches 全表一致", () => {
    for (const c of diagnosis.rule_matches) {
      expect(ruleMatches(c.match, c.submitted, c.expected), c.id).toBe(c.result);
    }
  });

  it("matchRules 全表一致", () => {
    for (const c of diagnosis.match_rules) {
      expect(matchRules(c.rules, c.submitted, c.expected), c.id).toEqual(c.codes);
    }
  });

  it("diagnose 全表一致", () => {
    for (const c of diagnosis.diagnose) {
      const attempt = diagnoseAttemptFromDesc(c);
      const item: EngineItemDesc | null = c.item;
      const actual = diagnose(attempt, item === null ? null : itemFromDesc(item), cfg);
      expect(actual, `${c.id}（${c.note}）`).toEqual(c.expect);
    }
  });

  it("diagnose 不修改 attempt.misconception_codes", () => {
    for (const c of diagnosis.diagnose) {
      const attempt = diagnoseAttemptFromDesc(c);
      const before = [...attempt.misconception_codes];
      const item: EngineItemDesc | null = c.item;
      diagnose(attempt, item === null ? null : itemFromDesc(item), cfg);
      expect(attempt.misconception_codes, c.id).toEqual(before);
    }
  });

  it("diagnose 在 correct=True 时返回的是**副本**，改它不影响 attempt", () => {
    const c = diagnosis.diagnose.find((x) => x.id === "correct_with_carried_codes")!;
    const attempt = diagnoseAttemptFromDesc(c);
    const codes = diagnose(attempt, null, cfg);
    codes.push("injected");
    expect(attempt.misconception_codes).toEqual(["question_structure_missed"]);
  });
});
