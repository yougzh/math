"""每日计划规划器。

时间预算是硬约束，题量不是（§20）。

    warmup   2min  召回旧知识（已会但未自动化）
    core     4min  围绕当前目标能力的核心训练
    story    4min  故事训练：把聚焦能力放进故事里练
    thinking 3min  思维挑战 / 迁移测试
    discovery 1min 今日发现

Planner 的输入是 Learning Intent，输出是 DailyPlan（其中含 slot 与选中题目）。

故事段的选法（ADR-0001）：
  故事段消费的是 `purpose=story` 的槽位 —— 这些槽位挂在故事的挑战节拍上，
  但**具体做哪一道题仍然由本模块在运行时决定**。故事作者写的是
  "这里需要算一算"，不是"这里做 mt_add_3_4"。
  一个节拍出一道题（`select_item` 而不是 `select_items`）：节拍的顺序就是故事的
  顺序，在同一个节拍上连出两道题，那不是故事，是刷题。
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Dict, List, Optional

from backend.content.loader import ChallengeSlot, ContentBundle, Item
from backend.engine.config import SCAFFOLD_LEVELS, AlgorithmConfig
from backend.engine.graph import CompetencyGraph
from backend.engine.intent import derive_intents
from backend.engine.scheduler import ReviewItem
from backend.engine.selector import effective_scaffold, select_item, select_items
from backend.engine.state_machine import next_competency
from backend.engine.types import ChildLearningState, LearningIntent

SCAFFOLD_LABELS = {
    "blocks": "用积木摆",
    "decompose": "先拆一拆",
    "direct": "直接算",
}

# 意图 → 计划段落
_INTENT_SEGMENT = {
    "warmup": "warmup",
    "review": "warmup",  # 复习占用热身段：热身的职责本来就是"召回旧知识"
    "repair": "core",
    "teach": "core",
    "strengthen_fluency": "core",
    "story": "story",
    "probe_transfer": "thinking",
}

# 复习意图的优先级：在常规热身之前，但不抢回退（repair）的位置
PRIORITY_REVIEW = 5

# 句子常量：故事段缺内容时，note 要能说清"是内容还没写"还是"这个能力还没故事"
NOTE_NO_STORY_AT_ALL = "故事段暂缺内容，其时间预算已按比例并入其他段落"
NOTE_NO_STORY_FOR_TARGET = "故事段暂缺内容：{} 还没有故事，其时间预算已按比例并入其他段落"

# 段落 → 优先匹配的 slot purpose
_SEGMENT_PURPOSES = {
    "warmup": ["warmup", "review", "practice"],
    "core": ["practice", "teach", "review"],
    "story": ["story"],
    "thinking": ["challenge", "practice"],
}


@dataclass
class StoryBeatAssignment:
    """故事段里"哪个节拍配了哪道题"。

    故事播放器要逐 beat 出题，所以这个映射必须显式给出 ——
    靠 `items` 的下标隐式对齐，会在某个节拍落不到题时整体错位。
    """

    beat_code: str
    slot_code: str
    item_code: str


@dataclass
class PlanSegment:
    type: str
    budget_s: int
    intents: List[LearningIntent] = field(default_factory=list)
    items: List[Item] = field(default_factory=list)
    slot_code: Optional[str] = None
    scaffold_level: Optional[str] = None
    note: str = ""
    story_code: Optional[str] = None
    beats: List[StoryBeatAssignment] = field(default_factory=list)


@dataclass
class DailyPlan:
    child_id: str
    budget_minutes: int
    segments: List[PlanSegment]
    intents: List[LearningIntent]
    discovery: str
    notes: List[str] = field(default_factory=list)


def _find_slot(
    bundle: ContentBundle,
    competency_id: str,
    purposes: List[str],
    pattern_id: Optional[str] = None,
) -> Optional[ChallengeSlot]:
    candidates = [
        slot
        for slot in bundle.slots.values()
        if slot.competency_id == competency_id and slot.purpose in purposes
    ]
    if pattern_id:
        exact = [s for s in candidates if s.pattern_id == pattern_id]
        if exact:
            candidates = exact
        else:
            # 槽位允许自由 pattern 时也能承接指定 pattern 的意图
            free = [s for s in candidates if s.pattern_id is None]
            if free:
                candidates = free
    if not candidates:
        return None
    return sorted(candidates, key=lambda s: (purposes.index(s.purpose), s.code))[0]


def _review_intents(
    due_reviews: Optional[List[ReviewItem]], cfg: AlgorithmConfig
) -> List[LearningIntent]:
    """把到期复习项翻译成学习意图（仍然是"练什么"，不是"做哪道题"）。

    顺序即优先级：调用方（scheduler.due_reviews）已按"逾期天数降序"排好，
    这里原样保留 —— 最该复习的排最前。
    """
    intents: List[LearningIntent] = []
    for row in due_reviews or []:
        intents.append(
            LearningIntent(
                kind="review",
                competency_id=row.competency_id,
                pattern_id=row.pattern_id,
                reason="到期复习：{}，第 {} 档间隔，逾期 {} 天".format(
                    row.pattern_id, row.interval_index + 1, row.overdue_days
                ),
                priority=PRIORITY_REVIEW,
                target_seconds=int(cfg.intent_config().get("warmup_item_count", 2)) * 10,
            )
        )
    return intents


def _scaffold_distance(level: str, preferred: Optional[str]) -> int:
    if preferred not in SCAFFOLD_LEVELS:
        return 0
    return abs(SCAFFOLD_LEVELS.index(level) - SCAFFOLD_LEVELS.index(preferred))


def _review_slot(
    slot: ChallengeSlot,
    bundle: ContentBundle,
    pattern_id: Optional[str],
    preferred_scaffold: Optional[str] = None,
) -> Optional[ChallengeSlot]:
    """复习必须打准问题结构。

    pattern 是复习的对象，不能"随便换一道"—— 换了结构就不是在复习那件事了。
    槽位允许自由 pattern 时，把它收窄到本次要复习的 pattern；槽位写死了别的
    pattern、或这个结构在难度区间内压根没有题目时，宁可跳过（交回 Planner 记 note），
    也不静默地复习成别的内容。

    脚手架则相反：内容里同一个结构只在某些呈现方式下存在（例如只有"先拆一拆"
    版本的 missing_part），熟练度对应的那一档没有这个结构的题时，退到离它最近的
    可用档 —— 换呈现方式不算换结构，做不上才是真的把复习丢了。
    """
    if not pattern_id:
        return slot
    if slot.pattern_id not in (None, pattern_id):
        return None
    pool = [
        item
        for item in bundle.items.values()
        if item.competency_id == slot.competency_id
        and item.pattern_id == pattern_id
        and slot.difficulty_min <= item.difficulty <= slot.difficulty_max
    ]
    if not pool:
        return None
    scaffolds = sorted({item.scaffold_level for item in pool})
    if preferred_scaffold not in scaffolds:
        preferred_scaffold = min(
            scaffolds, key=lambda s: (_scaffold_distance(s, preferred_scaffold), s)
        )
    return replace(slot, pattern_id=pattern_id, scaffold_level=preferred_scaffold)


def _warmup_intents_with_reviews(
    review_intents: List[LearningIntent],
    warmup_intents: List[LearningIntent],
    capacity: int,
) -> List[LearningIntent]:
    """复习优先占用热身段容量，剩余容量才安排常规热身。

    复习**不新开段落**：热身本来就是这个作用，多开一段会挤掉核心训练的时间预算。
    """
    if len(review_intents) >= capacity:
        return list(review_intents)
    kept = list(warmup_intents)[: capacity - len(review_intents)]
    return list(review_intents) + kept


def _story_for_target(bundle: ContentBundle, target: Optional[str]):
    """为聚焦能力挑一个故事。

    同一个能力可能有多站故事，按 order_index 取最靠前的一站 ——
    "从第一站开始"是内容作者的顺序，Planner 不重新发明排序。
    没有任何挑战节拍的故事不接（故事必须包含数学训练）。
    """
    if not target:
        return None
    candidates = [
        story
        for story in bundle.stories.values()
        if target in story.target_competencies and story.challenge_beats()
    ]
    if not candidates:
        return None
    return sorted(candidates, key=lambda s: (s.order_index, s.code))[0]


def _story_intent(
    story, target: str, graph: CompetencyGraph
) -> LearningIntent:
    """故事段也有意图 —— 它练的还是聚焦能力，只是换了个说法。

    故事不是"另一门课"，它是同一个学习意图的另一种交付方式：
    core 段是"练 make_ten"，story 段是"在车站的故事里练 make_ten"。
    所以这里刻意复用能力的名字，而不是新造一个教学概念。
    """
    competency = graph.competencies.get(target)
    name = competency.name if competency else target
    return LearningIntent(
        kind="story",
        competency_id=target,
        reason="故事训练《{}》：把{}放进故事里练".format(story.title, name),
        target_seconds=story.duration_min * 60,
    )


def _fill_story_segment(
    segment: PlanSegment,
    story,
    state: ChildLearningState,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    used_item_codes: List[str],
    notes: List[str],
) -> None:
    """一个挑战节拍出一道题，按节拍顺序排。

    节拍挂不到 slot、或槽位候选池为空时，**只跳过这一个节拍并记 note** ——
    不中断整个故事段。一个节拍没题是内容缺陷（Content Compiler 会拦），
    不该让孩子今天连故事都看不到。
    """
    segment.story_code = story.code
    for beat in story.challenge_beats():
        slot = bundle.slots.get(beat.slot_code or "")
        if slot is None:
            notes.append(
                "故事 {} 的挑战节拍 {} 没有可用的 slot".format(story.code, beat.code)
            )
            continue
        picked = select_item(
            slot, state, bundle, cfg, exclude_codes=used_item_codes
        )
        if picked is None:
            notes.append(
                "故事 {} 节拍 {} 的 slot {} 候选池为空".format(
                    story.code, beat.code, slot.code
                )
            )
            continue
        used_item_codes.append(picked.code)
        segment.items.append(picked)
        segment.beats.append(
            StoryBeatAssignment(
                beat_code=beat.code, slot_code=slot.code, item_code=picked.code
            )
        )


def _discovery_text(
    state: ChildLearningState,
    target: Optional[str],
    graph: CompetencyGraph,
    cfg: AlgorithmConfig,
) -> str:
    """今日发现 —— 核心是"和过去的自己比"，不是"今天做了多少题"。"""
    if target is None:
        return "今天你发现了：你已经把这一阶段的能力都拿下啦。"

    competency = graph.competencies.get(target)
    name = competency.name if competency else target
    signals = state.competencies.get(target)
    first = state.first_scaffold.get(target)
    current = cfg.scaffold_for_mastery(signals.mastery if signals else None)

    if first and first != current and current == "direct":
        return "今天你发现了：{}，第一次还要{}，现在可以{}了。".format(
            name, SCAFFOLD_LABELS.get(first, first), SCAFFOLD_LABELS.get(current, current)
        )
    if signals and signals.accuracy is not None and signals.accuracy >= 0.8:
        return "今天你发现了：{} 越来越顺了。".format(name)
    return "今天你发现了：{} 不止一种算法，找到自己最快的那一种。".format(name)


def build_daily_plan(
    state: ChildLearningState,
    graph: CompetencyGraph,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    budget_minutes: Optional[int] = None,
    due_reviews: Optional[List[ReviewItem]] = None,
) -> DailyPlan:
    """构建今日计划。

    `due_reviews`：scheduler.due_reviews() 的输出。传 None / 空列表时，
    计划行为与没有复习调度时**完全一致**（复习是叠加项，不是改造项）。
    有到期复习项时，它们优先占用热身段的容量。
    """
    plan_cfg = cfg.daily_plan()
    if budget_minutes is None:
        budget_minutes = int(plan_cfg.get("budget_minutes", 12))
    budget_minutes = max(
        int(plan_cfg.get("min_budget_minutes", 10)),
        min(int(plan_cfg.get("max_budget_minutes", 15)), budget_minutes),
    )

    notes: List[str] = []
    intents = derive_intents(state, graph, bundle, cfg)
    target = next_competency(state, graph, cfg)
    review_intents = _review_intents(due_reviews, cfg)
    if review_intents:
        notes.append(
            "今日复习 {} 项（间隔复习调度，优先占用热身段）：{}".format(
                len(review_intents),
                "、".join(i.competency_id + "::" + str(i.pattern_id) for i in review_intents),
            )
        )

    # 只保留"有内容可承接"的段落，时间按剩余段落比例重新分配
    ratio_by_type = {
        row["type"]: float(row["ratio"]) for row in plan_cfg.get("segments", [])
    }

    # 故事段是"聚焦能力的故事"，所以能不能开，取决于**这个能力**有没有故事，
    # 而不是内容库里有没有任何故事 —— 别人的故事帮不了今天的目标。
    story = _story_for_target(bundle, target)
    if story is not None:
        intents = intents + [_story_intent(story, target, graph)]

    active_types = [t for t in ratio_by_type if t != "story" or story is not None]
    if story is None:
        notes.append(
            NOTE_NO_STORY_FOR_TARGET.format(target)
            if bundle.stories
            else NOTE_NO_STORY_AT_ALL
        )
    total_ratio = sum(ratio_by_type[t] for t in active_types)

    segments: List[PlanSegment] = []
    used_item_codes: List[str] = []

    for segment_type in active_types:
        budget_s = int(
            round(budget_minutes * 60 * ratio_by_type[segment_type] / total_ratio)
        )
        segment = PlanSegment(type=segment_type, budget_s=budget_s)

        if segment_type == "discovery":
            segments.append(segment)
            continue

        if segment_type == "story":
            segment.intents = [
                i for i in intents if _INTENT_SEGMENT.get(i.kind) == "story"
            ]
            _fill_story_segment(
                segment, story, state, bundle, cfg, used_item_codes, notes
            )
            if not segment.items:
                segment.note = "故事段无法落题（内容缺失）"
            segments.append(segment)
            continue

        segment_intents = [
            i for i in intents if _INTENT_SEGMENT.get(i.kind) == segment_type
        ]
        if segment_type == "warmup" and review_intents:
            segment_intents = _warmup_intents_with_reviews(
                review_intents,
                segment_intents,
                int(cfg.intent_config().get("warmup_item_count", 2)),
            )
        segment.intents = segment_intents

        if segment_type == "warmup":
            count = int(cfg.intent_config().get("warmup_item_count", 2))
        elif segment_type == "thinking":
            count = int(cfg.intent_config().get("thinking_item_count", 1))
        else:
            count = int(cfg.intent_config().get("core_item_count", 3))

        # 同一段里有多个意图时，按意图数分配题量，避免后一个意图抢不到题
        per_intent = max(1, count // max(1, len(segment_intents)))

        for intent in segment_intents:
            slot = _find_slot(
                bundle,
                intent.competency_id,
                _SEGMENT_PURPOSES[segment_type],
                intent.pattern_id,
            )
            if slot is None:
                notes.append(
                    "内容缺失：{} 没有 purpose={} 的 slot，意图 [{}] 无法落地".format(
                        intent.competency_id, _SEGMENT_PURPOSES[segment_type], intent.kind
                    )
                )
                continue
            if intent.kind == "review":
                slot = _review_slot(
                    slot,
                    bundle,
                    intent.pattern_id,
                    effective_scaffold(slot, state, cfg),
                )
                if slot is None:
                    notes.append(
                        "复习无法落题：{} 的 {} 结构在可用槽位里没有候选题".format(
                            intent.competency_id, intent.pattern_id
                        )
                    )
                    continue
            segment.slot_code = slot.code
            segment.scaffold_level = effective_scaffold(slot, state, cfg)
            # 把今天已经排给其他段的题传下去：不传的话，选择器挑出重复题
            # 只能在这里被丢掉，而丢掉之后并没有重挑 —— 表现就是"这段明明
            # 有意图却一道题都没有"（迁移测试落地率低的机制之一）。
            picked = select_items(
                slot, state, bundle, cfg, per_intent, exclude_codes=used_item_codes
            )
            if intent.kind == "review" and intent.pattern_id:
                # 选择题在"该 pattern 在这个脚手架下没题"时会放宽 pattern 换一道。
                # 常规练习可以接受这种放宽，复习不行 —— 换了结构就不是在复习那件事。
                # 所以这里对选出的题做校验：不是被复习的结构，宁可不做。
                kept = [i for i in picked if i.pattern_id == intent.pattern_id]
                if len(kept) != len(picked):
                    notes.append(
                        "复习无法落题：{} 的 {} 结构在当前脚手架下没有候选题"
                        "（不换结构）".format(intent.competency_id, intent.pattern_id)
                    )
                picked = kept
            for item in picked:
                if item.code in used_item_codes:
                    continue
                used_item_codes.append(item.code)
                segment.items.append(item)

        if segment_type not in ("discovery",) and not segment.items:
            if not segment_intents:
                segment.note = "本段今日无意图"
            else:
                segment.note = "本段意图无法落题（内容缺失）"

        segments.append(segment)

    if not any(seg.items for seg in segments):
        notes.append("今日无可用题目：请检查内容与 slot 配置")

    return DailyPlan(
        child_id=state.child_id,
        budget_minutes=budget_minutes,
        segments=segments,
        intents=intents + review_intents,
        discovery=_discovery_text(state, target, graph, cfg),
        notes=notes,
    )


def render_plan(plan: DailyPlan, graph: CompetencyGraph, cfg: AlgorithmConfig) -> str:
    """把计划渲染成人能读的文本 —— 用来验证"Planner 决定的是意图，不是题目"。"""
    lines = [
        "📋 今日计划（{} 分钟，时间硬约束）".format(plan.budget_minutes),
    ]
    for seg in plan.segments:
        header = "  [{:<9}] {:>3}s".format(seg.type, seg.budget_s)
        detail = []
        if seg.story_code:
            detail.append("故事={}".format(seg.story_code))
        for intent in seg.intents:
            detail.append(
                "{}:{}".format(intent.kind, intent.competency_id)
            )
        if seg.scaffold_level:
            detail.append("脚手架={}".format(seg.scaffold_level))
        if seg.items:
            detail.append(
                "题目=" + ", ".join(
                    "{}（{}）".format(i.code, i.problem.get("prompt", "")) for i in seg.items
                )
            )
        elif seg.note:
            detail.append(seg.note)
        lines.append(header + ("  " + " | ".join(detail) if detail else ""))
    lines.append("  💡 " + plan.discovery)
    for note in plan.notes:
        lines.append("  ⚠️ " + note)
    return "\n".join(lines)
