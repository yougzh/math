"""学习状态推进器。

**在线更新与 Replay 使用同一段代码**（本模块），这是 Replay 可信的前提——
两套实现必然发散。

约定：
  - apply_attempt 是纯函数：返回新状态，不修改入参、不写数据库、不读时间
  - 事实来源只有 Attempt（ADR-0004）
"""
from __future__ import annotations

from typing import List, Optional

from backend.content.loader import ContentBundle, Item
from backend.engine.config import AlgorithmConfig
from backend.engine.diagnosis import diagnose
from backend.engine.graph import CompetencyGraph
from backend.engine.proficiency import update_signals
from backend.engine.types import (
    Attempt,
    ChildLearningState,
    MisconceptionState,
    Signals,
    pattern_key,
)


def apply_attempt(
    state: ChildLearningState,
    attempt: Attempt,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
) -> ChildLearningState:
    updated = state.copy()

    # 1) 能力信号
    competency_signals = updated.competencies.get(attempt.competency_id) or Signals()
    updated.competencies[attempt.competency_id] = update_signals(
        competency_signals, attempt, cfg
    )

    # 2) pattern 信号（迁移与策略变化都看这一层；键含 competency）
    key = pattern_key(attempt.competency_id, attempt.pattern_id)
    pattern_signals = updated.patterns.get(key) or Signals()
    updated.patterns[key] = update_signals(pattern_signals, attempt, cfg)

    # 3) 错误认知
    item: Optional[Item] = bundle.items.get(attempt.item_id)
    for code in diagnose(attempt, item, cfg):
        misc = updated.misconceptions.get(code)
        if misc is None:
            definition = bundle.misconceptions.get(code)
            misc = MisconceptionState(
                code=code,
                remediation_competency=(
                    definition.remediation_competency if definition else None
                ),
            )
        misc.hit_count += 1
        misc.last_seq = attempt.seq
        updated.misconceptions[code] = misc

    # 4) 历史窗口
    updated.attempts_seen += 1
    if attempt.is_assessment:
        updated.assessment_attempts += 1
    updated.recent_attempts.append(attempt)
    window = cfg.recent_attempt_window
    if len(updated.recent_attempts) > window:
        updated.recent_attempts = updated.recent_attempts[-window:]

    # 5) 记录每个能力首次接触时的脚手架级别（"今日发现"要和过去的自己比）
    if attempt.competency_id not in updated.first_scaffold:
        updated.first_scaffold[attempt.competency_id] = attempt.scaffold_level

    # 6) 记录落脚点：Planner 用它判断"孩子此刻正在练哪个能力"
    updated.last_touched_seq[attempt.competency_id] = attempt.seq

    return updated


def apply_attempts(
    state: ChildLearningState,
    attempts: List[Attempt],
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
) -> ChildLearningState:
    current = state
    for attempt in sorted(attempts, key=lambda a: a.seq):
        current = apply_attempt(current, attempt, bundle, cfg)
    return current


def new_state(child_id: str) -> ChildLearningState:
    return ChildLearningState(child_id=child_id)


__all__ = [
    "apply_attempt",
    "apply_attempts",
    "new_state",
    "CompetencyGraph",
]
