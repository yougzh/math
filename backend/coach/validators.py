"""教练的四道护栏。

孩子看到的每一句教练文案，都必须先过这四关：

    1. 不泄漏答案       —— 提示可以说方法，不能说出结果
    2. 不超纲           —— 不能提到还没学的能力（"进位"不能在凑十阶段出现）
    3. 长度可控         —— 8 岁孩子读不完成段的话
    4. 语气安全         —— 不出现否定评价（"错了"、"太慢"）

任何一条不过，就退回规则文案 —— 这是**决定**，不是建议：
LLM 的输出不可信，护栏是唯一让它进入孩子视野的通道。
"""
from __future__ import annotations

import re
from typing import List

from backend.coach.config import CoachConfig
from backend.content.loader import Item

_NUMBER_TOKEN = re.compile(r"\d+")
_SENTENCE_END = re.compile(r"[。！？!?；;]")
# "8 + 5 = 13" / "8 + 5 = 13" 这类显式结论
_EQUALITY = re.compile(r"(\d+)\s*[+\-加乘除×÷]\s*(\d+)\s*[=＝]")


def validate_answer_leak(text: str, item: Item) -> List[str]:
    """提示可以说方法，不能说结果。"""
    answer = item.answer
    if not isinstance(answer, int):
        return []
    problems = []
    if answer in {int(tok) for tok in _NUMBER_TOKEN.findall(text)}:
        problems.append("泄漏答案：文案里出现了答案 {}".format(answer))
    if _EQUALITY.search(text):
        problems.append("泄漏答案：文案里出现了完整算式")
    return problems


def validate_knowledge_scope(
    text: str,
    item: Item,
    graph,
) -> List[str]:
    """不能提到还没学到的能力。

    允许出现的内容 = 当前能力 + 它的所有（传递）前置，包括：
      · 能力名（"进位加法"）
      · 能力特有说法（"进位"、"借位" —— 见 competency.terms）

    术语表写在内容里而不是代码里：教学法用语会变，代码不该跟着改。
    """
    problems = []
    allowed = {item.competency_id}
    try:
        allowed |= set(graph.prerequisites(item.competency_id, transitive=True))
    except (KeyError, AttributeError):
        pass

    for competency in graph.competencies.values():
        if competency.code in allowed:
            continue
        name = competency.name or ""
        if name and name in text:
            problems.append("超纲：文案里出现了还没学的能力「{}」".format(name))
            continue
        for term in getattr(competency, "terms", []) or []:
            if term and term in text:
                problems.append(
                    "超纲：文案里用了还没学的说法「{}」（属于「{}」）".format(term, name)
                )
                break
    return problems


def validate_length(text: str, cfg: CoachConfig) -> List[str]:
    problems = []
    stripped = text.strip()
    if not stripped:
        return ["文案为空"]
    if len(stripped) > cfg.max_chars:
        problems.append(
            "文案太长：{} 字，上限 {} 字".format(len(stripped), cfg.max_chars)
        )
    sentences = [s for s in _SENTENCE_END.split(stripped) if s.strip()]
    if len(sentences) > cfg.max_sentences:
        problems.append(
            "句子太多：{} 句，上限 {} 句".format(len(sentences), cfg.max_sentences)
        )
    if stripped.count("！") + stripped.count("!") > cfg.max_exclamation_marks:
        problems.append("感叹号太多，会显得在催促")
    return problems


def validate_tone(text: str, cfg: CoachConfig) -> List[str]:
    hit = [phrase for phrase in cfg.forbidden_phrases() if phrase in text]
    if hit:
        return ["语气不合格，出现了否定评价：{}".format("、".join(hit))]
    return []


def run_all(text: str, item: Item, graph, cfg: CoachConfig) -> List[str]:
    """返回空列表 = 通过全部护栏。"""
    problems: List[str] = []
    problems.extend(validate_answer_leak(text, item))
    problems.extend(validate_knowledge_scope(text, item, graph))
    problems.extend(validate_length(text, cfg))
    problems.extend(validate_tone(text, cfg))
    return problems


GUARDRAILS = {
    "answer_leak": validate_answer_leak,
    "knowledge_scope": validate_knowledge_scope,
    "length": validate_length,
    "tone": validate_tone,
}
