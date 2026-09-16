"""模拟儿童长周期测试（P3）。

7 个不同类型的虚拟孩子 × 30 天 × 每天 10~15 分钟，每一步都走**真实引擎**：

    derive_intents → build_daily_plan(带 due_reviews) → select_items
    → 按画像规则作答 → apply_attempt → update_schedule

所有随机性都来自固定 seed 的 random.Random（不用真随机），同一个 seed
跑两次结果逐字段一致 —— 报告必须可复现，否则它只是段故事。

    python3 -m tools.simulate

体检要回答的 5 个问题（DoD）：
  Q1 是否过早升级  Q2 是否长期卡在简单题  Q3 回退是否频繁
  Q4 复习是否过载  Q5 是否出现难度断层

退出码：报告发现问题也返回 0（报告是给人看的，不是 CI 门禁）；
只有引擎真的崩了才返回非 0。
"""
from __future__ import annotations

import random
import sys
import traceback
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from backend.content.loader import (
    AUTO_SCAFFOLD,
    ChallengeSlot,
    ContentBundle,
    Item,
    load_bundle,
    validate_content,
)
from backend.engine.config import AlgorithmConfig, load_config
from backend.engine.graph import CompetencyGraph
from backend.engine.learner import apply_attempt, new_state
from backend.engine.planner import build_daily_plan
from backend.engine.scheduler import (
    due_reviews,
    pending_reviews,
    update_schedule,
)
from backend.engine.state_machine import (
    count_successful_patterns,
    derive_level,
    fallback_decision,
    is_mastered,
    next_competency,
    upgrade_decision,
)
from backend.engine.types import (
    Attempt,
    ChildLearningState,
    Signals,
    Telemetry,
    pattern_key,
)

SIM_DAYS = 30
ANALYSIS_WINDOW_DAYS = 30  # 报告口径：30 天

# ── 体检判据（报告口径，不是算法阈值；算法阈值一律来自 v0.yaml） ──
JUMP_ALERT = 2            # 相邻两次作答难度上升 ≥ 2 → 难度断层
STUCK_EASY_DAYS = 10      # 30 天里超过 10 天只做难度 1 的题 → 卡在简单题
FALLBACK_ALERT = 10       # 30 天里回退超过 10 次 → 回退频繁
REPEAT_ALERT = 5          # 同一道题出现超过 5 次 → 过度重复

LINE = "═" * 78
THIN = "─" * 78


# ══════════════════════════════════════════════════════════
#  一部分：作答建模
# ══════════════════════════════════════════════════════════
@dataclass
class Response:
    correct: bool
    hints_used: int
    thinking_ms: int
    submitted_answer: Any


@dataclass
class AttemptContext:
    day: int
    item: Item
    is_review: bool
    is_transfer_probe: bool
    days_since_pattern: Optional[int]  # None = 这个结构从没练过
    attempt_index: int                 # 当天第几次作答（从 0 开始）


def _ratio_threshold_ms(cfg: AlgorithmConfig, item: Item) -> int:
    return cfg.fluency_threshold_ms(item.pattern_id, item.interaction_type)


def _thinking_ms(cfg: AlgorithmConfig, item: Item, ratio: float, rng: random.Random) -> int:
    """思考时间 = 比值 × 该 (pattern, interaction_type) 的 fluency 阈值。

    带 ±10% 抖动，让信号是有波动的真实采样，而不是一条直线。
    """
    base = _ratio_threshold_ms(cfg, item)
    jitter = 0.9 + 0.2 * rng.random()
    return max(500, int(base * ratio * jitter))


def _wrong_answer(item: Item, rng: random.Random, style: str) -> Any:
    """构造一个"像孩子会犯的错"的答案，用来触发 diagnosis 的 error_rules。

    style:
      carry_missed —— 个位相加满十但不进位（答案差 10），命中 carry_missed / place_value_confusion
      off_by_one   —— 差 1，命中 counting_dependency
      off_by_ten   —— 差整十，命中 place_value_confusion
      mixed        —— 按 seed 在上面三种里挑
    """
    answer = item.answer
    if not isinstance(answer, int):
        return answer
    if style == "carry_missed":
        return answer - 10
    if style == "off_by_one":
        return answer - 1 if rng.random() < 0.5 else answer + 1
    if style == "off_by_ten":
        return answer + 10
    roll = rng.random()
    if roll < 0.5:
        return answer - 1 if rng.random() < 0.5 else answer + 1
    if roll < 0.85:
        return answer + 10
    return answer - 10


def _make_response(
    cfg: AlgorithmConfig,
    ctx: AttemptContext,
    rng: random.Random,
    correct: bool,
    hints: int = 0,
    ratio: float = 1.0,
    style: str = "mixed",
) -> Response:
    return Response(
        correct=correct,
        hints_used=hints,
        thinking_ms=_thinking_ms(cfg, ctx.item, ratio, rng),
        submitted_answer=ctx.item.answer if correct else _wrong_answer(ctx.item, rng, style),
    )


# ══════════════════════════════════════════════════════════
#  二部分：画像
# ══════════════════════════════════════════════════════════
@dataclass
class Entry:
    """画像的入学起点（显式声明，报告里公开）。

    为什么要起点：当前内容/配置下冷启动孩子会被锁在 place_value 上
    （该能力只有 1 个 pattern，永远满足不了 min_patterns=2 的升级条件），
    30 天里除了"重复做位值题"看不到任何其它行为。为了让每个画像在**它能暴露
    问题的那条路径**上被观察到，这里显式声明"这个孩子已经练到哪、练得怎么样"。
    冷启动路径单独作为附录跑一遍，不作弊、不隐藏。
    """

    focus: str
    focus_mastery: float = 0.55
    focus_accuracy: float = 0.62
    focus_independence: float = 0.9
    focus_fluency: float = 0.8
    focus_samples: int = 8
    mastered_prereqs: List[str] = field(default_factory=list)
    weak: Dict[str, float] = field(default_factory=dict)
    tried_patterns: int = 2


class ChildProfile:
    """虚拟孩子 = 一组"给定语境 → 作答结果"的确定规则。"""

    key = "base"
    name = "基础画像"
    description = ""
    seed = 20260915
    entry = Entry(focus="make_ten")

    # 子类覆盖
    def respond(self, ctx: AttemptContext, rng: random.Random, cfg: AlgorithmConfig) -> Response:
        raise NotImplementedError


class SlowStarter(ChildProfile):
    key = "slow_starter"
    name = "慢热型"
    description = "前 10 天正确率 0.35，之后逐步升到 0.75；思考偏慢、几乎不用提示"
    seed = 1101
    entry = Entry(
        focus="sd_add_10",
        focus_mastery=0.34,
        focus_accuracy=0.40,
        focus_independence=0.9,
        focus_fluency=0.7,
        focus_samples=5,
        tried_patterns=1,
    )

    # 前 RAMP_DAYS 天低正确率，之后线性爬到 0.75
    RAMP_DAYS = 10
    LOW = 0.35
    HIGH = 0.75

    def accuracy_at(self, day: int) -> float:
        if day <= self.RAMP_DAYS:
            return self.LOW
        span = max(1, ANALYSIS_WINDOW_DAYS - self.RAMP_DAYS)
        progress = min(1.0, (day - self.RAMP_DAYS) / float(span))
        return self.LOW + (self.HIGH - self.LOW) * progress

    def respond(self, ctx, rng, cfg):
        p = self.accuracy_at(ctx.day) - 0.06 * (ctx.item.difficulty - 1)
        correct = rng.random() < p
        hints = 1 if (not correct and rng.random() < 0.15) else 0
        return _make_response(cfg, ctx, rng, correct, hints, ratio=1.2)


class HintDependent(ChildProfile):
    key = "hint_dependent"
    name = "提示依赖型"
    description = "不用提示正确率 0.45；一提示就到 0.85，提示用得很凶"
    seed = 2202
    entry = Entry(focus="make_ten", focus_mastery=0.5, focus_accuracy=0.55,
                  mastered_prereqs=["sd_add_10"])
    SOLO_ACCURACY = 0.45
    HINTED_ACCURACY = 0.85
    HINT_SEEKING = 0.90  # 做不出来就求助的概率

    def respond(self, ctx, rng, cfg):
        p = self.SOLO_ACCURACY - 0.05 * (ctx.item.difficulty - 1)
        if rng.random() < p:
            return _make_response(cfg, ctx, rng, True, 0, ratio=1.4)
        if rng.random() < self.HINT_SEEKING:
            hints = 1 if rng.random() < 0.75 else 2
            correct = rng.random() < self.HINTED_ACCURACY
            return _make_response(cfg, ctx, rng, correct, hints, ratio=1.6)
        return _make_response(cfg, ctx, rng, False, 0, ratio=1.5)


class FluentButSloppy(ChildProfile):
    key = "fluent_but_sloppy"
    name = "会但很慢型"
    description = "正确率 0.92，但思考时间是阈值 2 倍以上；不提示、不放弃"
    seed = 3303
    entry = Entry(focus="make_ten", focus_mastery=0.6, focus_accuracy=0.85,
                  focus_fluency=0.5, mastered_prereqs=["sd_add_10"])
    BASE_ACCURACY = 0.92
    THINKING_RATIO = 2.2  # ratio 2.0~2.5 → fluency 采样落在 0.5 档

    def respond(self, ctx, rng, cfg):
        p = self.BASE_ACCURACY - 0.02 * (ctx.item.difficulty - 1)
        correct = rng.random() < p
        return _make_response(cfg, ctx, rng, correct, 0, ratio=self.THINKING_RATIO)


class FastButFragile(ChildProfile):
    key = "fast_but_fragile"
    name = "快但脆型"
    description = "常规题正确率 0.9 且很快；一换问题结构（迁移测试）掉到 0.3"
    seed = 4404
    entry = Entry(focus="make_ten", focus_mastery=0.6, focus_accuracy=0.9,
                  focus_fluency=0.9, focus_independence=0.95,
                  mastered_prereqs=["sd_add_10"])
    NORMAL_ACCURACY = 0.90
    TRANSFER_ACCURACY = 0.30

    def respond(self, ctx, rng, cfg):
        if ctx.is_transfer_probe:
            correct = rng.random() < self.TRANSFER_ACCURACY
            return _make_response(cfg, ctx, rng, correct, 0, ratio=1.1)
        p = self.NORMAL_ACCURACY - 0.02 * (ctx.item.difficulty - 1)
        correct = rng.random() < p
        return _make_response(cfg, ctx, rng, correct, 0, ratio=0.6)


class Plateau(ChildProfile):
    key = "plateau"
    name = "平台型"
    description = "正确率卡在 0.70 上下永远上不去；系统会怎么对待他"
    seed = 5505
    entry = Entry(focus="make_ten", focus_mastery=0.68, focus_accuracy=0.72,
                  focus_fluency=0.85, mastered_prereqs=["sd_add_10"])
    BASE_ACCURACY = 0.70

    def respond(self, ctx, rng, cfg):
        p = self.BASE_ACCURACY - 0.03 * (ctx.item.difficulty - 1)
        correct = rng.random() < p
        hints = 1 if (not correct and rng.random() < 0.2) else 0
        return _make_response(cfg, ctx, rng, correct, hints, ratio=1.3)


class Forgetful(ChildProfile):
    key = "forgetful"
    name = "健忘型"
    description = "当天练过就做得对（0.9），隔一天就忘（0.3）—— 复习调度的试金石"
    seed = 6606
    entry = Entry(focus="make_ten", focus_mastery=0.62, focus_accuracy=0.8,
                  mastered_prereqs=["sd_add_10"])
    SAME_DAY_ACCURACY = 0.90
    NEXT_DAY_ACCURACY = 0.30
    LONG_GAP_ACCURACY = 0.25

    def respond(self, ctx, rng, cfg):
        gap = ctx.days_since_pattern
        if gap is None or gap == 0:
            p = self.SAME_DAY_ACCURACY
        elif gap == 1:
            p = self.NEXT_DAY_ACCURACY
        else:
            p = self.LONG_GAP_ACCURACY
        p -= 0.03 * (ctx.item.difficulty - 1)
        correct = rng.random() < p
        hints = 1 if (not correct and rng.random() < 0.2) else 0
        return _make_response(cfg, ctx, rng, correct, hints, ratio=1.3)


class CarryPhobic(ChildProfile):
    key = "carry_phobic"
    name = "进位恐惧型"
    description = "除进位加法外都能过关；进位题正确率 0.25，错误一律是「忘记进 1」"
    seed = 7707
    entry = Entry(
        focus="carry_add",
        focus_mastery=0.62,
        focus_accuracy=0.78,
        focus_independence=0.9,
        focus_fluency=0.85,
        mastered_prereqs=["sd_add_10", "make_ten", "td_add_nocarry"],
        weak={"place_value": 0.55},
    )
    BASE_ACCURACY = 0.95
    CARRY_ACCURACY = 0.25

    def respond(self, ctx, rng, cfg):
        if ctx.item.competency_id == "carry_add":
            correct = rng.random() < self.CARRY_ACCURACY
            # 漏进位：13 + 8 答成 11，同时命中 carry_missed 与 place_value_confusion
            return _make_response(cfg, ctx, rng, correct, 0, ratio=1.2, style="carry_missed")
        p = self.BASE_ACCURACY - 0.02 * (ctx.item.difficulty - 1)
        correct = rng.random() < p
        return _make_response(cfg, ctx, rng, correct, 0, ratio=0.8)


PROFILES = [
    SlowStarter(),
    HintDependent(),
    FluentButSloppy(),
    FastButFragile(),
    Plateau(),
    Forgetful(),
    CarryPhobic(),
]


# ══════════════════════════════════════════════════════════
#  三部分：入学起点
# ══════════════════════════════════════════════════════════
def _mastered_signals(samples: int = 12) -> Signals:
    signals = Signals(
        mastery=0.92,
        accuracy=0.96,
        independence=0.95,
        transfer=0.95,
        fluency=0.9,
        confidence=0.95,
        sample_count=samples,
        probe_status="stable",
    )
    for name in ("mastery", "accuracy", "independence", "transfer", "fluency", "confidence"):
        signals.signal_sample_counts[name] = samples
    return signals


def _seed_mastered_competency(
    state: ChildLearningState,
    code: str,
    graph: CompetencyGraph,
    seq: int,
) -> int:
    state.competencies[code] = _mastered_signals()
    for pattern in graph.patterns_for(code):
        state.patterns[pattern_key(code, pattern.code)] = Signals(
            mastery=0.9, accuracy=1.0, sample_count=3
        )
    state.last_touched_seq[code] = seq
    return seq + 1


def build_entry_state(
    child_id: str,
    entry: Entry,
    graph: CompetencyGraph,
    cfg: AlgorithmConfig,
) -> ChildLearningState:
    """按画像的入学起点构造初始状态（不落库，只存在于模拟进程内）。"""
    state = new_state(child_id)
    seq = 1
    for code in entry.mastered_prereqs:
        seq = _seed_mastered_competency(state, code, graph, seq)

    # 明确"没掌握"的能力：只给低信号，不写 last_touched（不抢焦点）
    for code, mastery in entry.weak.items():
        state.competencies[code] = Signals(
            mastery=mastery,
            accuracy=mastery,
            independence=0.9,
            fluency=0.6,
            sample_count=4,
            probe_status="stable",
        )

    focus = entry.focus
    focus_signals = Signals(
        mastery=entry.focus_mastery,
        accuracy=entry.focus_accuracy,
        independence=entry.focus_independence,
        fluency=entry.focus_fluency,
        confidence=0.7,
        sample_count=entry.focus_samples,
        probe_status="stable",
    )
    for name in ("mastery", "accuracy", "independence", "fluency"):
        focus_signals.signal_sample_counts[name] = entry.focus_samples
    state.competencies[focus] = focus_signals

    for pattern in graph.patterns_for(focus)[: max(0, entry.tried_patterns)]:
        state.patterns[pattern_key(focus, pattern.code)] = Signals(
            mastery=0.85, accuracy=1.0, sample_count=2
        )
    state.last_touched_seq[focus] = seq
    state.attempts_seen = seq

    assert next_competency(state, graph, cfg) == focus, (
        "入学起点构造失败：期望焦点 {}，实际 {}".format(
            focus, next_competency(state, graph, cfg)
        )
    )
    return state


# ══════════════════════════════════════════════════════════
#  四部分：模拟用补槽
# ══════════════════════════════════════════════════════════
def with_practice_slots(
    bundle: ContentBundle, cfg: AlgorithmConfig
) -> Tuple[ContentBundle, List[str]]:
    """为"有题目、但没有可用训练槽"的能力补一个**模拟用**训练槽。

    ⚠️ 这不是内容：只存在于模拟进程内，不写回 content/**。
    理由：当前内容里 10 个能力中只有 make_ten / sd_add_10 有非 story 槽位，
    而 planner 的 story 段还没有意图映射，其余能力在真实引擎里"无题可出"。
    补槽让引擎的全部路径（教学 / 迁移 / 复习 / 回退）都能被跑到；
    "内容缺口"本身在报告里单独列出，不因为补槽而消失。
    """
    practice_purposes = {"practice", "teach", "review"}
    covered = {
        slot.competency_id
        for slot in bundle.slots.values()
        if slot.purpose in practice_purposes
    }
    by_competency: Dict[str, List[Item]] = {}
    for item in bundle.items.values():
        by_competency.setdefault(item.competency_id, []).append(item)

    added: List[str] = []
    slots = dict(bundle.slots)
    for competency_id in sorted(by_competency):
        if competency_id in covered:
            continue
        items = by_competency[competency_id]
        difficulties = [i.difficulty for i in items]
        seconds = sorted(i.estimated_seconds for i in items)
        code = "zzsim_{}_practice".format(competency_id)
        slots[code] = ChallengeSlot(
            code=code,
            competency_id=competency_id,
            difficulty_min=min(difficulties),
            difficulty_max=max(difficulties),
            purpose="practice",
            pattern_id=None,
            scaffold_level=AUTO_SCAFFOLD,
            estimated_seconds=seconds[len(seconds) // 2],
            selection_policy={"avoid_recent": 3},
        )
        added.append(code)

    cloned = ContentBundle(
        competencies=dict(bundle.competencies),
        patterns=dict(bundle.patterns),
        items=dict(bundle.items),
        misconceptions=dict(bundle.misconceptions),
        slots=slots,
        stories=dict(bundle.stories),
    )
    return cloned, added


# ══════════════════════════════════════════════════════════
#  五部分：模拟循环
# ══════════════════════════════════════════════════════════
@dataclass
class DayRecord:
    day: int
    focus: Optional[str]
    due_count: int            # 当日到期复习项（未做每日上限截断）
    planned_reviews: int      # 实际排进计划的复习项
    review_attempts: int
    probe_planned: int        # 计划里的迁移测试意图数
    probe_attempts: int       # 真正落到题上的迁移测试数
    notes: List[str] = field(default_factory=list)
    attempts: List[Attempt] = field(default_factory=list)


@dataclass
class ChildRun:
    key: str
    name: str
    description: str
    entry_focus: str
    days: List[DayRecord] = field(default_factory=list)
    attempts: List[Attempt] = field(default_factory=list)
    review_attempt_ids: set = field(default_factory=set)
    schedule: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    final_state: Optional[ChildLearningState] = None
    events: List[Dict[str, Any]] = field(default_factory=list)

    def all_attempts(self) -> List[Attempt]:
        return sorted(self.attempts, key=lambda a: a.seq)

    def review_attempts(self) -> List[Attempt]:
        return [a for a in self.all_attempts() if a.attempt_id in self.review_attempt_ids]

    def probe_attempts(self) -> List[Attempt]:
        return [a for a in self.all_attempts() if a.is_transfer_probe]

    def upgrades(self) -> List[Dict[str, Any]]:
        return [e for e in self.events if e["type"] == "upgrade"]

    def fallback_episodes(self) -> List[Dict[str, Any]]:
        """把连续几天、同一目标的回退合并成一次"回退事件"。"""
        episodes: List[Dict[str, Any]] = []
        for event in self.events:
            if event["type"] != "fallback":
                continue
            if episodes:
                last = episodes[-1]
                if last["target"] == event["target"] and event["day"] - last["last_day"] <= 1:
                    last["last_day"] = event["day"]
                    last["days"] += 1
                    continue
            episodes.append(
                {
                    "target": event["target"],
                    "first_day": event["day"],
                    "last_day": event["day"],
                    "days": 1,
                    "reasons": event["reasons"],
                }
            )
        return episodes

    def final_focus(self, graph: CompetencyGraph, cfg: AlgorithmConfig) -> Optional[str]:
        if self.final_state is None:
            return None
        return next_competency(self.final_state, graph, cfg)


def _attempt_from_response(
    seq: int, child_id: str, item: Item, response: Response, ctx: AttemptContext
) -> Attempt:
    active = min(2000, max(600, response.thinking_ms // 4))
    return Attempt(
        attempt_id="sim_{}_{:04d}".format(child_id, seq),
        child_id=child_id,
        item_id=item.code,
        competency_id=item.competency_id,
        pattern_id=item.pattern_id,
        correct=response.correct,
        telemetry=Telemetry(
            response_time_ms=response.thinking_ms + active,
            active_time_ms=active,
        ),
        seq=seq,
        hints_used=response.hints_used,
        hint_level_max=response.hints_used,
        scaffold_level=item.scaffold_level,
        interaction_type=item.interaction_type,
        is_transfer_probe=ctx.is_transfer_probe,
        submitted_answer=response.submitted_answer,
    )


def _switch_evidence(
    state: ChildLearningState,
    competency_id: Optional[str],
    graph: CompetencyGraph,
    cfg: AlgorithmConfig,
) -> Dict[str, Any]:
    """切换焦点时的证据快照 —— 体检要拿它对照升级门槛。"""
    if competency_id is None:
        return {}
    signals = state.competencies.get(competency_id)
    if signals is None:
        return {"sample_count": 0, "successful_patterns": 0}
    return {
        "mastery": signals.mastery,
        "accuracy": signals.accuracy,
        "independence": signals.independence,
        "transfer": signals.transfer,
        "fluency": signals.fluency,
        "practice_samples": signals.practice_samples,
        "successful_patterns": count_successful_patterns(state, competency_id, graph, cfg),
    }


def run_profile(
    profile: ChildProfile,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    graph: CompetencyGraph,
    days: int = SIM_DAYS,
) -> ChildRun:
    """跑一个画像的 30 天。全程走真实引擎，只把"孩子怎么作答"换成画像规则。"""
    state = build_entry_state(profile.key, profile.entry, graph, cfg)
    schedule: Dict[str, Dict[str, Any]] = {}
    rng = random.Random(profile.seed)
    run = ChildRun(
        key=profile.key,
        name=profile.name,
        description=profile.description,
        entry_focus=profile.entry.focus,
    )

    seq = 0
    prev_focus: Optional[str] = None
    last_pattern_day: Dict[str, int] = {}
    # 入学起点里"已经掌握"的能力不算本次模拟的升级事件
    upgraded: set = {
        code
        for code in list(state.competencies)
        if is_mastered(state, code, graph, cfg)
    }

    for day in range(1, days + 1):
        focus = next_competency(state, graph, cfg)
        if prev_focus is not None and focus != prev_focus:
            run.events.append(
                {
                    "day": day,
                    "type": "focus_switch",
                    "from": prev_focus,
                    "to": focus,
                    "evidence": _switch_evidence(state, prev_focus, graph, cfg),
                }
            )
        prev_focus = focus

        pending = pending_reviews(schedule, day, state, cfg)
        planned = due_reviews(schedule, day, state, cfg)
        plan = build_daily_plan(state, graph, bundle, cfg, due_reviews=planned)

        record = DayRecord(
            day=day,
            focus=focus,
            due_count=len(pending),
            planned_reviews=len(planned),
            review_attempts=0,
            probe_planned=sum(1 for i in plan.intents if i.kind == "probe_transfer"),
            probe_attempts=0,
            notes=list(plan.notes),
        )

        for segment in plan.segments:
            if segment.type == "discovery":
                continue
            for item in segment.items:
                seq += 1
                is_review = any(
                    i.kind == "review"
                    and i.competency_id == item.competency_id
                    and i.pattern_id == item.pattern_id
                    for i in segment.intents
                )
                is_probe = any(
                    i.kind == "probe_transfer" and i.competency_id == item.competency_id
                    for i in segment.intents
                )
                key = pattern_key(item.competency_id, item.pattern_id)
                ctx = AttemptContext(
                    day=day,
                    item=item,
                    is_review=is_review,
                    is_transfer_probe=is_probe,
                    days_since_pattern=(
                        None if key not in last_pattern_day else day - last_pattern_day[key]
                    ),
                    attempt_index=len(record.attempts),
                )
                response = profile.respond(ctx, rng, cfg)
                attempt = _attempt_from_response(seq, profile.key, item, response, ctx)
                state = apply_attempt(state, attempt, bundle, cfg)
                schedule = update_schedule(schedule, attempt, day, cfg)
                last_pattern_day[key] = day
                record.attempts.append(attempt)
                run.attempts.append(attempt)
                if is_review:
                    record.review_attempts += 1
                    run.review_attempt_ids.add(attempt.attempt_id)
                if is_probe:
                    record.probe_attempts += 1

        # 日终事件：升级 / 回退
        for code in sorted(set(state.competencies) | set(state.last_touched_seq)):
            if code in upgraded:
                continue
            if is_mastered(state, code, graph, cfg):
                upgraded.add(code)
                run.events.append({"day": day, "type": "upgrade", "competency": code})

        if focus is not None:
            decision = fallback_decision(state, focus, graph, cfg)
            if decision.action == "fallback":
                run.events.append(
                    {
                        "day": day,
                        "type": "fallback",
                        "competency": focus,
                        "target": decision.target_competency_id,
                        "reasons": list(decision.reasons),
                    }
                )

        run.days.append(record)

    run.schedule = schedule
    run.final_state = state
    return run


def run_simulation(
    profiles: List[ChildProfile],
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    graph: CompetencyGraph,
    days: int = SIM_DAYS,
) -> List[ChildRun]:
    return [run_profile(p, bundle, cfg, graph, days) for p in profiles]


def run_cold_start(
    bundle: ContentBundle, cfg: AlgorithmConfig, graph: CompetencyGraph, days: int = SIM_DAYS
) -> ChildRun:
    """冷启动路径：不加任何入学起点，看看新孩子第一天会遇到什么。

    这是最重要的对照 —— 它暴露的是"系统面对一个全新孩子"的真实行为。
    """
    profile = SlowStarter()
    profile.key = "cold_start"
    profile.name = "冷启动新孩子"
    state = new_state(profile.key)
    schedule: Dict[str, Dict[str, Any]] = {}
    run = ChildRun(
        key=profile.key,
        name=profile.name,
        description="不做任何入学起点设置的真正新孩子",
        entry_focus="（无）",
    )
    rng = random.Random(9001)
    seq = 0
    for day in range(1, days + 1):
        focus = next_competency(state, graph, cfg)
        pending = pending_reviews(schedule, day, state, cfg)
        plan = build_daily_plan(state, graph, bundle, cfg, due_reviews=due_reviews(schedule, day, state, cfg))
        record = DayRecord(
            day=day,
            focus=focus,
            due_count=len(pending),
            planned_reviews=0,
            review_attempts=0,
            probe_planned=sum(1 for i in plan.intents if i.kind == "probe_transfer"),
            probe_attempts=0,
            notes=list(plan.notes),
        )
        for segment in plan.segments:
            if segment.type == "discovery":
                continue
            for item in segment.items:
                seq += 1
                ctx = AttemptContext(day, item, False, False, None, len(record.attempts))
                response = profile.respond(ctx, rng, cfg)
                attempt = _attempt_from_response(seq, profile.key, item, response, ctx)
                state = apply_attempt(state, attempt, bundle, cfg)
                schedule = update_schedule(schedule, attempt, day, cfg)
                record.attempts.append(attempt)
                run.attempts.append(attempt)
        run.days.append(record)
    run.schedule = schedule
    run.final_state = state
    return run


# ══════════════════════════════════════════════════════════
#  六部分：体检（纯函数，可单独测试）
# ══════════════════════════════════════════════════════════
@dataclass
class Finding:
    question: str
    title: str
    detected: bool
    severity: str  # ok | warn | alert
    lines: List[str] = field(default_factory=list)


def _evidence_gaps(evidence: Dict[str, Any], cfg: AlgorithmConfig) -> List[str]:
    """对照 upgrade_requires，列出证据里没达标的项。"""
    requires = cfg.upgrade_requires()
    gaps: List[str] = []
    for name in ("accuracy", "mastery", "independence", "transfer", "fluency"):
        if name not in requires:
            continue
        value = evidence.get(name)
        threshold = float(requires[name])
        if value is None:
            gaps.append("{} 无证据".format(name))
        elif value < threshold:
            gaps.append("{}={:.2f} < {:.2f}".format(name, value, threshold))
    practice = evidence.get("practice_samples")
    if practice is not None and practice < cfg.min_practice_samples:
        gaps.append("练习样本 {} < {}".format(practice, cfg.min_practice_samples))
    rule = cfg.new_pattern_success_rule()
    need = int(rule.get("min_patterns", 2))
    got = evidence.get("successful_patterns")
    if got is not None and got < need:
        gaps.append("成功 pattern {} < {}".format(got, need))
    return gaps


def check_early_upgrade(
    runs: List[ChildRun], graph: CompetencyGraph, cfg: AlgorithmConfig
) -> Finding:
    """Q1：焦点被推到更靠后的能力上时，上一个能力真的达标了吗？

    "向前推进"用能力图的拓扑序判定：`to` 排在 `from` 之后才算推进。
    往前置方向移动（回退 / 遗忘后重练）不算过早升级 —— 那是系统在往回拉。
    """
    position = {code: i for i, code in enumerate(graph.topological_order())}
    lines: List[str] = []
    total_forward = 0
    for run in runs:
        switches = [e for e in run.events if e["type"] == "focus_switch"]
        forward = [e for e in switches if position.get(e["to"], -1) > position.get(e["from"], -1)]
        total_forward += len(forward)
        bad = [(e, _evidence_gaps(e.get("evidence", {}), cfg)) for e in forward]
        bad = [(e, gaps) for e, gaps in bad if gaps]
        if not bad:
            continue
        lines.append(
            "{}（{}）：焦点切换 {} 次（向前推进 {} 次），"
            "其中 {} 次在未达标时就推进".format(
                run.name, run.key, len(switches), len(forward), len(bad)
            )
        )
        for event, gaps in bad[:5]:
            lines.append(
                "    第 {} 天：{} → {}｜证据缺口：{}".format(
                    event["day"], event["from"], event["to"], "；".join(gaps)
                )
            )
    if lines:
        return Finding(
            question="Q1",
            title="过早升级（焦点在未达标时被推向更靠后的能力）",
            detected=True,
            severity="alert",
            lines=lines,
        )
    total_upgrades = sum(len(run.upgrades()) for run in runs)
    if total_upgrades:
        tail = "同期共完成 {} 次能力升级 —— 都是在前置达标后才升的。".format(total_upgrades)
    else:
        tail = "但代价在下面：没有任何一个孩子真的完成了升级。"
    return Finding(
        question="Q1",
        title="过早升级（焦点在未达标时被推向更靠后的能力）",
        detected=False,
        severity="ok",
        lines=[
            "{} 个孩子 30 天里共出现 {} 次「向前推进」，没有一次发生在证据不足时（0 次过早升级）。".format(
                len(runs), total_forward
            ),
            tail,
        ],
    )


def check_upgrade_blockers(
    runs: List[ChildRun], graph: CompetencyGraph, cfg: AlgorithmConfig
) -> Finding:
    """Q1 的补充：如果没人升级，卡在哪一条证据上？（给数字，不给感觉）"""
    lines: List[str] = []
    for run in runs:
        focus = run.final_focus(graph, cfg)
        if focus is None:
            lines.append("{}（{}）：已经把所有能力都拿下了".format(run.name, run.key))
            continue
        decision = upgrade_decision(run.final_state, focus, graph, cfg)
        status = "✅ 可推进" if decision.action == "upgrade" else "⏸ 暂不推进"
        reasons = "；".join(decision.reasons) if decision.reasons else "无"
        lines.append(
            "{}（{}）：最终焦点 {} → {}｜{}".format(
                run.name, run.key, focus, status, reasons
            )
        )
    return Finding(
        question="Q1b",
        title="还没升级的孩子卡在哪一条证据上（upgrade_decision 原话）",
        detected=False,
        severity="ok",
        lines=lines,
    )


def check_unupgradable_competencies(
    graph: CompetencyGraph, cfg: AlgorithmConfig
) -> Finding:
    """静态检查：有些能力**结构上**永远无法升级。

    upgrade_requires.require_new_pattern_success 要求"至少 2 个不同 pattern 成功过"，
    但能力图里有能力只挂了 1 个 pattern —— 那个能力的孩子永远凑不齐这一条。
    这是模拟跑出来的最严重的结构性问题：一个能力卡死，它下游的所有能力一起陪葬。
    """
    rule = cfg.new_pattern_success_rule()
    need = int(rule.get("min_patterns", 2))
    blocked = []
    for code in graph.topological_order():
        patterns = graph.patterns_for(code)
        if len(patterns) < need:
            blocked.append((code, [p.code for p in patterns]))
    lines: List[str] = []
    for code, patterns in blocked:
        downstream = graph.dependents(code)
        closure = [
            other
            for other in graph.topological_order()
            if code in graph.prerequisites(other, transitive=True)
        ]
        lines.append(
            "{}：只挂了 {} 个 pattern（{}），而升级需要 {} 个 → 该能力永远无法升级".format(
                code, len(patterns), "、".join(patterns) or "无", need
            )
        )
        if closure:
            lines.append(
                "    受牵连的下游能力 {} 个（含传递前置）：{}".format(
                    len(closure), "、".join(closure)
                )
            )
        _ = downstream
    return Finding(
        question="Q7",
        title="结构性缺陷：只有 1 个 pattern 的能力永远无法升级",
        detected=bool(blocked),
        severity="alert" if blocked else "ok",
        lines=lines or ["所有能力都挂了 ≥ {} 个 pattern，不存在结构性卡死。".format(need)],
    )


def signal_drift(run: ChildRun, focus_code: Optional[str], cfg: AlgorithmConfig) -> List[Dict[str, Any]]:
    """最终信号（EWMA）与 30 天样本均值的偏差。

    EWMA alpha 只有 0.25，有效记忆约十几次作答 —— 长期形成的习惯
    会被"最近几次恰好表现好"抹平。这个偏差就是证据。
    """
    from backend.engine.proficiency import samples_for_attempt

    totals: Dict[str, List[float]] = {}
    for attempt in run.all_attempts():
        for name, sample in samples_for_attempt(attempt, cfg).items():
            if sample is None or name == "confidence":
                continue
            totals.setdefault(name, []).append(sample)

    out: List[Dict[str, Any]] = []
    if focus_code is None or run.final_state is None:
        return out
    signals = run.final_state.competencies.get(focus_code)
    if signals is None:
        return out
    for name, values in sorted(totals.items()):
        final = signals.value(name)
        if final is None or not values:
            continue
        mean = sum(values) / float(len(values))
        out.append(
            {
                "signal": name,
                "final": final,
                "mean": mean,
                "drift": final - mean,
                "samples": len(values),
            }
        )
    return out


def render_signal_drift(
    runs: List[ChildRun], graph: CompetencyGraph, cfg: AlgorithmConfig
) -> List[str]:
    """只打印偏差 ≥ 0.05 的项 —— 偏差小的是噪声，偏差大的是"信号在骗人"。"""
    lines = [
        "口径：最终值 = 状态里的 EWMA（alpha={}）；样本均值 = 30 天每次作答的采样均值".format(
            cfg.ewma_alpha
        ),
        "{:<20} {:<12} {:>8} {:>10} {:>8} {:>8}".format(
            "画像", "信号", "最终值", "样本均值", "偏差", "采样数"
        ),
        THIN,
    ]
    flagged = 0
    for run in runs:
        focus = run.final_focus(graph, cfg)
        rows = signal_drift(run, focus, cfg)
        for row in rows:
            if abs(row["drift"]) < 0.05:
                continue
            flagged += 1
            lines.append(
                "{:<20} {:<12} {:>8} {:>10} {:>8} {:>8}".format(
                    "{}（{}）".format(run.name, run.key),
                    row["signal"],
                    _fmt(row["final"], 3),
                    _fmt(row["mean"], 3),
                    "{:+.3f}".format(row["drift"]),
                    row["samples"],
                )
            )
    if not flagged:
        lines.append("（没有任何信号出现 ≥ 0.05 的偏差）")
    return lines


def check_stuck_on_easy(
    runs: List[ChildRun], bundle: ContentBundle, cfg: AlgorithmConfig
) -> Finding:
    """Q2：30 天里超过 10 天只做难度 1 的题？"""
    lines: List[str] = []
    for run in runs:
        easy_days = []
        for record in run.days:
            if not record.attempts:
                continue
            difficulties = [
                bundle.items[a.item_id].difficulty
                for a in record.attempts
                if a.item_id in bundle.items
            ]
            if difficulties and max(difficulties) <= 1:
                easy_days.append(record.day)
        if len(easy_days) > STUCK_EASY_DAYS:
            lines.append(
                "{}（{}）：{} 天里有 {} 天全部是难度 1 的题（首日 {}，末日 {}）".format(
                    run.name, run.key, len(run.days), len(easy_days),
                    easy_days[0], easy_days[-1],
                )
            )
            lines.append(
                "    卡住时的焦点能力：{}".format(
                    "、".join(sorted({r.focus for r in run.days if r.focus})) or "（无）"
                )
            )
    return Finding(
        question="Q2",
        title="长期卡在简单题（> {} 天只做难度 1）".format(STUCK_EASY_DAYS),
        detected=bool(lines),
        severity="warn" if lines else "ok",
        lines=lines or ["没有孩子在 30 天里超过 {} 天只做难度 1 的题。".format(STUCK_EASY_DAYS)],
    )


def check_frequent_fallback(runs: List[ChildRun], cfg: AlgorithmConfig) -> Finding:
    """Q3：30 天里回退超过 10 次？"""
    lines: List[str] = []
    over = False
    for run in runs:
        episodes = run.fallback_episodes()
        raw_days = [e for e in run.events if e["type"] == "fallback"]
        if len(episodes) > FALLBACK_ALERT:
            over = True
            lines.append(
                "{}（{}）：回退事件 {} 起（原始命中 {} 天），超过 {} 次".format(
                    run.name, run.key, len(episodes), len(raw_days), FALLBACK_ALERT
                )
            )
            for episode in episodes[:5]:
                lines.append(
                    "    第 {}~{} 天 → 回退到 {}（{}）".format(
                        episode["first_day"], episode["last_day"], episode["target"],
                        episode["reasons"][0] if episode["reasons"] else "",
                    )
                )
        elif episodes:
            lines.append(
                "{}（{}）：回退 {} 起（原始命中 {} 天），未超阈值".format(
                    run.name, run.key, len(episodes), len(raw_days)
                )
            )
    if not lines:
        return Finding(
            question="Q3",
            title="回退频繁（> {} 次）".format(FALLBACK_ALERT),
            detected=False,
            severity="ok",
            lines=["没有任何孩子触发回退。"],
        )
    return Finding(
        question="Q3",
        title="回退频繁（> {} 次）".format(FALLBACK_ALERT),
        detected=over,
        severity="warn" if over else "ok",
        lines=lines,
    )


def check_review_overload(runs: List[ChildRun], cfg: AlgorithmConfig) -> Finding:
    """Q4：复习洪峰控制有没有守住？

    两个层次分开看，不能混为一谈：
      - 待复习积压（due_count > 上限）：说明当天到期的结构比能复习的多，
        按设计**顺延到次日**（release_pressure 只截断不丢项）—— 这是预警，不是故障
      - 计划排入（planned_reviews > 上限）：说明上限没守住，是机制故障（应当恒为 0）
    """
    max_per_day = int(cfg.get("review", "max_per_day"))
    lines: List[str] = []
    overloaded = False
    breached = 0
    for run in runs:
        over = [r for r in run.days if r.due_count > max_per_day]
        planned_breach = [r for r in run.days if r.planned_reviews > max_per_day]
        breached += len(planned_breach)
        peak = max([r.due_count for r in run.days] or [0])
        peak_planned = max([r.planned_reviews for r in run.days] or [0])
        if over:
            overloaded = True
            lines.append(
                "{}（{}）：{} 天待复习超过上限（上限 {}），峰值待复习 {} 项，"
                "首日超限第 {} 天，末日待复习 {} 项".format(
                    run.name, run.key, len(over), max_per_day, peak,
                    over[0].day, run.days[-1].due_count if run.days else 0,
                )
            )
            lines.append(
                "    当日实际排入复习最多 {} 项（超出部分按设计顺延到次日，不丢项）".format(
                    peak_planned
                )
            )
        else:
            lines.append(
                "{}（{}）：无超限，峰值待复习 {} 项".format(run.name, run.key, peak)
            )
    lines.append(
        "所有孩子的当日排入复习数都不超过上限（机制失守 {} 次）".format(breached)
    )
    return Finding(
        question="Q4",
        title="复习过载（待复习积压 > review.max_per_day={}）".format(max_per_day),
        detected=overloaded or breached > 0,
        severity="alert" if breached else ("warn" if overloaded else "ok"),
        lines=lines,
    )


def _difficulty_jumps(run: ChildRun, bundle: ContentBundle) -> List[Dict[str, Any]]:
    jumps: List[Dict[str, Any]] = []
    previous: Optional[Attempt] = None
    for attempt in run.all_attempts():
        if previous is not None:
            prev_item = bundle.items.get(previous.item_id)
            item = bundle.items.get(attempt.item_id)
            if prev_item is not None and item is not None:
                delta = item.difficulty - prev_item.difficulty
                if delta >= JUMP_ALERT:
                    jumps.append(
                        {
                            "from": previous,
                            "to": attempt,
                            "delta": delta,
                            "same_competency": previous.competency_id == attempt.competency_id,
                        }
                    )
        previous = attempt
    return jumps


def check_difficulty_jump(
    runs: List[ChildRun], bundle: ContentBundle, cfg: AlgorithmConfig
) -> Finding:
    """Q5：出现"难度 1 直接跳到难度 4"这种没有过渡的情况了吗？"""
    lines: List[str] = []
    detected = False
    for run in runs:
        jumps = _difficulty_jumps(run, bundle)
        if not jumps:
            continue
        detected = True
        same = [j for j in jumps if j["same_competency"]]
        cross = [j for j in jumps if not j["same_competency"]]
        lines.append(
            "{}（{}）：难度跳变 {} 次（同能力内 {} 次，换能力 {} 次），最大跨度 +{}".format(
                run.name, run.key, len(jumps), len(same), len(cross),
                max(j["delta"] for j in jumps),
            )
        )
        for jump in jumps[:3]:
            lines.append(
                "    第 {} 天（attempt #{}）：{} 难度 {} → {} 难度 {}（{}）".format(
                    _day_of(run, jump["to"]), jump["to"].seq,
                    jump["from"].item_id, bundle.items[jump["from"].item_id].difficulty,
                    jump["to"].item_id, bundle.items[jump["to"].item_id].difficulty,
                    "同能力内" if jump["same_competency"] else "跨能力",
                )
            )
    return Finding(
        question="Q5",
        title="难度断层（相邻两次难度上升 ≥ {}）".format(JUMP_ALERT),
        detected=detected,
        severity="warn" if detected else "ok",
        lines=lines or ["没有出现难度跨级上升。"],
    )


def _day_of(run: ChildRun, attempt: Attempt) -> int:
    for record in run.days:
        for a in record.attempts:
            if a.seq == attempt.seq:
                return record.day
    return -1


def check_repetition(
    runs: List[ChildRun], bundle: ContentBundle, cfg: AlgorithmConfig
) -> Finding:
    """附加体检：同一道题被反复出的次数（平台型画像最容易撞上）。"""
    from collections import Counter

    lines: List[str] = []
    detected = False
    for run in runs:
        counter = Counter(a.item_id for a in run.all_attempts())
        if not counter:
            continue
        item_id, count = counter.most_common(1)[0]
        if count > REPEAT_ALERT:
            detected = True
            lines.append(
                "{}（{}）：{} 被做了 {} 次（> {}），共 {} 道不同的题".format(
                    run.name, run.key, item_id, count, REPEAT_ALERT, len(counter)
                )
            )
        else:
            lines.append(
                "{}（{}）：最高重复 {} 次（{}），累计 {} 道不同的题".format(
                    run.name, run.key, count, item_id, len(counter)
                )
            )
    return Finding(
        question="Q6",
        title="同一道题重复次数（> {}）".format(REPEAT_ALERT),
        detected=detected,
        severity="warn" if detected else "ok",
        lines=lines,
    )


def run_health_checks(
    runs: List[ChildRun], bundle: ContentBundle, graph: CompetencyGraph, cfg: AlgorithmConfig
) -> List[Finding]:
    return [
        check_early_upgrade(runs, graph, cfg),
        check_upgrade_blockers(runs, graph, cfg),
        check_unupgradable_competencies(graph, cfg),
        check_stuck_on_easy(runs, bundle, cfg),
        check_frequent_fallback(runs, cfg),
        check_review_overload(runs, cfg),
        check_difficulty_jump(runs, bundle, cfg),
        check_repetition(runs, bundle, cfg),
    ]


# ══════════════════════════════════════════════════════════
#  七部分：报告
# ══════════════════════════════════════════════════════════
def _fmt(value: Optional[float], digits: int = 2) -> str:
    return "—" if value is None else "{:.{d}f}".format(value, d=digits)


def _profile_table(runs: List[ChildRun], graph: CompetencyGraph, cfg: AlgorithmConfig) -> List[str]:
    lines = [
        "{:<20} {:>6} {:>6} {:>8} {:>10} {:>16} {}".format(
            "画像", "作答", "升级", "复习题", "复习正确率", "最终焦点", "最终等级"
        ),
        THIN,
    ]
    for run in runs:
        reviews = run.review_attempts()
        review_correct = (
            sum(1 for a in reviews if a.correct) / float(len(reviews)) if reviews else None
        )
        focus = run.final_focus(graph, cfg)
        signals = run.final_state.competencies.get(focus) if run.final_state and focus else None
        level = cfg.level_label(derive_level(signals, cfg)) if signals else "—"
        lines.append(
            "{:<20} {:>6} {:>6} {:>8} {:>10} {:>16} {}".format(
                "{}（{}）".format(run.name, run.key),
                len(run.all_attempts()),
                len(run.upgrades()),
                len(reviews),
                _fmt(review_correct) if review_correct is not None else "—",
                focus or "—",
                level,
            )
        )
    return lines


def _review_section(runs: List[ChildRun], cfg: AlgorithmConfig) -> List[str]:
    max_per_day = int(cfg.get("review", "max_per_day"))
    lines = [
        "每日上限 review.max_per_day={}，间隔档位 {}".format(max_per_day, cfg.review_intervals_days),
        "「到期项次」= 每天待复习结构数之和；「排入」= 按上限截断后进计划的复习项次；"
        "「落空」= 因「该结构在当前脚手架下没有题」而没能落进计划（宁可跳过也不换结构）；「作答」= 实际落到的复习题",
        "{:<20} {:>8} {:>6} {:>6} {:>6} {:>10} {}".format(
            "画像", "到期项次", "排入", "落空", "作答", "复习正确率", "间隔档位分布"
        ),
        THIN,
    ]
    for run in runs:
        due = sum(r.due_count for r in run.days)
        planned = sum(r.planned_reviews for r in run.days)
        missed = sum(
            1 for r in run.days for note in r.notes if "复习无法落题" in note
        )
        reviews = run.review_attempts()
        correct = sum(1 for a in reviews if a.correct)
        histogram: Dict[int, int] = {}
        for entry in run.schedule.values():
            index = int(entry.get("interval_index", 0))
            histogram[index] = histogram.get(index, 0) + 1
        dist = " ".join(
            "第{}档×{}".format(i + 1, histogram[i]) for i in sorted(histogram)
        ) or "（空调度）"
        lines.append(
            "{:<20} {:>8} {:>6} {:>6} {:>6} {:>10} {}".format(
                "{}（{}）".format(run.name, run.key),
                due,
                planned,
                missed,
                len(reviews),
                _fmt(correct / float(len(reviews))) if reviews else "—",
                dist,
            )
        )
    return lines


def _probe_section(runs: List[ChildRun], cfg: AlgorithmConfig) -> List[str]:
    lines = [
        "{:<20} {:>10} {:>10} {:>10} {}".format(
            "画像", "计划天数", "落地次数", "落地率", "说明"
        ),
        THIN,
    ]
    for run in runs:
        planned_days = sum(1 for r in run.days if r.probe_planned)
        landed = len(run.probe_attempts())
        rate = (
            "{:.0%}".format(landed / float(planned_days)) if planned_days else "—"
        )
        if planned_days and not landed:
            note = "迁移测试一次都没落到题上"
        elif planned_days and landed:
            note = "首次迁移测试在第 {} 天".format(
                next(r.day for r in run.days if r.probe_attempts)
            )
        else:
            note = "从未安排迁移测试"
        lines.append(
            "{:<20} {:>10} {:>10} {:>10} {}".format(
                "{}（{}）".format(run.name, run.key), planned_days, landed, rate, note
            )
        )
    return lines


def render_report(
    runs: List[ChildRun],
    findings: List[Finding],
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    graph: CompetencyGraph,
    added_slots: List[str],
    cold_start: Optional[ChildRun] = None,
) -> str:
    lines: List[str] = []
    lines.append(LINE)
    lines.append("数学世界 · P3 模拟儿童长周期体检报告（{} 个画像 × {} 天）".format(len(runs), SIM_DAYS))
    lines.append(LINE)
    lines.append(
        "算法配置 v{} ｜ 内容：{} item / {} competency / {} slot ｜ 固定种子，可复现".format(
            cfg.version, len(bundle.items), len(bundle.competencies), len(bundle.slots)
        )
    )
    lines.append(
        "每天执行引擎计划产出的全部题目（warmup/core/story/thinking 段），"
        "每步走 apply_attempt + update_schedule"
    )
    lines.append("")

    lines.append("【一】孩子档案")
    lines.extend(_profile_table(runs, graph, cfg))
    lines.append("")

    lines.append("【二】五个体检问题（DoD）")
    for finding in findings:
        mark = {"alert": "❌", "warn": "⚠️", "ok": "✅"}[finding.severity]
        lines.append("")
        lines.append("{} {}：{}".format(mark, finding.question, finding.title))
        for line in finding.lines:
            lines.append("    " + line)
    lines.append("")

    lines.append("【三】信号漂移（EWMA 只记得最近十几次作答）")
    lines.extend(render_signal_drift(runs, graph, cfg))
    lines.append("")

    lines.append("【四】迁移测试落地情况")
    lines.extend(_probe_section(runs, cfg))
    lines.append("")
    lines.append("【五】复习调度实测")
    lines.extend(_review_section(runs, cfg))
    lines.append("")

    lines.append("【六】模拟设定说明")
    lines.append(
        "    模拟补槽 {} 个（仅存在于模拟进程，不写回 content/**）：{}".format(
            len(added_slots), "、".join(added_slots) if added_slots else "无"
        )
    )
    lines.append(
        "    每个画像的入学起点（focus / 已掌握前置 / 未掌握能力）都写在 tools/simulate.py 的 entry 字段里"
    )
    if cold_start is not None:
        lines.append("")
        lines.append("【七】冷启动对照（真正的新孩子，没有任何入学起点）")
        cold_focus = cold_start.final_focus(graph, cfg)
        lines.append(
            "    最终焦点：{}｜30 天作答 {} 次｜第 1 天计划产出题目数：{}".format(
                cold_focus,
                len(cold_start.attempts),
                len(cold_start.days[0].attempts) if cold_start.days else 0,
            )
        )
        if cold_start.days and cold_start.days[0].notes:
            lines.append("    第 1 天计划备注：{}".format(cold_start.days[0].notes[0]))
        done_items = sorted({a.item_id for a in cold_start.attempts})
        lines.append(
            "    30 天共做过 {} 道不同的题（全部属于 {}）".format(
                len(done_items),
                "、".join(sorted({a.competency_id for a in cold_start.attempts})) or "（无）",
            )
        )
    lines.append(LINE)
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════
#  八部分：入口
# ══════════════════════════════════════════════════════════
def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    days = SIM_DAYS
    if "--days" in argv:
        days = int(argv[argv.index("--days") + 1])

    bundle = load_bundle()
    cfg = load_config(0)
    graph = CompetencyGraph(bundle)

    problems = validate_content(bundle)
    graph_problems = graph.validate()

    sim_bundle, added_slots = with_practice_slots(bundle, cfg)

    runs = run_simulation(PROFILES, sim_bundle, cfg, graph, days)
    cold = run_cold_start(sim_bundle, cfg, graph, days)
    findings = run_health_checks(runs + [cold], sim_bundle, graph, cfg)

    print(render_report(runs, findings, sim_bundle, cfg, graph, added_slots, cold))
    print()
    print("内容校验：{} 条问题 ｜ 能力图校验：{} 条问题".format(len(problems), len(graph_problems)))
    for problem in problems[:5]:
        print("  ·", problem)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:  # 引擎崩了 → 非 0 退出码
        traceback.print_exc()
        raise SystemExit(1)
