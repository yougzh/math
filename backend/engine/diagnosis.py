"""错误认知诊断。

比记录"答错"有价值得多的是记录"错在哪里"：
  23 + 14 答成 47  → 位值混淆  → 回退到位值实验室
  8 + 5 答成 12    → 依赖数数  → 降低脚手架的抽象层级

P0 实现：内容层声明的 error_rules 精确匹配 + 配置层的通用兜底规则。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from backend.content.loader import Item
from backend.engine.config import AlgorithmConfig
from backend.engine.types import Attempt


def _as_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def rule_matches(match: Dict[str, Any], submitted: Any, expected: Any) -> bool:
    sub = _as_int(submitted)
    exp = _as_int(expected)

    if "answer_equals" in match:
        if sub is None or sub != _as_int(match["answer_equals"]):
            return False

    if "answer_in" in match:
        if sub is None or sub not in {_as_int(v) for v in match["answer_in"]}:
            return False

    if "answer_off_by" in match:
        delta = _as_int(match["answer_off_by"])
        if sub is None or exp is None or delta is None or abs(sub - exp) != delta:
            return False

    if "answer_off_by_multiple_of" in match:
        step = _as_int(match["answer_off_by_multiple_of"])
        if sub is None or exp is None or not step or sub == exp or (sub - exp) % step != 0:
            return False

    return bool(match)


def match_rules(
    rules: List[Dict[str, Any]],
    submitted: Any,
    expected: Any,
) -> List[str]:
    codes: List[str] = []
    for rule in rules:
        if rule_matches(rule.get("match", {}), submitted, expected):
            code = rule.get("code")
            if code and code not in codes:
                codes.append(code)
    return codes


def diagnose(
    attempt: Attempt,
    item: Optional[Item],
    cfg: AlgorithmConfig,
) -> List[str]:
    """返回本次作答命中的错误认知 code 列表。

    内容层规则优先；一条都没命中时，才用配置里的通用规则兜底。
    通用规则只兜最常见的结构性错误（如答案差了整十 → 位值混淆）。
    """
    if attempt.correct:
        return list(attempt.misconception_codes)

    codes: List[str] = []
    if item is not None and item.error_rules:
        codes = match_rules(item.error_rules, attempt.submitted_answer, item.answer)

    if not codes:
        codes = match_rules(
            cfg.generic_error_rules(), attempt.submitted_answer, item.answer if item else None
        )

    for code in attempt.misconception_codes:
        if code not in codes:
            codes.append(code)
    return codes
