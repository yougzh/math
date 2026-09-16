"""SQLAlchemy 声明基类与可移植类型别名。

可移植性原则（SQLite 开发 / PostgreSQL 生产）：
  - 不用 JSONB / ARRAY / UUID 等 PG 专有类型
  - 不用 server_default 表达式：PG 与 SQLite 的表达式语义不同，
    默认值一律由应用层或 Python 端 default 提供
  - BIGSERIAL 用 BigInteger + sqlite variant：SQLite 只对
    INTEGER PRIMARY KEY 自增，直接写 BigInteger 会失去自增能力
"""
from __future__ import annotations

from sqlalchemy import BigInteger, Integer
from sqlalchemy.orm import DeclarativeBase

# BIGINT（PG）/ INTEGER（SQLite）；两处都用它，保证两端都能自增
BigInt = BigInteger().with_variant(Integer, "sqlite")


class Base(DeclarativeBase):
    pass


__all__ = ["Base", "BigInt"]
