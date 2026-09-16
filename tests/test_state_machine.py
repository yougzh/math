"""状态机测试：等级派生 / 升级门 / 回退。"""
from __future__ import annotations

import pytest

from backend.engine.learner import apply_attempt, new_state
from backend.engine.state_machine import (
    count_successful_patterns,
    derive_level,
    fallback_decision,
    is_mastered,
    next_competency,
    upgrade_decision,
)
from backend.engine.types import Signals, pattern_key


def _run(make_attempt, bundle, cfg, item_code, times, **kw):
    state = new_state("c")
    item = bundle.items[item_code]
    for index in range(1, times + 1):
        state = apply_attempt(state, make_attempt(index, item, **kw), bundle, cfg)
    return state


def test_level_is_encountering_below_min_samples(make_attempt, bundle, cfg):
    state = _run(make_attempt, bundle, cfg, "mt_dir_8_5", 3, correct=True)
    signals = state.competencies["make_ten"]
    assert signals.sample_count == 3
    assert derive_level(signals, cfg) == "encountering"


def test_correct_but_slow_and_hinted_caps_at_can_do(make_attempt, bundle, cfg):
    """P0 验收点：95% 正确但很慢且依赖提示，只能是 🌳 会做，不能更高。"""
    state = _run(
        make_attempt, bundle, cfg, "mt_dir_8_5", 12,
        correct=True, hints_used=2, thinking_ms=30000,
    )
    signals = state.competencies["make_ten"]
    assert signals.accuracy == pytest.approx(1.0)
    assert derive_level(signals, cfg) == "can_do"
    assert cfg.level_label("can_do") == "🌳 会做"


def test_slow_but_independent_cannot_reach_automatic(make_attempt, bundle, cfg):
    state = _run(
        make_attempt, bundle, cfg, "mt_dir_8_5", 12,
        correct=True, hints_used=0, thinking_ms=30000,
    )
    signals = state.competencies["make_ten"]
    assert derive_level(signals, cfg) == "proficient"
    assert cfg.level_label("proficient") == "⭐ 熟练"


def test_fast_independent_correct_reaches_automatic(make_attempt, bundle, cfg):
    state = _run(
        make_attempt, bundle, cfg, "mt_dir_8_5", 12,
        correct=True, hints_used=0, thinking_ms=1500,
    )
    signals = state.competencies["make_ten"]
    assert signals.fluency == pytest.approx(1.0)
    assert derive_level(signals, cfg) == "automatic"


def test_unsampled_signal_does_not_block_level(make_attempt, bundle, cfg):
    """没测过 ≠ 不达标：transfer 未采样不应把等级卡死。"""
    state = _run(
        make_attempt, bundle, cfg, "mt_dir_8_5", 10,
        correct=True, hints_used=0, thinking_ms=1500,
    )
    signals = state.competencies["make_ten"]
    assert signals.transfer is None
    assert derive_level(signals, cfg) == "automatic"


def test_scaffold_fading_boundaries(cfg):
    assert cfg.scaffold_for_mastery(None) == "blocks"
    assert cfg.scaffold_for_mastery(0.0) == "blocks"
    assert cfg.scaffold_for_mastery(0.49) == "blocks"
    assert cfg.scaffold_for_mastery(0.50) == "decompose"
    assert cfg.scaffold_for_mastery(0.74) == "decompose"
    assert cfg.scaffold_for_mastery(0.75) == "direct"
    assert cfg.scaffold_for_mastery(1.0) == "direct"


# ── 升级门 ─────────────────────────────────────────────────
def _mastered_signals(**overrides) -> Signals:
    base = dict(
        mastery=0.92,
        accuracy=0.95,
        fluency=0.85,
        independence=0.92,
        transfer=0.90,
        confidence=0.8,
        sample_count=12,
        assessment_samples=0,
    )
    base.update(overrides)
    return Signals(**base)


def _state_with_patterns(child_state, competency_id, codes):
    s = _mastered_signals()
    for code in codes:
        child_state.patterns[pattern_key(competency_id, code)] = s
    return s


def test_upgrade_requires_every_condition(bundle, cfg, graph):
    state = new_state("c")
    state.competencies["sd_add_10"] = _mastered_signals()
    _state_with_patterns(state, "sd_add_10", ["direct_compute", "combine"])
    state.competencies["make_ten"] = _mastered_signals()
    _state_with_patterns(state, "make_ten", ["decompose", "direct_compute"])

    decision = upgrade_decision(state, "make_ten", graph, cfg)
    assert decision.action == "upgrade", decision.reasons


@pytest.mark.parametrize(
    "field,value",
    [
        ("accuracy", 0.80),
        ("mastery", 0.60),
        ("independence", 0.70),
        ("transfer", 0.50),
        ("fluency", 0.40),
    ],
)
def test_upgrade_blocked_by_any_weak_signal(bundle, cfg, graph, field, value):
    state = new_state("c")
    state.competencies["sd_add_10"] = _mastered_signals()
    _state_with_patterns(state, "sd_add_10", ["direct_compute", "combine"])
    state.competencies["make_ten"] = _mastered_signals(**{field: value})
    _state_with_patterns(state, "make_ten", ["decompose", "direct_compute"])

    decision = upgrade_decision(state, "make_ten", graph, cfg)
    assert decision.action == "hold"
    assert any(field in reason for reason in decision.reasons), decision.reasons


def test_upgrade_blocked_when_only_probe_samples(bundle, cfg, graph):
    """D5：探测题不能直接产生升级。"""
    state = new_state("c")
    state.competencies["sd_add_10"] = _mastered_signals()
    _state_with_patterns(state, "sd_add_10", ["direct_compute", "combine"])
    state.competencies["make_ten"] = _mastered_signals(
        sample_count=5, assessment_samples=5
    )
    _state_with_patterns(state, "make_ten", ["decompose", "direct_compute"])

    decision = upgrade_decision(state, "make_ten", graph, cfg)
    assert decision.action == "hold"
    assert any("探测题" in r or "练习样本不足" in r for r in decision.reasons)


def test_upgrade_blocked_when_prerequisite_unmastered(bundle, cfg, graph):
    state = new_state("c")
    state.competencies["make_ten"] = _mastered_signals()
    _state_with_patterns(state, "make_ten", ["decompose", "direct_compute"])

    decision = upgrade_decision(state, "make_ten", graph, cfg)
    assert decision.action == "hold"
    assert any("sd_add_10" in r for r in decision.reasons), decision.reasons


def test_upgrade_blocked_without_second_pattern(bundle, cfg, graph):
    state = new_state("c")
    state.competencies["sd_add_10"] = _mastered_signals()
    _state_with_patterns(state, "sd_add_10", ["direct_compute", "combine"])
    state.competencies["make_ten"] = _mastered_signals()
    _state_with_patterns(state, "make_ten", ["decompose"])  # 只有一个 pattern 成功

    assert count_successful_patterns(state, "make_ten", graph, cfg) == 1
    decision = upgrade_decision(state, "make_ten", graph, cfg)
    assert decision.action == "hold"
    assert any("pattern 数不足" in r for r in decision.reasons), decision.reasons


def test_automatic_level_still_blocked_by_prerequisites(bundle, cfg, graph, make_attempt):
    state = _run(make_attempt, bundle, cfg, "mt_dir_8_5", 30, correct=True, thinking_ms=1500)
    signals = state.competencies["make_ten"]
    # 30 次全对、独立、快 —— 但前置能力没练过，仍然不能升级
    assert derive_level(signals, cfg) == "automatic"
    decision = upgrade_decision(state, "make_ten", graph, cfg)
    assert decision.action == "hold"
    assert any("前置能力未达标" in r for r in decision.reasons)


# ── 焦点能力 ───────────────────────────────────────────────
def test_focus_stays_on_touched_competency(make_attempt, bundle, cfg, graph):
    """孩子正在练 make_ten，焦点就不能跳到完全没接触过的 place_value。"""
    state = new_state("c")
    assert next_competency(state, graph, cfg) == "place_value"

    state = apply_attempt(
        state, make_attempt(1, bundle.items["mt_dir_8_5"]), bundle, cfg
    )
    assert next_competency(state, graph, cfg) == "make_ten"


# ── 回退 ───────────────────────────────────────────────────
def test_fallback_after_consecutive_wrong(make_attempt, bundle, cfg, graph):
    state = new_state("c")
    for index in range(1, 4):
        state = apply_attempt(
            state,
            make_attempt(index, bundle.items["mt_dir_8_7"], correct=False, submitted_answer=17),
            bundle,
            cfg,
        )
    decision = fallback_decision(state, "make_ten", graph, cfg)
    assert decision.action == "fallback"
    assert decision.target_competency_id == "sd_add_10"
    assert any("连续答错" in r for r in decision.reasons)


def test_no_fallback_with_two_wrong(make_attempt, bundle, cfg, graph):
    state = new_state("c")
    for index in range(1, 3):
        state = apply_attempt(
            state,
            make_attempt(index, bundle.items["mt_dir_8_7"], correct=False, submitted_answer=17),
            bundle,
            cfg,
        )
    assert fallback_decision(state, "make_ten", graph, cfg).action == "hold"


def test_no_fallback_without_prerequisites(bundle, cfg, graph):
    """place_value 没有前置能力，即使连续答错也无处可退。"""
    state = new_state("c")
    decision = fallback_decision(state, "place_value", graph, cfg)
    assert decision.action == "hold"
