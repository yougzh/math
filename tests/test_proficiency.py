"""熟练度纯函数测试（含 ADR-0003 时间语义）。"""
from __future__ import annotations

import pytest

from backend.engine.proficiency import (
    attempt_quality,
    samples_for_attempt,
    time_factor,
    update_signals,
)
from backend.engine.types import Signals


def test_first_sample_initialises_directly(make_attempt, bundle, cfg):
    """首条证据直接作为初值，不按 current=0 平滑（否则冷启动严重低估）。"""
    item = bundle.items["mt_dir_8_5"]
    attempt = make_attempt(1, item, correct=True)
    updated = update_signals(Signals(), attempt, cfg)
    assert updated.accuracy == pytest.approx(1.0)
    assert updated.mastery == pytest.approx(1.0)
    assert updated.sample_count == 1


def test_ewma_moves_toward_sample(make_attempt, bundle, cfg):
    item = bundle.items["mt_dir_8_5"]
    state = Signals()
    state = update_signals(state, make_attempt(1, item, correct=True), cfg)
    first = state.accuracy
    state = update_signals(state, make_attempt(2, item, correct=False), cfg)
    assert first == pytest.approx(1.0)
    assert state.accuracy == pytest.approx(1.0 - cfg.ewma_alpha)
    assert 0.0 < state.accuracy < 1.0


def test_hint_reduces_independence_but_not_to_zero(make_attempt, bundle, cfg):
    item = bundle.items["mt_dec_8_5"]
    no_hint = samples_for_attempt(make_attempt(1, item, hints_used=0), cfg)
    one_hint = samples_for_attempt(make_attempt(1, item, hints_used=1), cfg)
    many_hints = samples_for_attempt(make_attempt(1, item, hints_used=5), cfg)

    assert no_hint["independence"] == pytest.approx(1.0)
    assert one_hint["independence"] < no_hint["independence"]
    assert many_hints["independence"] == pytest.approx(
        cfg.get("independence_sampling", "min_sample")
    )


def test_mastery_discounted_when_hint_used(make_attempt, bundle, cfg):
    item = bundle.items["mt_dec_8_5"]
    clean = samples_for_attempt(make_attempt(1, item, correct=True, hints_used=0), cfg)
    hinted = samples_for_attempt(make_attempt(1, item, correct=True, hints_used=1), cfg)
    assert clean["mastery"] == pytest.approx(1.0)
    assert hinted["mastery"] < clean["mastery"]


def test_fluency_uses_thinking_time_not_response(make_attempt, bundle, cfg):
    """ADR-0003：操作慢不等于计算慢。"""
    item = bundle.items["mt_dir_8_5"]

    fast_think_slow_hand = make_attempt(
        1, item, correct=True, thinking_ms=2000, active_ms=4000
    )
    slow_think_fast_hand = make_attempt(
        2, item, correct=True, thinking_ms=9000, active_ms=300
    )

    assert time_factor(fast_think_slow_hand, cfg) > time_factor(slow_think_fast_hand, cfg)


def test_idle_is_carved_out_of_thinking_but_attempt_still_counts(make_attempt, bundle, cfg):
    """短暂停顿属于思考；长时间离开记为 idle，但**不剔除整条作答**。"""
    item = bundle.items["mt_dir_8_5"]
    with_idle = make_attempt(
        1, item, correct=True, thinking_ms=3000, active_ms=1000, idle_ms=40000
    )
    assert with_idle.telemetry.thinking_time_ms == 3000
    assert with_idle.telemetry.is_idle_dominated(cfg.idle_dominated_ratio)

    updated = update_signals(Signals(), with_idle, cfg)
    assert updated.sample_count == 1  # 尝试仍然被计入，没有被丢弃
    assert updated.fluency is not None


def test_fluency_not_sampled_when_wrong(make_attempt, bundle, cfg):
    item = bundle.items["mt_dir_8_5"]
    samples = samples_for_attempt(make_attempt(1, item, correct=False), cfg)
    assert samples["fluency"] is None
    assert samples["accuracy"] == 0.0


def test_transfer_only_sampled_on_probe(make_attempt, bundle, cfg):
    item = bundle.items["mt_dir_8_5"]
    normal = samples_for_attempt(make_attempt(1, item, correct=True), cfg)
    probe = samples_for_attempt(
        make_attempt(2, item, correct=True, is_transfer_probe=True), cfg
    )
    assert normal["transfer"] is None
    assert probe["transfer"] == 1.0


def test_assessment_attempt_uses_discounted_alpha(make_attempt, bundle, cfg):
    item = bundle.items["mt_dir_8_5"]
    base = update_signals(Signals(), make_attempt(1, item, correct=True), cfg)
    probe_state = update_signals(
        base, make_attempt(2, item, correct=False, is_assessment=True), cfg
    )
    practice_state = update_signals(
        base, make_attempt(3, item, correct=False, is_assessment=False), cfg
    )
    # 探测题带来的状态变化更小
    probe_drop = base.accuracy - probe_state.accuracy
    practice_drop = base.accuracy - practice_state.accuracy
    assert probe_drop < practice_drop
    assert probe_state.assessment_samples == 1
    assert probe_state.practice_samples == 1
    assert practice_state.practice_samples == 2


def test_quality_breakdown(make_attempt, bundle, cfg):
    item = bundle.items["mt_dir_8_5"]
    wrong = attempt_quality(make_attempt(1, item, correct=False), cfg)
    good = attempt_quality(make_attempt(2, item, correct=True, hints_used=0), cfg)
    hinted = attempt_quality(make_attempt(3, item, correct=True, hints_used=1), cfg)

    assert wrong.quality == 0.0
    assert good.quality > hinted.quality > 0.0
    assert "transfer" not in good.to_dict()


def test_update_signals_does_not_mutate_input(make_attempt, bundle, cfg):
    item = bundle.items["mt_dir_8_5"]
    original = Signals()
    _ = update_signals(original, make_attempt(1, item, correct=True), cfg)
    assert original.sample_count == 0
    assert original.accuracy is None
