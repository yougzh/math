/**
 * 学习状态推进器 —— `backend/engine/learner.py` 的 TypeScript 移植。
 *
 * **在线更新与 Replay 使用同一段代码**（本模块），这是 Replay 可信的前提——
 * 两套实现必然发散。
 *
 * 约定：
 *   - `applyAttempt` 是纯函数：返回新状态，不修改入参、不写数据库、不读时间
 *   - 事实来源只有 Attempt（ADR-0004）
 *
 * 取既有 Signals 的写法是 `get(...) ?? new Signals()`（Python 的
 * `.get(...) or Signals()`），**不是** `state.competency(code)` ——
 * 后者是"有副作用的读"（缺键时先塞一个空 Signals 进 Map），而这里是
 * 直接把 updateSignals 的新值整个赋回去，预建键是多余动作。
 * 两条路径的结果等价，但照抄 Python 的形状，不做"顺手统一"。
 */

import type { ContentBundle } from "@/src/content/types";
import type { AlgorithmConfig } from "@/src/engine/config";
import { diagnose } from "@/src/engine/diagnosis";
import type { Attempt } from "@/src/engine/types";
import { ChildLearningState, MisconceptionState, Signals, patternKey } from "@/src/engine/types";
import { updateSignals } from "@/src/engine/proficiency";

export function applyAttempt(
  state: ChildLearningState,
  attempt: Attempt,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
): ChildLearningState {
  const updated = state.copy();

  // 1) 能力信号
  const competencySignals = updated.competencies.get(attempt.competency_id) ?? new Signals();
  updated.competencies.set(attempt.competency_id, updateSignals(competencySignals, attempt, cfg));

  // 2) pattern 信号（迁移与策略变化都看这一层；键含 competency）
  const key = patternKey(attempt.competency_id, attempt.pattern_id);
  const patternSignals = updated.patterns.get(key) ?? new Signals();
  updated.patterns.set(key, updateSignals(patternSignals, attempt, cfg));

  // 3) 错误认知
  const item = bundle.items.get(attempt.item_id) ?? null;
  for (const code of diagnose(attempt, item, cfg)) {
    let misc = updated.misconceptions.get(code);
    if (misc === undefined) {
      const definition = bundle.misconceptions.get(code);
      misc = new MisconceptionState({
        code,
        remediation_competency: definition ? definition.remediation_competency : null,
      });
    }
    misc.hit_count += 1;
    misc.last_seq = attempt.seq;
    updated.misconceptions.set(code, misc);
  }

  // 4) 历史窗口
  updated.attempts_seen += 1;
  if (attempt.is_assessment) {
    updated.assessment_attempts += 1;
  }
  updated.recent_attempts.push(attempt);
  const window = cfg.recent_attempt_window;
  if (updated.recent_attempts.length > window) {
    updated.recent_attempts = updated.recent_attempts.slice(-window);
  }

  // 5) 记录每个能力首次接触时的脚手架级别（"今日发现"要和过去的自己比）
  if (!updated.first_scaffold.has(attempt.competency_id)) {
    updated.first_scaffold.set(attempt.competency_id, attempt.scaffold_level);
  }

  // 6) 记录落脚点：Planner 用它判断"孩子此刻正在练哪个能力"
  updated.last_touched_seq.set(attempt.competency_id, attempt.seq);

  return updated;
}

export function applyAttempts(
  state: ChildLearningState,
  attempts: readonly Attempt[],
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
): ChildLearningState {
  let current = state;
  // Python `sorted(..., key=seq)` 是稳定排序：同 seq 保持传入顺序
  const ordered = [...attempts].sort((a, b) => a.seq - b.seq);
  for (const attempt of ordered) {
    current = applyAttempt(current, attempt, bundle, cfg);
  }
  return current;
}

export function newState(childId: string): ChildLearningState {
  return new ChildLearningState({ child_id: childId });
}
