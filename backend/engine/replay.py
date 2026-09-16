"""Learning Replay。

改算法后必须能把历史 attempt 重跑一遍，得到全部熟练度状态与等级 ——
这是 ADR-0002（等级是派生值）能成立的前提。

关键约束：**Replay 与在线更新必须共用同一段代码**（engine.learner.apply_attempt）。
两套实现必然发散，一旦发散，Replay 就失去了意义。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from backend.content.loader import ContentBundle, load_bundle
from backend.engine.config import AlgorithmConfig, load_config
from backend.engine.graph import CompetencyGraph
from backend.engine.learner import apply_attempt, new_state
from backend.engine.state_machine import (
    derive_level,
    next_competency,
    upgrade_decision,
)
from backend.engine.types import Attempt, ChildLearningState, Decision


@dataclass
class ReplaySnapshot:
    seq: int
    attempt_id: str
    competency_id: str
    correct: bool
    level: str
    level_label: str
    scaffold_recommended: str
    signals: Dict[str, Any]
    decision: Decision


@dataclass
class ReplayResult:
    child_id: str
    algorithm_version: int
    final_state: ChildLearningState
    snapshots: List[ReplaySnapshot] = field(default_factory=list)
    final_competency: Optional[str] = None
    final_level: str = "encountering"
    final_scaffold: str = "blocks"
    final_decision: Optional[Decision] = None
    final_mastered: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "child_id": self.child_id,
            "algorithm_version": self.algorithm_version,
            "attempts": self.final_state.attempts_seen,
            "final_competency": self.final_competency,
            "final_level": self.final_level,
            "final_scaffold": self.final_scaffold,
            "final_mastered": self.final_mastered,
            "competencies": {
                code: signals.to_dict()
                for code, signals in sorted(self.final_state.competencies.items())
            },
        }


def replay(
    child_id: str,
    attempts: List[Attempt],
    bundle: Optional[ContentBundle] = None,
    cfg: Optional[AlgorithmConfig] = None,
    graph: Optional[CompetencyGraph] = None,
    initial_state: Optional[ChildLearningState] = None,
) -> ReplayResult:
    bundle = bundle or load_bundle()
    cfg = cfg or load_config()
    graph = graph or CompetencyGraph(bundle)

    state = initial_state.copy() if initial_state else new_state(child_id)
    snapshots: List[ReplaySnapshot] = []

    for attempt in sorted(attempts, key=lambda a: a.seq):
        state = apply_attempt(state, attempt, bundle, cfg)
        signals = state.competencies[attempt.competency_id]
        level = derive_level(signals, cfg)
        snapshots.append(
            ReplaySnapshot(
                seq=attempt.seq,
                attempt_id=attempt.attempt_id,
                competency_id=attempt.competency_id,
                correct=attempt.correct,
                level=level,
                level_label=cfg.level_label(level),
                scaffold_recommended=cfg.scaffold_for_mastery(signals.mastery),
                signals={
                    name: (None if signals.value(name) is None else round(signals.value(name), 4))
                    for name in ("mastery", "accuracy", "fluency", "independence", "transfer")
                },
                decision=upgrade_decision(state, attempt.competency_id, graph, cfg),
            )
        )

    target = next_competency(state, graph, cfg)
    final_signals = state.competencies.get(target) if target else None
    final_level = derive_level(final_signals, cfg) if final_signals else cfg.level_order[0]
    final_decision = (
        upgrade_decision(state, target, graph, cfg) if target else None
    )

    return ReplayResult(
        child_id=child_id,
        algorithm_version=cfg.version,
        final_state=state,
        snapshots=snapshots,
        final_competency=target,
        final_level=final_level,
        final_scaffold=cfg.scaffold_for_mastery(
            final_signals.mastery if final_signals else None
        ),
        final_decision=final_decision,
        final_mastered=bool(final_decision and final_decision.action == "upgrade"),
    )


def states_equal(a: ChildLearningState, b: ChildLearningState) -> bool:
    """逐字段比较两个状态（用于验证 replay 与在线更新一致）。"""
    return json.dumps(_state_fingerprint(a), sort_keys=True) == json.dumps(
        _state_fingerprint(b), sort_keys=True
    )


def _state_fingerprint(state: ChildLearningState) -> Dict[str, Any]:
    return {
        "child_id": state.child_id,
        "attempts_seen": state.attempts_seen,
        "assessment_attempts": state.assessment_attempts,
        "competencies": {
            code: signals.to_dict() for code, signals in sorted(state.competencies.items())
        },
        "patterns": {
            code: signals.to_dict() for code, signals in sorted(state.patterns.items())
        },
        "misconceptions": {
            code: {
                "hit_count": m.hit_count,
                "last_seq": m.last_seq,
                "resolved": m.resolved,
                "remediation_competency": m.remediation_competency,
            }
            for code, m in sorted(state.misconceptions.items())
        },
        "first_scaffold": dict(sorted(state.first_scaffold.items())),
    }
