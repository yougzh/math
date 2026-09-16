"""P1 内容编译器测试。

这里的每一条都对应一次**真实踩过的坑**，不是为覆盖率写的：
  1. 步骤里的算式算错 —— 校验必须拦下，否则孩子学的是错的
  2. 步骤结论与答案矛盾 —— 典型症状是"从别的题复制步骤"
  3. guide 风格的步骤不该被报"没走到答案" —— 凑十法就该停在「10 + 3」
  4. 题面没带数字 —— 题面依赖故事补齐信息，独立训练槽选中时无法回答
  5. 提示泄漏答案 —— 提示里出现答案数字（"往前数 b 个"，b 恰好等于答案）
"""
from __future__ import annotations

import pytest

from backend.content import compiler
from backend.content.cognitive import (
    check_all,
    check_steps,
    lint_all,
    lint_steps,
    step_equalities,
)
from backend.content.loader import Item
from tools.content_cli.main import main


def make_item(**overrides) -> Item:
    base = dict(
        code="t_1",
        competency_id="sd_add_10",
        pattern_id="direct_compute",
        difficulty=1,
        scaffold_level="direct",
        interaction_type="number_pad",
        estimated_seconds=6,
        problem={"a": 3, "b": 4, "prompt": "3 + 4 = ?"},
        answer=7,
        steps=["3 加上 4"],
        hint_chain=["把两个数合起来"],
        error_rules=[],
        steps_style="guide",
    )
    base.update(overrides)
    return Item(**base)


# ── 步骤算式复核 ───────────────────────────────────────────
def test_step_equalities_extracts_chains():
    item = make_item(steps=["8 + 5 = 13", "13 - 3 = 10"], answer=13)
    found = step_equalities(item)
    assert [(computed, stated) for _, computed, stated in found] == [(13, 13), (10, 10)]


def test_step_equalities_understands_chinese_operators():
    item = make_item(steps=["10 减去 3 = 7"], answer=7)
    assert [(computed, stated) for _, computed, stated in step_equalities(item)] == [(7, 7)]


def test_check_steps_catches_wrong_arithmetic():
    item = make_item(steps=["3 + 4 = 8"], answer=7)
    problems = check_steps(item)
    assert len(problems) == 1
    assert "算错了" in problems[0]
    assert "应该是 7" in problems[0]


def test_check_steps_catches_answer_mismatch():
    """答案 13，步骤却写着算式 8 + 4 = 12 —— 典型的复制粘贴错误。"""
    item = make_item(steps=["8 + 4 = 12"], answer=13)
    problems = check_steps(item)
    assert any("与答案" in p for p in problems)


def test_check_steps_allows_guide_style_stopping_short():
    """凑十法的最后一步就该停在「10 + 3」，这不是错误。"""
    item = make_item(
        competency_id="make_ten",
        pattern_id="decompose",
        problem={"a": 8, "b": 5, "prompt": "把 5 拆成两部分，先把 8 凑成 10。"},
        answer=13,
        steps=["8 和 2 凑成 10", "5 拆成 2 和 3", "10 + 3"],
        steps_style="guide",
    )
    assert check_steps(item) == []
    assert lint_steps(item) == []


def test_lint_steps_fires_when_conclude_declared():
    item = make_item(steps=["8 和 2 凑成 10", "10 + 3"], answer=13, steps_style="conclude")
    assert check_steps(item) == []
    warnings = lint_steps(item)
    assert len(warnings) == 1
    assert "13" in warnings[0]


def test_lint_steps_passes_when_conclude_satisfied():
    item = make_item(steps=["10 + 3 = 13"], answer=13, steps_style="conclude")
    assert lint_steps(item) == []


def test_lint_steps_ignores_guide_items():
    item = make_item(steps=["描述型的步骤，没有数字"], answer=7, steps_style="guide")
    assert lint_all(item) == []


# ── 题面自包含 ─────────────────────────────────────────────
def test_lint_prompt_without_numbers(bundle):
    """题面没数字 → 被独立训练槽选中时孩子无法回答。"""
    item = make_item(
        problem={"a": 8, "b": 5, "prompt": "一共有多少个？"},
        answer=13,
        steps=["8 + 5 = 13"],
    )
    injected = _bundle_with(bundle, item)
    warnings = compiler.lint_bundle(injected)
    assert any("一个数字都没有" in w for w in warnings)


def test_lint_prompt_self_contained_passes_on_real_content(bundle):
    warnings = compiler._lint_prompt_self_contained(bundle)
    assert warnings == [], "现有内容的题面应当都自包含：{}".format(warnings)


# ── 真实内容整体验收 ───────────────────────────────────────
def test_real_content_has_no_errors(bundle):
    problems = compiler.validate_bundle(bundle)
    assert problems == [], "内容存在错误：\n{}".format("\n".join(problems))


def test_real_content_passes_check_all(bundle):
    bad = {}
    for item in bundle.items.values():
        problems = check_all(item)
        if problems:
            bad[item.code] = problems
    assert bad == {}, "以下内容未通过复核：{}".format(bad)


def test_real_content_has_no_duplicate_item_codes(bundle):
    """重复 code 会让 load_items 静默覆盖，必须在测试层拦住。"""
    assert len(bundle.items) == len(set(bundle.items))


def test_generated_items_declare_conclude():
    """生成器写的是完整解答，必须声明 conclude，否则 lint 形同虚设。"""
    from backend.content import generators

    items, rejected = generators.generate()
    assert items
    assert rejected == [], "生成器被拦下的候选：{}".format(rejected)
    styles = {item.steps_style for item in items}
    assert styles == {"conclude"}


def test_every_generated_item_mentions_its_answer_in_steps():
    """生成器声明了 conclude，那么示范路径就真的必须走到答案。"""
    from backend.content import generators

    items, _ = generators.generate()
    offenders = [i.code for i in items if lint_steps(i.as_item())]
    assert offenders == [], "以下生成题声明 conclude 却没走到答案：{}".format(offenders)


# ── CLI ────────────────────────────────────────────────────
def test_cli_validate_exit_code(capsys):
    assert main(["validate"]) == 0


def test_cli_lint_exit_code(capsys):
    assert main(["lint"]) == 0


def test_cli_stats_runs(capsys):
    assert main(["stats"]) == 0
    out = capsys.readouterr().out
    assert "内容总览" in out
    assert "槽位候选池宽度" in out


def test_cli_preview_unknown_item(capsys):
    assert main(["preview", "item", "no_such_item"]) == 0
    assert "找不到 item" in capsys.readouterr().out


def test_cli_generate_dry_run_does_not_write(capsys):
    assert main(["generate", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "dry-run，未写盘" in out


def _bundle_with(bundle, item):
    """复制一份内容包并塞入一道测试题，避免污染 session 级夹具。"""
    from backend.content.loader import ContentBundle

    return ContentBundle(
        competencies=dict(bundle.competencies),
        patterns=dict(bundle.patterns),
        items=dict(bundle.items, **{item.code: item}),
        misconceptions=dict(bundle.misconceptions),
        slots=dict(bundle.slots),
    )
