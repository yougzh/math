"""api-contract 对拍的 Python 侧 dump。

用 FastAPI TestClient 对 create_app() 打一组**确定性**场景，把每个请求的
method/path/query/body/status/body_json 记进 tests/fixtures/api_parity.json；
TS 侧（tests/acceptance/api-parity.test.ts）在独立数据库上重放同一组场景，
逐条比对 status 与响应体。

确定性约定（两侧都必须遵守）：
  - 独立数据库：由 MATH_DB_URL 指定（脚本会建库、建表、导入内容 dump）；
  - 场景序列固定；story_code / item_code / puzzle_id 从**前序响应**动态提取
    （两侧内容同源、选择器确定性同构 → 提取结果一致）；
  - 提交答案用固定字符串 "0"（判定结果两侧一致即可，对错本身不是对拍点）；
  - 响应中的 ISO 时间戳（两边各自 now() 产生）归一化为 "<ISO>" 后再入库。

用法：
    MATH_DB_URL=postgresql://postgres@127.0.0.1:5432/db_math_api_py \
        python3 -m tools.api_contract_dump
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional

import psycopg2
import yaml  # noqa: F401  (fastapi 依赖链自带；import 以防有人裁剪环境)
from fastapi.testclient import TestClient

from backend.api.app import create_app

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "api_parity.json")

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$")

ATTEMPT_ID_1 = "11111111-1111-4111-8111-111111111111"
ATTEMPT_ID_2 = "22222222-2222-4222-8222-222222222222"


def _db_url() -> str:
    url = os.environ.get("MATH_DB_URL", "").strip()
    if not url:
        print("MATH_DB_URL 未设置（需要指向一个**专用**对拍库，如 db_math_api_py）", file=sys.stderr)
        sys.exit(2)
    return url


def recreate_database(url: str) -> None:
    """DROP + CREATE：对拍基线必须从干净库开始（两侧 setup 同一策略）。"""
    parsed = urlparse_db(url)
    admin = psycopg2.connect(
        host=parsed["host"], port=parsed["port"], dbname="postgres",
        user=parsed["user"], password=parsed["password"],
    )
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (parsed["dbname"],),
            )
            cur.execute('DROP DATABASE IF EXISTS "{}"'.format(parsed["dbname"]))
            cur.execute('CREATE DATABASE "{}"'.format(parsed["dbname"]))
        print("已重建数据库 {}".format(parsed["dbname"]))
    finally:
        admin.close()


def urlparse_db(url: str) -> Dict[str, Any]:
    # postgresql://user:password@host:port/dbname
    from urllib.parse import urlparse, unquote

    parsed = urlparse(url)
    return {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 5432,
        "dbname": parsed.path.lstrip("/"),
        "user": unquote(parsed.username or "postgres"),
        "password": unquote(parsed.password or ""),
    }


def import_content(url: str) -> None:
    """建表 + 导入内容 dump（与 TS 侧 scripts/init-db.ts 的输入同源）。"""
    subprocess.run(
        [sys.executable, "-m", "tools.init_db", "--db-url", url],
        check=True,
        cwd=os.path.join(os.path.dirname(__file__), ".."),
    )


def normalize(value: Any) -> Any:
    """递归把 ISO 时间戳字符串替换为 "<ISO>"（两边各自 now() 产生的字段）。"""
    if isinstance(value, str):
        return "<ISO>" if ISO_RE.match(value) else value
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items()}
    return value


class Scenario:
    """按序执行请求；支持从前序响应提取值。"""

    def __init__(self, client: TestClient):
        self.client = client
        self.records: List[Dict[str, Any]] = []
        self.child_id: Optional[int] = None
        self.story_code: Optional[str] = None
        self.item_code: Optional[str] = None
        self.puzzle_id: Optional[str] = None
        self.session_id: Optional[int] = None

    def request(self, name: str, method: str, path: str, query: Optional[Dict[str, str]] = None,
                json_body: Any = None) -> Dict[str, Any]:
        response = self.client.request(
            method, path, params=query or {}, json=json_body if json_body is not None else None
        )
        try:
            body = response.json()
        except ValueError:
            body = None
        self.records.append(
            {
                "name": name,
                "method": method,
                "path": path,
                "query": query or {},
                "body": normalize(json_body),
                "status": response.status_code,
                "response": normalize(body),
            }
        )
        return body or {}

    def run(self) -> None:
        self.request("health", "GET", "/health")

        # ── 世界 ──
        world = self.request("world", "GET", "/v1/world")
        self.child_id = world.get("child", {}).get("id")
        for universe in world.get("universes", []):
            if universe.get("stories"):
                self.story_code = universe["stories"][0]["code"]
                break

        self.request("world_child_missing", "GET", "/v1/world", {"child_id": "999"})
        if self.story_code:
            self.request("story", "GET", "/v1/stories/{}".format(self.story_code))
        self.request("story_missing", "GET", "/v1/stories/__no_such_story__")
        self.request("lab", "GET", "/v1/lab")
        self.request("growth", "GET", "/v1/growth")
        self.request("parent_report", "GET", "/v1/parent/report")
        self.request("parent_report_bad_days", "GET", "/v1/parent/report", {"days": "0"})

        # ── 计划 / 会话 ──
        plan = self.request("plans_today", "GET", "/v1/plans/today")
        for segment in plan.get("segments", []):
            if segment.get("items"):
                self.item_code = segment["items"][0]["code"]
                break

        session = self.request(
            "session_create", "POST", "/v1/sessions",
            json_body={"planned_minutes": 15, "device": "parity"},
        )
        self.session_id = session.get("session_id")
        if self.session_id is not None:
            self.request(
                "session_end", "POST", "/v1/sessions/{}/end".format(self.session_id),
                json_body={"quit_reason": "parity"},
            )
        self.request("session_end_missing", "POST", "/v1/sessions/999999/end", json_body={})
        if self.session_id is not None:
            self.request(
                "plans_today_with_session", "GET", "/v1/plans/today",
                {"session_id": str(self.session_id)},
            )

        # ── 提交作答（唯一事实入口）──
        if self.item_code and self.child_id is not None:
            attempt_payload = {
                "client_attempt_id": ATTEMPT_ID_1,
                "child_id": self.child_id,
                "item_code": self.item_code,
                "answer": "0",
                "telemetry": {"response_time_ms": 5000, "active_time_ms": 3000, "idle_time_ms": 500},
                "hints_used": 0,
            }
            self.request("attempt_create", "POST", "/v1/attempts", json_body=attempt_payload)
            self.request("attempt_duplicate", "POST", "/v1/attempts", json_body=attempt_payload)
            second = dict(attempt_payload, client_attempt_id=ATTEMPT_ID_2)
            self.request("attempt_second", "POST", "/v1/attempts", json_body=second)
        self.request(
            "attempt_item_missing", "POST", "/v1/attempts",
            json_body={
                "client_attempt_id": "33333333-3333-4333-8333-333333333333",
                "child_id": self.child_id if self.child_id is not None else 1,
                "item_code": "__no_such_item__",
                "answer": "0",
                "telemetry": {"response_time_ms": 5000, "active_time_ms": 3000, "idle_time_ms": 500},
            },
        )
        self.request(
            "attempt_telemetry_inconsistent", "POST", "/v1/attempts",
            json_body={
                "client_attempt_id": "44444444-4444-4444-8444-444444444444",
                "child_id": self.child_id if self.child_id is not None else 1,
                "item_code": self.item_code or "x",
                "answer": "0",
                "telemetry": {"response_time_ms": 5000, "active_time_ms": 4000, "idle_time_ms": 2000},
            },
        )

        # ── 教练 ──
        if self.item_code:
            self.request(
                "coach_hint", "POST", "/v1/coach/hints",
                json_body={"item_code": self.item_code, "hints_used": 1},
            )
        self.request(
            "coach_hint_item_missing", "POST", "/v1/coach/hints",
            json_body={"item_code": "__no_such_item__"},
        )

        # ── 侦探 ──
        puzzle = self.request("detective_puzzle", "GET", "/v1/detective/puzzle")
        self.puzzle_id = puzzle.get("puzzle_id")
        if self.puzzle_id:
            self.request(
                "detective_answer", "POST", "/v1/detective/answer",
                json_body={"puzzle_id": self.puzzle_id, "answer": "999999"},
            )

        # ── 成长 ──
        self.request(
            "growth_build_insufficient", "POST", "/v1/growth/build",
            json_body={"building_code": "ticket_booth"},
        )
        self.request(
            "growth_build_missing", "POST", "/v1/growth/build",
            json_body={"building_code": "__nope__"},
        )

        # ── 调试 / 错误路径 ──
        self.request("debug_learning_state", "GET", "/v1/debug/learning-state")
        self.request("unknown_path", "GET", "/definitely/not/here")
        self.request("method_not_allowed", "DELETE", "/v1/world")


def main() -> None:
    url = _db_url()
    recreate_database(url)
    import_content(url)

    app = create_app(db_url=url)
    with TestClient(app) as client:
        scenario = Scenario(client)
        scenario.run()

    os.makedirs(os.path.dirname(FIXTURE_PATH), exist_ok=True)
    payload = {
        "source": "python",
        "db_url_label": urlparse_db(url)["dbname"],
        "scenarios": scenario.records,
    }
    with open(FIXTURE_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print("已写出 {} 条场景 → {}".format(len(scenario.records), os.path.abspath(FIXTURE_PATH)))


if __name__ == "__main__":
    main()
