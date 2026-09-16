"""诊断测试：错误认知归因。"""
from __future__ import annotations

from backend.engine.diagnosis import diagnose, match_rules, rule_matches


def test_answer_equals():
    assert rule_matches({"answer_equals": 3}, 3, 13)
    assert not rule_matches({"answer_equals": 3}, 4, 13)


def test_answer_in():
    assert rule_matches({"answer_in": [11, 12, 14]}, 12, 13)
    assert not rule_matches({"answer_in": [11, 12, 14]}, 13, 13)


def test_answer_off_by():
    assert rule_matches({"answer_off_by": 1}, 12, 13)
    assert not rule_matches({"answer_off_by": 1}, 15, 13)


def test_answer_off_by_multiple_of():
    """23+14 答成 47（差 10）→ 位值混淆。"""
    assert rule_matches({"answer_off_by_multiple_of": 10}, 47, 37)
    assert not rule_matches({"answer_off_by_multiple_of": 10}, 38, 37)


def test_string_answer_is_coerced():
    assert rule_matches({"answer_equals": 13}, "13", 13)


def test_item_rules_take_priority(make_attempt, bundle, cfg):
    item = bundle.items["mt_dir_8_5"]  # error_rules 含 counting_dependency(off_by 1)
    attempt = make_attempt(
        1, item, correct=False, submitted_answer=12, hints_used=0
    )
    codes = diagnose(attempt, item, cfg)
    assert "counting_dependency" in codes


def test_generic_rule_fallback(bundle, cfg):
    """内容层没有声明规则时，走配置里的通用规则。"""
    from backend.content.loader import Item

    item = Item(
        code="plain",
        competency_id="make_ten",
        pattern_id="direct_compute",
        difficulty=3,
        scaffold_level="direct",
        interaction_type="number_pad",
        estimated_seconds=6,
        problem={"a": 8, "b": 5},
        answer=13,
        error_rules=[],
    )
    attempt = type("A", (), {"correct": False, "submitted_answer": 23, "misconception_codes": []})()
    assert diagnose(attempt, item, cfg) == ["place_value_confusion"]


def test_correct_answer_produces_no_misconception(make_attempt, bundle, cfg):
    item = bundle.items["mt_dir_8_5"]
    attempt = make_attempt(1, item, correct=True)
    assert diagnose(attempt, item, cfg) == []


def test_signal_from_item_codes_is_kept(make_attempt, bundle, cfg):
    item = bundle.items["mt_dir_8_5"]
    attempt = make_attempt(1, item, correct=False, submitted_answer=99)
    attempt.misconception_codes = ["question_structure_missed"]
    assert "question_structure_missed" in diagnose(attempt, item, cfg)
