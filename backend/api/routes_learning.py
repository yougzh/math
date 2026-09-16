"""学习链路路由：会话 / 今日计划 / 提交作答 / 教练提示。

`POST /v1/attempts` 是学习系统唯一事实入口（ADR-0004），
本文件只做参数转换，事务与状态推进在 `backend.service.learning`。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query

from backend.api import deps
from backend.api.schemas import AttemptIn, HintIn, SessionCreateIn, SessionEndIn
from backend.coach.service import CoachService
from backend.content.loader import ContentBundle
from backend.db import models
from backend.engine.config import AlgorithmConfig
from backend.engine.graph import CompetencyGraph
from backend.engine.planner import build_daily_plan
from backend.engine.types import Telemetry
from backend.service import errors
from backend.service.content import item_payload
from backend.service.learning import (
    AttemptSubmission,
    iso_utc,
    load_state,
    submit_attempt,
)

router = APIRouter(prefix="/v1", tags=["learning"])


# ── 载荷组装 ───────────────────────────────────────────────
def plan_payload(plan, bundle: ContentBundle) -> Dict[str, Any]:
    return {
        "child_id": int(plan.child_id),
        "budget_minutes": plan.budget_minutes,
        "intents": [
            {
                "kind": intent.kind,
                "competency": intent.competency_id,
                "reason": intent.reason,
            }
            for intent in plan.intents
        ],
        "segments": [
            {
                "type": segment.type,
                "budget_s": segment.budget_s,
                "intent_kinds": [intent.kind for intent in segment.intents],
                "slot_code": segment.slot_code,
                "scaffold_level": segment.scaffold_level,
                "story_code": segment.story_code,
                "beats": [
                    {
                        "beat_code": beat.beat_code,
                        "slot_code": beat.slot_code,
                        "item_code": beat.item_code,
                    }
                    for beat in segment.beats
                ],
                "items": [item_payload(item) for item in segment.items],
                "note": segment.note,
            }
            for segment in plan.segments
        ],
        "discovery": plan.discovery,
        "notes": list(plan.notes),
    }


# ── 会话 ───────────────────────────────────────────────────
@router.post("/sessions")
def create_session(
    payload: SessionCreateIn,
    session=Depends(deps.get_session),
):
    child = deps.load_child(session, payload.child_id)
    row = models.LearningSession(
        child_id=child.id,
        started_at=datetime.utcnow(),
        planned_minutes=payload.planned_minutes,
        device=payload.device,
    )
    session.add(row)
    session.commit()
    return {"session_id": row.id, "started_at": iso_utc(row.started_at)}


@router.post("/sessions/{session_id}/end")
def end_session(
    session_id: int,
    payload: SessionEndIn,
    session=Depends(deps.get_session),
):
    row = (
        session.query(models.LearningSession)
        .filter(models.LearningSession.id == session_id)
        .one_or_none()
    )
    if row is None:
        raise errors.session_missing(session_id)
    now = datetime.utcnow()
    row.ended_at = now
    if row.started_at is not None:
        delta = now - row.started_at
        row.duration_ms = max(0, int(delta.total_seconds() * 1000))
    row.quit_reason = payload.quit_reason
    session.add(row)
    session.commit()
    return {"ok": True}


# ── 今日计划 ───────────────────────────────────────────────
@router.get("/plans/today")
def today_plan(
    child_id: Optional[int] = Query(default=None),
    session_id: Optional[int] = Query(default=None),
    session=Depends(deps.get_session),
    bundle: ContentBundle = Depends(deps.resolve_bundle),
    cfg: AlgorithmConfig = Depends(deps.get_cfg),
    graph: CompetencyGraph = Depends(deps.get_graph),
):
    child = deps.load_child(session, child_id)
    budget = None
    if session_id is not None:
        row = (
            session.query(models.LearningSession)
            .filter(models.LearningSession.id == session_id)
            .one_or_none()
        )
        if row is None:
            raise errors.session_missing(session_id)
        budget = row.planned_minutes
    state = load_state(session, child.id, bundle, cfg)
    plan = build_daily_plan(state, graph, bundle, cfg, budget_minutes=budget)
    return plan_payload(plan, bundle)


# ── 提交作答（唯一事实入口） ───────────────────────────────
@router.post("/attempts")
def post_attempt(
    payload: AttemptIn,
    session=Depends(deps.get_session),
    bundle: ContentBundle = Depends(deps.resolve_bundle),
    cfg: AlgorithmConfig = Depends(deps.get_cfg),
    coach: CoachService = Depends(deps.get_coach),
):
    submission = AttemptSubmission(
        client_attempt_id=payload.client_attempt_id,
        child_id=payload.child_id,
        item_code=payload.item_code,
        answer=payload.answer,
        telemetry=Telemetry(
            response_time_ms=payload.telemetry.response_time_ms,
            active_time_ms=payload.telemetry.active_time_ms,
            idle_time_ms=payload.telemetry.idle_time_ms,
        ),
        session_id=payload.session_id,
        slot_code=payload.slot_code,
        client_correct=payload.client_correct,
        hints_used=payload.hints_used,
        hint_level_max=payload.hint_level_max,
        method_used=payload.method_used,
        is_transfer_probe=payload.is_transfer_probe,
        is_assessment=payload.is_assessment,
    )
    return submit_attempt(session, bundle, cfg, coach, submission)


# ── 教练提示 ───────────────────────────────────────────────
@router.post("/coach/hints")
def coach_hint(
    payload: HintIn,
    session=Depends(deps.get_session),
    bundle: ContentBundle = Depends(deps.resolve_bundle),
    coach: CoachService = Depends(deps.get_coach),
):
    deps.load_child(session, payload.child_id)
    item = bundle.items.get(payload.item_code)
    if item is None:
        raise errors.item_missing(payload.item_code)
    # CoachMessage.to_hint_dict() 即契约 §5 的响应形状
    return coach.hint(item, payload.hints_used).to_hint_dict()


__all__ = ["router", "plan_payload"]
