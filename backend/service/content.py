"""内容读取服务。

内容的部署形态是数据库（`python3 -m tools.init_db` 把 `build/content_dump.json`
导入 `item` / `competency` / `pattern` / `misconception` / `challenge_slot` 等表），
本模块负责把 DB 行重新组装成引擎认识的 `ContentBundle`。

回退规则：数据库里一条 item 都没有时（开发环境还没跑 init_db），回退到内存
内容 `backend.content.loader.load_bundle()` —— API 不至于因为没初始化就不可用。
一旦 DB 有内容，DB 就是唯一来源。

硬性不变量：**answer / steps 永不下发前端**（契约 §0/§3）。
本模块是唯一的 item 载荷生产点，`item_payload()` 里不出现这两个字段。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from backend.content.loader import (
    ChallengeSlot,
    Competency,
    ContentBundle,
    Item,
    Misconception,
    Pattern,
    Story,
    StoryBeat,
    load_bundle,
    load_competencies,
)
from backend.db import models
from backend.engine.config import AlgorithmConfig
from backend.engine.selector import effective_scaffold, select_item
from backend.engine.types import ChildLearningState

# visual.kind 的默认值（契约 §6）。故事内容尚未提供 visual 字段时用它兜底。
_DEFAULT_VISUAL_KIND = "station"


# ── 载荷序列化（纯函数） ───────────────────────────────────
def choices_for(item: Item) -> Optional[List[int]]:
    """choice 题的选项数组。

    内容模型没有 choices 字段（P1 缺口，见 P2 报告），这里从 error_rules 的
    `answer_in` / `answer_equals` 反推"典型错法集合"，与正确答案合并成选项。
    """
    if item.interaction_type != "choice":
        return None
    values = set()
    if isinstance(item.answer, int) and not isinstance(item.answer, bool):
        values.add(item.answer)
    for rule in item.error_rules or []:
        match = rule.get("match") or {}
        for value in list(match.get("answer_in", []) or []):
            if isinstance(value, int) and not isinstance(value, bool):
                values.add(value)
        if isinstance(match.get("answer_equals"), int):
            values.add(match["answer_equals"])
    if not values:
        return None
    return sorted(values)


def item_payload(item: Item) -> Dict[str, Any]:
    """契约 §3 的 Item 载荷。**不含 answer，不含 steps。**"""
    problem = dict(item.problem or {})
    prompt = problem.pop("prompt", "")
    return {
        "code": item.code,
        "competency": item.competency_id,
        "pattern": item.pattern_id,
        "difficulty": item.difficulty,
        "scaffold_level": item.scaffold_level,
        "interaction_type": item.interaction_type,
        "estimated_seconds": item.estimated_seconds,
        "prompt": prompt,
        "problem": problem,
        "answer_type": "choice" if item.interaction_type == "choice" else "number",
        "choices": choices_for(item),
        "hints_available": len(item.hint_chain or []),
    }


def _beat_visual(
    row: Optional[models.StoryBeat], character: str
) -> Dict[str, Any]:
    """契约 §6 的 visual。DB 有 visual_json 就用它，否则给默认插画描述。"""
    visual = dict(row.visual_json or {}) if row is not None else {}
    if not visual:
        visual = {
            "kind": _DEFAULT_VISUAL_KIND,
            "mood": "calm",
            "characters": [character] if character else [],
        }
    return visual


# ── DB → ContentBundle ─────────────────────────────────────
def _bundle_from_db(session) -> Optional[ContentBundle]:
    item_rows = session.query(models.Item).all()
    if not item_rows:
        return None

    prereq_rows = session.query(models.CompetencyPrerequisite).all()
    prerequisites: Dict[str, List[str]] = {}
    for row in prereq_rows:
        prerequisites.setdefault(row.competency_code, []).append(row.prerequisite_code)

    # terms 只用于 AI 教练的"不超纲"护栏，尚未入库（P1 缺口），从内存内容回填
    try:
        memory_competencies = load_competencies()
    except Exception:  # 内容目录缺失时不影响主流程
        memory_competencies = {}

    competencies: Dict[str, Competency] = {}
    for row in session.query(models.Competency).all():
        memory = memory_competencies.get(row.code)
        competencies[row.code] = Competency(
            code=row.code,
            name=row.name,
            description=row.description or "",
            prerequisites=sorted(prerequisites.get(row.code, [])),
            stage=row.stage,
            terms=list(memory.terms) if memory else [],
        )

    pattern_rows = session.query(models.PatternCompetency).all()
    related: Dict[str, List[str]] = {}
    primary_by_pattern: Dict[str, str] = {}
    for row in pattern_rows:
        related.setdefault(row.pattern_code, []).append(row.competency_code)
        if row.is_primary:
            primary_by_pattern[row.pattern_code] = row.competency_code

    patterns: Dict[str, Pattern] = {}
    for row in session.query(models.ProblemPattern).all():
        primary = primary_by_pattern.get(row.code)
        applicable = sorted(
            code for code in related.get(row.code, []) if code != primary
        )
        patterns[row.code] = Pattern(
            code=row.code,
            name=row.name,
            cognitive_type=row.cognitive_type,
            primary_competency=primary,
            applicable_competencies=applicable,
            description=row.description or "",
        )

    misconceptions: Dict[str, Misconception] = {}
    for row in session.query(models.Misconception).all():
        misconceptions[row.code] = Misconception(
            code=row.code,
            name=row.name,
            description=row.description or "",
            severity=row.severity,
            remediation_competency=row.remediation_competency,
        )

    items: Dict[str, Item] = {}
    for row in item_rows:
        items[row.code] = Item(
            code=row.code,
            competency_id=row.competency_code,
            pattern_id=row.pattern_code,
            difficulty=row.difficulty,
            scaffold_level=row.scaffold_level,
            interaction_type=row.interaction_type,
            estimated_seconds=row.estimated_seconds,
            problem=dict(row.problem_json or {}),
            answer=row.answer_json,
            steps=list(row.steps_json or []),
            hint_chain=list(row.hint_chain_json or []),
            error_rules=list(row.error_rules_json or []),
        )

    slots: Dict[str, ChallengeSlot] = {}
    for row in session.query(models.ChallengeSlot).all():
        slots[row.code] = ChallengeSlot(
            code=row.code,
            competency_id=row.competency_code,
            difficulty_min=row.difficulty_min,
            difficulty_max=row.difficulty_max,
            purpose=row.purpose,
            pattern_id=row.pattern_code,
            scaffold_level=row.scaffold_level,
            estimated_seconds=row.estimated_seconds,
            story_beat_id=row.story_beat_code,
            selection_policy=dict(row.selection_policy_json or {}),
            review_policy=dict(row.review_policy_json or {}),
        )

    stories: Dict[str, Story] = {}
    beat_rows = (
        session.query(models.StoryBeat)
        .order_by(models.StoryBeat.story_code, models.StoryBeat.sequence)
        .all()
    )
    slot_by_beat = {
        row.story_beat_code: row.code
        for row in session.query(models.ChallengeSlot).all()
        if row.story_beat_code
    }
    beats_by_story: Dict[str, List[StoryBeat]] = {}
    for row in beat_rows:
        beats_by_story.setdefault(row.story_code, []).append(
            StoryBeat(
                code=row.code,
                story_code=row.story_code,
                sequence=row.sequence,
                beat_type=row.beat_type,
                narration=row.narration or "",
                character=row.character or "",
                slot_code=slot_by_beat.get(row.code),
            )
        )
    for row in session.query(models.Story).all():
        stories[row.code] = Story(
            code=row.code,
            title=row.title,
            universe=row.universe_code,
            summary=row.summary or "",
            order_index=row.order_index,
            duration_min=row.duration_min or 8,
            target_competencies=list(row.target_competencies_json or []),
            beats=beats_by_story.get(row.code, []),
        )

    return ContentBundle(
        competencies=competencies,
        patterns=patterns,
        items=items,
        misconceptions=misconceptions,
        slots=slots,
        stories=stories,
    )


class ContentService:
    """内容入口。DB 是权威来源；表为空时回退内存内容（开发环境）。"""

    def __init__(self, memory_bundle: Optional[ContentBundle] = None):
        self._memory_bundle = memory_bundle
        self._bundle: Optional[ContentBundle] = None

    def bundle(self, session) -> ContentBundle:
        if self._bundle is None:
            self._bundle = _bundle_from_db(session)
            if self._bundle is None:
                self._bundle = self._memory_bundle or load_bundle()
        return self._bundle

    def refresh(self) -> None:
        """内容重新导入后调用（测试与开发用）。"""
        self._bundle = None

    # ── 故事载荷（契约 §6） ─────────────────────────────
    def story_payload(
        self,
        session,
        story_code: str,
        state: ChildLearningState,
        cfg: AlgorithmConfig,
    ) -> Optional[Dict[str, Any]]:
        bundle = self.bundle(session)
        story = bundle.stories.get(story_code)
        if story is None:
            return None

        # visual / reward 只存在于 story_beat 的 JSON 列（loader 的 StoryBeat
        # 不携带它们）。DB 有对应行就拿来装饰；内容走内存回退时给默认值。
        decorations = {
            row.code: row
            for row in session.query(models.StoryBeat)
            .filter(models.StoryBeat.story_code == story_code)
            .all()
        }

        payload_beats = []
        for beat in story.ordered_beats():
            row = decorations.get(beat.code)
            challenge = None
            if beat.slot_code:
                slot = bundle.slots.get(beat.slot_code)
                if slot is not None:
                    selected = select_item(slot, state, bundle, cfg)
                    challenge = {
                        "slot_code": beat.slot_code,
                        "purpose": slot.purpose,
                        "scaffold_level": effective_scaffold(slot, state, cfg),
                        "item": (
                            item_payload(selected) if selected is not None else None
                        ),
                    }
            # 契约 §6 的字段（index/type/narration/visual/reward/challenge）
            # + 前端直接可用的别名（code/sequence/text/character/slot_code）。
            # 两者同源：都从同一个 StoryBeat 生成。
            payload_beats.append(
                {
                    "index": beat.sequence,
                    "sequence": beat.sequence,
                    "code": beat.code,
                    "type": beat.beat_type,
                    "narration": beat.narration,
                    "text": beat.narration,
                    "character": beat.character,
                    "slot_code": beat.slot_code,
                    "visual": _beat_visual(row, beat.character),
                    "reward": (
                        dict(row.reward_json)
                        if row is not None and row.reward_json
                        else None
                    ),
                    "challenge": challenge,
                }
            )

        return {
            "code": story.code,
            "universe": story.universe,
            "title": story.title,
            "summary": story.summary or "",
            "duration_min": story.duration_min or 8,
            "order_index": story.order_index,
            "beats": payload_beats,
        }


__all__ = [
    "ContentService",
    "item_payload",
    "choices_for",
]
