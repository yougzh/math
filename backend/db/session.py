"""数据库连接与会话工厂。

- 生产目标：PostgreSQL（db/migrations/0001_init.sql 是参考 schema）
- 开发 / 测试：SQLite（默认 `sqlite:///<root>/build/math_world.db`，
  可用环境变量 `MATH_DB_URL` 覆盖）

SQLite 连接开启 `PRAGMA foreign_keys=ON`：让本地行为尽量贴近 PG，
否则"外键写错顺序"这类错误只会在生产暴露。
"""
from __future__ import annotations

import os
from typing import Optional

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.paths import ROOT

DEFAULT_DB_PATH = os.path.join(ROOT, "build", "math_world.db")
DEFAULT_DB_URL = "sqlite:///" + DEFAULT_DB_PATH


def database_url(url: Optional[str] = None) -> str:
    if url:
        return url
    return os.environ.get("MATH_DB_URL") or DEFAULT_DB_URL


def create_db_engine(url: Optional[str] = None) -> Engine:
    target = database_url(url)
    kwargs = {}
    if target.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
        if ":memory:" in target or target in ("sqlite://", "sqlite:///"):
            kwargs["poolclass"] = StaticPool
    engine = create_engine(target, future=True, **kwargs)

    if target.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _enable_foreign_keys(dbapi_connection, _record):  # pragma: no cover
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine


def create_session_factory(engine: Engine) -> sessionmaker:
    return sessionmaker(bind=engine, future=True, expire_on_commit=False)


__all__ = [
    "DEFAULT_DB_URL",
    "DEFAULT_DB_PATH",
    "database_url",
    "create_db_engine",
    "create_session_factory",
]
