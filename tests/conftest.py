"""测试共享夹具。"""
from __future__ import annotations

from typing import Optional

import pytest

from backend.content.loader import ContentBundle, Item, load_bundle
from backend.engine.config import AlgorithmConfig, load_config
from backend.engine.graph import CompetencyGraph
from backend.engine.types import Attempt, Telemetry


@pytest.fixture(scope="session")
def bundle() -> ContentBundle:
    return load_bundle()


@pytest.fixture(scope="session")
def cfg() -> AlgorithmConfig:
    return load_config(0)


@pytest.fixture(scope="session")
def graph(bundle: ContentBundle) -> CompetencyGraph:
    return CompetencyGraph(bundle)


@pytest.fixture
def make_attempt():
    """构造一次作答的工厂。"""

    def _make(
        seq: int,
        item: Item,
        correct: bool = True,
        hints_used: int = 0,
        thinking_ms: int = 5000,
        active_ms: int = 1000,
        idle_ms: int = 0,
        is_assessment: bool = False,
        is_transfer_probe: bool = False,
        submitted_answer: Optional[object] = None,
        child_id: str = "test_child",
    ) -> Attempt:
        return Attempt(
            attempt_id="att_{:03d}".format(seq),
            child_id=child_id,
            item_id=item.code,
            competency_id=item.competency_id,
            pattern_id=item.pattern_id,
            correct=correct,
            telemetry=Telemetry(
                response_time_ms=thinking_ms + active_ms + idle_ms,
                active_time_ms=active_ms,
                idle_time_ms=idle_ms,
            ),
            seq=seq,
            hints_used=hints_used,
            hint_level_max=hints_used,
            scaffold_level=item.scaffold_level,
            interaction_type=item.interaction_type,
            is_assessment=is_assessment,
            is_transfer_probe=is_transfer_probe,
            submitted_answer=submitted_answer if submitted_answer is not None else item.answer,
        )

    return _make
