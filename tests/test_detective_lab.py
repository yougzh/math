"""数学侦探与数学实验室测试。

侦探部分的核心是**可解性**：孩子必须能靠推理得到唯一答案，
既不能"排不掉某些候选项只能猜"，也不能"一开局就已经是答案"。
这两种缺陷都靠 2000 个种子的穷举扫荡来拦住。
"""
from __future__ import annotations

import pytest

from backend.engine import detective as det
from backend.lab.service import is_unlocked, list_experiments, load_lab_config


# ── 侦探：结构与可解性 ─────────────────────────────────────
def test_all_kinds_are_reachable():
    kinds = {det.generate_puzzle(det.make_puzzle_id(s)).kind for s in range(30)}
    assert kinds == set(det.ALL_KINDS)


def test_sweep_2000_seeds_none_trivial_or_unsolvable():
    """穷举扫荡：没有一道题是"排不掉"或"一开局就唯一"。"""
    failures = []
    for seed in range(2000):
        puzzle = det.generate_puzzle(det.make_puzzle_id(seed))
        problems = puzzle.validate()
        if problems:
            failures.append((seed, "unsolvable", problems))
        if puzzle.is_trivial(reveal_count=2):
            failures.append((seed, "trivial", puzzle.domain))
    assert failures == [], "有缺陷的谜题种子：{}".format(failures[:5])


def test_every_candidate_is_excludable():
    """每个非答案候选项都必须能被至少一条线索排除，否则孩子只能猜。"""
    for seed in range(200):
        puzzle = det.generate_puzzle(det.make_puzzle_id(seed))
        for value in puzzle.domain:
            if value == puzzle.answer:
                continue
            assert not all(c.predicate(value) for c in puzzle.clues), (
                "种子 {} 的候选项 {} 排不掉".format(seed, value)
            )


def test_answer_never_leaves_the_server():
    puzzle = det.generate_puzzle(det.make_puzzle_id(7))
    payload = puzzle.to_dict()
    assert "answer" not in payload
    assert puzzle.answer not in payload["candidates"] or len(payload["candidates"]) > 1


def test_payload_matches_contract_shape():
    payload = det.generate_puzzle(det.make_puzzle_id(3)).to_dict()
    assert set(payload) == {
        "puzzle_id", "kind", "prompt", "clues", "candidates",
        "answer_type", "clues_remaining",
    }
    assert payload["answer_type"] == "number"
    assert all(set(c) == {"text", "revealed"} for c in payload["clues"])


def test_initial_reveal_count():
    for seed in range(50):
        puzzle = det.generate_puzzle(det.make_puzzle_id(seed), reveal_count=2)
        revealed = [c for c in puzzle.clues if c.revealed]
        assert len(revealed) == 2
        assert puzzle.clues_remaining == len(puzzle.clues) - 2


def test_regeneration_is_stable():
    """GET 出题和 POST 判题各自生成一次，必须得到同一道题。"""
    first = det.generate_puzzle(det.make_puzzle_id(42))
    second = det.generate_puzzle(det.make_puzzle_id(42))
    assert first.to_dict() == second.to_dict()
    assert first.answer == second.answer


def test_wrong_answer_reveals_a_clue():
    puzzle = det.generate_puzzle(det.make_puzzle_id(11))
    before = puzzle.clues_remaining
    revealed = det.reveal_after_attempt(puzzle, correct=False)
    assert len(revealed) == 1
    assert puzzle.clues_remaining == before - 1


def test_correct_answer_reveals_nothing():
    puzzle = det.generate_puzzle(det.make_puzzle_id(11))
    before = puzzle.clues_remaining
    assert det.reveal_after_attempt(puzzle, correct=True) == []
    assert puzzle.clues_remaining == before


def test_revealing_all_clues_makes_it_solvable():
    """用到极限：把所有线索都揭开，一定只剩答案。"""
    puzzle = det.generate_puzzle(det.make_puzzle_id(9))
    while puzzle.reveal_next() is not None:
        pass
    assert puzzle.solve() == [puzzle.answer]


def test_judge_accepts_answer_and_rejects_others():
    puzzle = det.generate_puzzle(det.make_puzzle_id(5))
    assert det.judge(puzzle, puzzle.answer) is True
    assert det.judge(puzzle, str(puzzle.answer)) is True
    assert det.judge(puzzle, puzzle.answer + 1) is False
    assert det.judge(puzzle, "abc") is False
    assert det.judge(puzzle, None) is False


def test_parse_puzzle_id():
    assert det.parse_puzzle_id("det_0042") == 42
    assert det.parse_puzzle_id("det_abc") is None
    assert det.parse_puzzle_id("") is None
    assert det.parse_puzzle_id("nope_1") is None


def test_unknown_puzzle_id_raises():
    with pytest.raises(ValueError):
        det.generate_puzzle("bogus_1")


def test_jump_search_is_deterministic():
    """被顺延掉的种子也要稳定：同一个 id 每次跳到同一个种子上。"""
    ids = [det.make_puzzle_id(s) for s in range(100)]
    assert [det.generate_puzzle(i).to_dict() for i in ids] == [
        det.generate_puzzle(i).to_dict() for i in ids
    ]


def test_clues_are_child_friendly():
    """线索文案不能出现否定评价，也不能长到读不完。"""
    banned = ["错了", "太慢", "怎么又", "笨"]
    for seed in range(300):
        puzzle = det.generate_puzzle(det.make_puzzle_id(seed))
        for clue in puzzle.clues:
            assert len(clue.text) <= 30, "线索太长：{}".format(clue.text)
            for word in banned:
                assert word not in clue.text


# ── 实验室 ─────────────────────────────────────────────────
def test_lab_always_open_experiments(bundle):
    experiments = list_experiments(
        level_of=lambda code: "encountering", level_order=["encountering", "understanding"]
    )
    open_codes = {e["code"] for e in experiments if e["unlocked"]}
    # 探索区不能一进门全是锁：至少有三个实验对"刚接触"的孩子开放
    assert {"blocks", "decompose", "make_ten"} <= open_codes


def test_lab_unlocks_with_level():
    order = ["encountering", "understanding", "can_do", "proficient", "automatic"]

    def level_of(code):
        return {"place_value": "can_do"}.get(code, "encountering")

    experiments = {e["code"]: e for e in list_experiments(level_of=level_of, level_order=order)}
    assert experiments["place_value_train"]["unlocked"] is True
    assert experiments["carry_exchange"]["unlocked"] is False


def test_lab_config_has_unique_codes_and_emoji():
    config = load_lab_config(0)
    codes = [e["code"] for e in config.experiments]
    assert len(codes) == len(set(codes))
    assert all(e.get("emoji") for e in config.experiments)
    assert all(e.get("component") for e in config.experiments)


def test_lab_contract_fields():
    experiments = list_experiments(
        level_of=lambda code: "automatic",
        level_order=["encountering", "understanding", "can_do", "proficient", "automatic"],
    )
    for experiment in experiments:
        assert set(experiment) == {
            "code", "name", "emoji", "description", "component", "unlocked"
        }


def test_typo_in_level_name_does_not_lock_the_child_out():
    """配置里等级名写错时宁可开着，也不要因为笔误把孩子关在门外。"""
    experiment = {"unlock": {"competency": "place_value", "min_level": "typo_level"}}
    assert is_unlocked(experiment, lambda code: "can_do", ["encountering", "can_do"]) is True
