/**
 * simulate 对拍 —— TS 的 8 画像 × 30 天全量模拟 vs Python 的黄金语料。
 *
 * `tests/oracle/fixtures/simulate_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py simulate` 产出。
 *
 * 覆盖（P3 体检的回归基准，Python 删除后唯一权威）：
 *   1. 画像声明 —— makeProfiles() 的 key/seed/entry 必须与 Python PROFILES
 *      逐字段一致，否则整个模拟都在对拍"别的孩子"；
 *   2. 模拟本体 —— 每天 DayRecord、每个 attempt、schedule 终态、
 *      日终事件（focus_switch / upgrade / fallback）、final_state 快照；
 *   3. 派生结果 —— fallback_episodes 合并、final_focus，两侧各自计算再对比；
 *   4. 体检 findings 全文 + render_report 全文（文案逐字对拍）。
 *
 * 作答建模本身是画像规则（确定性）：全部随机性来自 PyRandom(profile.seed)，
 * 同一 seed 两次跑逐字段一致 —— 所以这里直接跑一遍把结果全部固化对比。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadBundle } from "@/src/content/loader";
import { loadConfig } from "@/src/engine/config";
import { CompetencyGraph } from "@/src/engine/graph";
import type { Attempt } from "@/src/engine/types";
import {
  renderReport,
  runColdStart,
  runHealthChecks,
  runSimulation,
  SIM_DAYS,
  withPracticeSlots,
} from "@/scripts/simulate";
import type { ChildRun, DayRecord, Entry, Finding } from "@/scripts/simulate";
import { makeProfiles } from "@/scripts/simulate";
import { learnerStateSnapshot } from "../helpers/engine-probes";

// ── fixture 形状 ──────────────────────────────────────────
interface AttemptDict {
  attempt_id: string;
  child_id: string;
  item_id: string;
  competency_id: string;
  pattern_id: string;
  correct: boolean;
  telemetry: {
    response_time_ms: number;
    active_time_ms: number;
    idle_time_ms: number;
    thinking_time_ms: number;
  };
  seq: number;
  hints_used: number;
  hint_level_max: number;
  scaffold_level: string;
  interaction_type: string;
  is_transfer_probe: boolean;
  submitted_answer: unknown;
}

interface DayDict {
  day: number;
  focus: string | null;
  due_count: number;
  planned_reviews: number;
  review_attempts: number;
  probe_planned: number;
  probe_attempts: number;
  notes: string[];
  attempt_ids: string[];
}

interface RunDict {
  key: string;
  name: string;
  description: string;
  entry_focus: string;
  days: DayDict[];
  attempts: AttemptDict[];
  review_attempt_ids: string[];
  schedule: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  fallback_episodes: Array<Record<string, unknown>>;
  final_focus: string | null;
  final_state: Record<string, unknown>;
}

interface FindingDict {
  question: string;
  title: string;
  detected: boolean;
  severity: string;
  lines: string[];
}

interface ProfileDict {
  key: string;
  name: string;
  description: string;
  seed: number;
  entry: Record<string, unknown>;
}

interface Fixture {
  days: number;
  added_slots: string[];
  profiles: ProfileDict[];
  runs: RunDict[];
  cold_start: RunDict;
  findings: FindingDict[];
  report: string;
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/simulate_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

// ── 投影（与 dump_fixtures.py 的 _sim_attempt_dict / _sim_run_dict 同构）──
function attemptDict(a: Attempt): AttemptDict {
  return {
    attempt_id: a.attempt_id,
    child_id: a.child_id,
    item_id: a.item_id,
    competency_id: a.competency_id,
    pattern_id: a.pattern_id,
    correct: a.correct,
    telemetry: a.telemetry.toDict(),
    seq: a.seq,
    hints_used: a.hints_used,
    hint_level_max: a.hint_level_max,
    scaffold_level: a.scaffold_level,
    interaction_type: a.interaction_type,
    is_transfer_probe: a.is_transfer_probe,
    submitted_answer: a.submitted_answer,
  };
}

function dayDict(d: DayRecord): DayDict {
  return {
    day: d.day,
    focus: d.focus,
    due_count: d.due_count,
    planned_reviews: d.planned_reviews,
    review_attempts: d.review_attempts,
    probe_planned: d.probe_planned,
    probe_attempts: d.probe_attempts,
    notes: [...d.notes],
    attempt_ids: d.attempts.map((a) => a.attempt_id),
  };
}

function entryDict(e: Entry): Record<string, unknown> {
  return {
    focus: e.focus,
    focus_mastery: e.focus_mastery,
    focus_accuracy: e.focus_accuracy,
    focus_independence: e.focus_independence,
    focus_fluency: e.focus_fluency,
    focus_samples: e.focus_samples,
    mastered_prereqs: [...e.mastered_prereqs],
    weak: { ...e.weak },
    tried_patterns: e.tried_patterns,
  };
}

// ── 引擎环境（整个文件只跑一次模拟）─────────────────────────
const bundle = loadBundle();
const cfg = loadConfig(0);
const graph = new CompetencyGraph(bundle);
const [simBundle, addedSlots] = withPracticeSlots(bundle, cfg);
const profiles = makeProfiles();
const runs = runSimulation(profiles, simBundle, cfg, graph, fixture.days);
const cold = runColdStart(simBundle, cfg, graph, fixture.days);
const findings = runHealthChecks([...runs, cold], simBundle, graph, cfg);
const report = renderReport(runs, findings, simBundle, cfg, graph, addedSlots, cold);

function tsRunDict(r: ChildRun): RunDict {
  return {
    key: r.key,
    name: r.name,
    description: r.description,
    entry_focus: r.entry_focus,
    days: r.days.map(dayDict),
    attempts: r.all_attempts().map(attemptDict),
    review_attempt_ids: [...r.review_attempt_ids].sort(),
    schedule: Object.fromEntries(r.schedule),
    events: r.events,
    fallback_episodes: r.fallback_episodes(),
    final_focus: r.final_focus(graph, cfg),
    final_state: learnerStateSnapshot(r.final_state!),
  };
}

/** 一整个 run 的逐段对拍（拆开断言，失败时能直接看出是哪一块漂移）。 */
function expectRunParity(actual: ChildRun, expected: RunDict) {
  describe(`run ${expected.key}`, () => {
    it("画像元信息", () => {
      expect(actual.key).toBe(expected.key);
      expect(actual.name).toBe(expected.name);
      expect(actual.description).toBe(expected.description);
      expect(actual.entry_focus).toBe(expected.entry_focus);
    });

    it("每天 DayRecord（focus / 计数 / notes / attempt 排布）", () => {
      expect(actual.days.map(dayDict)).toStrictEqual(expected.days);
    });

    it("全部 attempt 逐字段", () => {
      expect(actual.all_attempts().map(attemptDict)).toStrictEqual(expected.attempts);
    });

    it("复习题 id 集", () => {
      expect([...actual.review_attempt_ids].sort()).toStrictEqual(expected.review_attempt_ids);
    });

    it("schedule 终态", () => {
      expect(Object.fromEntries(actual.schedule)).toStrictEqual(expected.schedule);
    });

    it("日终事件（focus_switch / upgrade / fallback）", () => {
      expect(actual.events).toStrictEqual(expected.events);
    });

    it("fallback_episodes（TS 自己合并再对比 Python 结果）", () => {
      expect(actual.fallback_episodes()).toStrictEqual(expected.fallback_episodes);
    });

    it("final_focus", () => {
      expect(actual.final_focus(graph, cfg)).toBe(expected.final_focus);
    });

    it("final_state 快照", () => {
      expect(learnerStateSnapshot(actual.final_state!)).toStrictEqual(expected.final_state);
    });
  });
}

// ── 测试 ──────────────────────────────────────────────────
describe("simulate 画像声明（makeProfiles vs Python PROFILES）", () => {
  it("画像数量与顺序一致", () => {
    expect(profiles.map((p) => p.key)).toStrictEqual(fixture.profiles.map((p) => p.key));
    expect(fixture.days).toBe(SIM_DAYS);
  });

  for (let i = 0; i < fixture.profiles.length; i++) {
    const expected = fixture.profiles[i]!;
    it(`${expected.key}：key/name/description/seed/entry 逐字段`, () => {
      const p = profiles[i]!;
      expect(p.key).toBe(expected.key);
      expect(p.name).toBe(expected.name);
      expect(p.description).toBe(expected.description);
      expect(p.seed).toBe(expected.seed);
      expect(entryDict(p.entry)).toStrictEqual(expected.entry);
    });
  }
});

describe("simulate 补槽与作答流", () => {
  it("withPracticeSlots 的补槽清单", () => {
    expect(addedSlots).toStrictEqual(fixture.added_slots);
  });

  it("runs 数量 = 画像数，cold_start 独立一条", () => {
    expect(runs.length).toBe(fixture.runs.length);
    expect(cold.key).toBe(fixture.cold_start.key);
  });
});

for (let i = 0; i < fixture.runs.length; i++) {
  expectRunParity(runs[i]!, fixture.runs[i]!);
}
expectRunParity(cold, fixture.cold_start);

describe("simulate 体检 findings", () => {
  it("findings 数量与顺序", () => {
    expect(findings.map((f) => f.question)).toStrictEqual(
      fixture.findings.map((f) => f.question),
    );
  });

  for (let i = 0; i < fixture.findings.length; i++) {
    const expected = fixture.findings[i]!;
    it(`${expected.question}：全文逐字`, () => {
      const f = findings[i]!;
      const actual: FindingDict = {
        question: f.question,
        title: f.title,
        detected: f.detected,
        severity: f.severity,
        lines: [...f.lines],
      };
      expect(actual).toStrictEqual(expected);
    });
  }
});

describe("simulate 报告全文", () => {
  it("render_report 全文逐字", () => {
    expect(report).toBe(fixture.report);
  });
});
