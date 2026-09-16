/**
 * state_machine 的合成数据单测 —— 专门钉**对拍 fixture 到不了**的那些点。
 *
 * 分三类：
 *
 * ① **边界值恰好落在门槛上**：fixture 的 case 都设计在门槛两侧，但有几个
 *    "恰好等于"的形态装不进去（pattern sample_count=1、practiceSamples=6、
 *    连错 run 与阈值的关系靠三连错才成立……）—— 这里逐个补齐。
 *
 * ② **真实配置到不了的分支**：`pyGet` 的默认值只在**配置缺键**时生效，
 *    而 v0.yaml 把所有键都写了 —— 默认值漂移在真实配置下不可见，
 *    只能用删键变体配置钉住。
 *
 * ③ **fixture 因数据形态装不下的组合**：传递闭包指名、两个错误认知同时命中、
 *    两个触发器同时命中 —— 每种都要求"首条胜出 / 顺序固定"的语义。
 */
import { describe, expect, it } from "vitest";

import { AlgorithmConfig, loadConfig } from "@/src/engine/config";
import { CompetencyGraph } from "@/src/engine/graph";
import {
  countSuccessfulPatterns,
  deriveLevel,
  fallbackDecision,
  upgradeDecision,
} from "@/src/engine/state-machine";
import { loadBundle } from "@/src/content/loader";
import { smStateFromDesc } from "../helpers/engine-probes";
import type { EngineSmStateDesc } from "../helpers/engine-probes";

const cfg = loadConfig(0);
const graph = new CompetencyGraph(loadBundle());

/** `scheduler-parity.test.ts` 同款：**不能**用 `{...cfg, raw}` 造变体（getter 在原型上） */
function variantConfig(mutate: (raw: Record<string, unknown>) => void): AlgorithmConfig {
  const raw = structuredClone(cfg.raw) as Record<string, unknown>;
  mutate(raw);
  return new AlgorithmConfig(raw);
}

/** 恰好满足 v0 升级门全部数值条件的 signals 描述（practiceSamples 可调） */
function fullSignals(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sample_count: 8,
    mastery: 0.9,
    accuracy: 0.95,
    independence: 0.9,
    transfer: 0.9,
    fluency: 0.9,
    ...overrides,
  };
}

function state(desc: EngineSmStateDesc) {
  return smStateFromDesc(desc);
}

// ══════════════════════════════════════════════════════════
describe("state_machine 单测：门槛上的边界值", () => {
  it("pattern 的 sample_count=1 也算『碰过』（fixture 里只有 0/2/3）", () => {
    const s = state({ patterns: { "sd_add_10::direct_compute": { sample_count: 1, accuracy: 0.9 } } });
    expect(countSuccessfulPatterns(s, "sd_add_10", graph, cfg)).toBe(1);
  });

  it("practiceSamples 恰好 = 6 时**不**缺样本（fixture 里只有 0/5/8）", () => {
    const s = state({
      competencies: { sd_add_10: fullSignals({ sample_count: 6, assessment_samples: 0 }) },
      patterns: {
        "sd_add_10::combine": { sample_count: 3, accuracy: 0.9 },
        "sd_add_10::direct_compute": { sample_count: 3, accuracy: 0.9 },
      },
    });
    const decision = upgradeDecision(s, "sd_add_10", graph, cfg);
    expect(decision.reasons.some((r) => r.includes("正式练习样本不足"))).toBe(false);
    expect(decision.action).toBe("upgrade");
  });

  it("等级门槛看的是 sample_count 而不是 practiceSamples（探测题也算样本数）", () => {
    // sample_count=6、全是探测题 → practiceSamples=0，但等级照样派生
    const s = state({
      competencies: { x: fullSignals({ sample_count: 6, assessment_samples: 6 }) },
    });
    expect(deriveLevel(s.competencies.get("x")!, cfg)).toBe("automatic");
  });

  it("错误认知的 last_seq 恰好 = 最后作答 seq - 1 时仍算『新』", () => {
    const s = state({
      competencies: {},
      recent_attempts: [
        { correct: false, seq: 1 },
        { correct: false, seq: 2 },
        { correct: false, seq: 3 },
      ],
      misconceptions: [{ code: "m1", last_seq: 2, remediation_competency: "td_add_nocarry" }],
    });
    const decision = fallbackDecision(s, "carry_add", graph, cfg);
    expect(decision.reasons.some((r) => r.includes("近期命中错误认知"))).toBe(true);
  });
  it("阈值**非单调**时『逐档爬、断了停』可观测（Python 同场景 = encountering）", () => {
    // 真实配置阈值累积单调，某档不满足后后续只会更严 → break 与 continue
    // 行为恒等（对拍钉不住）。这里人为造出"understanding 比 can_do 严"的
    // 配置：mastery 0.5 过得了 can_do（0.1）但过不了 understanding（0.9）
    // —— break 停在 encountering；若实现是 continue 会爬到 can_do。
    // Python 侧同场景已验证返回 encountering（见会话记录）。
    const variant = variantConfig((raw) => {
      const thresholds = raw["level_thresholds"] as Record<string, Record<string, number>>;
      thresholds["understanding"] = { mastery: 0.9 };
      thresholds["can_do"] = { mastery: 0.1 };
    });
    const s = state({ competencies: { x: fullSignals({ mastery: 0.5, sample_count: 6 }) } });
    expect(deriveLevel(s.competencies.get("x")!, variant)).toBe("encountering");
  });
});

// ══════════════════════════════════════════════════════════
describe("state_machine 单测：配置缺键时的默认值（pyGet 兜底）", () => {
  it("删除 require_prerequisites 键 → 默认仍是 true（前置照查）", () => {
    const variant = variantConfig((raw) => {
      delete (raw["upgrade_requires"] as Record<string, unknown>)["require_prerequisites"];
    });
    const s = state({
      competencies: { make_ten: fullSignals() }, // 前置 sd_add_10 无记录 → 未掌握
    });
    const decision = upgradeDecision(s, "make_ten", graph, variant);
    expect(decision.reasons).toContain("前置能力未达标：sd_add_10");
  });

  it("删除 require_new_pattern_success 键 → 默认仍是 true（pattern 照查）", () => {
    const variant = variantConfig((raw) => {
      delete (raw["upgrade_requires"] as Record<string, unknown>)["require_new_pattern_success"];
    });
    const s = state({ competencies: { sd_add_10: fullSignals() } });
    const decision = upgradeDecision(s, "sd_add_10", graph, variant);
    expect(decision.reasons.some((r) => r.includes("成功过的 pattern 数不足"))).toBe(true);
  });

  it("删除 min_patterns 键 → 默认 2；且小数值会被截断（int() 语义）", () => {
    const variant = variantConfig((raw) => {
      const rule = (raw["upgrade_requires"] as Record<string, unknown>)[
        "new_pattern_success"
      ] as Record<string, unknown>;
      delete rule["min_patterns"];
      rule["min_patterns"] = 2.5; // 顺手验证截断：2 个成功 pattern 应当够
    });
    const s = state({
      competencies: { sd_add_10: fullSignals() },
      patterns: {
        "sd_add_10::combine": { sample_count: 3, accuracy: 0.9 },
        "sd_add_10::direct_compute": { sample_count: 3, accuracy: 0.9 },
      },
    });
    const decision = upgradeDecision(s, "sd_add_10", graph, variant);
    expect(decision.reasons.some((r) => r.includes("pattern 数不足"))).toBe(false);
  });

  it("删除 min_accuracy 键 → 默认 0.5（恰好达标的 pattern 算成功）", () => {
    const variant = variantConfig((raw) => {
      const rule = (raw["upgrade_requires"] as Record<string, unknown>)[
        "new_pattern_success"
      ] as Record<string, unknown>;
      delete rule["min_accuracy"];
    });
    const s = state({ patterns: { "sd_add_10::direct_compute": { sample_count: 2, accuracy: 0.5 } } });
    expect(countSuccessfulPatterns(s, "sd_add_10", graph, variant)).toBe(1);
  });

  it("删除 fallback_triggers 的触发阈值 → 默认 consecutive_wrong=3、hint_spike_delta=2", () => {
    const variant = variantConfig((raw) => {
      const triggers = raw["fallback_triggers"] as Record<string, unknown>;
      delete triggers["consecutive_wrong"];
      delete triggers["hint_spike_delta"];
    });
    // 两次连错：低于默认 3，不触发
    const two = state({
      recent_attempts: [
        { correct: false, seq: 1 },
        { correct: false, seq: 2 },
      ],
    });
    expect(fallbackDecision(two, "carry_add", graph, variant).action).toBe("hold");
    // 提示只 +1：低于默认 2，不触发
    const oneHint = state({
      recent_attempts: [
        { correct: true, seq: 1, hints_used: 0 },
        { correct: false, seq: 2, hints_used: 1 },
      ],
    });
    expect(fallbackDecision(oneHint, "carry_add", graph, variant).action).toBe("hold");
  });

  it("删除 misconception_prerequisite_trigger 键 → 默认仍是 true", () => {
    const variant = variantConfig((raw) => {
      delete (raw["fallback_triggers"] as Record<string, unknown>)[
        "misconception_prerequisite_trigger"
      ];
    });
    const s = state({
      recent_attempts: [
        { correct: false, seq: 1 },
        { correct: false, seq: 2 },
        { correct: false, seq: 3 },
      ],
      misconceptions: [{ code: "m1", last_seq: 3, remediation_competency: "td_add_nocarry" }],
    });
    const decision = fallbackDecision(s, "carry_add", graph, variant);
    expect(decision.target_competency_id).toBe("td_add_nocarry");
  });

  it("level_thresholds 里出现未知信号名 → 直接炸（配置写错必须可见）", () => {
    const variant = variantConfig((raw) => {
      (raw["level_thresholds"] as Record<string, Record<string, number>>)["understanding"]![
        "bogus_signal"
      ] = 0.5;
    });
    const s = state({ competencies: { x: fullSignals({ sample_count: 6 }) } });
    expect(() => deriveLevel(s.competencies.get("x")!, variant)).toThrow(/未知的信号名/);
  });
});

// ══════════════════════════════════════════════════════════
describe("state_machine 单测：fixture 装不下的组合", () => {
  it("错误认知指向**传递**前置（sd_add_10 对 carry_add）也触发指名回退", () => {
    // sd_add_10 不在 carry_add 的直接前置里（经由 make_ten 间接可达）——
    // 递归闭包 (prerequisites(code, true)) 与只查直接前置的分界就在这里
    const s = state({
      recent_attempts: [
        { correct: false, seq: 1 },
        { correct: false, seq: 2 },
        { correct: false, seq: 3 },
      ],
      misconceptions: [{ code: "m1", last_seq: 3, remediation_competency: "sd_add_10" }],
    });
    const decision = fallbackDecision(s, "carry_add", graph, cfg);
    expect(decision.action).toBe("fallback");
    expect(decision.target_competency_id).toBe("sd_add_10");
  });

  it("两个错误认知同时命中 → **先注册的**胜出（Python dict 迭代序）", () => {
    const s = state({
      recent_attempts: [
        { correct: false, seq: 1 },
        { correct: false, seq: 2 },
        { correct: false, seq: 3 },
      ],
      misconceptions: [
        { code: "m_first", last_seq: 3, remediation_competency: "td_add_nocarry" },
        { code: "m_second", last_seq: 3, remediation_competency: "make_ten" },
      ],
    });
    const decision = fallbackDecision(s, "carry_add", graph, cfg);
    expect(decision.target_competency_id).toBe("td_add_nocarry");
    expect(decision.reasons.some((r) => r.includes("m_first"))).toBe(true);
    expect(decision.reasons.some((r) => r.includes("m_second"))).toBe(false);
  });

  it("连错与提示突增**同时**触发 → reasons 固定为〔连错, 提示〕顺序", () => {
    const s = state({
      recent_attempts: [
        { correct: false, seq: 1, hints_used: 2 },
        { correct: false, seq: 2, hints_used: 4 },
        { correct: false, seq: 3, hints_used: 6 },
      ],
    });
    const decision = fallbackDecision(s, "carry_add", graph, cfg);
    expect(decision.reasons[0]).toBe("连续答错 3 次");
    expect(decision.reasons[1]).toBe("提示使用突然增加：4 → 6");
  });

  it("开头答对、后面连错 → 尾部连错计数（不是从头数）", () => {
    const s = state({
      recent_attempts: [
        { correct: true, seq: 1 },
        { correct: false, seq: 2 },
        { correct: false, seq: 3 },
        { correct: false, seq: 4 },
      ],
    });
    const decision = fallbackDecision(s, "carry_add", graph, cfg);
    expect(decision.action).toBe("fallback");
    expect(decision.reasons[0]).toBe("连续答错 3 次");
  });

  it("只有一条作答时不做提示突增判定（不能访问不存在的『前一条』）", () => {
    const s = state({ recent_attempts: [{ correct: false, seq: 1, hints_used: 5 }] });
    const decision = fallbackDecision(s, "carry_add", graph, cfg);
    expect(decision.action).toBe("hold");
    expect(decision.reasons).toEqual(["未触发回退条件"]);
  });

  it("最弱前置按 (mastery, code) 取最小：分 lowest 的不在首位也能选中", () => {
    // 传递闭包四项全给分，最低的是 td_add_nocarry（字典序最大的那个）——
    // 若实现退化成"永远取第一个/字典序最小"，会选中 make_ten
    const s = state({
      competencies: {
        td_add_nocarry: { mastery: 0.1 },
        make_ten: { mastery: 0.9 },
        place_value: { mastery: 0.95 },
        sd_add_10: { mastery: 0.95 },
      },
      recent_attempts: [
        { correct: false, seq: 1 },
        { correct: false, seq: 2 },
        { correct: false, seq: 3 },
      ],
    });
    const decision = fallbackDecision(s, "carry_add", graph, cfg);
    expect(decision.target_competency_id).toBe("td_add_nocarry");
  });

  it("mastery 为 null / 无记录的前置按 0 分参与最弱比较", () => {
    // place_value 无记录 → 0 分 → 最弱；若实现把缺记录当 1 分（全掌握），
    // 会在其余 0.9 里按字典序选中 make_ten
    const s = state({
      competencies: {
        td_add_nocarry: { mastery: 0.9 },
        make_ten: { mastery: 0.9 },
        sd_add_10: { mastery: 0.9 },
      },
      recent_attempts: [
        { correct: false, seq: 1 },
        { correct: false, seq: 2 },
        { correct: false, seq: 3 },
      ],
    });
    const decision = fallbackDecision(s, "carry_add", graph, cfg);
    expect(decision.target_competency_id).toBe("place_value");
  });
});
