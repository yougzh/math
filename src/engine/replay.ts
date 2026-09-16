/**
 * Learning Replay —— `backend/engine/replay.py` 的 TypeScript 移植。
 *
 * 改算法后必须能把历史 attempt 重跑一遍，得到全部熟练度状态与等级 ——
 * 这是 ADR-0002（等级是派生值）能成立的前提。
 *
 * 关键约束：**Replay 与在线更新必须共用同一段代码**（`learner.ts` 的
 * applyAttempt）。两套实现必然发散，一旦发散，Replay 就失去了意义。
 */

import type { ContentBundle } from "@/src/content/types";
import { loadBundle } from "@/src/content/loader";
import type { AlgorithmConfig } from "@/src/engine/config";
import { loadConfig } from "@/src/engine/config";
import { CompetencyGraph } from "@/src/engine/graph";
import { applyAttempt, newState } from "@/src/engine/learner";
import { deriveLevel, nextCompetency, upgradeDecision } from "@/src/engine/state-machine";
import type { Attempt, ChildLearningState, Decision } from "@/src/engine/types";
import { pyRound } from "@/src/py/pyround";
import { pyDumps } from "@/src/py/pyjson";

export interface ReplaySnapshot {
  seq: number;
  attempt_id: string;
  competency_id: string;
  correct: boolean;
  level: string;
  level_label: string;
  scaffold_recommended: string;
  signals: Record<string, number | null>;
  decision: Decision;
}

export class ReplayResult {
  child_id: string;
  algorithm_version: number;
  final_state: ChildLearningState;
  snapshots: ReplaySnapshot[];
  final_competency: string | null;
  final_level: string;
  final_scaffold: string;
  final_decision: Decision | null;
  final_mastered: boolean;

  constructor(init: {
    child_id: string;
    algorithm_version: number;
    final_state: ChildLearningState;
    snapshots?: ReplaySnapshot[];
    final_competency?: string | null;
    final_level?: string;
    final_scaffold?: string;
    final_decision?: Decision | null;
    final_mastered?: boolean;
  }) {
    this.child_id = init.child_id;
    this.algorithm_version = init.algorithm_version;
    this.final_state = init.final_state;
    this.snapshots = init.snapshots ?? [];
    this.final_competency = init.final_competency ?? null;
    this.final_level = init.final_level ?? "encountering";
    this.final_scaffold = init.final_scaffold ?? "blocks";
    this.final_decision = init.final_decision ?? null;
    this.final_mastered = init.final_mastered ?? false;
  }

  toDict(): Record<string, unknown> {
    return {
      child_id: this.child_id,
      algorithm_version: this.algorithm_version,
      attempts: this.final_state.attempts_seen,
      final_competency: this.final_competency,
      final_level: this.final_level,
      final_scaffold: this.final_scaffold,
      final_mastered: this.final_mastered,
      competencies: Object.fromEntries(
        [...this.final_state.competencies.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([code, signals]) => [code, signals.toDict()]),
      ),
    };
  }
}

const SNAPSHOT_SIGNALS = ["mastery", "accuracy", "fluency", "independence", "transfer"] as const;

export function replay(
  child_id: string,
  attempts: readonly Attempt[],
  bundle: ContentBundle = loadBundle(),
  cfg: AlgorithmConfig = loadConfig(),
  graph: CompetencyGraph = new CompetencyGraph(bundle),
  initial_state?: ChildLearningState | null,
): ReplayResult {
  // Python `sorted(attempts, key=seq)`：稳定排序，同 seq 保持传入顺序
  const ordered = [...attempts].sort((a, b) => a.seq - b.seq);
  let state = initial_state ? initial_state.copy() : newState(child_id);
  const snapshots: ReplaySnapshot[] = [];
  for (const attempt of ordered) {
    state = applyAttempt(state, attempt, bundle, cfg);
    const signals = state.competencies.get(attempt.competency_id)!;
    const level = deriveLevel(signals, cfg);
    const signalValues: Record<string, number | null> = {};
    for (const name of SNAPSHOT_SIGNALS) {
      const value = signals.value(name);
      signalValues[name] = value === null ? null : pyRound(value, 4);
    }
    snapshots.push({
      seq: attempt.seq,
      attempt_id: attempt.attempt_id,
      competency_id: attempt.competency_id,
      correct: attempt.correct,
      level,
      level_label: cfg.levelLabel(level),
      scaffold_recommended: cfg.scaffoldForMastery(signals.mastery),
      signals: signalValues,
      decision: upgradeDecision(state, attempt.competency_id, graph, cfg),
    });
  }

  const target = nextCompetency(state, graph, cfg);
  const final_signals = target !== null ? (state.competencies.get(target) ?? null) : null;
  const final_level = final_signals ? deriveLevel(final_signals, cfg) : cfg.level_order[0];
  const final_decision = target !== null ? upgradeDecision(state, target, graph, cfg) : null;

  return new ReplayResult({
    child_id,
    algorithm_version: cfg.version,
    final_state: state,
    snapshots,
    final_competency: target,
    final_level,
    final_scaffold: cfg.scaffoldForMastery(final_signals ? final_signals.mastery : null),
    final_decision,
    final_mastered: final_decision !== null && final_decision.action === "upgrade",
  });
}

/** 逐字段比较两个状态（用于验证 replay 与在线更新一致）。 */
export function statesEqual(a: ChildLearningState, b: ChildLearningState): boolean {
  return (
    pyDumps(stateFingerprint(a), { sortKeys: true }) ===
    pyDumps(stateFingerprint(b), { sortKeys: true })
  );
}

function stateFingerprint(state: ChildLearningState): Record<string, unknown> {
  const sortedByCode = <T>(map: Map<string, T>): Array<[string, T]> =>
    [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

  return {
    child_id: state.child_id,
    attempts_seen: state.attempts_seen,
    assessment_attempts: state.assessment_attempts,
    competencies: Object.fromEntries(
      sortedByCode(state.competencies).map(([code, signals]) => [code, signals.toDict()]),
    ),
    patterns: Object.fromEntries(
      sortedByCode(state.patterns).map(([key, signals]) => [key, signals.toDict()]),
    ),
    misconceptions: Object.fromEntries(
      sortedByCode(state.misconceptions).map(([code, m]) => [
        code,
        {
          hit_count: m.hit_count,
          last_seq: m.last_seq,
          resolved: m.resolved,
          remediation_competency: m.remediation_competency,
        },
      ]),
    ),
    first_scaffold: Object.fromEntries(sortedByCode(state.first_scaffold)),
  };
}
