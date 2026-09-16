/**
 * 学习意图层 —— `backend/engine/intent.py` 的 TypeScript 移植。
 *
 * 这是学习决策链的第 2 环，也是整个系统"大脑"的关键一层：
 *
 *     Child State → **Learning Intent** → Daily Plan → Story → Challenge Slot → Item
 *
 * **Planner 不应该直接选题目。**
 *
 * 反例（禁止）：❌ 今天做 item_102
 * 正例：         ✅ 今天 1) 强化 make_ten fluency  2) 复习 place_value  3) 测试 transfer
 *
 * 先定意图再落题目，好处：
 *   - 规划策略与题目细节解耦，可复用、可解释、可回放
 *   - 同一条意图可以在不同故事、不同槽位里被实现
 */

import type { ContentBundle } from "@/src/content/types";
import type { AlgorithmConfig } from "@/src/engine/config";
import type { CompetencyGraph } from "@/src/engine/graph";
import { fallbackDecision, nextCompetency } from "@/src/engine/state-machine";
import type { ChildLearningState, LearningIntent, Signals } from "@/src/engine/types";
import { LearningIntent as LearningIntentClass, Signals as SignalsClass, patternKey } from "@/src/engine/types";
import { pyGet } from "@/src/py/pyvalue";

export const PRIORITY_WARMUP = 0;
export const PRIORITY_REPAIR = 10;
export const PRIORITY_TEACH = 20;

function competencySignals(state: ChildLearningState, code: string): Signals {
  return state.competencies.get(code) ?? new SignalsClass();
}

/**
 * 热身选"已经会、但还没完全自动化"的能力 —— 目的是召回，不是教学。
 *
 * 必须排除当前聚焦能力：否则会出现"热身练的就是今天要学的东西"。
 */
function warmupTarget(
  state: ChildLearningState,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
  exclude?: string | null,
): string | null {
  const intentCfg = cfg.intentConfig();
  const minMastery = Number(pyGet(intentCfg, "warmup_min_mastery", 0.6));
  const maxSamples = Math.trunc(Number(pyGet(intentCfg, "warmup_max_samples", 12)));

  const candidates: Array<[number, number, string]> = [];
  for (const code of graph.topologicalOrder()) {
    if (code === exclude) {
      continue;
    }
    const signals = state.competencies.get(code);
    if (signals === undefined || signals.mastery === null) {
      continue;
    }
    if (signals.mastery < minMastery) {
      continue;
    }
    if (signals.sample_count > maxSamples) {
      continue; // 已经自动化，不需要热身
    }
    candidates.push([signals.sample_count, signals.mastery, code]);
  }

  if (candidates.length === 0) {
    return null;
  }
  // 样本最少的最需要召回
  candidates.sort(
    (a, b) =>
      a[0] - b[0] ||
      b[1] - a[1] || // -mastery
      (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0),
  );
  return candidates[0]![2];
}

function untriedPatterns(
  state: ChildLearningState,
  competency_id: string,
  graph: CompetencyGraph,
): string[] {
  return graph
    .patternsFor(competency_id)
    .map((p) => p.code)
    .filter((code) => !state.patterns.has(patternKey(competency_id, code)))
    .sort();
}

export function deriveIntents(
  state: ChildLearningState,
  graph: CompetencyGraph,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
): LearningIntent[] {
  const intents: LearningIntent[] = [];

  // 2) 主目标能力（先算出来，热身要排除它）
  const target = nextCompetency(state, graph, cfg);
  // 1) 热身：召回旧知识
  const warmupCode = warmupTarget(state, graph, cfg, target ?? undefined);
  if (warmupCode) {
    intents.push(
      new LearningIntentClass({
        kind: "warmup",
        competency_id: warmupCode,
        reason: "召回已会但尚未自动化的能力",
        priority: PRIORITY_WARMUP,
        target_seconds:
          Number(pyGet(cfg.intentConfig(), "warmup_item_count", 2)) * 10,
      }),
    );
  }

  if (target === null) {
    return intents;
  }

  const signals = competencySignals(state, target);

  // 2a) 需要回退时，回退意图优先于一切教学意图
  const fallback = fallbackDecision(state, target, graph, cfg);
  if (fallback.action === "fallback" && fallback.target_competency_id) {
    intents.push(
      new LearningIntentClass({
        kind: "repair",
        competency_id: fallback.target_competency_id,
        reason: fallback.reasons.join("；"),
        priority: PRIORITY_REPAIR,
        scaffold_level: cfg.scaffoldForMastery(
          competencySignals(state, fallback.target_competency_id).mastery,
        ),
      }),
    );
    // 修复期间不推进新内容
  }

  const scaffold = cfg.scaffoldForMastery(signals.mastery);

  // 2b) 迁移测试：熟练度够高，但还有没试过的问题结构
  const intentCfg = cfg.intentConfig();
  const probeMastery = Number(pyGet(intentCfg, "probe_transfer_mastery", 0.6));
  const untried = untriedPatterns(state, target, graph);
  if (
    fallback.action !== "fallback" &&
    signals.mastery !== null &&
    signals.mastery >= probeMastery &&
    untried.length > 0 &&
    signals.sampleCountFor("transfer") === 0
  ) {
    intents.push(
      new LearningIntentClass({
        kind: "probe_transfer",
        competency_id: target,
        reason: "熟练度已达标但迁移能力尚无证据，换一种问题结构验证",
        pattern_id: untried[0]!,
        scaffold_level: scaffold,
        priority: PRIORITY_TEACH,
        target_seconds: 25,
      }),
    );
  }

  // 2c) 流畅度专项：会做但慢 —— 本产品的核心痛点
  const fluencyTarget = Number(pyGet(cfg.upgradeRequires(), "fluency", 0.6));
  const strengthenRatio = Number(pyGet(intentCfg, "strengthen_fluency_ratio", 0.8));
  if (
    signals.fluency !== null &&
    signals.fluency < fluencyTarget * strengthenRatio &&
    (signals.mastery ?? 0) >= 0.5
  ) {
    intents.push(
      new LearningIntentClass({
        kind: "strengthen_fluency",
        competency_id: target,
        reason: "已经理解，但还不够流畅（会，但是慢）",
        scaffold_level: scaffold,
        priority: PRIORITY_TEACH,
        target_seconds: 20,
      }),
    );
  }

  // 2d) 默认：继续教 / 继续练。
  // 与 strengthen_fluency / probe_transfer **并存**，不是二选一 ——
  // 一次会话既要练核心，也要有迁移测试（分别落在 core 段和 thinking 段）。
  if (fallback.action !== "fallback") {
    intents.push(
      new LearningIntentClass({
        kind: "teach",
        competency_id: target,
        reason: "当前聚焦能力尚未达标",
        scaffold_level: scaffold,
        priority: PRIORITY_TEACH,
      }),
    );
  }

  return intents.sort(
    (a, b) =>
      a.priority - b.priority || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
}

/** 给人看的意图清单 —— 这是 Planner 决策可解释性的落点。 */
export function describeIntents(intents: readonly LearningIntent[]): string[] {
  return intents.map(
    (i, idx) => `${idx + 1}. [${i.kind}] ${i.competency_id} ← ${i.reason}`,
  );
}
