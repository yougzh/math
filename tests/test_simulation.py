"""模拟儿童长周期测试的测试（P3）。

体检报告的价值取决于"检查函数真的会报警"。这里不靠跑完整模拟碰运气，
而是**构造小场景**逐个触发 Q1~Q5，并验证控制组不会被误报；
另外验证模拟是确定性的：同一个 seed 跑两次，逐字段一致。
"""
from __future__ import annotations

from typing import Any, Dict, List

import tools.simulate as S
from backend.engine.types import Attempt, Telemetry


def _attempt(seq: int, item) -> Attempt:
    return Attempt(
        attempt_id="t_{:03d}".format(seq),
        child_id="tester",
        item_id=item.code,
        competency_id=item.competency_id,
        pattern_id=item.pattern_id,
        correct=True,
        telemetry=Telemetry(response_time_ms=6000, active_time_ms=1500),
        seq=seq,
    )


def _day(day: int, focus: str, attempts: List[Attempt], due_count: int = 0) -> S.DayRecord:
    return S.DayRecord(
        day=day,
        focus=focus,
        due_count=due_count,
        planned_reviews=0,
        review_attempts=0,
        probe_planned=0,
        probe_attempts=0,
        attempts=list(attempts),
    )


def _run(
    name: str = "体检对象",
    key: str = "check",
    days: List[S.DayRecord] = None,
    attempts: List[Attempt] = None,
    events: List[Dict[str, Any]] = None,
) -> S.ChildRun:
    run = S.ChildRun(key=key, name=name, description="", entry_focus="make_ten")
    run.days = list(days or [])
    run.attempts = list(attempts or [])
    run.events = list(events or [])
    return run


def _items_at_difficulty(bundle, difficulty: int) -> Any:
    pool = sorted(
        (i for i in bundle.items.values() if i.difficulty == difficulty),
        key=lambda i: i.code,
    )
    assert pool, "内容库里没有难度 {} 的题目，测试前提不成立".format(difficulty)
    return pool[0]


def _evidence_that_passes(cfg) -> Dict[str, float]:
    requires = cfg.upgrade_requires()
    evidence = {
        name: float(requires[name])
        for name in ("accuracy", "mastery", "independence", "transfer", "fluency")
        if name in requires
    }
    evidence["practice_samples"] = int(cfg.min_practice_samples)
    evidence["successful_patterns"] = int(cfg.new_pattern_success_rule().get("min_patterns", 2))
    return evidence


# ── 模拟跑通 + 确定性 ──────────────────────────────────────
def test_two_profiles_run_30_days_without_crashing(bundle, cfg, graph):
    sim_bundle, _added = S.with_practice_slots(bundle, cfg)
    runs = S.run_simulation([S.SlowStarter(), S.CarryPhobic()], sim_bundle, cfg, graph, S.SIM_DAYS)

    assert [r.key for r in runs] == ["slow_starter", "carry_phobic"]
    for run in runs:
        assert len(run.days) == S.SIM_DAYS
        assert len(run.attempts) > 100, "{}：30 天作答太少".format(run.key)
        with_items = [r for r in run.days if r.attempts]
        assert len(with_items) >= S.SIM_DAYS - 2, "{}：太多天没有题可做".format(run.key)
        assert run.final_state is not None
        assert run.schedule, "作答后复习调度表不该是空的"
        assert run.days[0].due_count == 0, "第一天没有历史，不该有到期复习"
        assert sum(r.review_attempts for r in run.days) == len(run.review_attempts())


def test_simulation_is_deterministic_for_the_same_seed(bundle, cfg, graph):
    """同一个 seed 跑两次：题目、作答、调度、事件逐字段一致。"""
    sim_bundle, _added = S.with_practice_slots(bundle, cfg)

    first = S.run_simulation([S.Forgetful()], sim_bundle, cfg, graph, S.SIM_DAYS)[0]
    second = S.run_simulation([S.Forgetful()], sim_bundle, cfg, graph, S.SIM_DAYS)[0]

    def digest(run: S.ChildRun):
        return [
            (a.seq, a.item_id, a.correct, a.hints_used, a.telemetry.response_time_ms)
            for a in run.all_attempts()
        ]

    assert digest(first) == digest(second)
    assert first.schedule == second.schedule
    assert first.events == second.events
    assert [
        (r.day, r.due_count, r.planned_reviews, r.review_attempts) for r in first.days
    ] == [(r.day, r.due_count, r.planned_reviews, r.review_attempts) for r in second.days]


def test_simulation_only_slots_do_not_touch_the_real_content(bundle, cfg):
    before = set(bundle.slots)
    sim_bundle, added = S.with_practice_slots(bundle, cfg)

    assert set(bundle.slots) == before, "模拟补槽不能写回真实内容"
    assert not any(code.startswith("zzsim_") for code in before)

    # 补槽名单必须从内容现状**动态算**：内容补齐 practice 槽之后，
    # "一定有 9 个 zzsim_*" 这个前提就不成立了（内容缺口消失，补槽自然归零）。
    covered = {
        slot.competency_id
        for slot in bundle.slots.values()
        if slot.purpose in {"practice", "teach", "review"}
    }
    with_items = {item.competency_id for item in bundle.items.values()}
    expected = [
        "zzsim_{}_practice".format(code)
        for code in sorted(with_items)
        if code not in covered
    ]
    assert added == expected
    assert all(code.startswith("zzsim_") for code in added)
    if expected:
        assert set(sim_bundle.slots) > before
    else:
        assert set(sim_bundle.slots) == before


# ── 体检逻辑本身：构造场景逐个触发 ─────────────────────────
def test_q1_early_upgrade_detected_and_topology_guard(cfg, graph):
    order = graph.topological_order()
    earlier, later = order[0], order[1]

    forward = {
        "day": 3, "type": "focus_switch",
        "from": earlier, "to": later, "evidence": {},
    }
    finding = S.check_early_upgrade([_run(events=[forward])], graph, cfg)
    assert finding.question == "Q1"
    assert finding.detected and finding.severity == "alert"
    assert "第 3 天" in " ".join(finding.lines)

    # 控制组 1：证据齐备的向前推进不算过早升级
    ready = dict(forward, evidence=_evidence_that_passes(cfg))
    assert not S.check_early_upgrade([_run(events=[ready])], graph, cfg).detected

    # 控制组 2：往前置方向移动不算"推进"（那是系统在往回拉）
    backward = {
        "day": 3, "type": "focus_switch",
        "from": later, "to": earlier, "evidence": {},
    }
    assert not S.check_early_upgrade([_run(events=[backward])], graph, cfg).detected


def test_q2_stuck_on_easy_detected(bundle, cfg):
    item = _items_at_difficulty(bundle, 1)
    stuck_days = S.STUCK_EASY_DAYS + 1
    attempts = [_attempt(seq, item) for seq in range(1, stuck_days + 1)]
    days = [_day(d, "make_ten", [attempts[d - 1]]) for d in range(1, stuck_days + 1)]

    finding = S.check_stuck_on_easy([_run(days=days, attempts=attempts)], bundle, cfg)
    assert finding.question == "Q2"
    assert finding.detected and finding.severity == "warn"
    assert str(stuck_days) in " ".join(finding.lines)

    # 控制组：刚好等于阈值的天数不触发（判据是"超过"）
    short = _run(days=days[:-1], attempts=attempts[:-1])
    assert not S.check_stuck_on_easy([short], bundle, cfg).detected


def test_q3_fallback_episodes_merge_and_over_threshold_detected(cfg):
    # 同一目标连续两天 → 合并成 1 起
    merged = _run(events=[
        {"day": 1, "type": "fallback", "target": "make_ten", "reasons": ["连续答错"]},
        {"day": 2, "type": "fallback", "target": "make_ten", "reasons": ["连续答错"]},
        {"day": 3, "type": "fallback", "target": "sd_add_10", "reasons": ["提示骤增"]},
    ])
    assert len(merged.fallback_episodes()) == 2

    # 目标来回漂移 → 每一起都算独立回退事件，超过阈值要报警
    targets = ["make_ten", "sd_add_10"]
    events = [
        {"day": d, "type": "fallback", "target": targets[d % 2], "reasons": ["测试"]}
        for d in range(1, S.FALLBACK_ALERT + 2)
    ]
    finding = S.check_frequent_fallback([_run(events=events)], cfg)
    assert finding.question == "Q3"
    assert finding.detected and finding.severity == "warn"

    quiet = _run(events=events[: S.FALLBACK_ALERT])
    assert not S.check_frequent_fallback([quiet], cfg).detected


def test_q4_review_overload_detected(cfg):
    max_per_day = int(cfg.get("review", "max_per_day"))

    finding = S.check_review_overload(
        [_run(days=[_day(1, "make_ten", [], due_count=max_per_day + 1)])], cfg
    )
    assert finding.question == "Q4"
    assert finding.detected and finding.severity == "warn"

    # 控制组：正好等于上限不算过载（上限是"最多做几个"，不是"最多到期几个"）
    at_limit = _run(days=[_day(1, "make_ten", [], due_count=max_per_day)])
    assert not S.check_review_overload([at_limit], cfg).detected


def test_q5_difficulty_jump_detected(bundle, cfg):
    low = _items_at_difficulty(bundle, 1)
    high = _items_at_difficulty(bundle, 1 + S.JUMP_ALERT)
    attempts = [_attempt(1, low), _attempt(2, high)]
    run = _run(days=[_day(1, "make_ten", attempts)], attempts=attempts)

    finding = S.check_difficulty_jump([run], bundle, cfg)
    assert finding.question == "Q5"
    assert finding.detected and finding.severity == "warn"
    assert "最大跨度 +{}".format(S.JUMP_ALERT) in " ".join(finding.lines)

    # 控制组：难度只升 1 级不算断层
    mid = _items_at_difficulty(bundle, 2)
    smooth_attempts = [_attempt(1, low), _attempt(2, mid)]
    smooth = _run(days=[_day(1, "make_ten", smooth_attempts)], attempts=smooth_attempts)
    assert not S.check_difficulty_jump([smooth], bundle, cfg).detected


def test_q7_flags_exactly_the_competencies_with_too_few_patterns(cfg, graph):
    """Q7 的判据必须与能力图一致：pattern 数不足 min_patterns 的能力就是结构性卡死。"""
    need = int(cfg.new_pattern_success_rule().get("min_patterns", 2))
    expected = [
        code for code in graph.topological_order() if len(graph.patterns_for(code)) < need
    ]

    finding = S.check_unupgradable_competencies(graph, cfg)
    assert finding.question == "Q7"
    assert finding.detected == bool(expected)
    text = " ".join(finding.lines)
    for code in expected:
        assert code in text
    if not expected:
        assert "不存在结构性卡死" in text


# ── 报告入口 ───────────────────────────────────────────────
def test_main_prints_report_and_returns_zero(capsys):
    exit_code = S.main(["--days", "3"])
    out = capsys.readouterr().out

    assert exit_code == 0
    assert "体检报告" in out
    for question in ("Q1", "Q2", "Q3", "Q4", "Q5"):
        assert question in out, "报告缺少 {}".format(question)
    assert "内容校验" in out
