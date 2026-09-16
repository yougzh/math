/**
 * proficiency 对拍 —— TS 的熟练度纯函数 vs Python 的黄金语料。
 *
 * `tests/oracle/fixtures/engine_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py engine` 产出。
 *
 * ## 为什么对拍的是"序列"而不是"单次调用"
 *
 * `updateSignals` 是累积的：EWMA 的收敛、`signal_sample_counts` 的增长、
 * probe_status 的推进，都只在连续多次作答之后才显出差异。单次调用的对拍
 * 只能证明"第一条证据直取初值"，证明不了"第四条 probe 之后状态是 probing
 * 还是 estimated"。所以 fixture 里存的是 12 条**序列**，每条跑完一串
 * attempt 并把**每一步**的 `toDict()` 都固化下来。
 *
 * ## fixture 自证比逐条对拍更要紧
 *
 * 这是 S1-2c 用血换来的：真实内容对 9 条 lint 规则里的 8 条零约束力，
 * 逐条对拍全绿而规则全被换成 `return []` 也不会有人发现。
 * 所以这里的第二段专门断言"分支真的被走到了" —— 尤其是
 * `practice_only_to_stable` 那条（第六步要在**同一行里**从 unknown 经
 * estimated 到 stable）。把 `update_signals` 的第三段 if 删掉，
 * 这段自证会红，而不是等到逐条对拍才发现。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "@/src/engine/config";
import {
  attemptQuality,
  samplesForAttempt,
  signalSummary,
  timeFactor,
  updateSignals,
} from "@/src/engine/proficiency";
import { SIGNAL_NAMES } from "@/src/engine/types";
import type { SignalsDict } from "@/src/engine/types";
import {
  attemptsById,
  signalsFromDesc,
} from "../helpers/engine-probes";
import type { EngineAttemptDesc, EngineSignalsDesc } from "../helpers/engine-probes";

interface QualityCase {
  id: string;
  quality: Record<string, number>;
}

interface TimeCase {
  id: string;
  value: number;
}

interface SamplesCase {
  id: string;
  samples: Record<string, number | null>;
}

interface SignalSequence {
  id: string;
  note: string;
  initial: EngineSignalsDesc;
  attempts: string[];
  steps: SignalsDict[];
}

interface SummaryCase {
  signals: EngineSignalsDesc;
  text: string;
}

interface Fixture {
  config_version: number;
  attempts: EngineAttemptDesc[];
  time_factor: TimeCase[];
  attempt_quality: QualityCase[];
  samples_for_attempt: SamplesCase[];
  update_signals: SignalSequence[];
  signal_summary: SummaryCase[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/engine_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const cfg = loadConfig(fixture.config_version);
const attempts = attemptsById(fixture.attempts);

// ══════════════════════════════════════════════════════════
describe("proficiency 对拍：前置一致性", () => {
  it("fixture 的 config_version 与本地配置一致", () => {
    expect(fixture.config_version).toBe(cfg.version);
  });

  it("每条序列引用的 attempt 都在表里", () => {
    for (const seq of fixture.update_signals) {
      for (const id of seq.attempts) {
        expect(attempts.has(id), `${seq.id} 引用了不存在的 attempt ${id}`).toBe(true);
      }
    }
  });

  it("steps 的条数等于 attempts 的条数", () => {
    for (const seq of fixture.update_signals) {
      expect(seq.steps.length, seq.id).toBe(seq.attempts.length);
    }
  });

  it("三张单次调用的表覆盖同一批 attempt（少一条就是漏了一个输入）", () => {
    const ids = fixture.attempts.map((d) => d.id);
    expect(fixture.time_factor.map((c) => c.id)).toEqual(ids);
    expect(fixture.attempt_quality.map((c) => c.id)).toEqual(ids);
    expect(fixture.samples_for_attempt.map((c) => c.id)).toEqual(ids);
  });
});

// ══════════════════════════════════════════════════════════
describe("proficiency 对拍：fixture 自证", () => {
  it("fluency 波段表的五档与「掉出波段表」的 0.0 都被覆盖", () => {
    const scored = new Set(
      fixture.time_factor
        .filter((c) => c.id.startsWith("ratio_"))
        .map((c) => c.value),
    );
    // 1.00 / 0.90 / 0.70 / 0.50 / 0.30 五档，加 0.0（ratio > 999 掉出表）
    expect([...scored].sort((a, b) => b - a)).toEqual([1, 0.9, 0.7, 0.5, 0.3, 0]);
  });

  it("波段的闭区间两侧都被覆盖（边界值本身与刚越过它的值）", () => {
    const byId = new Map(fixture.time_factor.map((c) => [c.id, c.value]));
    expect(byId.get("ratio_at_075"), "0.75 落在含的一侧").toBe(1.0);
    expect(byId.get("ratio_over_075")).toBe(0.9);
    expect(byId.get("ratio_at_100")).toBe(0.9);
    expect(byId.get("ratio_over_100")).toBe(0.7);
    expect(byId.get("ratio_at_150")).toBe(0.7);
    expect(byId.get("ratio_over_150")).toBe(0.5);
    expect(byId.get("ratio_at_250")).toBe(0.5);
    expect(byId.get("ratio_over_250")).toBe(0.3);
    expect(byId.get("ratio_at_999")).toBe(0.3);
    expect(byId.get("ratio_over_999"), "越过最后一档 → 掉出波段表").toBe(0.0);
  });

  it("thinking_time 的 max(0, ...) 被夹到过（三个时间互相矛盾的那条）", () => {
    const byId = new Map(fixture.time_factor.map((c) => [c.id, c.value]));
    // active 2s + idle 3s > response 1s → thinking 是 -4s → 夹到 0 → ratio 0
    expect(byId.get("impossible_times")).toBe(1.0);
  });

  it("probe_status 的四个取值都出现过", () => {
    const seen = new Set<string>();
    for (const seq of fixture.update_signals) {
      seen.add(seq.initial.probe_status);
      for (const step of seq.steps) seen.add(step.probe_status);
    }
    expect([...seen].sort()).toEqual(["estimated", "probing", "stable", "unknown"]);
  });

  it("「同一行里连升两级」那条序列真的在第六步跨过去", () => {
    const seq = fixture.update_signals.find((s) => s.id === "practice_only_to_stable")!;
    const statuses = seq.steps.map((step) => step.probe_status);
    // 前五条样本：unknown（min_samples_for_level = 6）
    expect(statuses.slice(0, 5)).toEqual(Array(5).fill("unknown"));
    // 第六条：elif 升 estimated，紧随其后的第三段无条件升 stable
    expect(statuses[5]).toBe("stable");
  });

  it("probe 序列在 probe_items 那一步翻状态（前三次 probing、第四次 estimated）", () => {
    const seq = fixture.update_signals.find((s) => s.id === "probe_four_steps")!;
    expect(seq.steps.map((step) => step.probe_status)).toEqual([
      "probing",
      "probing",
      "probing",
      "estimated",
    ]);
  });

  it("samples_for_attempt 真的产生过 None（不采样 ≠ 采样为 0）", () => {
    const nulls = new Set<string>();
    for (const c of fixture.samples_for_attempt) {
      for (const [name, value] of Object.entries(c.samples)) {
        if (value === null) nulls.add(name);
      }
    }
    // fluency 在做错时不采样；transfer 只在迁移测试上采样
    expect(nulls.has("fluency")).toBe(true);
    expect(nulls.has("transfer")).toBe(true);
  });

  it("六条序列的初始 probe_status 不是同一个值（否则 first-step 分支没被区分）", () => {
    const initials = new Set(fixture.update_signals.map((s) => s.initial.probe_status));
    expect(initials.size).toBeGreaterThanOrEqual(3);
  });

  it("signal_summary 里 `—` 与 `0.00` 都出现过（未采样 ≠ 零分）", () => {
    const texts = fixture.signal_summary.map((c) => c.text);
    expect(texts.some((t) => t.includes("mastery=—"))).toBe(true);
    expect(texts.some((t) => t.includes("mastery=0.00"))).toBe(true);
  });

  it("signal_summary 覆盖 {:.2f} 的 half-even 分歧点与负零", () => {
    const texts = fixture.signal_summary.map((c) => c.text);
    // 0.125 是二进制精确的 .xx5：Python 取偶给 "0.12"，JS 的 toFixed(2) 会给 "0.13"
    expect(texts.some((t) => t.includes("fluency=0.12"))).toBe(true);
    expect(texts.some((t) => t.includes("mastery=-0.00"))).toBe(true);
  });

  it("每条序列的 note 都非空（note 是分支覆盖的说明书）", () => {
    for (const seq of fixture.update_signals) {
      expect(seq.note.length, seq.id).toBeGreaterThan(10);
    }
  });
});

// ══════════════════════════════════════════════════════════
describe("proficiency 对拍：逐条比较", () => {
  it("timeFactor 全表一致", () => {
    for (const c of fixture.time_factor) {
      const attempt = attempts.get(c.id)!;
      expect(timeFactor(attempt, cfg), c.id).toBe(c.value);
    }
  });

  it("attemptQuality 全表一致", () => {
    for (const c of fixture.attempt_quality) {
      const attempt = attempts.get(c.id)!;
      expect(attemptQuality(attempt, cfg).toDict(), c.id).toEqual(c.quality);
    }
  });

  it("samplesForAttempt 全表一致", () => {
    for (const c of fixture.samples_for_attempt) {
      const attempt = attempts.get(c.id)!;
      const actual = Object.fromEntries(samplesForAttempt(attempt, cfg));
      expect(actual, c.id).toEqual(c.samples);
      // 键集合必须正好是六个信号名（多一个少一个都是分叉）
      expect(Object.keys(actual).sort(), c.id).toEqual([...SIGNAL_NAMES].sort());
    }
  });

  it("signalSummary 全表一致", () => {
    for (const c of fixture.signal_summary) {
      expect(signalSummary(signalsFromDesc(c.signals)), c.signals.probe_status).toBe(c.text);
    }
  });

  for (const seq of fixture.update_signals) {
    it(`updateSignals 序列「${seq.id}」逐步一致`, () => {
      let signals = signalsFromDesc(seq.initial);
      seq.attempts.forEach((attemptId, index) => {
        signals = updateSignals(signals, attempts.get(attemptId)!, cfg);
        expect(signals.toDict(), `${seq.id} 第 ${index + 1} 步（${attemptId}）`).toEqual(
          seq.steps[index],
        );
      });
    });
  }

  it("updateSignals 不修改入参 —— replay 可重现的前提", () => {
    for (const seq of fixture.update_signals) {
      const original = signalsFromDesc(seq.initial);
      const before = original.toDict();
      updateSignals(original, attempts.get(seq.attempts[0]!)!, cfg);
      expect(original.toDict(), `${seq.id} 的入参被改掉了`).toEqual(before);
    }
  });
});
