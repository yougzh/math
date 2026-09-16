"""P2 API 端到端测试（httpx / TestClient）。

覆盖契约里的每一个端点：happy path + 关键错误路径，以及两条硬性不变量：
  - 任何下发 item 的响应都不含 answer / steps
  - 错误响应统一为 {"error": {"code","message"}}

数据库：复制一份"内容已导入"的模板库，每个用例一个干净副本。
"""
from __future__ import annotations

import os
import shutil
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.api.app import create_app
from backend.engine import detective as detective_engine
from tools import init_db

API_PREFIX = "/v1"


# ═══════════════════════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════════════════════
@pytest.fixture(scope="session")
def api_db_template(tmp_path_factory) -> str:
    from tools.content_cli import main as content_cli

    workdir = tmp_path_factory.mktemp("api-db-template")
    dump_path = str(workdir / "content_dump.json")
    assert content_cli.main(["dump", "--out", dump_path]) == 0
    path = str(workdir / "template.db")
    assert init_db.main(["--db-url", "sqlite:///" + path, "--dump", dump_path]) == 0
    return path


@pytest.fixture
def api_db(tmp_path, api_db_template) -> str:
    target = tmp_path / "api.db"
    shutil.copy(api_db_template, str(target))
    return str(target)


@pytest.fixture
def app(api_db, bundle, graph, cfg):
    return create_app(
        db_url="sqlite:///" + api_db, bundle=bundle, graph=graph, cfg=cfg
    )


@pytest.fixture
def client(app):
    with TestClient(app) as handle:
        yield handle


@pytest.fixture
def item_for(bundle):
    def _pick(competency: str = "make_ten"):
        items = [
            item for item in bundle.items.values() if item.competency_id == competency
        ]
        assert items, "内容里必须有 {} 的题".format(competency)
        return sorted(items, key=lambda i: (i.difficulty, i.code))[0]

    return _pick


def attempt_body(item, **overrides) -> dict:
    body = {
        "client_attempt_id": str(uuid4()),
        "child_id": 1,
        "item_code": item.code,
        "answer": item.answer,
        "hints_used": 0,
        "hint_level_max": 0,
        "telemetry": {
            "response_time_ms": 9000,
            "active_time_ms": 1500,
            "idle_time_ms": 0,
        },
    }
    body.update(overrides)
    return body


# ═══════════════════════════════════════════════════════════
# 通用不变量
# ═══════════════════════════════════════════════════════════
def assert_no_answer(payload: Any, path: str = "$"):
    if isinstance(payload, dict):
        for key, value in payload.items():
            assert key not in ("answer", "steps"), "{} 泄漏了 {}".format(path, key)
            assert_no_answer(value, "{}.{}".format(path, key))
    elif isinstance(payload, list):
        for index, value in enumerate(payload):
            assert_no_answer(value, "{}[{}]".format(path, index))


def assert_error_shape(response, status: int, code: str = None):
    assert response.status_code == status, response.text
    body = response.json()
    assert "error" in body and "code" in body["error"] and "message" in body["error"]
    if code:
        assert body["error"]["code"] == code


# ═══════════════════════════════════════════════════════════
# 1. 首页
# ═══════════════════════════════════════════════════════════
def test_world(client):
    response = client.get(API_PREFIX + "/world", params={"child_id": 1})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["child"] == {"id": 1, "name": "小明"}
    assert set(body["today"]) == {
        "headline",
        "subtitle",
        "story_code",
        "universe_code",
        "estimated_minutes",
        "completed",
    }
    assert isinstance(body["universes"], list) and body["universes"]
    universe = body["universes"][0]
    assert {"code", "name", "emoji", "unlocked", "progress", "stories"} <= set(universe)
    assert isinstance(body["lab_unlocked"], bool)
    assert isinstance(body["detective_unlocked"], bool)
    assert set(body["growth_summary"]) == {"materials", "buildings", "newest_badge"}
    assert set(body["growth_summary"]["materials"]) >= {"wood", "coin", "gem", "seed"}


def test_world_default_child_works_without_param(client):
    response = client.get(API_PREFIX + "/world")
    assert response.status_code == 200
    assert response.json()["child"]["id"] == 1


def test_world_unknown_child(client):
    assert_error_shape(
        client.get(API_PREFIX + "/world", params={"child_id": 999}),
        404,
        "CHILD_NOT_FOUND",
    )


# ═══════════════════════════════════════════════════════════
# 2. 会话
# ═══════════════════════════════════════════════════════════
def test_session_lifecycle(client):
    response = client.post(
        API_PREFIX + "/sessions",
        json={"child_id": 1, "planned_minutes": 12, "device": "web"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert isinstance(body["session_id"], int)
    assert body["started_at"].endswith("Z")

    ended = client.post(
        API_PREFIX + "/sessions/{}/end".format(body["session_id"]),
        json={"quit_reason": "completed"},
    )
    assert ended.status_code == 200
    assert ended.json() == {"ok": True}


def test_session_end_unknown_id(client):
    assert_error_shape(
        client.post(
            API_PREFIX + "/sessions/999/end", json={"quit_reason": "completed"}
        ),
        404,
        "SESSION_NOT_FOUND",
    )


def test_session_unknown_child(client):
    assert_error_shape(
        client.post(API_PREFIX + "/sessions", json={"child_id": 12345}),
        404,
        "CHILD_NOT_FOUND",
    )


# ═══════════════════════════════════════════════════════════
# 3. 今日计划
# ═══════════════════════════════════════════════════════════
def test_today_plan_shape(client):
    response = client.get(API_PREFIX + "/plans/today", params={"child_id": 1})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["child_id"] == 1
    assert 10 <= body["budget_minutes"] <= 15
    assert isinstance(body["intents"], list)
    for intent in body["intents"]:
        assert set(intent) == {"kind", "competency", "reason"}
    types = [segment["type"] for segment in body["segments"]]
    assert types == ["warmup", "core", "story", "thinking", "discovery"]
    for segment in body["segments"]:
        assert {
            "type",
            "budget_s",
            "intent_kinds",
            "slot_code",
            "scaffold_level",
            "items",
            "note",
        } <= set(segment)
        # 故事段的节拍映射（plan_payload 输出的扩展字段）
        for beat in segment.get("beats") or []:
            assert set(beat) == {"beat_code", "slot_code", "item_code"}
        for item in segment["items"]:
            assert set(item) == {
                "code",
                "competency",
                "pattern",
                "difficulty",
                "scaffold_level",
                "interaction_type",
                "estimated_seconds",
                "prompt",
                "problem",
                "answer_type",
                "choices",
                "hints_available",
            }
    assert isinstance(body["discovery"], str) and body["discovery"]
    assert isinstance(body["notes"], list)
    assert_no_answer(body)


def test_today_plan_uses_session_budget(client):
    created = client.post(
        API_PREFIX + "/sessions", json={"child_id": 1, "planned_minutes": 15}
    ).json()
    response = client.get(
        API_PREFIX + "/plans/today",
        params={"child_id": 1, "session_id": created["session_id"]},
    )
    assert response.status_code == 200
    assert response.json()["budget_minutes"] == 15


def test_today_plan_unknown_session(client):
    assert_error_shape(
        client.get(API_PREFIX + "/plans/today", params={"session_id": 999}),
        404,
        "SESSION_NOT_FOUND",
    )


# ═══════════════════════════════════════════════════════════
# 4. 提交作答
# ═══════════════════════════════════════════════════════════
def test_attempt_happy_path(client, item_for):
    item = item_for("make_ten")
    response = client.post(
        API_PREFIX + "/attempts",
        json=attempt_body(item, slot_code="core_make_ten_practice"),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["duplicate"] is False
    assert body["correct"] is True
    assert body["judgement_mismatch"] is False
    assert body["attempt_id"] == body["seq"]
    assert body["progress"]["competency"] == "make_ten"
    assert body["progress"]["level"] in (
        "encountering",
        "understanding",
        "can_do",
        "proficient",
        "automatic",
    )
    assert set(body["progress"]["signals"]) == {
        "mastery",
        "accuracy",
        "fluency",
        "independence",
        "transfer",
    }
    assert body["progress"]["sample_count"] == 1
    assert set(body["feedback"]) == {"tone", "text", "character"}
    assert body["feedback"]["tone"] in ("praise", "encourage", "repair")
    assert set(body["reward"]) == {"materials", "coins", "unlocks"}
    assert body["next"]["kind"] == "next_item"
    assert body["next"]["item"] is None or set(body["next"]["item"]) == {
        "code",
        "competency",
        "pattern",
        "difficulty",
        "scaffold_level",
        "interaction_type",
        "estimated_seconds",
        "prompt",
        "problem",
        "answer_type",
        "choices",
        "hints_available",
    }
    assert_no_answer(body)


def test_attempt_duplicate_returns_first_result(client, item_for):
    item = item_for("make_ten")
    body = attempt_body(item)
    first = client.post(API_PREFIX + "/attempts", json=body).json()
    second = client.post(API_PREFIX + "/attempts", json=body)
    assert second.status_code == 200
    payload = second.json()
    assert payload["duplicate"] is True
    assert payload["attempt_id"] == first["attempt_id"]
    assert payload["progress"] == first["progress"]
    assert payload["correct"] == first["correct"]

    debug = client.get(
        API_PREFIX + "/debug/learning-state", params={"child_id": 1}
    ).json()
    assert debug["attempts_seen"] == 1


def test_attempt_backend_judgement_wins(client, item_for):
    item = item_for("make_ten")
    body = attempt_body(item, answer=999, client_correct=True)
    response = client.post(API_PREFIX + "/attempts", json=body)
    assert response.status_code == 200
    payload = response.json()
    assert payload["correct"] is False
    assert payload["judgement_mismatch"] is True
    debug = client.get(
        API_PREFIX + "/debug/learning-state", params={"child_id": 1}
    ).json()
    assert debug["competencies"]["make_ten"]["accuracy"] == 0.0


def test_attempt_unknown_item(client):
    body = {
        "client_attempt_id": str(uuid4()),
        "child_id": 1,
        "item_code": "no_such_item",
        "answer": 1,
        "telemetry": {
            "response_time_ms": 5000,
            "active_time_ms": 1000,
            "idle_time_ms": 0,
        },
    }
    assert_error_shape(
        client.post(API_PREFIX + "/attempts", json=body), 404, "ITEM_NOT_FOUND"
    )


def test_attempt_unknown_child(client, item_for):
    item = item_for("make_ten")
    assert_error_shape(
        client.post(API_PREFIX + "/attempts", json=attempt_body(item, child_id=999)),
        404,
        "CHILD_NOT_FOUND",
    )


def test_attempt_unknown_session(client, item_for):
    item = item_for("make_ten")
    assert_error_shape(
        client.post(
            API_PREFIX + "/attempts", json=attempt_body(item, session_id=999)
        ),
        404,
        "SESSION_NOT_FOUND",
    )


def test_attempt_telemetry_inconsistent_is_400(client, item_for):
    item = item_for("make_ten")
    body = attempt_body(item)
    body["telemetry"] = {
        "response_time_ms": 1000,
        "active_time_ms": 5000,
        "idle_time_ms": 0,
    }
    assert_error_shape(
        client.post(API_PREFIX + "/attempts", json=body), 400, "INVALID_PARAM"
    )


def test_attempt_missing_client_attempt_id_is_400(client, item_for):
    item = item_for("make_ten")
    body = attempt_body(item)
    body.pop("client_attempt_id")
    assert_error_shape(
        client.post(API_PREFIX + "/attempts", json=body), 400, "INVALID_PARAM"
    )


def test_attempt_updates_session_counter(client, item_for):
    created = client.post(
        API_PREFIX + "/sessions", json={"child_id": 1, "planned_minutes": 12}
    ).json()
    item = item_for("make_ten")
    client.post(
        API_PREFIX + "/attempts",
        json=attempt_body(item, session_id=created["session_id"]),
    )
    # 通过家长报告之外的路径验证：会话结束不报错即可（计数在 debug 里不可见）
    ended = client.post(
        API_PREFIX + "/sessions/{}/end".format(created["session_id"]),
        json={"quit_reason": "completed"},
    )
    assert ended.status_code == 200


# ═══════════════════════════════════════════════════════════
# 5. 教练提示
# ═══════════════════════════════════════════════════════════
def test_coach_hint(client, item_for):
    item = item_for("make_ten")
    response = client.post(
        API_PREFIX + "/coach/hints",
        json={
            "child_id": 1,
            "item_code": item.code,
            "hints_used": 0,
            "last_answer": None,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {
        "hint_level",
        "hint_text",
        "source",
        "fallback_used",
        "exhausted",
    }
    assert body["source"] in ("rule", "llm", "fallback")
    assert body["hint_text"]
    assert isinstance(body["exhausted"], bool)


def test_coach_hint_exhausts_beyond_available(client, item_for):
    item = item_for("make_ten")
    response = client.post(
        API_PREFIX + "/coach/hints",
        json={
            "child_id": 1,
            "item_code": item.code,
            "hints_used": len(item.hint_chain) + 5,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["exhausted"] is True


def test_coach_hint_unknown_item(client):
    assert_error_shape(
        client.post(
            API_PREFIX + "/coach/hints",
            json={"child_id": 1, "item_code": "nope", "hints_used": 0},
        ),
        404,
        "ITEM_NOT_FOUND",
    )


# ═══════════════════════════════════════════════════════════
# 6. 故事
# ═══════════════════════════════════════════════════════════
def test_story_payload(client, bundle):
    assert bundle.stories, "内容里必须有故事（P2 由故事内容提供）"
    code = sorted(bundle.stories)[0]
    response = client.get(
        API_PREFIX + "/stories/{}".format(code), params={"child_id": 1}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) >= {
        "code",
        "universe",
        "title",
        "summary",
        "duration_min",
        "order_index",
        "beats",
    }
    for beat in body["beats"]:
        assert set(beat) == {
            "index",
            "sequence",
            "code",
            "type",
            "narration",
            "text",
            "character",
            "slot_code",
            "visual",
            "reward",
            "challenge",
        }
        # 契约字段与前端别名同源，必须一致
        assert beat["sequence"] == beat["index"]
        assert beat["text"] == beat["narration"]
        assert beat["type"] in ("narration", "challenge", "reward")
        if beat["type"] == "challenge":
            assert beat["challenge"] is not None
            challenge = beat["challenge"]
            assert set(challenge) == {
                "slot_code",
                "purpose",
                "scaffold_level",
                "item",
            }
            assert beat["slot_code"] == challenge["slot_code"]
            if challenge["item"] is not None:
                assert "answer" not in challenge["item"]
                assert "steps" not in challenge["item"]
    assert_no_answer(body)


def test_story_unknown_code(client):
    assert_error_shape(
        client.get(API_PREFIX + "/stories/not_a_story"), 404, "STORY_NOT_FOUND"
    )


def test_story_falls_back_to_memory_when_db_empty(tmp_path, bundle, graph, cfg):
    """DB 还没 init_db 时内容整体回退内存，故事端点必须同样可用。"""
    from backend.db import models
    from backend.db.base import Base
    from backend.db.session import create_db_engine, create_session_factory

    db_url = "sqlite:///" + str(tmp_path / "empty.db")
    engine = create_db_engine(db_url)
    Base.metadata.create_all(engine)
    with create_session_factory(engine)() as empty_session:
        empty_session.add(models.Child(name="小明"))
        empty_session.commit()
    engine.dispose()

    fallback_app = create_app(db_url=db_url, bundle=bundle, graph=graph, cfg=cfg)
    with TestClient(fallback_app) as handle:
        code = sorted(bundle.stories)[0]
        response = handle.get(
            API_PREFIX + "/stories/{}".format(code), params={"child_id": 1}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["code"] == code
        assert body["beats"]
        # 内存内容没有 visual_json，走默认插画描述
        assert body["beats"][0]["visual"]["kind"] == "station"
        assert_no_answer(body)


# ═══════════════════════════════════════════════════════════
# 7. 实验室
# ═══════════════════════════════════════════════════════════
def test_lab(client):
    response = client.get(API_PREFIX + "/lab", params={"child_id": 1})
    assert response.status_code == 200, response.text
    experiments = response.json()["experiments"]
    assert experiments
    for experiment in experiments:
        assert {"code", "name", "emoji", "description", "unlocked"} <= set(experiment)
        assert isinstance(experiment["unlocked"], bool)
    by_code = {row["code"]: row for row in experiments}
    # 无门槛的实验对新孩子开放；要求能力等级的实验对新孩子锁定
    assert by_code["blocks"]["unlocked"] is True
    assert by_code["make_ten"]["unlocked"] is True
    assert by_code["place_value_train"]["unlocked"] is False


def test_lab_unlocks_when_derived_level_rises(client, item_for):
    """解锁靠派生等级（ADR-0002），不是把 level 存进库里。"""
    item = item_for("place_value")
    for _ in range(6):  # >= min_samples_for_level，正确作答足以到 understanding
        response = client.post(API_PREFIX + "/attempts", json=attempt_body(item))
        assert response.status_code == 200, response.text

    experiments = client.get(API_PREFIX + "/lab", params={"child_id": 1}).json()[
        "experiments"
    ]
    by_code = {row["code"]: row for row in experiments}
    assert by_code["place_value_train"]["unlocked"] is True


# ═══════════════════════════════════════════════════════════
# 8. 侦探
# ═══════════════════════════════════════════════════════════
def test_detective_puzzle_and_answer(client):
    puzzle_response = client.get(
        API_PREFIX + "/detective/puzzle", params={"child_id": 1}
    )
    assert puzzle_response.status_code == 200, puzzle_response.text
    puzzle = puzzle_response.json()
    assert set(puzzle) == {
        "puzzle_id",
        "kind",
        "prompt",
        "clues",
        "candidates",
        "answer_type",
        "clues_remaining",
    }
    assert "answer" not in puzzle
    assert all(set(clue) == {"text", "revealed"} for clue in puzzle["clues"])

    # 测试里直接问引擎要真答案（API 永不下发）
    engine_puzzle = detective_engine.generate_puzzle(puzzle["puzzle_id"])
    correct = client.post(
        API_PREFIX + "/detective/answer",
        json={
            "child_id": 1,
            "puzzle_id": puzzle["puzzle_id"],
            "answer": engine_puzzle.answer,
            "client_attempt_id": str(uuid4()),
        },
    )
    assert correct.status_code == 200, correct.text
    body = correct.json()
    assert body["correct"] is True
    assert body["revealed_clues"] == []
    assert set(body["feedback"]) == {"tone", "text", "character"}
    assert set(body["reward"]) == {"materials", "coins", "unlocks"}

    wrong = client.post(
        API_PREFIX + "/detective/answer",
        json={
            "child_id": 1,
            "puzzle_id": puzzle["puzzle_id"],
            "answer": engine_puzzle.answer + 1,
        },
    )
    assert wrong.status_code == 200
    assert wrong.json()["correct"] is False
    assert isinstance(wrong.json()["revealed_clues"], list)


def test_detective_errors(client):
    assert_error_shape(
        client.get(API_PREFIX + "/detective/puzzle", params={"child_id": 999}),
        404,
        "CHILD_NOT_FOUND",
    )
    assert_error_shape(
        client.post(
            API_PREFIX + "/detective/answer",
            json={"child_id": 1, "puzzle_id": "xxx", "answer": 1},
        ),
        400,
        "PUZZLE_INVALID",
    )


# ═══════════════════════════════════════════════════════════
# 9. 成长
# ═══════════════════════════════════════════════════════════
def test_growth(client):
    response = client.get(API_PREFIX + "/growth", params={"child_id": 1})
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"tree", "materials", "buildings", "badges"}
    node = body["tree"]["nodes"][0]
    assert set(node) == {
        "code",
        "name",
        "level",
        "level_label",
        "mastered",
        "emoji",
        "unlocked",
        "position",
    }
    assert set(node["position"]) == {"x", "y"}
    assert body["tree"]["edges"] and set(body["tree"]["edges"][0]) == {"from", "to"}
    assert {"wood", "coin", "gem", "seed"} <= set(body["materials"])
    assert body["buildings"][0]["cost"]
    assert isinstance(body["badges"], list)


def test_growth_build_insufficient_materials(client):
    response = client.post(
        API_PREFIX + "/growth/build",
        json={"child_id": 1, "building_code": "platform"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["built"] is False
    assert body["reason"] == "材料不足"
    assert set(body["materials"]) >= {"wood", "coin"}


def test_growth_build_success(client, item_for):
    """先攒够材料（提交 attempt 会掉木材与金币），再建售票亭。"""
    item = item_for("make_ten")
    for _ in range(6):
        client.post(API_PREFIX + "/attempts", json=attempt_body(item))

    response = client.post(
        API_PREFIX + "/growth/build",
        json={"child_id": 1, "building_code": "ticket_booth"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["built"] is True
    assert set(body["materials"]) >= {"wood", "coin"}

    growth = client.get(API_PREFIX + "/growth", params={"child_id": 1}).json()
    booth = next(row for row in growth["buildings"] if row["code"] == "ticket_booth")
    assert booth["built"] is True


def test_growth_build_unknown_building(client):
    assert_error_shape(
        client.post(
            API_PREFIX + "/growth/build",
            json={"child_id": 1, "building_code": "nope"},
        ),
        404,
        "BUILDING_NOT_FOUND",
    )


# ═══════════════════════════════════════════════════════════
# 10. 家长报告
# ═══════════════════════════════════════════════════════════
def test_parent_report_empty(client):
    response = client.get(
        API_PREFIX + "/parent/report", params={"child_id": 1, "days": 7}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {
        "child",
        "range",
        "headline",
        "competencies",
        "weak_points",
        "misconceptions",
        "progress",
        "engagement",
        "advice",
        "disclaimer",
    }
    assert set(body["range"]) == {"days", "from", "to"}
    assert set(body["engagement"]) == {
        "sessions",
        "total_minutes",
        "avg_minutes_per_session",
        "next_day_return_rate",
        "story_completion_rate",
    }
    assert body["child"] == {"id": 1, "name": "小明"}


def test_parent_report_after_attempts(client, item_for):
    item = item_for("make_ten")
    for _ in range(8):
        client.post(API_PREFIX + "/attempts", json=attempt_body(item))

    body = client.get(
        API_PREFIX + "/parent/report", params={"child_id": 1, "days": 7}
    ).json()
    assert body["competencies"], "做过题之后应当有能力数据"
    entry = body["competencies"][0]
    assert set(entry) == {"code", "name", "level", "level_label", "score", "signals"}
    assert set(entry["signals"]) == {
        "mastery",
        "accuracy",
        "fluency",
        "independence",
        "transfer",
    }
    assert body["progress"], "等级推进应当产生 progress 事件"
    assert set(body["progress"][0]) == {"date", "level", "note"}
    assert body["advice"] and body["disclaimer"]


# ═══════════════════════════════════════════════════════════
# 11. 调试透视窗
# ═══════════════════════════════════════════════════════════
def test_debug_learning_state(client, item_for):
    empty = client.get(
        API_PREFIX + "/debug/learning-state", params={"child_id": 1}
    ).json()
    assert empty["attempts_seen"] == 0
    assert empty["competencies"] == {}

    item = item_for("make_ten")
    client.post(API_PREFIX + "/attempts", json=attempt_body(item))
    client.post(
        API_PREFIX + "/attempts",
        json=attempt_body(item, answer=999),
    )

    body = client.get(
        API_PREFIX + "/debug/learning-state", params={"child_id": 1}
    ).json()
    assert body["algorithm_version"] == 0
    assert body["attempts_seen"] == 2
    assert "make_ten" in body["competencies"]
    competency = body["competencies"]["make_ten"]
    assert set(competency) >= {
        "level",
        "level_label",
        "scaffold_level",
        "mastery",
        "accuracy",
        "fluency",
        "independence",
        "transfer",
        "confidence",
        "sample_count",
        "algorithm_version",
        "probe_status",
        "signal_sample_counts",
    }
    assert competency["sample_count"] == 2
    assert competency["algorithm_version"] == 0
    assert any(
        key.startswith("make_ten::") for key in body["patterns"]
    ), "pattern 状态的键必须带 competency"
    assert len(body["recent_attempts"]) == 2
    assert set(body["recent_attempts"][0]) >= {
        "attempt_id",
        "seq",
        "item_code",
        "competency",
        "correct",
        "thinking_time_ms",
    }
    assert isinstance(body["misconceptions"], list)


# ═══════════════════════════════════════════════════════════
# 12. 错误形状 / 未知路由
# ═══════════════════════════════════════════════════════════
def test_unknown_route_uses_error_shape(client):
    assert_error_shape(client.get(API_PREFIX + "/nope"), 404, "NOT_FOUND")


def test_internal_error_uses_error_shape(
    api_db, bundle, graph, cfg, item_for, monkeypatch
):
    """事务中途的未预期异常 → 统一 500 形状，且不留下半截数据。"""
    import backend.service.learning as learning_service

    def boom(*args, **kwargs):
        raise RuntimeError("注入的内部错误")

    monkeypatch.setattr(learning_service, "record_reward", boom)
    app = create_app(db_url="sqlite:///" + api_db, bundle=bundle, graph=graph, cfg=cfg)
    with TestClient(app, raise_server_exceptions=False) as handle:
        response = handle.post(API_PREFIX + "/attempts", json=attempt_body(item_for()))
    assert_error_shape(response, 500, "INTERNAL_ERROR")

    monkeypatch.undo()
    debug = TestClient(app).get(
        API_PREFIX + "/debug/learning-state", params={"child_id": 1}
    ).json()
    assert debug["attempts_seen"] == 0, "失败的事务不得留下 attempt"


def test_health(client):
    assert client.get("/health").json() == {"ok": True}


# ═══════════════════════════════════════════════════════════
# 13. ADR-0002：等级是派生值（同一份数据 + 不同配置 → 不同等级）
# ═══════════════════════════════════════════════════════════
def _stricter_config(cfg):
    import copy

    import yaml

    from backend.engine.config import AlgorithmConfig as Cfg
    from backend.paths import ALGORITHM_CONFIG_DIR

    with open(
        os.path.join(ALGORITHM_CONFIG_DIR, "v0.yaml"), "r", encoding="utf-8"
    ) as handle:
        raw = yaml.safe_load(handle)
    raw = copy.deepcopy(raw)
    raw["level_thresholds"]["understanding"] = {"mastery": 1.5, "accuracy": 1.5}
    raw["level_thresholds"]["can_do"] = {"mastery": 1.5}
    return Cfg(raw)


def test_level_is_derived_from_config_not_stored(api_db, bundle, graph, cfg, item_for):
    """同一个数据库、同一批 attempt，只换算法阈值 → debug 端点返回不同等级。

    这是 ADR-0002 的行为验证：level 没有存在任何一张表里，
    每次读的时候由 derive_level(signals, config) 现算。
    """
    url = "sqlite:///" + api_db
    item = item_for("make_ten")

    with TestClient(create_app(db_url=url, bundle=bundle, graph=graph, cfg=cfg)) as first:
        for _ in range(8):
            first.post(API_PREFIX + "/attempts", json=attempt_body(item))
        level_before = first.get(
            API_PREFIX + "/debug/learning-state", params={"child_id": 1}
        ).json()["competencies"]["make_ten"]["level"]

    stricter = _stricter_config(cfg)
    with TestClient(
        create_app(db_url=url, bundle=bundle, graph=graph, cfg=stricter)
    ) as second:
        payload = second.get(
            API_PREFIX + "/debug/learning-state", params={"child_id": 1}
        ).json()
        level_after = payload["competencies"]["make_ten"]["level"]
        # 信号没变（同一份数据），只有等级变了
        assert payload["competencies"]["make_ten"]["accuracy"] == 1.0

    assert level_before != level_after
    assert cfg.level_order.index(level_after) < cfg.level_order.index(level_before)
