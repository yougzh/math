"""数据库持久层。

- models：与 db/migrations/0001_init.sql 逐列对齐的 ORM 模型
- session：engine / sessionmaker 工厂（SQLite 开发，PG 生产）

本层只负责存取；学习状态的推进逻辑永远在 backend/engine 里（ADR-0004、
Replay 与在线更新共用同一段代码）。
"""
from __future__ import annotations

from backend.db.base import Base
from backend.db.session import (
    DEFAULT_DB_URL,
    create_db_engine,
    create_session_factory,
    database_url,
)

__all__ = [
    "Base",
    "DEFAULT_DB_URL",
    "create_db_engine",
    "create_session_factory",
    "database_url",
]
