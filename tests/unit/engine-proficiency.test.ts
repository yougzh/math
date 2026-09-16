/**
 * `src/engine/proficiency.ts` 的**合成配置**单测。
 *
 * 为什么对拍之外还要这一层
 * ------------------------
 * `proficiency-parity.test.ts` 用的是真实配置 v0，它有两个够不到的地方：
 *
 * ① **容错路径**。真实配置里每个 `fluency_thresholds` 都是正数，
 *    所以 `timeFactor` 的 `thresholdMs <= 0` 分支一次都走不到 ——
 *    把它改成 `return 0.0` 照样全绿，而那道题在真实内容里会静默变成
 *    "流畅度 0 分"（对孩子是"怎么算都算不对"，对排查是"没有报错"）。
 *
 * ② **配置版本不是 0 的情形**。v0 的 `cfg.version` 恰好是 0，
 *    于是 `updated.algorithm_version = cfg.version` 与 `= 0` 无法区分 ——
 *    这和 S1-2c 那个"10 个能力全是 stage 1"是同一类盲区：
 *    **被对拍的那一维恰好退化成了常量**。
 *
 * 另外这里直接钉 `ewma` 本身：它是模块里唯一被 `updateSignals` 与
 * `attemptQuality` 之外单独复用的原语，"0 不是哨兵"这条语义值得写在最显眼处。
 */
import { describe, expect, it } from "vitest";

import { AlgorithmConfig } from "@/src/engine/config";
import { ewma, timeFactor, updateSignals } from "@/src/engine/proficiency";
import { Attempt, PROBE_STATUS_UNKNOWN, Signals, Telemetry } from "@/src/engine/types";

/** 一份能跑通 proficiency 全部读配置路径的最小配置（值都是 v0 的） */
function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 0,
    smoothing: { ewma_alpha: 0.25, min_samples_for_level: 6 },
    assessment: { probe_items: 4, weight: 0.5 },
    mastery_sampling: { correct_without_hint: 1.0, correct_with_hint: 0.7, incorrect: 0.0 },
    independence_sampling: { hint_penalty: 0.35, min_sample: 0.3 },
    fluency_sampling: {
      ratio_scores: [
        { max_ratio: 0.75, score: 1.0 },
        { max_ratio: 999.0, score: 0.3 },
      ],
    },
    confidence_sampling: { correct: 1.0, incorrect: 0.4, alpha: 0.05 },
    fluency_thresholds: { default: { number_pad: 20 } },
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<ConstructorParameters<typeof Attempt>[0]> = {}): Attempt {
  return new Attempt({
    attempt_id: "att_1",
    child_id: "c1",
    item_id: "it_1",
    competency_id: "make_ten",
    pattern_id: "decompose",
    correct: true,
    telemetry: new Telemetry({ response_time_ms: 5000, active_time_ms: 1000 }),
    ...overrides,
  });
}

function timeFactorOf(cfg: AlgorithmConfig, thinkingMs: number): number {
  return timeFactor(
    makeAttempt({
      telemetry: new Telemetry({ response_time_ms: thinkingMs + 1000, active_time_ms: 1000 }),
    }),
    cfg,
  );
}

// ══════════════════════════════════════════════════════════
describe("ewma", () => {
  it("首条证据直取初值（不是按 0 平滑）", () => {
    expect(ewma(null, 0.8, 0.25)).toBe(0.8);
    expect(ewma(null, 0.0, 0.25)).toBe(0.0);
  });

  it("**0 不是哨兵**：已采到 0 的信号要继续走 EWMA", () => {
    // 用 `if (!current) return sample` 或 `current || 0` 会在这里给 1
    expect(ewma(0, 1, 0.25)).toBe(0.25);
    expect(ewma(0, 0, 0.25)).toBe(0);
  });

  it("常规 EWMA 公式", () => {
    expect(ewma(0.5, 1, 0.25)).toBe(0.625);
    expect(ewma(0.5, 0, 0.25)).toBe(0.375);
    // alpha = 1 时完全跟随新证据
    expect(ewma(0.5, 1, 1)).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════
describe("timeFactor 的容错分支（真实配置到不了）", () => {
  it("阈值配成 0 秒 → 该题不考流畅度，给满分而不是 0 分", () => {
    const cfg = new AlgorithmConfig(
      rawConfig({ fluency_thresholds: { default: { number_pad: 0 } } }),
    );
    expect(cfg.fluencyThresholdMs("decompose", "number_pad")).toBe(0);
    // thinking_time 随便多长都一样
    expect(timeFactorOf(cfg, 0)).toBe(1.0);
    expect(timeFactorOf(cfg, 60000)).toBe(1.0);
  });

  it("阈值配成负数也走同一条容错分支（不是只有 0）", () => {
    const cfg = new AlgorithmConfig(
      rawConfig({ fluency_thresholds: { default: { number_pad: -5 } } }),
    );
    expect(timeFactorOf(cfg, 99999)).toBe(1.0);
  });
});

// ══════════════════════════════════════════════════════════
describe("updateSignals 的 algorithm_version", () => {
  it("写入配置的版本号，而不是 0（v0 是 0，所以只有非 0 配置能证明这条）", () => {
    const cfg = new AlgorithmConfig(rawConfig({ version: 7 }));
    const updated = updateSignals(new Signals(), makeAttempt(), cfg);
    expect(updated.algorithm_version).toBe(7);
  });

  it("覆盖 Signals 上已有的旧版本号", () => {
    const cfg = new AlgorithmConfig(rawConfig({ version: 7 }));
    const stale = new Signals({ algorithm_version: 3 });
    expect(updateSignals(stale, makeAttempt(), cfg).algorithm_version).toBe(7);
  });

  it("不修改入参的版本号", () => {
    const cfg = new AlgorithmConfig(rawConfig({ version: 7 }));
    const stale = new Signals({ algorithm_version: 3 });
    updateSignals(stale, makeAttempt(), cfg);
    expect(stale.algorithm_version).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════
describe("probe 状态在合成配置下的边界", () => {
  it("min_samples_for_level = 0 时，第一条证据就把状态推成 stable", () => {
    const cfg = new AlgorithmConfig(
      rawConfig({ smoothing: { ewma_alpha: 0.25, min_samples_for_level: 0 } }),
    );
    const updated = updateSignals(new Signals(), makeAttempt(), cfg);
    expect(updated.probe_status).toBe("stable");
  });

  it("probe_items = 1 时，第一条 probe 就离开 probing", () => {
    const cfg = new AlgorithmConfig(
      rawConfig({ assessment: { probe_items: 1, weight: 0.5 } }),
    );
    const updated = updateSignals(new Signals(), makeAttempt({ is_assessment: true }), cfg);
    // probe_items=1 → estimated；但 min_samples_for_level=6 未达标 → 停在那里
    expect(updated.probe_status).toBe("estimated");
  });

  it("初始状态是 unknown，且非 probe 作答样本不足时保持 unknown", () => {
    const cfg = new AlgorithmConfig(rawConfig());
    const updated = updateSignals(new Signals(), makeAttempt(), cfg);
    expect(updated.probe_status).toBe(PROBE_STATUS_UNKNOWN);
    expect(updated.sample_count).toBe(1);
    expect(updated.assessment_samples).toBe(0);
  });
});
