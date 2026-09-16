/**
 * replay 对拍 —— TS 的 replay() / statesEqual() vs Python 的黄金语料。
 *
 * `tests/oracle/fixtures/replay_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py replay` 产出。
 *
 * 本模块最重的一条断言是 `replay_matches_online`：同一批 attempt，
 * applyAttempts（在线路径）与 replay（重放路径）的最终状态必须一致 ——
 * "Replay 与在线更新共用同一段代码"这条约束的正面验证。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "@/src/engine/config";
import { CompetencyGraph } from "@/src/engine/graph";
import { applyAttempts, newState } from "@/src/engine/learner";
import { replay, statesEqual } from "@/src/engine/replay";
import type { Decision } from "@/src/engine/types";
import { loadBundle } from "@/src/content/loader";
import { learnerAttemptFromDesc, learnerStateFromDesc } from "../helpers/engine-probes";
import type { LearnerAttemptDesc, LearnerStateDesc } from "../helpers/engine-probes";
import type { ErrorRule, Item } from "@/src/content/types";

interface ReplaySnapshotExpect {
  seq: number;
  attempt_id: string;
  competency_id: string;
  correct: boolean;
  level: string;
  level_label: string;
  scaffold_recommended: string;
  signals: Record<string, number | null>;
  decision: {
    action: string;
    competency_id: string;
    target_competency_id: string | null;
    reasons: string[];
  };
}

interface ReplayCase {
  id: string;
  note: string;
  child_id: string;
  initial: LearnerStateDesc;
  attempts: LearnerAttemptDesc[];
  snapshots: ReplaySnapshotExpect[];
  to_dict: Record<string, unknown>;
  final_decision: {
    action: string;
    competency_id: string;
    target_competency_id: string | null;
    reasons: string[];
  } | null;
}

interface Fixture {
  config_version: number;
  items: LearnerItemDesc[];
  cases: ReplayCase[];
  states_equal: Array<{ id: string; note: string; expect: boolean }>;
}

interface LearnerItemDesc {
  code: string;
  answer: unknown;
  error_rules: ErrorRule[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/replay_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const cfg = loadConfig(fixture.config_version);
const bundle = loadBundle();

/** 与 Python 侧 dump_replay 同构：注入定制 item */
for (const desc of fixture.items) {
  const item: Item = {
    code: desc.code,
    competency_id: "make_ten",
    pattern_id: "direct_compute",
    difficulty: 3,
    scaffold_level: "direct",
    interaction_type: "number_pad",
    estimated_seconds: 6,
    problem: {},
    answer: desc.answer,
    steps: [],
    hint_chain: [],
    error_rules: desc.error_rules,
    steps_style: "guide",
  };
  bundle.items.set(desc.code, item);
}

const graph = new CompetencyGraph(bundle);

function expectDecision(got: Decision, want: ReplaySnapshotExpect["decision"], label: string): void {
  expect(got.action, `${label} 的 action`).toBe(want.action);
  expect(got.competency_id, `${label} 的 competency_id`).toBe(want.competency_id);
  expect(got.target_competency_id, `${label} 的 target`).toStrictEqual(want.target_competency_id);
  expect(got.reasons, `${label} 的 reasons`).toStrictEqual(want.reasons);
}

function caseAttempts(c: ReplayCase) {
  return c.attempts.map(learnerAttemptFromDesc);
}

// ══════════════════════════════════════════════════════════
describe("replay 对拍：前置一致性", () => {
  it("fixture 的 config_version 与本地配置一致", () => {
    expect(fixture.config_version).toBe(cfg.version);
  });

  it("注入的 item 进了 bundle", () => {
    for (const desc of fixture.items) {
      expect(bundle.items.get(desc.code), desc.code).toBeDefined();
    }
  });
});

// ══════════════════════════════════════════════════════════
describe("replay 对拍：fixture 自证", () => {
  it("progression 的等级跟着 mastery 走：会爬升、也会因答错回退（派生值，ADR-0002）", () => {
    const c = fixture.cases.find((x) => x.id === "progression_ten_attempts")!;
    const levels = c.snapshots.map((s) => s.level);
    const order = cfg.level_order;
    const rank = (lv: string) => order.indexOf(lv);
    // 等级是派生值不是累积成就：mastery 掉，等级就掉 ——
    // 所以这里钉的是"跟着 mastery 走"，而不是单调爬升
    for (let i = 1; i < levels.length; i += 1) {
      const masteryUp = c.snapshots[i]!.signals.mastery! > c.snapshots[i - 1]!.signals.mastery!;
      const masteryDown =
        c.snapshots[i]!.signals.mastery! < c.snapshots[i - 1]!.signals.mastery!;
      if (masteryUp) {
        expect(rank(levels[i]!), `${levels[i - 1]} → ${levels[i]}（mastery 升）`).toBeGreaterThanOrEqual(
          rank(levels[i - 1]!),
        );
      }
      if (masteryDown) {
        expect(rank(levels[i]!), `${levels[i - 1]} → ${levels[i]}（mastery 降）`).toBeLessThanOrEqual(
          rank(levels[i - 1]!),
        );
      }
    }
    // 等级真的动过（不然"派生"是平凡的）
    expect(rank(levels.at(-1)!)).toBeGreaterThan(rank(levels[0]!));
  });

  it("multi_competency 的 final_competency 是**最后落脚**的能力（carry_add）", () => {
    const c = fixture.cases.find((x) => x.id === "multi_competency_landing")!;
    expect(c.to_dict["final_competency"]).toBe("carry_add");
    expect(c.attempts.at(-1)!.competency).toBe("carry_add");
  });

  it("states_equal 的三个用例覆盖 True 与 False 两侧", () => {
    const expects = fixture.states_equal.map((s) => s.expect);
    expect(expects).toContain(true);
    expect(expects).toContain(false);
  });
});

// ══════════════════════════════════════════════════════════
describe("replay 对拍：逐条比较", () => {
  for (const c of fixture.cases) {
    it(`${c.id}：${c.note}`, () => {
      const initial = learnerStateFromDesc(c.initial ?? {}, new Map());
      const result = replay(c.child_id, caseAttempts(c), bundle, cfg, graph, initial);

      // snapshots 逐步逐字
      expect(result.snapshots).toHaveLength(c.snapshots.length);
      result.snapshots.forEach((got, i) => {
        const want = c.snapshots[i]!;
        expect(got.seq, `snapshot ${i} seq`).toBe(want.seq);
        expect(got.attempt_id, `snapshot ${i} attempt_id`).toBe(want.attempt_id);
        expect(got.competency_id, `snapshot ${i} competency`).toBe(want.competency_id);
        expect(got.correct, `snapshot ${i} correct`).toBe(want.correct);
        expect(got.level, `snapshot ${i} level`).toBe(want.level);
        expect(got.level_label, `snapshot ${i} level_label`).toBe(want.level_label);
        expect(got.scaffold_recommended, `snapshot ${i} scaffold`).toBe(want.scaffold_recommended);
        expect(got.signals, `snapshot ${i} signals`).toStrictEqual(want.signals);
        expectDecision(got.decision, want.decision, `snapshot ${i} decision`);
      });

      expect(result.final_decision !== null).toBe(c.final_decision !== null);
      if (c.final_decision !== null) {
        expectDecision(result.final_decision!, c.final_decision, "final_decision");
      }
      expect(result.toDict(), `${c.id} 的 to_dict`).toStrictEqual(c.to_dict);
    });
  }

  it("带初态 replay **不修改入参**（内部必须先 copy）", () => {
    const c = fixture.cases.find((x) => x.id === "with_initial_state")!;
    const initial = learnerStateFromDesc(c.initial, new Map());
    replay(c.child_id, caseAttempts(c), bundle, cfg, graph, initial);
    expect(initial.attempts_seen).toBe(c.initial.attempts_seen);
    expect(initial.competencies.size).toBe(
      Object.keys(c.initial.competencies ?? {}).length,
    );
  });
});

// ══════════════════════════════════════════════════════════
describe("replay 对拍：states_equal（replay 与在线一致）", () => {
  for (const s of fixture.states_equal) {
    it(`${s.id}：${s.note}`, () => {
      if (s.id === "differs_by_mastery") {
        const a = learnerStateFromDesc(
          { competencies: { make_ten: { mastery: 0.5 } } },
          new Map(),
        );
        const b = learnerStateFromDesc(
          { competencies: { make_ten: { mastery: 0.9 } } },
          new Map(),
        );
        expect(statesEqual(a, b)).toBe(s.expect);
        return;
      }
      // replay_matches_online__*：与 Python 同一构造 —— 在线路径 applyAttempts，
      // 重放路径 replay，两边终态必须相等
      const specId = s.id.replace("replay_matches_online__", "");
      const c = fixture.cases.find((x) => x.id === specId)!;
      expect(c).toBeDefined();
      const attempts = caseAttempts(c);
      const online = applyAttempts(
        newState(c.child_id),
        attempts,
        bundle,
        cfg,
      );
      const rep = replay(c.child_id, attempts, bundle, cfg, graph);
      expect(statesEqual(online, rep.final_state)).toBe(s.expect);
    });
  }
});
