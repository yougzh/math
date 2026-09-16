"""FastAPI 应用工厂。

    from backend.api.app import create_app
    app = create_app()                      # 用 MATH_DB_URL 或默认 SQLite
    app = create_app(db_url="sqlite:///tmp/test.db", bundle=bundle, cfg=cfg)

所有外部依赖（数据库、内容、算法配置、教练）都通过参数注入，测试可以
给每个用例一份干净的临时库与假内容。

统一错误形状（契约 §12）：

    { "error": { "code": "ITEM_NOT_FOUND", "message": "..." } }
"""
from __future__ import annotations

import logging
import os
from typing import Any, List, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.api import routes_learning, routes_world
from backend.coach.service import CoachService
from backend.content.loader import ContentBundle, load_bundle
from backend.db.session import create_db_engine, create_session_factory
from backend.engine.config import AlgorithmConfig, load_config
from backend.engine.graph import CompetencyGraph
from backend.service import errors
from backend.service.content import ContentService

logger = logging.getLogger("math_world.api")

DEFAULT_CORS_ORIGIN = "http://localhost:3000"


def _cors_origins() -> List[str]:
    """允许的跨域来源：环境变量 MATH_CORS_ORIGINS（逗号分隔）。

    缺省只放行前端 dev server。上线时通过环境变量配置正式域名；
    不支持通配 "*" —— 通配来源无法与凭据共存，也会把内网里的
    任何页面都变成可信调用方。
    """
    raw = os.environ.get("MATH_CORS_ORIGINS", DEFAULT_CORS_ORIGIN)
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or [DEFAULT_CORS_ORIGIN]


def create_app(
    db_url: Optional[str] = None,
    bundle: Optional[ContentBundle] = None,
    graph: Optional[CompetencyGraph] = None,
    cfg: Optional[AlgorithmConfig] = None,
    coach: Optional[CoachService] = None,
    engine: Any = None,
) -> FastAPI:
    app = FastAPI(title="数学世界 API", version="1.0.0")

    # 来源清单来自 MATH_CORS_ORIGINS（显式列表，见 _cors_origins）。
    # 显式列表下允许携带凭据是安全的；若将来引入通配来源，必须同时把
    # allow_credentials 关回 False（CORS 规范禁止 "*" 与凭据同用）。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    db_engine = engine or create_db_engine(db_url)
    app.state.db_engine = db_engine
    app.state.session_factory = create_session_factory(db_engine)
    app.state.cfg = cfg or load_config(0)
    app.state.content = ContentService(memory_bundle=bundle)
    app.state.graph = graph or CompetencyGraph(bundle or load_bundle())
    app.state.coach = coach

    # ── 统一错误形状 ─────────────────────────────────────
    @app.exception_handler(errors.ApiError)
    async def _api_error_handler(_request: Request, exc: errors.ApiError):
        return JSONResponse(status_code=exc.status_code, content=exc.to_dict())

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(_request: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        location = ".".join(str(part) for part in first.get("loc", []))
        message = "请求参数不合法: {}{}".format(
            location, ": " + str(first.get("msg")) if first.get("msg") else ""
        )
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "INVALID_PARAM", "message": message}},
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_handler(_request: Request, exc: StarletteHTTPException):
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(
            exc.status_code, "HTTP_ERROR"
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": code, "message": str(exc.detail)}},
        )

    @app.exception_handler(Exception)
    async def _unhandled_handler(_request: Request, exc: Exception):
        logger.exception("未处理异常", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "服务端错误，请稍后重试",
                }
            },
        )

    app.include_router(routes_learning.router)
    app.include_router(routes_world.router)

    @app.get("/health", tags=["ops"])
    def health():
        return {"ok": True}

    return app


__all__ = ["create_app"]
