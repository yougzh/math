"""世界 / 实验室 / 成长域。

**P2 阶段的定位**：契约里这些端点必须存在且形状正确，但它们的游戏规则
（材料掉落、建筑解锁、徽章、布局）属于 P5 成长体系。因此本模块只实现
"从学习事实中可推导"的部分，规则常量集中放在文件顶部，方便 P5 整体替换。

实验室（§7）不在本模块维护规则：解锁判定统一走 `backend/lab` +
`config/lab/v0.yaml`，这里只提供 `level_of`（派生等级，ADR-0002）。

推导原则：游戏状态永远不是学习状态的权威（见 db/migrations 的注释）。
这里的材料 / 建筑 / 徽章只读 inventory / unlock / attempt / proficiency_state。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from backend.content.loader import ContentBundle
from backend.db import models
from backend.engine.config import AlgorithmConfig
from backend.engine.graph import CompetencyGraph
from backend.engine.state_machine import derive_level, is_mastered
from backend.engine.types import ChildLearningState
from backend.lab import list_experiments

# ── P5 待接管的常量（内容是资产，规则应可配置） ─────────────
UNIVERSES = [
    {"code": "number_station", "name": "数字车站", "emoji": "🚂"},
    {"code": "detective", "name": "侦探社", "emoji": "🦊"},
]

BUILDINGS = [
    {
        "code": "ticket_booth",
        "name": "售票亭",
        "emoji": "🎫",
        "cost": {"wood": 5, "coin": 2},
        "unlocks": [],
    },
    {
        "code": "platform",
        "name": "站台",
        "emoji": "🛤️",
        "cost": {"wood": 10, "coin": 5},
        "unlocks": ["universe.detective"],
    },
]

BADGES = [
    {"code": "first_make_ten", "name": "第一次凑十", "emoji": "🎖️", "competency": "make_ten"},
    {"code": "first_carry", "name": "第一次进位", "emoji": "🚃", "competency": "carry_add"},
]

MATERIAL_CODES = ["wood", "coin", "gem", "seed"]

COMPETENCY_EMOJI = {
    "sd_add_10": "➕",
    "sd_sub_10": "➖",
    "sd_add_20": "🔢",
    "sd_sub_20": "🔽",
    "make_ten": "🔟",
    "place_value": "🚃",
    "td_add_nocarry": "🧮",
    "td_sub_nocarry": "📉",
    "carry_add": "🔁",
    "borrow_sub": "🔄",
}

DEFAULT_UNIVERSE = "number_station"


# ── 基础读取 ───────────────────────────────────────────────
def materials_of(session, child_id: int) -> Dict[str, int]:
    out = {code: 0 for code in MATERIAL_CODES}
    for row in (
        session.query(models.Inventory)
        .filter(models.Inventory.child_id == child_id)
        .all()
    ):
        out[row.item_code] = int(row.count or 0)
    return out


def unlocked_codes(session, child_id: int) -> set:
    return {
        row.unlock_code
        for row in session.query(models.Unlock)
        .filter(models.Unlock.child_id == child_id)
        .all()
    }


def competency_emoji(code: str) -> str:
    return COMPETENCY_EMOJI.get(code, "📘")


def lab_payload(state: ChildLearningState, cfg: AlgorithmConfig) -> Dict[str, Any]:
    """契约 §7：实验列表。

    解锁规则整套由 `backend/lab` 负责（配置在 `config/lab/v0.yaml`）：
    按能力的**派生等级**（ADR-0002，读时现算，不落库）判定，而不是年级/天数。
    """

    def level_of(competency_code: str) -> str:
        signals = state.competencies.get(competency_code)
        if signals is None:
            return cfg.level_order[0]
        return derive_level(signals, cfg)

    return {
        "experiments": list_experiments(
            level_of=level_of, level_order=cfg.level_order
        )
    }


# ── 故事完成度（用 attempt 的 slot_code 反推） ─────────────
def completed_story_codes(
    session, child_id: int, bundle: ContentBundle
) -> List[str]:
    done: List[str] = []
    for story in bundle.stories.values():
        slot_codes = [
            beat.slot_code for beat in story.challenge_beats() if beat.slot_code
        ]
        if not slot_codes:
            continue
        hit = {
            row[0]
            for row in session.query(models.Attempt.slot_code)
            .filter(
                models.Attempt.child_id == child_id,
                models.Attempt.slot_code.in_(slot_codes),
            )
            .distinct()
            .all()
            if row[0]
        }
        if all(code in hit for code in slot_codes):
            done.append(story.code)
    return done


# ── GET /v1/world ──────────────────────────────────────────
def world_payload(
    session,
    child: models.Child,
    state: ChildLearningState,
    cfg: AlgorithmConfig,
    bundle: ContentBundle,
    budget_minutes: int,
) -> Dict[str, Any]:
    completed = set(completed_story_codes(session, child.id, bundle))
    stories = sorted(bundle.stories.values(), key=lambda s: (s.order_index, s.code))

    universes = []
    for universe in UNIVERSES:
        universe_stories = [s for s in stories if s.universe == universe["code"]]
        total = len(universe_stories)
        progress = (len([s for s in universe_stories if s.code in completed]) / total) if total else 0.0
        universes.append(
            {
                "code": universe["code"],
                "name": universe["name"],
                "emoji": universe["emoji"],
                "unlocked": universe["code"] == DEFAULT_UNIVERSE
                or ("universe.{}".format(universe["code"]) in unlocked_codes(session, child.id)),
                "progress": round(progress, 4),
                "stories": [
                    {
                        "code": story.code,
                        "title": story.title,
                        "completed": story.code in completed,
                        "unlocked": True,
                    }
                    for story in universe_stories
                ],
            }
        )

    today_story = next((s for s in stories if s.code not in completed), None)
    if today_story is not None:
        today = {
            "headline": today_story.title,
            "subtitle": today_story.summary or "去数字车站帮它一把",
            "story_code": today_story.code,
            "universe_code": today_story.universe,
            "estimated_minutes": today_story.duration_min or budget_minutes,
            "completed": False,
        }
    else:
        # 没有故事内容（P2 未接入）时的降级：形状不变，字段指向默认宇宙
        today = {
            "headline": "今天来练一练数字吧",
            "subtitle": "去数字车站练一练",
            "story_code": None,
            "universe_code": DEFAULT_UNIVERSE,
            "estimated_minutes": budget_minutes,
            "completed": False,
        }

    return {
        "child": {"id": child.id, "name": child.name},
        "today": today,
        "universes": universes,
        "lab_unlocked": True,
        "detective_unlocked": "universe.detective" in unlocked_codes(session, child.id),
        "growth_summary": {
            "materials": materials_of(session, child.id),
            "buildings": [
                code.split(".", 1)[1]
                for code in sorted(unlocked_codes(session, child.id))
                if code.startswith("building.")
            ],
            "newest_badge": _newest_badge(session, child.id, state),
        },
    }


# ── GET /v1/growth ─────────────────────────────────────────
def badge_payloads(
    session, child_id: int, state: ChildLearningState
) -> List[Dict[str, Any]]:
    out = []
    for badge in BADGES:
        signals = state.competencies.get(badge["competency"])
        earned = signals is not None and signals.sample_count > 0
        earned_at = None
        if earned:
            row = (
                session.query(models.Attempt.created_at)
                .filter(
                    models.Attempt.child_id == child_id,
                    models.Attempt.competency_code == badge["competency"],
                )
                .order_by(models.Attempt.seq)
                .first()
            )
            if row is not None and row[0] is not None:
                earned_at = _iso(row[0])
        out.append(
            {
                "code": badge["code"],
                "name": badge["name"],
                "emoji": badge["emoji"],
                "earned": earned,
                "earned_at": earned_at,
            }
        )
    return out


def _newest_badge(session, child_id: int, state: ChildLearningState) -> Optional[Dict[str, Any]]:
    earned = [b for b in badge_payloads(session, child_id, state) if b["earned"]]
    if not earned:
        return None
    return {
        "code": earned[-1]["code"],
        "name": earned[-1]["name"],
        "emoji": earned[-1]["emoji"],
    }


def growth_payload(
    session,
    child: models.Child,
    state: ChildLearningState,
    cfg: AlgorithmConfig,
    bundle: ContentBundle,
    graph: CompetencyGraph,
) -> Dict[str, Any]:
    order = graph.topological_order()
    position_index = {code: index for index, code in enumerate(order)}

    nodes = []
    for code in order:
        competency = bundle.competencies.get(code)
        if competency is None:
            continue
        signals = state.competencies.get(code)
        level = derive_level(signals, cfg) if signals is not None else cfg.level_order[0]
        nodes.append(
            {
                "code": code,
                "name": competency.name,
                "level": level,
                "level_label": cfg.level_label(level),
                "mastered": is_mastered(state, code, graph, cfg),
                "emoji": competency_emoji(code),
                "unlocked": True,
                "position": {"x": position_index.get(code, 0), "y": competency.stage},
            }
        )

    edges = []
    for code in order:
        for prereq in graph.prerequisites(code):
            edges.append({"from": prereq, "to": code})

    built = {
        code.split(".", 1)[1]
        for code in unlocked_codes(session, child.id)
        if code.startswith("building.")
    }
    return {
        "tree": {"nodes": nodes, "edges": edges},
        "materials": materials_of(session, child.id),
        "buildings": [
            {
                "code": row["code"],
                "name": row["name"],
                "emoji": row["emoji"],
                "built": row["code"] in built,
                "cost": row["cost"],
            }
            for row in BUILDINGS
        ],
        "badges": badge_payloads(session, child.id, state),
    }


def build_payload(
    session, child_id: int, building: Dict[str, Any]
) -> Dict[str, Any]:
    """POST /v1/growth/build：材料足够则扣减并解锁。"""
    materials = materials_of(session, child_id)
    cost = building["cost"]
    missing = {
        code: need - materials.get(code, 0)
        for code, need in cost.items()
        if materials.get(code, 0) < need
    }
    if missing:
        return {
            "built": False,
            "reason": "材料不足",
            "materials": materials,
            "missing": missing,
            "unlocks": [],
        }

    for code, need in cost.items():
        row = (
            session.query(models.Inventory)
            .filter(
                models.Inventory.child_id == child_id,
                models.Inventory.item_code == code,
            )
            .one_or_none()
        )
        if row is None:
            row = models.Inventory(child_id=child_id, item_code=code, count=0)
        row.count = (row.count or 0) - need
        session.add(row)

    unlock_codes_now = []
    for unlock_code in building.get("unlocks", []):
        exists = (
            session.query(models.Unlock)
            .filter(
                models.Unlock.child_id == child_id,
                models.Unlock.unlock_code == unlock_code,
            )
            .one_or_none()
        )
        if exists is None:
            session.add(models.Unlock(child_id=child_id, unlock_code=unlock_code))
        unlock_codes_now.append(unlock_code)
    session.add(
        models.Unlock(child_id=child_id, unlock_code="building.{}".format(building["code"]))
    )
    session.flush()
    return {
        "built": True,
        "materials": materials_of(session, child_id),
        "unlocks": unlock_codes_now,
    }


def _iso(value) -> str:
    text = value.isoformat()
    if value.tzinfo is None:
        text += "Z"
    return text


__all__ = [
    "UNIVERSES",
    "BUILDINGS",
    "BADGES",
    "materials_of",
    "unlocked_codes",
    "lab_payload",
    "world_payload",
    "growth_payload",
    "build_payload",
    "completed_story_codes",
    "competency_emoji",
]
