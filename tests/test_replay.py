"""Replay 测试：重放必须与在线增量更新逐字段一致。"""
from __future__ import annotations

import copy

import pytest

from backend.content.loader import load_bundle
from backend.engine.config import AlgorithmConfig, load_config
from backend.engine.graph import CompetencyGraph
from backend.engine.learner import apply_attempt, new_state
from backend.engine.replay import replay, states_equal
from backend.engine.state_machine import derive_level


def _scenario(make_attempt, bundle):
    """8+5 错 → 8+5 提示后对 → 7+6 对 → 9+4 对 → 8+7 无提示对。"""
    plan = [
        ("mt_blk_8_5", False, 0, 6800, 12),
        ("mt_blk_8_5", True, 1, 9200, 13),
        ("mt_blk_7_6", True, 0, 7400, 13),
        ("mt_blk_9_4", True, 0, 6100, 13),
        ("mt_dec_8_7", True, 0, 8900, 15),
    ]
    attempts = []
    for seq, (code, correct, hints, thinking, submitted) in enumerate(plan, start=1):
        attempts.append(
            make_attempt(
                seq,
                bundle.items[code],
                correct=correct,
                hints_used=hints,
                thinking_ms=thinking,
                submitted_answer=submitted,
            )
        )
    return attempts


def test_replay_is_deterministic(make_attempt, bundle, cfg, graph):
    attempts = _scenario(make_attempt, bundle)
    first = replay("c", attempts, bundle, cfg, graph)
    second = replay("c", attempts, bundle, cfg, graph)
    assert states_equal(first.final_state, second.final_state)


def test_replay_matches_incremental_update(make_attempt, bundle, cfg, graph):
    """Replay 与在线更新共用 learner.apply_attempt，结果必须完全一致。"""
    attempts = _scenario(make_attempt, bundle)

    online = new_state("c")
    for attempt in attempts:
        online = apply_attempt(online, attempt, bundle, cfg)

    replayed = replay("c", attempts, bundle, cfg, graph)
    assert states_equal(replayed.final_state, online)


def test_replay_order_is_normalised_by_seq(make_attempt, bundle, cfg, graph):
    attempts = _scenario(make_attempt, bundle)
    shuffled = [attempts[3], attempts[0], attempts[4], attempts[1], attempts[2]]
    assert states_equal(
        replay("c", attempts, bundle, cfg, graph).final_state,
        replay("c", shuffled, bundle, cfg, graph).final_state,
    )


def test_replay_snapshots_track_signal_growth(make_attempt, bundle, cfg, graph):
    result = replay("c", _scenario(make_attempt, bundle), bundle, cfg, graph)
    mastery = [s.signals["mastery"] for s in result.snapshots]
    accuracy = [s.signals["accuracy"] for s in result.snapshots]
    independence = [s.signals["independence"] for s in result.snapshots]

    assert mastery[0] == 0.0 and mastery[-1] > mastery[0]
    assert accuracy[-1] > accuracy[0]
    assert independence[-1] > 0.9
    assert len(result.snapshots) == 5
    assert result.snapshots[-1].level_label  # 等级是派生出来的


def test_replay_snapshot_carries_decision(make_attempt, bundle, cfg, graph):
    result = replay("c", _scenario(make_attempt, bundle), bundle, cfg, graph)
    last = result.snapshots[-1]
    assert last.decision.action == "hold"
    assert last.decision.reasons


def test_config_version_changes_replay_result(make_attempt, bundle, graph):
    """ADR-0002：改阈值后必须能整表重算，用同一批数据得到不同判定。"""
    attempts = _scenario(make_attempt, bundle)
    cfg_v0 = load_config(0)

    raw = copy.deepcopy(cfg_v0.raw)
    raw["smoothing"]["min_samples_for_level"] = 1
    for level in ("understanding", "can_do", "proficient", "automatic"):
        for key in list(raw["level_thresholds"][level].keys()):
            raw["level_thresholds"][level][key] = 0.10
    relaxed = AlgorithmConfig(raw)

    strict_result = replay("c", attempts, bundle, cfg_v0, graph)
    relaxed_result = replay("c", attempts, bundle, relaxed, graph)

    assert derive_level(strict_result.final_state.competencies["make_ten"], cfg_v0) == "encountering"
    assert (
        derive_level(relaxed_result.final_state.competencies["make_ten"], relaxed)
        == "automatic"
    )
    # 原始信号完全相同 —— 变的只是派生结果
    assert (
        strict_result.final_state.competencies["make_ten"].accuracy
        == relaxed_result.final_state.competencies["make_ten"].accuracy
    )


def test_replay_can_resume_from_existing_state(make_attempt, bundle, cfg, graph):
    """断点续跑：前 3 条已入库，后 2 条补上后结果必须一致。"""
    attempts = _scenario(make_attempt, bundle)
    full = replay("c", attempts, bundle, cfg, graph)

    partial = replay("c", attempts[:3], bundle, cfg, graph)
    resumed = replay(
        "c", attempts[3:], bundle, cfg, graph, initial_state=partial.final_state
    )
    assert states_equal(full.final_state, resumed.final_state)


def test_algorithm_version_is_pinned(make_attempt, bundle, cfg, graph):
    result = replay("c", _scenario(make_attempt, bundle), bundle, cfg, graph)
    signals = result.final_state.competencies["make_ten"]
    assert signals.algorithm_version == cfg.version
    assert result.algorithm_version == cfg.version


def test_replay_ignores_unknown_competency_gracefully(bundle, cfg, graph):
    """没有作答时不报错，返回空状态。"""
    result = replay("c", [], bundle, cfg, graph)
    assert result.final_state.attempts_seen == 0
    assert result.final_competency == "place_value"
    assert result.final_level == "encountering"
