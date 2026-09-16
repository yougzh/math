"""间隔复习调度测试（P3）。

要证明的事：
  1. 间隔按 1/3/7/14/30 推进（封顶在最后一档），答错退回第 1 档
  2. 复习按 pattern 记账，不是按题记账
  3. 只有"会了"（能力 mastery 达阈值）的结构才进复习队列
  4. 到期排序确定、每日上限生效且不丢项
  5. 没有复习项时，Planner 行为与引入复习之前完全一致（逐字节）
  6. 复习进热身段，且**只打指定的 pattern** —— 落不到题宁可不做，不静默换结构
"""
from __future__ import annotations

import json
from typing import Dict, List

from backend.engine.learner import new_state
from backend.engine.planner import build_daily_plan, render_plan
from backend.engine.scheduler import (
    ReviewItem,
    due_reviews,
    new_schedule,
    next_review_day,
    pending_reviews,
    release_pressure,
    update_schedule,
)
from backend.engine.types import Signals, pattern_key

DIRECT = pattern_key("make_ten", "direct_compute")


def _state_with(mastery: float, competency_id: str = "make_ten", child_id: str = "c"):
    """构造一个"某能力达到某熟练度"的状态。"""
    state = new_state(child_id)
    state.competencies[competency_id] = Signals(
        mastery=mastery,
        accuracy=0.9,
        independence=0.95,
        sample_count=8,
        probe_status="stable",
    )
    state.last_touched_seq[competency_id] = 8
    return state


def _entry(
    comp: str,
    pattern: str,
    due_day: int,
    interval_index: int = 0,
    consecutive_correct: int = 1,
    last_correct_day: int = 1,
) -> Dict[str, object]:
    return {
        "interval_index": interval_index,
        "consecutive_correct": consecutive_correct,
        "last_correct_day": last_correct_day,
        "due_day": due_day,
    }


def _review_item(comp: str, pattern: str, overdue: int = 0, due_day: int = 1) -> ReviewItem:
    return ReviewItem(
        pattern_key=pattern_key(comp, pattern),
        competency_id=comp,
        pattern_id=pattern,
        due_day=due_day,
        interval_index=0,
        last_correct_day=due_day - 1,
        consecutive_correct=1,
        overdue_days=overdue,
    )


# ── 间隔推进 ───────────────────────────────────────────────
def test_intervals_advance_on_consecutive_correct(bundle, cfg, make_attempt):
    """第 n 次连续答对 → 第 n+1 档间隔（1/3/7/14/30）。"""
    intervals: List[int] = list(cfg.review_intervals_days)
    assert intervals == [1, 3, 7, 14, 30]

    schedule = new_schedule()
    item = bundle.items["mt_dir_8_7"]
    day = 1
    for step, gap in enumerate(intervals):
        schedule = update_schedule(schedule, make_attempt(step + 1, item), day, cfg)
        entry = schedule[DIRECT]
        assert entry["consecutive_correct"] == step + 1
        assert entry["interval_index"] == step
        assert entry["last_correct_day"] == day
        # 每次都"按时复习"：下一次作答就发生在到期日
        day = day + gap
        assert entry["due_day"] == day
        assert next_review_day(schedule, DIRECT, cfg) == day


def test_interval_caps_at_last_step(bundle, cfg, make_attempt):
    """连续答对超过档位数后，间隔封顶在最后一档，interval_index 不越界。"""
    intervals: List[int] = list(cfg.review_intervals_days)
    schedule = new_schedule()
    item = bundle.items["mt_dir_8_7"]

    day = 1
    gaps: List[int] = []
    for seq in range(1, 9):  # 8 次 > 5 档
        schedule = update_schedule(schedule, make_attempt(seq, item), day, cfg)
        entry = schedule[DIRECT]
        assert 0 <= entry["interval_index"] <= len(intervals) - 1
        gaps.append(entry["due_day"] - day)
        day = entry["due_day"]

    assert gaps == intervals + [intervals[-1]] * (8 - len(intervals))


def test_wrong_answer_resets_to_first_step(bundle, cfg, make_attempt):
    """答错一次就退回第 1 档：明天再见，且保留"上次做对是哪天"。"""
    schedule = new_schedule()
    schedule = update_schedule(schedule, make_attempt(1, bundle.items["mt_dir_8_7"]), 1, cfg)
    schedule = update_schedule(schedule, make_attempt(2, bundle.items["mt_dir_5_6"]), 4, cfg)
    assert schedule[DIRECT]["interval_index"] == 1, "同 pattern 的另一道题也算连续答对"

    schedule = update_schedule(
        schedule,
        make_attempt(3, bundle.items["mt_dir_8_7"], correct=False, submitted_answer=99),
        11,
        cfg,
    )
    entry = schedule[DIRECT]
    assert entry["consecutive_correct"] == 0
    assert entry["interval_index"] == 0
    assert entry["due_day"] == 12, "答错 → 第 1 档（1 天）"
    assert entry["last_correct_day"] == 4, "答错不抹掉「上次做对是哪天」"


def test_schedule_is_keyed_by_pattern_not_by_item(bundle, cfg, make_attempt):
    """同能力不同 pattern 分开记账：换结构不是复习。"""
    schedule = new_schedule()
    schedule = update_schedule(schedule, make_attempt(1, bundle.items["mt_dir_8_7"]), 1, cfg)
    schedule = update_schedule(schedule, make_attempt(2, bundle.items["mt_dec_8_5"]), 1, cfg)
    schedule = update_schedule(schedule, make_attempt(3, bundle.items["mt_inc_8_5"]), 1, cfg)

    assert DIRECT in schedule
    assert pattern_key("make_ten", "decompose") in schedule
    assert pattern_key("make_ten", "increase") in schedule
    assert len(schedule) == 3


def test_update_schedule_is_pure_and_json_serializable(bundle, cfg, make_attempt):
    schedule = update_schedule(new_schedule(), make_attempt(1, bundle.items["mt_dir_8_7"]), 1, cfg)
    snapshot = json.loads(json.dumps(schedule))

    after = update_schedule(schedule, make_attempt(2, bundle.items["mt_dir_8_7"]), 2, cfg)
    assert schedule == snapshot, "update_schedule 不能修改入参"
    assert after == json.loads(json.dumps(after)), "调度状态必须可 JSON 往返"


# ── 到期查询 ───────────────────────────────────────────────
def test_due_reviews_excludes_not_yet_due(bundle, cfg, make_attempt):
    schedule = update_schedule(new_schedule(), make_attempt(1, bundle.items["mt_dir_8_7"]), 1, cfg)
    state = _state_with(0.9)
    assert schedule[DIRECT]["due_day"] == 2

    assert due_reviews(schedule, 1, state, cfg) == []
    assert [r.pattern_key for r in due_reviews(schedule, 2, state, cfg)] == [DIRECT]
    assert [r.pattern_key for r in due_reviews(schedule, 9, state, cfg)] == [DIRECT]
    assert due_reviews(schedule, 9, state, cfg)[0].overdue_days == 7


def test_low_mastery_pattern_never_enters_review_queue(bundle, cfg, make_attempt):
    """还没学会的东西属于教学，不属于复习。"""
    threshold = float(cfg.get("review", "min_mastery"))
    schedule = update_schedule(new_schedule(), make_attempt(1, bundle.items["mt_dir_8_7"]), 1, cfg)

    below = _state_with(threshold - 0.01)
    assert due_reviews(schedule, 5, below, cfg) == []

    boundary = _state_with(threshold)
    assert len(due_reviews(schedule, 5, boundary, cfg)) == 1, "刚好达阈值 → 进队列"


def test_unsampled_competency_never_enters_review_queue(bundle, cfg, make_attempt):
    schedule = update_schedule(new_schedule(), make_attempt(1, bundle.items["mt_dir_8_7"]), 1, cfg)

    assert due_reviews(schedule, 5, new_state("c"), cfg) == [], "没有信号 ≠ 会了"

    no_mastery = new_state("c")
    no_mastery.competencies["make_ten"] = Signals(accuracy=1.0, sample_count=5)
    assert due_reviews(schedule, 5, no_mastery, cfg) == [], "mastery 未采样 → 不进队列"


def test_due_reviews_sorted_by_overdue_then_pattern_key(cfg):
    """逾期越久越先复习；同逾期按 pattern_key 稳定排序（排序必须确定）。"""
    schedule = {
        pattern_key("make_ten", "total"): _entry("make_ten", "total", due_day=14),
        pattern_key("make_ten", "increase"): _entry("make_ten", "increase", due_day=10),
        pattern_key("make_ten", "direct_compute"): _entry("make_ten", "direct_compute", due_day=10),
    }
    state = _state_with(0.9)
    items = due_reviews(schedule, 15, state, cfg)

    assert [r.overdue_days for r in items] == [5, 5, 1]
    assert [r.pattern_id for r in items] == ["direct_compute", "increase", "total"]


# ── 每日上限（复习洪峰控制） ───────────────────────────────
def test_daily_cap_truncates_and_drops_nothing(cfg):
    """超上限的项今天不做，但必须还在 schedule 里（次日以更大逾期顺延）。"""
    patterns = ["direct_compute", "increase", "total", "reverse", "missing_part"]
    schedule = {
        pattern_key("make_ten", p): _entry("make_ten", p, due_day=5) for p in patterns
    }
    state = _state_with(0.9)
    max_per_day = int(cfg.get("review", "max_per_day"))

    pending = pending_reviews(schedule, 10, state, cfg)
    today = due_reviews(schedule, 10, state, cfg)

    assert len(pending) == 5
    assert len(today) == max_per_day
    assert [r.pattern_key for r in today] == [r.pattern_key for r in pending[:max_per_day]]

    for item in pending[max_per_day:]:
        assert next_review_day(schedule, item.pattern_key, cfg) == item.due_day
        assert item.pattern_key in schedule, "被压下去的项不能丢"


def test_release_pressure_is_a_plain_prefix(cfg):
    items = [_review_item("make_ten", "p{}".format(i), overdue=9 - i) for i in range(5)]
    max_per_day = int(cfg.get("review", "max_per_day"))
    assert release_pressure(items, cfg) == items[:max_per_day]

    empty = release_pressure([], cfg)
    assert empty == []


# ── 与 Planner 的接口 ──────────────────────────────────────
def test_plan_is_identical_when_no_reviews_due(bundle, cfg, graph):
    """due_reviews=None / [] 时，计划行为与没有复习调度时逐字节一致。"""
    state = _state_with(0.4)  # 焦点能力没掌握 → 复习队列为空
    assert due_reviews(new_schedule(), 1, state, cfg) == []

    base = build_daily_plan(state, graph, bundle, cfg)
    unset = build_daily_plan(state, graph, bundle, cfg, due_reviews=None)
    empty = build_daily_plan(state, graph, bundle, cfg, due_reviews=[])

    text = render_plan(base, graph, cfg)
    assert render_plan(unset, graph, cfg) == text
    assert render_plan(empty, graph, cfg) == text
    assert [(s.type, s.note, [i.code for i in s.items]) for s in base.segments] == [
        (s.type, s.note, [i.code for i in s.items]) for s in unset.segments
    ]


def test_plan_puts_review_into_warmup_with_the_reviewed_pattern(bundle, cfg, graph):
    """有复习项时：进热身段、排在最前、落到的题必须就是被复习的那个 pattern。"""
    state = _state_with(0.6)  # 脚手架 decompose：这个结构在内容里确实有题
    review = _review_item("make_ten", "decompose", overdue=2)
    plan = build_daily_plan(state, graph, bundle, cfg, due_reviews=[review])

    warmup = next(s for s in plan.segments if s.type == "warmup")
    assert warmup.intents and warmup.intents[0].kind == "review"
    assert warmup.intents[0].pattern_id == "decompose"

    assert any(i.kind == "review" and i.pattern_id == "decompose" for i in plan.intents)
    assert warmup.items, "复习必须真的落到题上"
    assert all(i.pattern_id == "decompose" for i in warmup.items)
    assert "今日复习 1 项" in " ".join(plan.notes)


def test_plan_never_silently_reviews_a_different_pattern(bundle, cfg, graph):
    """复习打不到指定结构时，宁可跳过并说明，也不静默换成别的结构。"""
    state = _state_with(0.8)
    review = _review_item("make_ten", "pattern_that_does_not_exist", overdue=3)
    plan = build_daily_plan(state, graph, bundle, cfg, due_reviews=[review])

    warmup = next(s for s in plan.segments if s.type == "warmup")
    assert warmup.items == []
    assert any("复习无法落题" in note for note in plan.notes)


def test_review_pins_scaffold_but_keeps_the_pattern(bundle, cfg, graph):
    """熟练度对应的那一档没有这个结构的题时，退到最近可用档 —— 但不换结构。

    make_ten::decompose 只有 blocks/decompose 两个版本的题；mastery=0.8 的
    孩子按熟练度该用 direct，direct 档没有 decompose 时不能让选择题换成
    direct_compute（那是另一个结构），而要退档把这个结构做完。
    """
    state = _state_with(0.8)
    review = _review_item("make_ten", "decompose", overdue=2)
    plan = build_daily_plan(state, graph, bundle, cfg, due_reviews=[review])

    warmup = next(s for s in plan.segments if s.type == "warmup")
    assert warmup.items, "复习必须落到题上（换脚手架不算换结构）"
    assert all(i.pattern_id == "decompose" for i in warmup.items)
    assert warmup.scaffold_level != "direct", "熟练度那一档没有这个结构的题，应退档"
    assert not any("复习无法落题" in note for note in plan.notes)


def test_reviews_come_before_regular_warmup(bundle, cfg, graph):
    """复习优先占用热身段容量：复习占满后，常规热身让位。"""
    from backend.engine.intent import derive_intents

    # 孩子练过 sd_add_10（会产生常规热身意图），焦点能力 make_ten 还没掌握
    state = _state_with(0.4)
    state.competencies["sd_add_10"] = Signals(
        mastery=0.8, accuracy=0.9, independence=0.95, sample_count=8, probe_status="stable"
    )
    state.last_touched_seq["make_ten"] = 20
    state.last_touched_seq["sd_add_10"] = 18
    state.patterns[pattern_key("sd_add_10", "direct_compute")] = Signals(
        sample_count=4, accuracy=1.0
    )

    regular = [i for i in derive_intents(state, graph, bundle, cfg) if i.kind == "warmup"]
    assert regular, "这个状态必须有常规热身意图，否则测不到'让位'"

    capacity = int(cfg.intent_config().get("warmup_item_count", 2))
    reviews = [
        _review_item("sd_add_10", "direct_compute"),
        _review_item("sd_add_10", "combine"),
    ]
    plan = build_daily_plan(state, graph, bundle, cfg, due_reviews=reviews[:capacity])
    warmup = next(s for s in plan.segments if s.type == "warmup")
    assert [i.kind for i in warmup.intents] == ["review"] * len(reviews[:capacity])
    assert all(i.kind != "warmup" for i in warmup.intents)
