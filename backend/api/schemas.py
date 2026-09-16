"""请求体模型（pydantic v2）。

只描述**请求**。响应一律用普通 dict 组装 —— 响应形状由契约文档与测试锁定，
多一层模型只会让"契约字段漂移"更难被发现。
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, model_validator


class TelemetryIn(BaseModel):
    response_time_ms: int = Field(ge=0)
    active_time_ms: int = Field(ge=0)
    idle_time_ms: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def _consistent(self):
        # ADR-0003：response = active + thinking + idle，三项必须自洽
        if self.active_time_ms + self.idle_time_ms > self.response_time_ms:
            raise ValueError("active_time_ms + idle_time_ms 不能大于 response_time_ms")
        return self


class SessionCreateIn(BaseModel):
    child_id: Optional[int] = None
    planned_minutes: Optional[int] = Field(default=None, ge=1, le=120)
    device: Optional[str] = None


class SessionEndIn(BaseModel):
    quit_reason: str = "completed"


class AttemptIn(BaseModel):
    client_attempt_id: str = Field(min_length=1, max_length=64)
    child_id: int
    item_code: str = Field(min_length=1)
    answer: Any
    session_id: Optional[int] = None
    slot_code: Optional[str] = None
    client_correct: Optional[bool] = None
    hints_used: int = Field(default=0, ge=0)
    hint_level_max: int = Field(default=0, ge=0)
    method_used: Optional[str] = None
    is_transfer_probe: bool = False
    is_assessment: bool = False
    telemetry: TelemetryIn


class HintIn(BaseModel):
    child_id: Optional[int] = None
    item_code: str = Field(min_length=1)
    hints_used: int = Field(default=0, ge=0)
    last_answer: Any = None


class DetectiveAnswerIn(BaseModel):
    child_id: Optional[int] = None
    puzzle_id: str = Field(min_length=1)
    answer: Any
    client_attempt_id: Optional[str] = None


class BuildIn(BaseModel):
    child_id: Optional[int] = None
    building_code: str = Field(min_length=1)


__all__ = [
    "TelemetryIn",
    "SessionCreateIn",
    "SessionEndIn",
    "AttemptIn",
    "HintIn",
    "DetectiveAnswerIn",
    "BuildIn",
]
