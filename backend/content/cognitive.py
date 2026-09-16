"""认知有效性校验与答案独立复核。

这是内容系统里最重要、也最容易被忽略的一层：

> 一道题"数字变了"不等于"认知结构变了"。

例如：
  make_ten   要求两数之和 > 10 且都是个位数 —— 否则根本用不上凑十，孩子会退回数数
  carry_add  必须个位相加 ≥ 10 —— 否则不是进位题
  decompose  要求这个数"值得拆" —— 否则拆分是多余的步骤
  place_value 必须真的在问十位/个位 —— 否则只是普通口算

问题参数在不同 pattern 下语义不同，因此本模块用**显式的键名**区分，
不让同一套 a/b 在不同结构之间串味：

    a, b                两个加数（加法类）
    a, b (op="sub")     被减数、减数（减法类）
    known, target       已知部分、目标（缺失部分类）
    result, added       结果、增加量（逆向类）

规则以声明式表的形式集中在本文件，便于 review。不满足即为**错误**，
会让 `math-content validate` 失败。
"""
from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from backend.content.loader import Item

Problem = Optional[str]

_NUMBER_TOKEN = re.compile(r"\d+")


# ── 基础工具 ───────────────────────────────────────────────
def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def addends(item: Item) -> Tuple[Optional[int], Optional[int]]:
    return _int(item.problem.get("a")), _int(item.problem.get("b"))


def sub_pair(item: Item) -> Tuple[Optional[int], Optional[int]]:
    """返回（被减数, 减数）。缺失部分题的两个数语义相反，这里统一换算。"""
    if item.pattern_id == "missing_part":
        return _int(item.problem.get("target")), _int(item.problem.get("known"))
    return _int(item.problem.get("a")), _int(item.problem.get("b"))


def part_pair(item: Item) -> Tuple[Optional[int], Optional[int]]:
    return _int(item.problem.get("known")), _int(item.problem.get("target"))


def reverse_pair(item: Item) -> Tuple[Optional[int], Optional[int]]:
    return _int(item.problem.get("result")), _int(item.problem.get("added"))


def ones(n: int) -> int:
    return abs(n) % 10


def tens(n: int) -> int:
    return abs(n) // 10


def op(item: Item) -> str:
    return str(item.problem.get("op", "add"))


# ── 结构有效性规则 ─────────────────────────────────────────
CognitiveRule = Tuple[str, Optional[Sequence[str]], str, Callable[[Item], Problem]]


def _rule_sd_add_10(item: Item) -> Problem:
    a, b = addends(item)
    if a is None or b is None:
        return None
    if a + b > 10:
        return "10 以内加法的和不能超过 10（当前 {} + {} = {}）".format(a, b, a + b)
    if a >= 10 or b >= 10:
        return "10 以内加法不应出现两位数操作数"
    return None


def _rule_sd_sub_10(item: Item) -> Problem:
    a, b = sub_pair(item)
    if a is None or b is None:
        return None
    if a > 10:
        return "10 以内减法不应出现大于 10 的被减数（当前 {}）".format(a)
    if b < 1:
        return "减数至少是 1（当前 {}）".format(b)
    if a - b < 0:
        return "10 以内减法不应出现负数结果（{} - {}）".format(a, b)
    return None


def _rule_sd_sub_20(item: Item) -> Problem:
    a, b = sub_pair(item)
    if a is None or b is None:
        return None
    if not (10 < a <= 20):
        return "20 以内减法的被减数必须落在 11~20（当前 {}）".format(a)
    if a - b < 0:
        return "20 以内减法不应出现负数结果（{} - {}）".format(a, b)
    if ones(a) >= ones(b):
        return "20 以内减法（退位）要求个位不够减（当前个位 {} ≥ {}）".format(
            ones(a), ones(b)
        )
    return None


def _rule_sd_add_20(item: Item) -> Problem:
    a, b = addends(item)
    if a is None or b is None:
        return None
    if not (10 < a + b <= 20):
        return "20 以内加法的和必须落在 11~20（当前 {}）".format(a + b)
    return None


def _rule_make_ten(item: Item) -> Problem:
    """凑十题必须"需要凑十"。"""
    a, b = addends(item)
    if a is None or b is None:
        return None
    if a >= 10 or b >= 10:
        return "凑十题的加数应小于 10（当前 {} / {}）".format(a, b)
    if a + b <= 10:
        return "凑十要求两数之和大于 10，否则用不上凑十（当前 {} + {} = {}）".format(
            a, b, a + b
        )
    if 10 - a >= b:
        return "凑十要求 {} 能给出凑满 10 所需的 {} 个（当前只有 {}）".format(b, 10 - a, b)
    return None


def _rule_carry_add(item: Item) -> Problem:
    a, b = addends(item)
    if a is None or b is None:
        return None
    if ones(a) + ones(b) < 10:
        return "进位题必须个位相加 ≥ 10（当前个位 {} + {} = {}）".format(
            ones(a), ones(b), ones(a) + ones(b)
        )
    return None


def _rule_td_add_nocarry(item: Item) -> Problem:
    a, b = addends(item)
    if a is None or b is None:
        return None
    if ones(a) + ones(b) >= 10:
        return "不进位题不能个位相加 ≥ 10（当前 {}）".format(ones(a) + ones(b))
    if max(a, b) < 10:
        return "两位数加法应至少有一个两位数操作数"
    return None


def _rule_borrow_sub(item: Item) -> Problem:
    minuend, subtrahend = sub_pair(item)
    if minuend is None or subtrahend is None:
        return None
    if ones(minuend) >= ones(subtrahend):
        return "退位题必须个位不够减（被减数个位 {} ≥ 减数个位 {}）".format(
            ones(minuend), ones(subtrahend)
        )
    return None


def _rule_td_sub_nocarry(item: Item) -> Problem:
    minuend, subtrahend = sub_pair(item)
    if minuend is None or subtrahend is None:
        return None
    if ones(minuend) < ones(subtrahend):
        return "不退位题个位必须够减（当前 {} < {}）".format(
            ones(minuend), ones(subtrahend)
        )
    return None


def _rule_represent_place_value(item: Item) -> Problem:
    a, _ = addends(item)
    if a is None:
        return None
    if a < 10:
        return "位值题必须是两位数（当前 {}）".format(a)
    if item.problem.get("ask") not in ("tens", "ones"):
        return "位值题必须显式声明问的是 tens 还是 ones"
    return None


def _rule_decompose_worthwhile(item: Item) -> Problem:
    a, b = addends(item)
    if a is None or b is None:
        return None
    if max(a, b) < 5:
        return "两数都太小，拆分不会带来任何便利（{} / {}）".format(a, b)
    return None


def _rule_part_target_larger(item: Item) -> Problem:
    known, target = part_pair(item)
    if known is None or target is None:
        return None
    if target <= known:
        return "缺失部分题的目标（{}）必须大于已知部分（{}）".format(target, known)
    return None


def _rule_reverse_result_larger(item: Item) -> Problem:
    result, added = reverse_pair(item)
    if result is None or added is None:
        return None
    if added >= result:
        return "逆向题的增加量（{}）必须小于结果（{}）".format(added, result)
    return None


# (competency, patterns, 标签, 检查函数) —— patterns 为 None 表示该能力下所有结构
STRUCTURE_RULES: List[CognitiveRule] = [
    ("sd_add_10", ("direct_compute", "combine"), "和不超过 10", _rule_sd_add_10),
    ("sd_sub_10", ("direct_compute", "missing_part"), "10 以内减法", _rule_sd_sub_10),
    ("sd_add_20", ("direct_compute", "total"), "和在 11~20", _rule_sd_add_20),
    ("sd_sub_20", ("direct_compute", "missing_part"), "20 以内退位减法", _rule_sd_sub_20),
    ("make_ten", ("decompose", "direct_compute"), "必须需要凑十", _rule_make_ten),
    ("carry_add", ("direct_compute", "increase", "combine", "carry_exchange"),
     "个位相加满十", _rule_carry_add),
    ("td_add_nocarry", ("direct_compute", "combine"), "个位不进位", _rule_td_add_nocarry),
    ("borrow_sub", ("direct_compute", "missing_part", "carry_exchange"),
     "个位不够减", _rule_borrow_sub),
    ("td_sub_nocarry", ("direct_compute",), "个位够减", _rule_td_sub_nocarry),
    (None, ("represent_place_value",), "必须是两位数", _rule_represent_place_value),
    (None, ("decompose",), "拆分必须有意义", _rule_decompose_worthwhile),
    (None, ("missing_part",), "目标大于已知部分", _rule_part_target_larger),
    (None, ("reverse",), "结果大于增加量", _rule_reverse_result_larger),
]


def check_cognitive(item: Item) -> List[str]:
    problems: List[str] = []
    for competency, patterns, label, check in STRUCTURE_RULES:
        if competency and item.competency_id != competency:
            continue
        if patterns and item.pattern_id not in patterns:
            continue
        result = check(item)
        if result:
            problems.append("[认知有效性·{}] {}".format(label, result))
    return problems


# ── 答案独立复核 ───────────────────────────────────────────
def solve(item: Item) -> Optional[int]:
    """用与内容无关的独立方式求解，用于复核 answer 字段。"""
    pattern = item.pattern_id

    if pattern == "number_friends":
        a, _ = addends(item)
        target = _int(item.problem.get("target"))
        if a is None or target is None:
            return None
        return target - a

    if pattern == "represent_place_value":
        a, _ = addends(item)
        if a is None:
            return None
        return tens(a) if item.problem.get("ask") == "tens" else ones(a)

    if pattern == "missing_part":
        known, target = part_pair(item)
        if known is None or target is None:
            return None
        return target - known

    if pattern == "reverse":
        result, added = reverse_pair(item)
        if result is None or added is None:
            return None
        return result - added

    a, b = addends(item)
    if a is None or b is None:
        return None
    return a - b if op(item) == "sub" else a + b


def check_answer(item: Item) -> List[str]:
    expected = solve(item)
    if expected is None:
        return []
    actual = _int(item.answer)
    if actual is None:
        return ["答案不是整数，无法复核"]
    if actual != expected:
        return [
            "答案与独立求解不一致：内容写的是 {}，独立求解得到 {}".format(actual, expected)
        ]
    return []


# ── steps 复核 ─────────────────────────────────────────────
# steps 是**示范路径**，不是提示。它出现在答案之后（给家长报告、复盘、教练引用），
# 因此写不写答案都可以。凑十法的最后一步就该停在「10 + 3」—— 把最后一步留给孩子，
# 这才是教学设计；反过来要求它写成「= 13」反而是错的。
#
# 所以这里只查两类**客观错误**：
#   1. 步骤里的算式算错了（8 + 5 = 12）—— 会直接把孩子教歪
#   2. 步骤给出的结论和答案矛盾（答案 13，步骤却是从别的题复制来的「8 + 4 = 12」）
# 至于"步骤没有走到答案"，那是**可疑**不是**错误**，交给 lint。

_OP_ALIASES = {
    "+": "+", "加": "+", "加上": "+",
    "-": "-", "减": "-", "减去": "-",
    "×": "*", "*": "*", "乘": "*",
    "÷": "/", "/": "/", "除以": "/",
}
_OP_PATTERN = "|".join(sorted((re.escape(k) for k in _OP_ALIASES), key=len, reverse=True))

# 捕获 "10 + 3 = 13" / "8 - 5 ＝ 3" / "13 减去 3 = 10" 这样的等式，支持连算
_EQUALITY = re.compile(
    r"(\d+(?:\s*(?:{op})\s*\d+)+)\s*[=＝]\s*(\d+)".format(op=_OP_PATTERN)
)
_TOKEN = re.compile(r"\d+|{op}".format(op=_OP_PATTERN))


def _eval_chain(expression: str) -> Optional[int]:
    """把「10 + 3」「13 减去 3」这类算式按从左到右求值。

    只支持一元连算（不做优先级），因为这类内容里不会出现带括号的混合运算；
    真出现了，求值结果与答案不符会被报出来，人再判断。
    """
    tokens = _TOKEN.findall(expression)
    if not tokens:
        return None
    total = _int(tokens[0])
    if total is None:
        return None
    index = 1
    while index + 1 < len(tokens):
        operator = _OP_ALIASES.get(tokens[index])
        if operator is None:
            return None
        operand = _int(tokens[index + 1])
        if operand is None:
            return None
        if operator == "+":
            total += operand
        elif operator == "-":
            total -= operand
        elif operator == "*":
            total *= operand
        elif operator == "/":
            if operand == 0 or total % operand != 0:
                return None
            total //= operand
        index += 2
    if index != len(tokens):
        return None  # 尾部还有没消化掉的 token，说明不是干净的算式
    return total


def step_equalities(item: Item) -> List[Tuple[str, int, int]]:
    """抽取 steps 里所有显式等式，返回（原始文本, 算出来的值, 内容写的结果）。"""
    out = []
    for step in item.steps or []:
        for expression, stated in _EQUALITY.findall(str(step)):
            computed = _eval_chain(expression)
            if computed is not None:
                out.append((str(step), computed, int(stated)))
    return out


def check_steps(item: Item) -> List[str]:
    problems: List[str] = []

    for step, computed, stated in step_equalities(item):
        if computed != stated:
            problems.append(
                "steps 里的算式算错了：「{}」应该是 {}，内容写的是 {}".format(
                    step, computed, stated
                )
            )

    if problems:
        return problems

    # 结论与答案矛盾 —— 典型的"从别的题复制步骤"
    answer = _int(item.answer)
    if answer is None or not item.steps:
        return problems
    text = " ".join(str(s) for s in item.steps)
    if answer in {int(tok) for tok in _NUMBER_TOKEN.findall(text)}:
        return problems
    for step, computed, stated in step_equalities(item):
        if stated != answer:
            problems.append(
                "steps 的结论（{}）与答案（{}）矛盾，而且步骤里完全没出现答案：「{}」".format(
                    stated, answer, step
                )
            )
            break
    return problems


def lint_steps(item: Item) -> List[str]:
    """可疑但不阻塞：声明了 conclude，示范路径却没走到答案。

    只有 `steps_style: conclude` 的题才检查 —— 默认的 `guide` 是**刻意的教学设计**
    （凑十法的最后一步「10 + 3」就该留给孩子算），对它报"没走到答案"是误报。
    """
    if item.steps_style != "conclude":
        return []
    answer = _int(item.answer)
    if answer is None:
        return []
    text = " ".join(str(s) for s in item.steps or [])
    if answer in {int(tok) for tok in _NUMBER_TOKEN.findall(text)}:
        return []
    if any(stated == answer for _, _, stated in step_equalities(item)):
        return []
    return [
        "steps_style=conclude，但示范路径全程没有出现答案 {}".format(answer)
    ]


def check_all(item: Item) -> List[str]:
    return check_cognitive(item) + check_answer(item) + check_steps(item)


def lint_all(item: Item) -> List[str]:
    return lint_steps(item)
