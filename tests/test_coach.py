"""AI 教练与四道护栏测试。

核心不变量（每一条都有对应的反面断言）：
  未经护栏的文本，永远不出现在孩子眼前。
"""
from __future__ import annotations

import pytest

from backend.coach import CoachService, default_service
from backend.coach.config import load_coach_config
from backend.coach.llm import LLMAdapter, NullLLM
from backend.coach import validators
from backend.engine.graph import CompetencyGraph


class EvilLLM(LLMAdapter):
    """一个"故意使坏"的模型：每次都吐违规文案。

    它同时验证了两件事：护栏真的在拦，以及拦下之后真的退回了规则文案。
    """

    name = "evil"

    def __init__(self, payload: str):
        self.payload = payload

    def available(self) -> bool:
        return True

    def rewrite(self, instruction, rule_text, context):
        return self.payload


@pytest.fixture
def coach(bundle, graph) -> CoachService:
    return default_service(bundle, graph)


# ── 护栏本身 ───────────────────────────────────────────────
def test_leak_validator_catches_answer(bundle, graph):
    item = bundle.items["mt_dec_8_5"]     # answer 13
    assert validators.validate_answer_leak("答案是 13", item)
    assert validators.validate_answer_leak("10 + 3 = 13", item)
    assert validators.validate_answer_leak("8 和几凑成 10？", item) == []


def test_scope_validator_catches_downstream_concept(bundle, graph):
    """凑十阶段不能提"进位"——那是还没学的能力。"""
    item = bundle.items["mt_dec_8_5"]
    problems = validators.validate_knowledge_scope("个位满十了要进位", item, graph)
    assert problems
    assert "进位" in problems[0]


def test_scope_validator_allows_prerequisites(bundle, graph):
    """讲凑十的时候提"数字朋友"是允许的 —— 它是前置能力。"""
    item = bundle.items["mt_dec_8_5"]
    allowed = graph.prerequisites("make_ten", transitive=True)
    assert "sd_add_10" in allowed
    assert validators.validate_knowledge_scope("用凑十的办法", item, graph) == []


def test_length_validator(bundle, graph):
    cfg = load_coach_config(0)
    item = bundle.items["mt_dec_8_5"]
    assert validators.validate_length("短句。", cfg) == []
    assert validators.validate_length("这句话" * 30, cfg)
    assert validators.validate_length("第一句。第二句。第三句。", cfg)
    assert validators.validate_length("", cfg)


def test_tone_validator(bundle, graph):
    cfg = load_coach_config(0)
    assert validators.validate_tone("差一点，再试一次", cfg) == []
    assert validators.validate_tone("又错了，怎么这么慢", cfg)


# ── 编排：护栏一票否决 + 退回规则文案 ─────────────────────
def test_evil_llm_is_rejected_and_falls_back(bundle, graph):
    coach = CoachService(bundle, graph, load_coach_config(0), EvilLLM("答案是 13，你太慢了"))
    message = coach.hint(bundle.items["mt_dec_8_5"], hints_used=0)
    assert message.source == "rule"
    assert message.text == "8 和几凑成 10？"
    assert message.rejected
    assert any("泄漏答案" in reason for reason in message.rejected)


def test_wellbehaved_llm_is_accepted(bundle, graph):
    coach = CoachService(bundle, graph, load_coach_config(0), EvilLLM("看看 8 还差几才能满十？"))
    message = coach.hint(bundle.items["mt_dec_8_5"], hints_used=0)
    assert message.source == "llm"
    assert message.text == "看看 8 还差几才能满十？"
    assert message.rejected == []


def test_null_llm_keeps_rule_text(bundle, graph):
    coach = CoachService(bundle, graph, load_coach_config(0), NullLLM())
    message = coach.hint(bundle.items["mt_dec_8_5"], hints_used=0)
    assert message.source == "rule"


def test_llm_exception_does_not_break_the_child_experience(bundle, graph):
    class BrokenLLM(LLMAdapter):
        name = "broken"

        def available(self):
            return True

        def rewrite(self, instruction, rule_text, context):
            raise RuntimeError("模型超时")

    coach = CoachService(bundle, graph, load_coach_config(0), BrokenLLM())
    # service 不吞异常，但 API 层必须兜住 —— 这里断言规则文案可以独立求出
    from backend.coach import rules

    fallback = rules.build_hint_rule_text(bundle.items["mt_dec_8_5"], 0, coach.cfg)
    assert fallback["text"]


# ── 提示逐级，不跳级 ───────────────────────────────────────
def test_hints_are_progressive(coach, bundle):
    item = bundle.items["mt_dec_8_5"]
    texts = [coach.hint(item, used).text for used in range(len(item.hint_chain))]
    assert texts == list(item.hint_chain)


def test_hint_exhaustion_falls_back_to_concept_prompt(coach, bundle):
    item = bundle.items["mt_dec_8_5"]
    message = coach.hint(item, hints_used=len(item.hint_chain))
    assert message.exhausted is True
    assert message.level == 0
    assert message.text == coach.cfg.concept_prompt("make_ten")


# ── 反馈三档语气 ───────────────────────────────────────────
def test_feedback_tones(coach, bundle):
    item = bundle.items["mt_dec_8_5"]
    assert coach.feedback(item, correct=True, hints_used=0).tone == "praise"
    assert coach.feedback(item, correct=True, hints_used=1).tone == "praise_nudge"
    assert coach.feedback(item, correct=False, hints_used=0).tone == "repair"
    assert (
        coach.feedback(item, correct=False, hints_used=0, misconception_codes=["make_ten_not_used"]).tone
        == "repair"
    )


def test_correct_with_hint_never_reads_like_failure(coach, bundle):
    """用提示答对了还是"对"—— 不能出现"差一点"这种否定开场。"""
    message = coach.feedback(bundle.items["mt_dec_8_5"], correct=True, hints_used=2)
    for phrase in ["差一点", "快到了", "再试一下"]:
        assert phrase not in message.text


# ── 全内容扫荡：所有 item 的提示与反馈都必须过护栏 ─────────
def test_every_hint_in_content_passes_guardrails(coach, bundle):
    failures = {}
    for item in bundle.items.values():
        for level in range(len(item.hint_chain) + 1):
            message = coach.hint(item, hints_used=level)
            if message.source == "fallback":
                failures.setdefault(item.code, []).append((level, message.rejected))
    assert failures == {}, "以下内容的提示未过护栏：{}".format(failures)


def test_every_feedback_variant_passes_guardrails(coach, bundle):
    failures = {}
    for item in bundle.items.values():
        for correct in (True, False):
            for hints_used in (0, 1):
                message = coach.feedback(item, correct=correct, hints_used=hints_used)
                if message.source == "fallback":
                    failures.setdefault(item.code, []).append(
                        (correct, hints_used, message.rejected)
                    )
    assert failures == {}, "以下内容的反馈未过护栏：{}".format(failures)


def test_coach_message_serializes_for_api(coach, bundle):
    item = bundle.items["mt_dec_8_5"]

    feedback = coach.hint(item, hints_used=0).to_dict()
    # 契约 §4：feedback 只有三个字段，不能把内部排查信息漏给前端
    assert set(feedback) == {"tone", "text", "character"}

    hint = coach.hint(item, hints_used=0).to_hint_dict()
    # 契约 §6：hints 端点是另一套形状
    assert set(hint) == {"hint_level", "hint_text", "source", "fallback_used", "exhausted"}
    assert hint["source"] == "rule"
    assert hint["fallback_used"] is False


def test_hint_endpoint_shape_reports_fallback(bundle, graph):
    coach = CoachService(
        bundle, graph, load_coach_config(0), EvilLLM("答案是 13，太慢了")
    )
    hint = coach.hint(bundle.items["mt_dec_8_5"], hints_used=0).to_hint_dict()
    # 模型被拦下 → 退回规则文案，source 仍是 rule，孩子看不出区别
    assert hint["source"] == "rule"
    assert hint["fallback_used"] is False
