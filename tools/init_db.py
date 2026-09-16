"""初始化数据库：建表 + 导入内容。

    python3 -m tools.init_db                    # 默认 build/content_dump.json → MATH_DB_URL
    python3 -m tools.init_db --db-url sqlite:///tmp/x.db
    python3 -m tools.init_db --dump build/content_dump.json

幂等：重复执行不报错、不产生重复行（按主键 upsert）。
输入是 `python3 -m tools.content_cli dump` 产出的 JSON —— 文件不存在时直接失败，
提示先跑 dump，避免"悄悄导入了过期内容"。dump 是**唯一输入**：学习内容与
故事（story / story_beat）全部来自 dump 文件，本脚本不再自行读取内容目录。

另外插入（不属于 dump 的部署必需品）：
  - algorithm_config v0：proficiency_state.algorithm_version 的外键目标，
    内容来自 config/algorithm/v0.yaml，payload 原样入库（ADR-0002 的版本 pin）
  - 默认孩子：契约 §0 的"缺省使用默认孩子"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from hashlib import sha256
from typing import Any, Dict, List, Optional

import yaml

from backend.db import models
from backend.db.base import Base
from backend.db.session import create_db_engine, create_session_factory, database_url
from backend.paths import ALGORITHM_CONFIG_DIR, ROOT

DEFAULT_DUMP = os.path.join(ROOT, "build", "content_dump.json")
DEFAULT_CHILD_NAME = "小明"

UNIVERSE_NAMES = {
    "number_station": ("数字车站", "🚂"),
    "detective": ("侦探社", "🦊"),
}


# ── upsert ─────────────────────────────────────────────────
def upsert(session, model, rows: List[Dict[str, Any]], key_columns: List[str]) -> int:
    existing = {}
    for obj in session.query(model).all():
        existing[tuple(getattr(obj, column) for column in key_columns)] = obj
    written = 0
    for row in rows:
        key = tuple(row[column] for column in key_columns)
        obj = existing.get(key)
        if obj is None:
            obj = model()
            session.add(obj)
            existing[key] = obj
        for column, value in row.items():
            setattr(obj, column, value)
        written += 1
    session.flush()
    return written


# ── 各内容块 ───────────────────────────────────────────────
def competency_rows(dump: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            "code": row["code"],
            "name": row["name"],
            "description": row.get("description", ""),
            "stage": int(row.get("stage", 1)),
            "active": True,
        }
        for row in dump.get("competencies", [])
    ]


def prerequisite_rows(dump: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = []
    for row in dump.get("competencies", []):
        for prereq in row.get("prerequisites", []) or []:
            rows.append(
                {
                    "competency_code": row["code"],
                    "prerequisite_code": prereq,
                    "weight": 1.0,
                }
            )
    return rows


def pattern_rows(dump: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = []
    for row in dump.get("patterns", []):
        rows.append(
            {
                "code": row["code"],
                "name": row["name"],
                "description": row.get("description", ""),
                "cognitive_type": row["cognitive_type"],
            }
        )
    return rows


def pattern_competency_rows(dump: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = []
    for row in dump.get("patterns", []):
        primary = row["primary_competency"]
        related = set(row.get("applicable_competencies", []) or []) | {primary}
        for competency_code in sorted(related):
            rows.append(
                {
                    "pattern_code": row["code"],
                    "competency_code": competency_code,
                    "is_primary": competency_code == primary,
                }
            )
    return rows


def misconception_rows(dump: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            "code": row["code"],
            "name": row["name"],
            "description": row.get("description", ""),
            "severity": int(row.get("severity", 1)),
            "remediation_competency": row.get("remediation_competency"),
        }
        for row in dump.get("misconceptions", [])
    ]


def item_rows(dump: Dict[str, Any], release_id: int) -> List[Dict[str, Any]]:
    return [
        {
            "code": row["code"],
            "competency_code": row["competency"],
            "pattern_code": row["pattern"],
            "difficulty": int(row.get("difficulty", 1)),
            "scaffold_level": row["scaffold_level"],
            "interaction_type": row["interaction_type"],
            "estimated_seconds": int(row.get("estimated_seconds", 15)),
            "problem_json": row.get("problem", {}),
            "answer_json": row.get("answer"),
            "steps_json": row.get("steps", []) or [],
            "hint_chain_json": row.get("hint_chain", []) or [],
            "error_rules_json": row.get("error_rules", []) or [],
            "source_template": row.get("source_template"),
            "review_status": row.get("review_status", "approved"),
            "content_release_id": release_id,
        }
        for row in dump.get("items", [])
    ]


def story_rows(dump: Dict[str, Any]) -> List[Dict[str, Any]]:
    """story 主表行。universe 为空时归入 number_station（loader 的缺省宇宙）。"""
    return [
        {
            "code": row["code"],
            "universe_code": row.get("universe") or "number_station",
            "title": row["title"],
            "summary": row.get("summary", ""),
            "duration_min": row.get("duration_min"),
            "target_competencies_json": list(row.get("target_competencies", []) or []),
            "order_index": int(row.get("order_index", 0)),
        }
        for row in dump.get("stories", [])
    ]


def story_beat_rows(dump: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            "code": beat["code"],
            "story_code": row["code"],
            "sequence": int(beat["sequence"]),
            "beat_type": beat["beat_type"],
            "narration": beat.get("narration", ""),
            "character": beat.get("character", ""),
            "visual_json": beat.get("visual", {}) or {},
            "reward_json": beat.get("reward", {}) or {},
        }
        for row in dump.get("stories", [])
        for beat in row.get("beats", []) or []
    ]


def algorithm_config_rows() -> List[Dict[str, Any]]:
    rows = []
    for name in sorted(os.listdir(ALGORITHM_CONFIG_DIR)) if os.path.isdir(ALGORITHM_CONFIG_DIR) else []:
        if not name.endswith(".yaml"):
            continue
        path = os.path.join(ALGORITHM_CONFIG_DIR, name)
        with open(path, "r", encoding="utf-8") as handle:
            payload = yaml.safe_load(handle)
        rows.append(
            {
                "version": int(payload["version"]),
                "payload_json": payload,
                "is_active": name == "v0.yaml",
            }
        )
    return rows


def _load_dump(path: str, version: Optional[str]) -> Dict[str, Any]:
    if not os.path.isfile(path):
        print("找不到内容导出文件：{}".format(path))
        print("请先运行：python3 -m tools.content_cli dump")
        raise SystemExit(1)
    with open(path, "r", encoding="utf-8") as handle:
        dump = json.load(handle)
    if version:
        dump["content_version"] = version
    return dump


def _checksum(path: str) -> str:
    with open(path, "rb") as handle:
        return sha256(handle.read()).hexdigest()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="初始化数据库并导入内容")
    parser.add_argument("--dump", default=DEFAULT_DUMP, help="content_dump.json 路径")
    parser.add_argument("--db-url", default=None, help="数据库 URL（默认 MATH_DB_URL）")
    parser.add_argument("--version", default=None, help="覆盖内容版本号")
    args = parser.parse_args(argv)

    dump = _load_dump(args.dump, args.version)
    if "stories" not in dump:
        print("dump 文件缺少 stories 段（过期导出）。")
        print("请先重新运行：python3 -m tools.content_cli dump")
        raise SystemExit(1)
    target = database_url(args.db_url)
    print("数据库：{}".format(target))

    engine = create_db_engine(target)
    Base.metadata.create_all(engine)
    session = create_session_factory(engine)()
    counts: Dict[str, int] = {}
    try:
        counts["algorithm_config"] = upsert(
            session, models.AlgorithmConfig, algorithm_config_rows(), ["version"]
        )

        release_version = str(dump.get("content_version", "v0"))
        release = (
            session.query(models.ContentRelease)
            .filter(models.ContentRelease.version == release_version)
            .one_or_none()
        )
        if release is None:
            release = models.ContentRelease(version=release_version)
            session.add(release)
        release.checksum = _checksum(args.dump)
        release.stats_json = dict(dump.get("counts", {}))
        session.flush()
        release_id = release.id

        counts["competency"] = upsert(
            session, models.Competency, competency_rows(dump), ["code"]
        )
        counts["competency_prerequisite"] = upsert(
            session,
            models.CompetencyPrerequisite,
            prerequisite_rows(dump),
            ["competency_code", "prerequisite_code"],
        )
        counts["problem_pattern"] = upsert(
            session, models.ProblemPattern, pattern_rows(dump), ["code"]
        )
        counts["pattern_competency"] = upsert(
            session,
            models.PatternCompetency,
            pattern_competency_rows(dump),
            ["pattern_code", "competency_code"],
        )
        counts["misconception"] = upsert(
            session, models.Misconception, misconception_rows(dump), ["code"]
        )
        counts["item"] = upsert(
            session, models.Item, item_rows(dump, release_id), ["code"]
        )

        # 故事域：universe → story → story_beat → challenge_slot（全部来自 dump）
        story_data = story_rows(dump)
        universes = sorted({row["universe_code"] for row in story_data})
        counts["universe"] = upsert(
            session,
            models.Universe,
            [
                {
                    "code": code,
                    "name": UNIVERSE_NAMES.get(code, (code, ""))[0],
                    "theme": "",
                    "unlock_rule_json": {},
                    "order_index": index,
                }
                for index, code in enumerate(universes)
            ],
            ["code"],
        )
        counts["story"] = upsert(session, models.Story, story_data, ["code"])
        counts["story_beat"] = upsert(
            session, models.StoryBeat, story_beat_rows(dump), ["code"]
        )

        slot_rows = [
            {
                "code": row["code"],
                "story_beat_code": row.get("story_beat_id"),
                "competency_code": row["competency"],
                "pattern_code": row.get("pattern"),
                "difficulty_min": int(row.get("difficulty_min", 1)),
                "difficulty_max": int(row.get("difficulty_max", 5)),
                "scaffold_level": row.get("scaffold_level") or "auto",
                "purpose": row.get("purpose", "practice"),
                "estimated_seconds": int(row.get("estimated_seconds", 20)),
                "selection_policy_json": row.get("selection_policy", {}) or {},
                "review_policy_json": row.get("review_policy", {}) or {},
            }
            for row in dump.get("slots", [])
        ]
        counts["challenge_slot"] = upsert(
            session, models.ChallengeSlot, slot_rows, ["code"]
        )

        child = session.query(models.Child).order_by(models.Child.id).first()
        if child is None:
            session.add(models.Child(name=DEFAULT_CHILD_NAME))
            session.flush()
        counts["child"] = session.query(models.Child).count()

        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

    print("导入完成（重复执行不会产生重复行）：")
    for key in sorted(counts):
        print("  {:<24} {}".format(key, counts[key]))
    print("\n下一步：python3 -m uvicorn backend.api.app:create_app --factory")
    return 0


if __name__ == "__main__":
    sys.exit(main())
