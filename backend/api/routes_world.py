"""世界 / 故事 / 实验室 / 侦探 / 成长 / 家长端 / 调试路由。"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query, Request

from backend.api import deps
from backend.api.schemas import BuildIn, DetectiveAnswerIn
from backend.content.loader import ContentBundle
from backend.db import models
from backend.engine import detective as detective_engine
from backend.engine.config import AlgorithmConfig
from backend.engine.graph import CompetencyGraph
from backend.engine.state_machine import derive_level
from backend.engine.types import Signals, split_pattern_key
from backend.service import errors
from backend.service.growth import (
    BUILDINGS,
    build_payload,
    growth_payload,
    lab_payload,
    world_payload,
)
from backend.service.learning import load_state
from backend.service.report import report_payload

router = APIRouter(prefix="/v1", tags=["world"])


def _state(session, child, bundle, cfg):
    return load_state(session, child.id, bundle, cfg)


# ── 首页 ───────────────────────────────────────────────────
@router.get("/world")
def get_world(
    child_id: Optional[int] = Query(default=None),
    session=Depends(deps.get_session),
    bundle: ContentBundle = Depends(deps.resolve_bundle),
    cfg: AlgorithmConfig = Depends(deps.get_cfg),
):
    child = deps.load_child(session, child_id)
    state = _state(session, child, bundle, cfg)
    budget = int(cfg.daily_plan().get("budget_minutes", 12))
    return world_payload(session, child, state, cfg, bundle, budget)


# ── 故事 ───────────────────────────────────────────────────
@router.get("/stories/{story_code}")
def get_story(
    story_code: str,
    request: Request,
    child_id: Optional[int] = Query(default=None),
    session=Depends(deps.get_session),
    bundle: ContentBundle = Depends(deps.resolve_bundle),
    cfg: AlgorithmConfig = Depends(deps.get_cfg),
):
    child = deps.load_child(session, child_id)
    state = _state(session, child, bundle, cfg)
    payload = request.app.state.content.story_payload(
        session, story_code, state, cfg
    )
    if payload is None:
        raise errors.story_missing(story_code)
    return payload


# ── 实验室 ─────────────────────────────────────────────────
@router.get("/lab")
def get_lab(
    child_id: Optional[int] = Query(default=None),
    session=Depends(deps.get_session),
    bundle: ContentBundle = Depends(deps.resolve_bundle),
    cfg: AlgorithmConfig = Depends(deps.get_cfg),
):
    child = deps.load_child(session, child_id)
    state = _state(session, child, bundle, cfg)
    return lab_payload(state, cfg)


# ── 侦探 ───────────────────────────────────────────────────
@router.get("/detective/puzzle")
def detective_puzzle(
    child_id: Optional[int] = Query(default=None),
    session=Depends(deps.get_session),
):
    child = deps.load_child(session, child_id)
    count = (
        session.query(models.Attempt)
        .filter(models.Attempt.child_id == child.id)
        .count()
    )
    puzzle_id = detective_engine.make_puzzle_id(child.id * 1000 + count)
    try:
        puzzle = detective_engine.generate_puzzle(puzzle_id)
    except ValueError as exc:
        raise errors.bad_request(str(exc), code="PUZZLE_INVALID")
    return puzzle.to_dict()


@router.post("/detective/answer")
def detective_answer(
    payload: DetectiveAnswerIn,
    session=Depends(deps.get_session),
):
    deps.load_child(session, payload.child_id)
    try:
        puzzle = detective_engine.generate_puzzle(payload.puzzle_id)
    except ValueError as exc:
        raise errors.bad_request(str(exc), code="PUZZLE_INVALID")
    correct = detective_engine.judge(puzzle, payload.answer)
    revealed = detective_engine.reveal_after_attempt(puzzle, correct)
    feedback = (
        {
            "tone": "praise",
            "text": "推理得真漂亮，线索全被你用上了！",
            "character": "小助手",
        }
        if correct
        else {
            "tone": "repair",
            "text": "再想想，还有线索没有用上哦。",
            "character": "小助手",
        }
    )
    # 侦探答题不写学习状态：不进 attempt/熟练度/复习调度（ADR-0005）。
    # 契约 §7 的实验室同款语义 —— 不是所有答题都是 attempt。
    return {
        "correct": correct,
        "feedback": feedback,
        "revealed_clues": revealed,
        "reward": {"materials": [], "coins": 0, "unlocks": []},
    }


# ── 成长 ───────────────────────────────────────────────────
@router.get("/growth")
def get_growth(
    child_id: Optional[int] = Query(default=None),
    session=Depends(deps.get_session),
    bundle: ContentBundle = Depends(deps.resolve_bundle),
    cfg: AlgorithmConfig = Depends(deps.get_cfg),
    graph: CompetencyGraph = Depends(deps.get_graph),
):
    child = deps.load_child(session, child_id)
    state = _state(session, child, bundle, cfg)
    return growth_payload(session, child, state, cfg, bundle, graph)


@router.post("/growth/build")
def post_growth_build(
    payload: BuildIn,
    session=Depends(deps.get_session),
):
    child = deps.load_child(session, payload.child_id)
    building = next(
        (row for row in BUILDINGS if row["code"] == payload.building_code), None
    )
    if building is None:
        raise errors.not_found(
            "BUILDING_NOT_FOUND", "建筑 {} 不存在".format(payload.building_code)
        )
    result = build_payload(session, child.id, building)
    session.commit()
    return result


# ── 家长端 ─────────────────────────────────────────────────
@router.get("/parent/report")
def parent_report(
    child_id: Optional[int] = Query(default=None),
    days: int = Query(default=7, ge=1, le=90),
    session=Depends(deps.get_session),
    bundle: ContentBundle = Depends(deps.resolve_bundle),
    cfg: AlgorithmConfig = Depends(deps.get_cfg),
    graph: CompetencyGraph = Depends(deps.get_graph),
):
    child = deps.load_child(session, child_id)
    state = _state(session, child, bundle, cfg)
    return report_payload(session, child, state, cfg, bundle, graph, days)


# ── 调试透视窗（仅开发环境） ───────────────────────────────
@router.get("/debug/learning-state")
def debug_learning_state(
    child_id: Optional[int] = Query(default=None),
    session=Depends(deps.get_session),
    bundle: ContentBundle = Depends(deps.resolve_bundle),
    cfg: AlgorithmConfig = Depends(deps.get_cfg),
):
    child = deps.load_child(session, child_id)
    state = _state(session, child, bundle, cfg)

    def signals_payload(signals: Signals) -> Dict[str, Any]:
        level = derive_level(signals, cfg)
        return {
            "level": level,
            "level_label": cfg.level_label(level),
            "scaffold_level": cfg.scaffold_for_mastery(signals.mastery),
            "mastery": signals.mastery,
            "accuracy": signals.accuracy,
            "fluency": signals.fluency,
            "independence": signals.independence,
            "transfer": signals.transfer,
            "confidence": signals.confidence,
            "sample_count": signals.sample_count,
            "assessment_samples": signals.assessment_samples,
            "signal_sample_counts": dict(signals.signal_sample_counts),
            "probe_status": signals.probe_status,
            "algorithm_version": signals.algorithm_version,
        }

    recent = [
        {
            "attempt_id": attempt.attempt_id,
            "seq": attempt.seq,
            "item_code": attempt.item_id,
            "competency": attempt.competency_id,
            "pattern": attempt.pattern_id,
            "correct": attempt.correct,
            "hints_used": attempt.hints_used,
            "thinking_time_ms": attempt.telemetry.thinking_time_ms,
            "scaffold_level": attempt.scaffold_level,
            "created_at": attempt.created_at,
        }
        for attempt in state.recent_attempts[-10:]
    ]

    return {
        "child_id": child.id,
        "child_name": child.name,
        "algorithm_version": cfg.version,
        "attempts_seen": state.attempts_seen,
        "assessment_attempts": state.assessment_attempts,
        "competencies": {
            code: signals_payload(signals)
            for code, signals in sorted(state.competencies.items())
        },
        "patterns": {
            key: dict(
                signals_payload(signals),
                competency=split_pattern_key(key)[0],
                pattern=split_pattern_key(key)[1],
            )
            for key, signals in sorted(state.patterns.items())
        },
        "misconceptions": [
            {
                "code": code,
                "hit_count": misc.hit_count,
                "last_seq": misc.last_seq,
                "resolved": misc.resolved,
                "remediation_competency": misc.remediation_competency,
            }
            for code, misc in sorted(state.misconceptions.items())
        ],
        "recent_attempts": recent,
        "first_scaffold": dict(state.first_scaffold),
        "last_touched_seq": dict(state.last_touched_seq),
    }


__all__ = ["router"]
