"""Planner / Intent / Selector 测试。

核心要证明三件事：
  1. Planner 决定的是"学习意图"，不是题目
  2. 脚手架随熟练度自然递退：blocks → decompose → direct
  3. 系统不会在孩子还没达标时跳到后面的能力（如两位数进位）
"""
from __future__ import annotations

from dataclasses import replace

import pytest

from backend.content.loader import ChallengeSlot, ContentBundle
from backend.engine.intent import derive_intents
from backend.engine.learner import apply_attempt, new_state
from backend.engine.planner import build_daily_plan, render_plan
from backend.engine.selector import effective_scaffold, select_item
from backend.engine.state_machine import next_competency
from backend.engine.types import Signals, pattern_key

INTENT_KINDS = {"warmup", "repair", "teach", "strengthen_fluency", "probe_transfer"}


def _state_with_mastery(mastery: float, child_id: str = "c"):
    state = new_state(child_id)
    state.competencies["make_ten"] = Signals(
        mastery=mastery,
        accuracy=0.8,
        independence=0.9,
        sample_count=6,
        probe_status="stable",
    )
    state.last_touched_seq["make_ten"] = 6
    return state


# ── 意图层 ─────────────────────────────────────────────────
def test_intents_are_intents_not_items(bundle, cfg, graph):
    state = _state_with_mastery(0.4)
    intents = derive_intents(state, graph, bundle, cfg)
    assert intents
    for intent in intents:
        assert intent.kind in INTENT_KINDS
        assert intent.competency_id in bundle.competencies
        assert not intent.competency_id.startswith("mt_"), "意图里不能出现题目"
        assert intent.reason, "每条意图都必须可解释"


def test_focus_never_jumps_ahead(bundle, cfg, graph):
    """make_ten 未达标时，不允许出现 carry_add / td_add_nocarry 的意图。"""
    state = _state_with_mastery(0.4)
    intents = derive_intents(state, graph, bundle, cfg)
    targets = {i.competency_id for i in intents}
    assert targets <= {"make_ten", "sd_add_10"}
    assert "carry_add" not in targets
    assert "td_add_nocarry" not in targets
    assert next_competency(state, graph, cfg) == "make_ten"


def test_warmup_excludes_focus_competency(bundle, cfg, graph):
    state = _state_with_mastery(0.8)
    intents = derive_intents(state, graph, bundle, cfg)
    warmups = [i for i in intents if i.kind == "warmup"]
    assert all(i.competency_id != "make_ten" for i in warmups)


def test_warmup_targets_previously_practised_competency(bundle, cfg, graph, make_attempt):
    state = new_state("c")
    for seq, code in enumerate(["s10_3_4", "s10_5_2", "s10_6_1", "s10_2_3"], start=1):
        state = apply_attempt(
            state, make_attempt(seq, bundle.items[code]), bundle, cfg
        )

    state.competencies["make_ten"] = Signals(
        mastery=0.4, accuracy=0.7, independence=0.9, sample_count=6
    )
    state.last_touched_seq["make_ten"] = 10

    intents = derive_intents(state, graph, bundle, cfg)
    warmups = [i for i in intents if i.kind == "warmup"]
    assert warmups and warmups[0].competency_id == "sd_add_10"


def test_repair_intent_wins_after_consecutive_wrong(bundle, cfg, graph, make_attempt):
    state = new_state("c")
    for seq in range(1, 4):
        state = apply_attempt(
            state,
            make_attempt(
                seq, bundle.items["mt_dir_8_7"], correct=False, submitted_answer=17
            ),
            bundle,
            cfg,
        )
    intents = derive_intents(state, graph, bundle, cfg)
    kinds = {i.kind for i in intents}
    assert "repair" in kinds
    repair = [i for i in intents if i.kind == "repair"][0]
    assert repair.competency_id == "sd_add_10"
    assert "teach" not in kinds, "修复期间不推进新内容"


def test_transfer_probe_intent_appears_when_mastery_is_high(bundle, cfg, graph):
    state = _state_with_mastery(0.8)
    intents = derive_intents(state, graph, bundle, cfg)
    probe = [i for i in intents if i.kind == "probe_transfer"]
    assert probe, [i.kind for i in intents]
    assert probe[0].pattern_id not in state.patterns


def test_strengthen_fluency_intent_when_slow(bundle, cfg, graph):
    """会，但是慢 —— 本产品的核心痛点必须能被识别。"""
    state = new_state("c")
    state.competencies["make_ten"] = Signals(
        mastery=0.85, accuracy=0.95, independence=0.95,
        fluency=0.20, sample_count=8, probe_status="stable",
    )
    state.patterns[pattern_key("make_ten", "decompose")] = Signals(sample_count=3, accuracy=1.0)
    state.last_touched_seq["make_ten"] = 8

    intents = derive_intents(state, graph, bundle, cfg)
    assert any(i.kind == "strengthen_fluency" for i in intents), [i.kind for i in intents]


# ── 脚手架递退 ─────────────────────────────────────────────
@pytest.mark.parametrize(
    "mastery,expected",
    [(0.30, "blocks"), (0.60, "decompose"), (0.85, "direct")],
)
def test_scaffold_fades_with_mastery(bundle, cfg, graph, mastery, expected):
    state = _state_with_mastery(mastery)
    plan = build_daily_plan(state, graph, bundle, cfg)
    core = [s for s in plan.segments if s.type == "core"]
    assert core and core[0].scaffold_level == expected
    assert all(item.scaffold_level == expected for item in core[0].items)


def test_scaffold_progression_over_time(bundle, cfg, graph):
    """同一条能力链，脚手架随时间从 blocks 走到 direct。"""
    progression = []
    for mastery in (0.2, 0.4, 0.6, 0.75, 0.9):
        state = _state_with_mastery(mastery)
        plan = build_daily_plan(state, graph, bundle, cfg)
        core = [s for s in plan.segments if s.type == "core"]
        progression.append(core[0].scaffold_level if core else None)
    assert progression == ["blocks", "blocks", "decompose", "direct", "direct"]


def test_selector_picks_untried_pattern_for_transfer(bundle, cfg, graph):
    state = _state_with_mastery(0.7)
    state.patterns[pattern_key("make_ten", "decompose")] = Signals(sample_count=3, accuracy=1.0)

    slot = bundle.slots["core_make_ten_transfer"]
    item = select_item(slot, state, bundle, cfg)
    assert item is not None
    assert item.pattern_id != "decompose", "迁移测试必须换问题结构"


def test_selector_avoids_recent_items(bundle, cfg, graph, make_attempt):
    state = _state_with_mastery(0.7)
    state.recent_attempts = [
        make_attempt(1, bundle.items["mt_dec_8_5"]),
        make_attempt(2, bundle.items["mt_dec_7_6"]),
    ]
    slot = bundle.slots["core_make_ten_practice"]
    item = select_item(slot, state, bundle, cfg)
    assert item.code not in {"mt_dec_8_5", "mt_dec_7_6"}


def test_selector_respects_explicit_scaffold(bundle, cfg, graph):
    state = _state_with_mastery(0.9)  # 熟练度高 → auto 会选 direct
    warmup_slot = bundle.slots["core_sd_add_10_warmup"]
    assert effective_scaffold(warmup_slot, state, cfg) == "direct"
    item = select_item(warmup_slot, state, bundle, cfg)
    assert item.scaffold_level == "direct"


# ── 选题：难度推进 + 跨天不重复（P3 模拟体检的回归） ────────
def test_selector_rotates_across_consecutive_picks(bundle, cfg, graph, make_attempt):
    """同一槽位、状态不变（只有最近作答在增长）时，连续选题不能总出同一道题。

    回归的是"核心训练槽每天出同一道题"：避重窗口如果小于一天的量，
    昨天做过的题今天还会排在第一位。
    """
    state = _state_with_mastery(0.4)
    slot = bundle.slots["core_make_ten_practice"]

    picked = []
    for seq in range(1, 7):
        item = select_item(slot, state, bundle, cfg)
        assert item is not None
        picked.append(item.code)
        state.recent_attempts.append(make_attempt(seq, item))

    assert len(set(picked)) >= 3, "连续选题仍在重复同一道题：{}".format(picked)


def test_avoid_recent_window_covers_a_full_day(bundle, cfg, graph, make_attempt):
    """跨天不重复：昨天核心槽做过的那道题，今天不能再排第一。

    一天的计划是**整批生成**的，核心槽那一道之后还有故事段 / 思维段，
    它们会把"最近 N 次作答"占满。声明窗口只有 3 时，窗口整体被当天后半段
    吃掉，昨天做过的题不在窗口里，于是每天都挑同一道题 —— 这就是 Q6 的机制。
    这里用 5 道别的能力的题模拟当天剩余段落：核心槽那一道之后间隔 6 次作答，
    声明窗口 3 看不见它，配置下限（≥ 一天的作答量）看得见。

    只断言"相邻两天不同"，不要求池子更大时也不能连续三天不同 —— 池子大小
    不由 selector 决定，池子只有两道题时两两交替已经是最优。
    """
    slot = bundle.slots["core_make_ten_practice"]
    fillers = bundle.items_for(competency_id="sd_add_10")[:5]
    assert len(fillers) == 5, "需要 5 道别的能力的题来模拟当天剩余段落"

    state = _state_with_mastery(0.4)
    picked = []
    seq = 0
    for _ in range(3):
        item = select_item(slot, state, bundle, cfg)
        assert item is not None
        picked.append(item.code)
        seq += 1
        state.recent_attempts.append(make_attempt(seq, item))
        # 当天剩余段落：故事 / 思维 / 迁移，都属于别的能力
        for filler in fillers:
            seq += 1
            state.recent_attempts.append(make_attempt(seq, filler))

    for yesterday, today in zip(picked, picked[1:]):
        assert yesterday != today, "核心训练槽跨天重复同一道题：{}".format(picked)


def test_difficulty_rises_with_mastery(bundle, cfg, graph):
    """熟练度越高，选出的题越难；但永远落在 slot 声明的难度区间内。"""
    slot = bundle.slots["core_make_ten_practice"]

    untouched = new_state("c")  # mastery 为 None：这个能力还没有任何证据
    strong = _state_with_mastery(0.9)

    low = select_item(slot, untouched, bundle, cfg)
    high = select_item(slot, strong, bundle, cfg)
    assert low is not None and high is not None
    assert high.difficulty >= low.difficulty, (low.code, low.difficulty, high.code, high.difficulty)
    for item in (low, high):
        assert slot.difficulty_min <= item.difficulty <= slot.difficulty_max


def test_target_difficulty_mapping_contract(cfg):
    """熟练度 → 目标难度的映射契约（数字全部来自 config/algorithm/v0.yaml）。"""
    # 没有证据 / 刚到下限阈值 → 目标贴着区间下限
    assert cfg.target_difficulty(None, 1, 4) == pytest.approx(float(1))
    assert cfg.target_difficulty(0.0, 1, 4) == pytest.approx(float(1))
    # 到上限阈值 → 目标到达区间上限，且不越过
    assert cfg.target_difficulty(1.0, 1, 4) == pytest.approx(float(4))
    assert cfg.target_difficulty(0.99, 3, 5) <= 5.0
    # 难度区间退化（min == max）时不放大：单档槽只能给那一档
    assert cfg.target_difficulty(1.0, 3, 3) == pytest.approx(float(3))

    values = [cfg.target_difficulty(m / 10.0, 1, 5) for m in range(0, 11)]
    assert values == sorted(values), "目标难度必须随熟练度单调不减：{}".format(values)
    assert all(1.0 <= value <= 5.0 for value in values), values


def test_single_item_pool_never_returns_none(bundle, cfg, graph, make_attempt):
    """池里只有一道题（且刚做过）时：不崩、不返回 None、也不换到别的能力。"""
    only = min(
        (i for i in bundle.items.values() if i.competency_id == "make_ten"),
        key=lambda i: i.code,
    )
    mini = ContentBundle(items={only.code: only})
    slot = ChallengeSlot(
        code="t_solo",
        competency_id=only.competency_id,
        difficulty_min=only.difficulty,
        difficulty_max=only.difficulty,
        scaffold_level=only.scaffold_level,
    )
    state = _state_with_mastery(0.9)

    first = select_item(slot, state, bundle=mini, cfg=cfg)
    assert first is not None and first.code == only.code

    state.recent_attempts.append(make_attempt(1, first))
    again = select_item(slot, state, bundle=mini, cfg=cfg)
    assert again is not None and again.code == only.code


def test_explicit_avoid_recent_overrides_default(bundle, cfg, graph, make_attempt):
    """槽位显式写的 avoid_recent 优先于配置缺省值（含显式写 0 = 关闭避重）。"""
    from backend.engine.selector import _avoid_recent_window

    # 内容里显式写了 3，但配置下限更高：有效窗口取两者中更大的那个
    declared = bundle.slots["core_make_ten_practice"]
    assert _avoid_recent_window(declared, cfg) >= cfg.min_avoid_recent() > 0

    # 显式写 0 → 关闭避重，缺省值与下限都不生效（内容作者的表达优先）
    off = replace(declared, selection_policy={"avoid_recent": 0})
    assert _avoid_recent_window(off, cfg) == 0

    state = _state_with_mastery(0.4)
    picked = []
    for seq in range(1, 4):
        item = select_item(off, state, bundle, cfg)
        assert item is not None
        picked.append(item.code)
        state.recent_attempts.append(make_attempt(seq, item))
    assert picked[0] == picked[-1], "显式关闭避重后仍在避重：{}".format(picked)


# ── 每日计划 ───────────────────────────────────────────────
def test_plan_budget_is_respected(bundle, cfg, graph):
    state = _state_with_mastery(0.4)
    plan = build_daily_plan(state, graph, bundle, cfg, budget_minutes=12)
    total = sum(s.budget_s for s in plan.segments)
    assert plan.budget_minutes == 12
    assert abs(total - 720) <= 4, total


def test_plan_budget_is_clamped(bundle, cfg, graph):
    state = _state_with_mastery(0.4)
    assert build_daily_plan(state, graph, bundle, cfg, 2).budget_minutes == 10
    assert build_daily_plan(state, graph, bundle, cfg, 60).budget_minutes == 15


def test_plan_has_expected_segments(bundle, cfg, graph):
    state = _state_with_mastery(0.4)
    plan = build_daily_plan(state, graph, bundle, cfg)
    types = [s.type for s in plan.segments]
    assert types == ["warmup", "core", "story", "thinking", "discovery"]


def test_story_segment_carries_items_from_the_target_story(bundle, cfg, graph):
    """故事段必须落在这个能力自己的故事上，一个挑战节拍一道题。"""
    state = _state_with_mastery(0.4)
    plan = build_daily_plan(state, graph, bundle, cfg)
    story_seg = next(s for s in plan.segments if s.type == "story")

    story = bundle.stories["station_03_make_ten"]
    assert story_seg.story_code == story.code
    assert [b.beat_code for b in story_seg.beats] == [
        b.code for b in story.challenge_beats()
    ]
    assert len(story_seg.items) == len(story.challenge_beats())
    for beat, item in zip(story_seg.beats, story_seg.items):
        assert beat.item_code == item.code
        assert item.competency_id == "make_ten"


def test_story_items_do_not_repeat_core_items(bundle, cfg, graph):
    """同一天里，故事段和核心段不能出同一道题。"""
    state = _state_with_mastery(0.4)
    plan = build_daily_plan(state, graph, bundle, cfg)
    core = {i.code for s in plan.segments if s.type == "core" for i in s.items}
    story = {i.code for s in plan.segments if s.type == "story" for i in s.items}
    assert core and story
    assert not (core & story)


def test_plan_without_story_for_target_notes_it(bundle, cfg, graph):
    """聚焦能力没有故事时，故事段整段让位，且 note 说清原因。"""
    from backend.content.loader import ContentBundle

    storyless = ContentBundle(
        competencies=dict(bundle.competencies),
        patterns=dict(bundle.patterns),
        items=dict(bundle.items),
        misconceptions=dict(bundle.misconceptions),
        slots=dict(bundle.slots),
    )
    assert storyless.stories == {}

    state = _state_with_mastery(0.4)
    plan = build_daily_plan(state, graph, storyless, cfg)
    assert "story" not in [s.type for s in plan.segments]
    assert "故事段暂缺内容" in " ".join(plan.notes)


def test_plan_discovery_compares_with_past_self(bundle, cfg, graph, make_attempt):
    """今日发现要和"过去的自己"比，不是报题量。"""
    state = new_state("c")
    state.first_scaffold["make_ten"] = "blocks"
    state.competencies["make_ten"] = Signals(
        mastery=0.9, accuracy=0.95, independence=0.95, sample_count=10
    )
    state.last_touched_seq["make_ten"] = 10

    plan = build_daily_plan(state, graph, bundle, cfg)
    assert "第一次还要用积木摆" in plan.discovery
    assert "题" not in plan.discovery


def test_plan_is_renderable(bundle, cfg, graph):
    state = _state_with_mastery(0.4)
    text = render_plan(build_daily_plan(state, graph, bundle, cfg), graph, cfg)
    assert "今日计划" in text
    assert "时间硬约束" in text
    assert "[" in text


def test_plan_never_targets_later_competencies(bundle, cfg, graph):
    """最终把关：计划里不允许出现尚未满足前置的能力。"""
    state = _state_with_mastery(0.4)
    plan = build_daily_plan(state, graph, bundle, cfg)
    for intent in plan.intents:
        assert intent.competency_id not in {"carry_add", "borrow_sub", "td_add_nocarry"}
    for segment in plan.segments:
        for item in segment.items:
            assert item.competency_id not in {"carry_add", "borrow_sub", "td_add_nocarry"}
