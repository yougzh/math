"""学习意图层。

这是学习决策链的第 2 环，也是整个系统"大脑"的关键一层：

    Child State → **Learning Intent** → Daily Plan → Story → Challenge Slot → Item

**Planner 不应该直接选题目。**

反例（禁止）：❌ 今天做 item_102
正例：         ✅ 今天 1) 强化 make_ten fluency  2) 复习 place_value  3) 测试 transfer

先定意图再落题目，好处：
  - 规划策略与题目细节解耦，可复用、可解释、可回放
  - 同一条意图可以在不同故事、不同槽位里被实现
"""
from __future__ import annotations

from typing import List, Optional

from backend.content.loader import ContentBundle
from backend.engine.config import AlgorithmConfig
from backend.engine.graph import CompetencyGraph
from backend.engine.state_machine import fallback_decision, next_competency
from backend.engine.types import ChildLearningState, LearningIntent, Signals, pattern_key

PRIORITY_WARMUP = 0
PRIORITY_REPAIR = 10
PRIORITY_TEACH = 20


def _competency_signals(state: ChildLearningState, code: str) -> Signals:
    return state.competencies.get(code) or Signals()


def _warmup_target(
    state: ChildLearningState,
    graph: CompetencyGraph,
    cfg: AlgorithmConfig,
    exclude: Optional[str] = None,
) -> Optional[str]:
    """热身选"已经会、但还没完全自动化"的能力 —— 目的是召回，不是教学。

    必须排除当前聚焦能力：否则会出现"热身练的就是今天要学的东西"。
    """
    intent_cfg = cfg.intent_config()
    min_mastery = float(intent_cfg.get("warmup_min_mastery", 0.6))
    max_samples = int(intent_cfg.get("warmup_max_samples", 12))

    candidates = []
    for code in graph.topological_order():
        if code == exclude:
            continue
        signals = state.competencies.get(code)
        if signals is None or signals.mastery is None:
            continue
        if signals.mastery < min_mastery:
            continue
        if signals.sample_count > max_samples:
            continue  # 已经自动化，不需要热身
        candidates.append((signals.sample_count, signals.mastery, code))

    if not candidates:
        return None
    # 样本最少的最需要召回
    candidates.sort(key=lambda row: (row[0], -row[1], row[2]))
    return candidates[0][2]


def _untried_patterns(
    state: ChildLearningState,
    competency_id: str,
    graph: CompetencyGraph,
) -> List[str]:
    return sorted(
        p.code
        for p in graph.patterns_for(competency_id)
        if pattern_key(competency_id, p.code) not in state.patterns
    )


def derive_intents(
    state: ChildLearningState,
    graph: CompetencyGraph,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
) -> List[LearningIntent]:
    intents: List[LearningIntent] = []

    # 2) 主目标能力（先算出来，热身要排除它）
    target = next_competency(state, graph, cfg)
    # 1) 热身：召回旧知识
    warmup_code = _warmup_target(state, graph, cfg, exclude=target)
    if warmup_code:
        intents.append(
            LearningIntent(
                kind="warmup",
                competency_id=warmup_code,
                reason="召回已会但尚未自动化的能力",
                priority=PRIORITY_WARMUP,
                target_seconds=cfg.intent_config().get("warmup_item_count", 2) * 10,
            )
        )

    if target is None:
        return intents

    signals = _competency_signals(state, target)

    # 2a) 需要回退时，回退意图优先于一切教学意图
    fallback = fallback_decision(state, target, graph, cfg)
    if fallback.action == "fallback" and fallback.target_competency_id:
        intents.append(
            LearningIntent(
                kind="repair",
                competency_id=fallback.target_competency_id,
                reason="；".join(fallback.reasons),
                priority=PRIORITY_REPAIR,
                scaffold_level=cfg.scaffold_for_mastery(
                    _competency_signals(state, fallback.target_competency_id).mastery
                ),
            )
        )
        # 修复期间不推进新内容

    scaffold = cfg.scaffold_for_mastery(signals.mastery)

    # 2b) 迁移测试：熟练度够高，但还有没试过的问题结构
    intent_cfg = cfg.intent_config()
    probe_mastery = float(intent_cfg.get("probe_transfer_mastery", 0.6))
    untried = _untried_patterns(state, target, graph)
    if (
        fallback.action != "fallback"
        and signals.mastery is not None
        and signals.mastery >= probe_mastery
        and untried
        and signals.sample_count_for("transfer") == 0
    ):
        intents.append(
            LearningIntent(
                kind="probe_transfer",
                competency_id=target,
                reason="熟练度已达标但迁移能力尚无证据，换一种问题结构验证",
                pattern_id=untried[0],
                scaffold_level=scaffold,
                priority=PRIORITY_TEACH,
                target_seconds=25,
            )
        )

    # 2c) 流畅度专项：会做但慢 —— 本产品的核心痛点
    fluency_target = float(cfg.upgrade_requires().get("fluency", 0.6))
    strengthen_ratio = float(intent_cfg.get("strengthen_fluency_ratio", 0.8))
    if (
        signals.fluency is not None
        and signals.fluency < fluency_target * strengthen_ratio
        and (signals.mastery or 0) >= 0.5
    ):
        intents.append(
            LearningIntent(
                kind="strengthen_fluency",
                competency_id=target,
                reason="已经理解，但还不够流畅（会，但是慢）",
                scaffold_level=scaffold,
                priority=PRIORITY_TEACH,
                target_seconds=20,
            )
        )

    # 2d) 默认：继续教 / 继续练。
    # 与 strengthen_fluency / probe_transfer **并存**，不是二选一 ——
    # 一次会话既要练核心，也要有迁移测试（分别落在 core 段和 thinking 段）。
    if fallback.action != "fallback":
        intents.append(
            LearningIntent(
                kind="teach",
                competency_id=target,
                reason="当前聚焦能力尚未达标",
                scaffold_level=scaffold,
                priority=PRIORITY_TEACH,
            )
        )

    return sorted(intents, key=lambda i: (i.priority, i.kind))


def describe_intents(intents: List[LearningIntent]) -> List[str]:
    """给人看的意图清单 —— 这是 Planner 决策可解释性的落点。"""
    return [
        "{}. [{}] {} ← {}".format(idx + 1, i.kind, i.competency_id, i.reason)
        for idx, i in enumerate(intents)
    ]
