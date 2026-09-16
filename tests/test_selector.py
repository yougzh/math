"""Selector 单元测试（P3 体检修复的回归）。

对齐模拟体检暴露的三个问题：
  1. 难度推进：同一 slot 连续作答，难度单调不降、单步 ≤ +1，且能真的往上走
     （不再被池子里数量占优的低难度题钉死）；
  2. 跨天不重复：slot 未声明 selection_policy.avoid_recent 时回落到配置缺省值；
  3. 不虚报推进：到达 slot 难度上限后稳定在上限，池子缺中间档时不跳级。

用自建 mini 内容（固定难度梯度），不依赖 content/** 的当前形态。
"""
from __future__ import annotations

import pytest

from backend.content.loader import ChallengeSlot, ContentBundle, Item
from backend.engine.learner import apply_attempt
from backend.engine.selector import select_item
from backend.engine.types import ChildLearningState, Signals

COMPETENCY = "cmp"


# ── mini 内容与状态 ────────────────────────────────────────
def _item(code, difficulty, competency=COMPETENCY, pattern="pat", scaffold="direct"):
    return Item(
        code=code,
        competency_id=competency,
        pattern_id=pattern,
        difficulty=difficulty,
        scaffold_level=scaffold,
        interaction_type="number_pad",
        estimated_seconds=20,
        problem={"text": code},
        answer=0,
    )


def _mini_bundle(levels=(1, 2, 3, 4, 5), per_level=3):
    items = {}
    for difficulty in levels:
        for suffix in ("a", "b", "c")[:per_level]:
            code = "it_{}_d{}_{}".format(COMPETENCY, difficulty, suffix)
            items[code] = _item(code, difficulty)
    return ContentBundle(items=items)


def _slot(difficulty_min=1, difficulty_max=5, competency=COMPETENCY, **policy):
    return ChallengeSlot(
        code="test_slot",
        competency_id=competency,
        difficulty_min=difficulty_min,
        difficulty_max=difficulty_max,
        scaffold_level="direct",
        selection_policy=dict(policy),
    )


def _state(mastery=None, recent=()):
    state = ChildLearningState(child_id="kid")
    if mastery is not None:
        state.competencies[COMPETENCY] = Signals(mastery=mastery, sample_count=8)
    state.recent_attempts = list(recent)
    return state


# ── 1. 难度推进：单调不降、单步 ≤ +1 ───────────────────────
def test_difficulty_climbs_one_step_at_a_time(cfg, make_attempt):
    """同一 slot 连续作答（每次都做对）：难度只升不降，且每次最多升 1 档。"""
    bundle = _mini_bundle()
    slot = _slot()
    state = _state()  # 该能力还没有证据 → 从区间下限开始

    seen = []
    for seq in range(1, 41):
        item = select_item(slot, state, bundle, cfg)
        assert item is not None
        seen.append(item.difficulty)
        state = apply_attempt(state, make_attempt(seq, item, correct=True), bundle, cfg)

    assert seen == sorted(seen), "难度出现了回落：{}".format(seen)
    assert all(b - a <= 1 for a, b in zip(seen, seen[1:])), "难度跳级：{}".format(seen)
    assert seen[0] == 1 and seen[-1] == 5, "难度没有真的沿区间推进：{}".format(seen)


def test_low_difficulty_supply_does_not_pin_the_child(cfg, make_attempt):
    """低难度题在池子里占绝对多数时，熟练度仍能把难度顶上去（Q2 的回归）。"""
    bundle = _mini_bundle(per_level=3)
    for difficulty in (1, 2):
        for extra in range(20):  # 难度 1/2 的题远多于高难度题
            code = "it_{}_d{}_x{:02d}".format(COMPETENCY, difficulty, extra)
            bundle.items[code] = _item(code, difficulty)

    slot = _slot()
    state = _state()
    for seq in range(1, 11):
        item = select_item(slot, state, bundle, cfg)
        assert item is not None
        state = apply_attempt(state, make_attempt(seq, item, correct=True), bundle, cfg)

    assert item.difficulty >= 4, "熟练度足够时仍被低难度题钉住：{}".format(item.difficulty)


# ── 2. 未声明 avoid_recent 时的避重回退 ────────────────────
def test_slot_without_policy_falls_back_to_default_avoid_recent(cfg, make_attempt):
    """slot 没写 selection_policy.avoid_recent → 用配置缺省窗口避开最近做过的题。"""
    assert cfg.default_avoid_recent() > 0, "缺省避重窗口必须为正，否则回退等于没回退"

    bundle = _mini_bundle()
    slot = _slot()  # 未声明任何 selection_policy
    state = _state(
        mastery=0.0,
        recent=[
            make_attempt(1, bundle.items["it_cmp_d3_a"]),
            make_attempt(2, bundle.items["it_cmp_d3_b"]),
        ],
    )

    item = select_item(slot, state, bundle, cfg)
    assert item is not None
    assert item.code == "it_cmp_d3_c", "最近做过的题没有被避开：{}".format(item.code)


def test_explicit_zero_avoid_recent_still_disables_dedup(cfg, make_attempt):
    """内容作者显式写 avoid_recent: 0 仍然关闭避重，不被缺省值覆盖。"""
    bundle = _mini_bundle()
    slot = _slot(avoid_recent=0)
    state = _state(
        mastery=0.0,
        recent=[
            make_attempt(1, bundle.items["it_cmp_d3_a"]),
            make_attempt(2, bundle.items["it_cmp_d3_b"]),
        ],
    )

    item = select_item(slot, state, bundle, cfg)
    assert item is not None
    assert item.code == "it_cmp_d3_a"


# ── 3. 到顶与缺档：不虚报推进 ──────────────────────────────
def test_no_false_progress_at_difficulty_ceiling(cfg, make_attempt):
    """到 slot 难度上限后稳定在上限：不越界、也不继续"上升"。"""
    bundle = _mini_bundle()
    slot = _slot(difficulty_min=1, difficulty_max=3)
    state = _state()

    seen = []
    for seq in range(1, 26):
        item = select_item(slot, state, bundle, cfg)
        assert item is not None
        assert item.difficulty <= 3, "越过了 slot 声明的难度上限：{}".format(item.difficulty)
        seen.append(item.difficulty)
        state = apply_attempt(state, make_attempt(seq, item, correct=True), bundle, cfg)

    assert seen[-10:] == [3] * 10, "到顶后没有稳定住：{}".format(seen)


def test_single_band_slot_never_pretends_to_progress(cfg, make_attempt):
    """区间写死 1~1 的槽（慢热型体检现场）：选择器不硬拗，也不报错。"""
    bundle = _mini_bundle()
    slot = _slot(difficulty_min=1, difficulty_max=1)
    state = _state()

    for seq in range(1, 11):
        item = select_item(slot, state, bundle, cfg)
        assert item is not None
        assert item.difficulty == 1
        state = apply_attempt(state, make_attempt(seq, item, correct=True), bundle, cfg)


def test_missing_middle_band_does_not_skip_a_level(cfg, make_attempt):
    """池子缺中间难度档时：宁可先停在原难度，也不一次跳两级（Q5 的硬约束）。"""
    bundle = _mini_bundle(levels=(1, 3, 4, 5))  # 没有难度 2
    slot = _slot()
    state = _state(mastery=1.0, recent=[make_attempt(1, bundle.items["it_cmp_d1_a"])])

    item = select_item(slot, state, bundle, cfg)
    assert item is not None
    assert item.difficulty == 1, "缺档时跳级了：{}".format(item.difficulty)


def test_scaffold_fade_does_not_jump_a_level(cfg, make_attempt):
    """脚手架递退与难度耦合（blocks=1 / decompose=2 / direct=3）时：

    熟练度一次跃过递退阈值（首条证据直接作为初值）会让目标脚手架从 blocks
    直接跳到 direct。此时选择器要放宽到含中间难度的层，而不是从难度 1 跳到 3。
    """
    bundle = ContentBundle(
        items={
            "it_s1": _item("it_s1", 1, scaffold="blocks"),
            "it_s2": _item("it_s2", 2, scaffold="decompose"),
            "it_s3": _item("it_s3", 3, scaffold="direct"),
        }
    )
    slot = ChallengeSlot(
        code="fade_slot",
        competency_id=COMPETENCY,
        difficulty_min=1,
        difficulty_max=3,
        scaffold_level="auto",
        selection_policy={},
    )

    state = _state()  # 无证据 → blocks
    seen = []
    for seq in range(1, 4):
        item = select_item(slot, state, bundle, cfg)
        assert item is not None
        seen.append(item.difficulty)
        state = apply_attempt(state, make_attempt(seq, item, correct=True), bundle, cfg)

    assert seen == [1, 2, 3], "脚手架递退时跳了难度：{}".format(seen)


# ── 4. 跨能力切换：难度是能力内标尺 ────────────────────────
def test_cross_competency_switch_uses_new_competency_target(cfg, make_attempt):
    """换能力时不沿用上一能力的难度：新能力的起点由它自己的熟练度决定。"""
    bundle = _mini_bundle()
    for difficulty in (1, 2, 3):
        for suffix in ("a", "b"):
            code = "it_other_d{}_{}".format(difficulty, suffix)
            bundle.items[code] = _item(code, difficulty, competency="other")

    slot = _slot(competency="other", difficulty_min=1, difficulty_max=3)
    state = _state(
        mastery=0.95,
        recent=[
            make_attempt(1, bundle.items["it_cmp_d5_a"]),  # 上个能力练到了难度 5
            make_attempt(2, bundle.items["it_cmp_d5_b"]),
        ],
    )

    item = select_item(slot, state, bundle, cfg)
    assert item is not None
    assert item.competency_id == "other"
    assert item.difficulty == 1, "新能力没有证据时应从自己的区间下限开始：{}".format(
        item.difficulty
    )
