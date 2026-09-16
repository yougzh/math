"""FastAPI 依赖：会话、内容、配置、教练。

所有依赖都从 `request.app.state` 取——app 由 `create_app()` 工厂构造，
测试可以注入临时数据库与假内容。
"""
from __future__ import annotations

from typing import Iterator, Optional

from fastapi import Depends, Request

from backend.coach.service import CoachService, default_service
from backend.content.loader import ContentBundle
from backend.db import models
from backend.engine.config import AlgorithmConfig
from backend.engine.graph import CompetencyGraph
from backend.service import errors


def get_session(request: Request) -> Iterator[object]:
    session = request.app.state.session_factory()
    try:
        yield session
    finally:
        session.close()


def resolve_bundle(
    request: Request, session=Depends(get_session)
) -> ContentBundle:
    """内容入口：数据库优先，表为空时回退内存内容（见 service.content）。"""
    return request.app.state.content.bundle(session)


def get_cfg(request: Request) -> AlgorithmConfig:
    return request.app.state.cfg


def get_graph(request: Request) -> CompetencyGraph:
    return request.app.state.graph


def get_coach(
    request: Request,
    bundle: ContentBundle = Depends(resolve_bundle),
) -> CoachService:
    coach = getattr(request.app.state, "coach", None)
    if coach is None:
        coach = default_service(bundle, request.app.state.graph)
        request.app.state.coach = coach
    return coach


def default_child(session) -> Optional[models.Child]:
    return session.query(models.Child).order_by(models.Child.id).first()


def load_child(session, child_id: Optional[int]) -> models.Child:
    """child_id 缺省时用默认孩子（MVP 不做账号体系，契约 §0）。"""
    if child_id is None:
        child = default_child(session)
        if child is None:
            raise errors.child_missing("default")
        return child
    child = session.query(models.Child).filter(models.Child.id == child_id).one_or_none()
    if child is None:
        raise errors.child_missing(child_id)
    return child


__all__ = [
    "get_session",
    "resolve_bundle",
    "get_cfg",
    "get_graph",
    "get_coach",
    "load_child",
    "default_child",
]
