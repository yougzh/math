"""题目模板生成器。

> 不要人工生产几千道题。

    Template → Parameter Generator → Validator → Candidate Item → Human Review

生成的候选必须通过 `cognitive.check_all`（认知有效性 + 答案独立复核）才允许落盘。
好处是生成器本身不必"小心翼翼别写错"—— 写错了会被校验拦下并报出来。

问题参数在不同 pattern 下语义不同，约定见 cognitive.py 顶部说明：
    a, b            两个加数
    a, b (op=sub)   被减数、减数
    known, target   已知部分、目标
    result, added   结果、增加量
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

import yaml

from backend.content.cognitive import check_all
from backend.content.loader import Item
from backend.paths import ITEM_DIR


# ── 生成结果 ───────────────────────────────────────────────
@dataclass
class GeneratedItem:
    code: str
    competency: str
    pattern: str
    difficulty: int
    scaffold_level: str
    interaction_type: str
    estimated_seconds: int
    problem: Dict[str, Any]
    answer: int
    steps: List[str]
    hint_chain: List[str]
    error_rules: List[Dict[str, Any]] = field(default_factory=list)
    # 生成器写的是完整解答（最后一步带答案），所以声明 conclude 让 lint 真的检查它
    steps_style: str = "conclude"

    def to_yaml_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "competency": self.competency,
            "pattern": self.pattern,
            "difficulty": self.difficulty,
            "scaffold_level": self.scaffold_level,
            "interaction_type": self.interaction_type,
            "estimated_seconds": self.estimated_seconds,
            "problem": self.problem,
            "answer": self.answer,
            "steps": self.steps,
            "steps_style": self.steps_style,
            "hint_chain": self.hint_chain,
            "error_rules": self.error_rules,
        }

    def as_item(self) -> Item:
        return Item(
            code=self.code,
            competency_id=self.competency,
            pattern_id=self.pattern,
            difficulty=self.difficulty,
            scaffold_level=self.scaffold_level,
            interaction_type=self.interaction_type,
            estimated_seconds=self.estimated_seconds,
            problem=self.problem,
            answer=self.answer,
            steps=list(self.steps),
            hint_chain=list(self.hint_chain),
            error_rules=list(self.error_rules),
            steps_style=self.steps_style,
        )


# ── 通用小工具 ─────────────────────────────────────────────
def off_by_rules(answer: int) -> List[Dict[str, Any]]:
    rules: List[Dict[str, Any]] = [{"code": "counting_dependency", "match": {"answer_off_by": 1}}]
    if answer >= 10:
        rules.insert(
            0, {"code": "place_value_confusion", "match": {"answer_off_by_multiple_of": 10}}
        )
    return rules


def make_ten_steps(a: int, b: int) -> Tuple[List[str], List[str]]:
    """凑十路径：把 b 拆成 (10-a) 和剩下的部分（调用方需保证 10-a < b）。"""
    friend = 10 - a
    rest = b - friend
    return (
        [
            "{} 和 {} 凑成 10".format(a, friend),
            "{} 拆成 {} 和 {}".format(b, friend, rest),
            "10 + {} = {}".format(rest, a + b),
        ],
        [
            "{} 和几凑成 10？".format(a),
            "把 {} 拆开试试".format(b),
            "先算 {} + {}".format(a, friend),
        ],
    )


def col_add_steps(a: int, b: int) -> Tuple[List[str], List[str]]:
    ao, bo = a % 10, b % 10
    at, bt = a // 10, b // 10
    carry = ao + bo >= 10
    if carry:
        steps = [
            "个位 {}+{}={}，满十要进 1".format(ao, bo, ao + bo),
            "十位 {}+{}+1={}".format(at, bt, at + bt + 1),
            "合起来是 {}".format(a + b),
        ]
        hints = ["先算个位，看看要不要进位", "满十的时候别忘了进 1"]
    else:
        steps = [
            "个位 {}+{}={}".format(ao, bo, ao + bo),
            "十位 {}+{}={}".format(at, bt, at + bt),
            "合起来是 {}".format(a + b),
        ]
        hints = ["个位和个位相加", "十位和十位相加"]
    return steps, hints


def sd_add_10_difficulty(total: int) -> int:
    """10 以内加法的难度梯：和越大，需要保持的跨度越长。

    这个能力只有一类数（一位数、和 ≤ 10），难度不可能来自"题型"，
    所以按**和的大小**分三档：≤5 可以一眼看出，6~8 要数几步，
    9~10 已经贴到 10 的边界。slot 声明 1~4 的难度区间，靠它才有内容可推进 ——
    如果所有题都挂在难度 1，孩子熟练度再涨也只会一直拿到同一档题。
    """
    if total <= 5:
        return 1
    if total <= 8:
        return 2
    return 3


def sd_sub_10_difficulty(minuend: int) -> int:
    """10 以内减法的难度梯：被减数越大，越难一眼看出还剩多少。"""
    if minuend <= 5:
        return 1
    if minuend <= 8:
        return 2
    return 3


def col_sub_steps(minuend: int, subtrahend: int) -> Tuple[List[str], List[str]]:
    mo, so = minuend % 10, subtrahend % 10
    mt, st = minuend // 10, subtrahend // 10
    diff = minuend - subtrahend
    if mo < so:
        steps = [
            "个位 {} 不够减 {}，从十位借 1".format(mo, so),
            "借来以后个位是 {}，{} - {} = {}".format(mo + 10, mo + 10, so, mo + 10 - so),
            "十位剩下 {} - {} = {}".format(mt - 1, st, mt - 1 - st),
            "合起来是 {}".format(diff),
        ]
        hints = ["个位不够减的时候，可以找十位帮忙", "借走 1 个十以后，十位还剩几？"]
    else:
        steps = [
            "个位 {} - {} = {}".format(mo, so, mo - so),
            "十位 {} - {} = {}".format(mt, st, mt - st),
            "合起来是 {}".format(diff),
        ]
        hints = ["个位和个位相减", "十位和十位相减"]
    return steps, hints


# ── 内容家族 ───────────────────────────────────────────────
def gen_number_friends() -> List[GeneratedItem]:
    """凑十补数：8 和谁是好朋友。"""
    out = []
    for a in range(6, 10):
        friend = 10 - a
        others = [x for x in range(1, 11) if x != friend]
        out.append(
            GeneratedItem(
                code="nf_{}".format(a),
                competency="make_ten",
                pattern="number_friends",
                difficulty=1,
                scaffold_level="blocks",
                interaction_type="choice",
                estimated_seconds=8,
                problem={"a": a, "target": 10, "prompt": "{} 和谁是好朋友？".format(a)},
                answer=friend,
                steps=["{} 再添 {} 就是 10".format(a, friend)],
                hint_chain=["从 {} 往上数到 10，数了几个？".format(a)],
                error_rules=[{"code": "make_ten_not_used", "match": {"answer_in": others}}],
            )
        )
    return out


def gen_make_ten() -> List[GeneratedItem]:
    """11~18 的一位加法，三种脚手架各一份。"""
    out: List[GeneratedItem] = []
    for a in range(5, 10):
        for b in range(2, 10):
            total = a + b
            if total <= 10 or total > 18:
                continue
            if 10 - a >= b:
                continue  # 凑十要从 b 里借，friend 必须小于 b
            steps, hints = make_ten_steps(a, b)
            rules = off_by_rules(total)
            near = [total - 2, total - 1, total + 1]

            out.append(
                GeneratedItem(
                    code="mt_blk_{}_{}".format(a, b),
                    competency="make_ten",
                    pattern="decompose",
                    difficulty=1,
                    scaffold_level="blocks",
                    interaction_type="blocks",
                    estimated_seconds=20,
                    problem={
                        "a": a, "b": b, "target": 10,
                        "prompt": "摆出 {} 个，再摆出 {} 个。把十格框补满，一共是多少个？".format(a, b),
                    },
                    answer=total,
                    steps=steps,
                    hint_chain=[
                        "{} 再添几个就满十格框了？".format(a),
                        "从 {} 个里面拿几个过去补满？".format(b),
                        "补满以后，外面还剩几个？",
                    ],
                    error_rules=rules
                    + [{"code": "make_ten_not_used", "match": {"answer_in": near}}],
                )
            )
            out.append(
                GeneratedItem(
                    code="mt_dec_{}_{}".format(a, b),
                    competency="make_ten",
                    pattern="decompose",
                    difficulty=2,
                    scaffold_level="decompose",
                    interaction_type="decompose_drag",
                    estimated_seconds=15,
                    problem={
                        "a": a, "b": b,
                        "prompt": "把 {} 拆成两部分，先把 {} 凑成 10。".format(b, a),
                    },
                    answer=total,
                    steps=steps,
                    hint_chain=hints,
                    error_rules=rules
                    + [{"code": "make_ten_not_used", "match": {"answer_in": near}}],
                )
            )
            out.append(
                GeneratedItem(
                    code="mt_dir_{}_{}".format(a, b),
                    competency="make_ten",
                    pattern="direct_compute",
                    difficulty=3,
                    scaffold_level="direct",
                    interaction_type="number_pad",
                    estimated_seconds=6,
                    problem={"a": a, "b": b, "prompt": "{} + {} = ?".format(a, b)},
                    answer=total,
                    steps=steps,
                    hint_chain=["{} 和几凑成 10？".format(a), "把 {} 拆开试试".format(b)],
                    error_rules=rules
                    + [{"code": "make_ten_not_used", "match": {"answer_in": near}}],
                )
            )
    return out


def gen_applied_make_ten() -> List[GeneratedItem]:
    """同一能力、不同问题结构：总量 / 增加 / 缺失部分 / 逆向。

    ⚠️ 题面必须**自包含**：故事负责"为什么做"，题目负责"练什么"，
    但题目不能依赖故事补齐信息 —— 因为同一个 item 也可能被核心训练段
    （没有故事的独立槽位）选中。故事可以叠加情境，不能承担题面的义务。

    所以这里的 prompt 全部带上了具体数字，只是不加情境词（"车厢里"、"小熊"）。
    """
    out: List[GeneratedItem] = []
    pairs = [
        (8, 5), (7, 6), (9, 4), (8, 7), (9, 6),
        (7, 5), (6, 9), (9, 8), (5, 9), (6, 8),
    ]

    for a, b in pairs:
        total = a + b
        steps, hints = make_ten_steps(a, b)

        out.append(
            GeneratedItem(
                code="mt_total_{}_{}".format(a, b),
                competency="make_ten",
                pattern="total",
                difficulty=2,
                scaffold_level="decompose",
                interaction_type="number_pad",
                estimated_seconds=18,
                problem={"a": a, "b": b, "prompt": "{} 和 {} 一共有多少个？".format(a, b)},
                answer=total,
                steps=steps,
                hint_chain=["「一共」要用加法，还是减法？", "{} 和几凑成 10？".format(a)],
                error_rules=[
                    {"code": "operation_confusion", "match": {"answer_equals": abs(a - b)}},
                    {"code": "make_ten_not_used", "match": {"answer_in": [total - 1, total + 1]}},
                ],
            )
        )
        out.append(
            GeneratedItem(
                code="mt_inc_{}_{}".format(a, b),
                competency="make_ten",
                pattern="increase",
                difficulty=2,
                scaffold_level="decompose",
                interaction_type="number_pad",
                estimated_seconds=18,
                problem={
                    "a": a, "b": b,
                    "prompt": "原来有 {} 个，又来了 {} 个，现在一共有多少？".format(a, b),
                },
                answer=total,
                steps=steps,
                hint_chain=["「又多了」是变多还是变少？", "{} 和几凑成 10？".format(a)],
                error_rules=[
                    {"code": "operation_confusion", "match": {"answer_equals": abs(a - b)}},
                    {"code": "make_ten_not_used", "match": {"answer_in": [total - 1, total + 1]}},
                ],
            )
        )
        out.append(
            GeneratedItem(
                code="mt_miss_{}_{}".format(a, b),
                competency="make_ten",
                pattern="missing_part",
                difficulty=2,
                scaffold_level="decompose",
                interaction_type="number_pad",
                estimated_seconds=18,
                problem={
                    "known": a, "target": total,
                    "prompt": "已经有 {} 个，凑满 {} 个还差几个？".format(a, total),
                },
                answer=b,
                steps=[
                    "求还差多少，用目标减去已有的",
                    "{} - {} = {}".format(total, a, b),
                ],
                hint_chain=[
                    "这里问的是「还差多少」，还是「一共多少」？",
                    "用目标减去已有的",
                ],
                error_rules=[
                    {"code": "question_structure_missed", "match": {"answer_equals": total}},
                    {"code": "operation_confusion", "match": {"answer_equals": a + total}},
                ],
            )
        )
        out.append(
            GeneratedItem(
                code="mt_rev_{}_{}".format(a, b),
                competency="make_ten",
                pattern="reverse",
                difficulty=3,
                scaffold_level="decompose",
                interaction_type="choice",
                estimated_seconds=20,
                problem={
                    "result": total, "added": b,
                    "prompt": "加上 {} 以后变成了 {}，原来是多少？".format(b, total),
                },
                answer=a,
                steps=[
                    "已知结果，反推起点要用减法",
                    "{} - {} = {}".format(total, b, a),
                ],
                hint_chain=[
                    "已知结果反推起点，要用减法",
                    "从 {} 里减掉 {}".format(total, b),
                ],
                error_rules=[
                    {"code": "operation_confusion", "match": {"answer_equals": total + b}},
                    {"code": "question_structure_missed", "match": {"answer_equals": total}},
                ],
            )
        )
    return out


def gen_sd_add_10() -> List[GeneratedItem]:
    out: List[GeneratedItem] = []
    for a in range(1, 10):
        for b in range(1, 10):
            if a + b > 10:
                continue
            total = a + b
            hints = ["从 {} 开始，往后数 {} 个".format(a, b)]
            if total >= 9:
                # 难度 ≥ 3 的题必须有 ≥ 2 级台阶（lint 会检查），
                # 且提示里不能出现「数几步」以外的数字 —— 免得和答案撞车。
                hints.append("数的时候用手指点着，一个一个往后数")
            out.append(
                GeneratedItem(
                    code="s10a_{}_{}".format(a, b),
                    competency="sd_add_10",
                    pattern="direct_compute",
                    difficulty=sd_add_10_difficulty(total),
                    scaffold_level="direct",
                    interaction_type="number_pad",
                    estimated_seconds=6,
                    problem={"a": a, "b": b, "prompt": "{} + {} = ?".format(a, b)},
                    answer=total,
                    steps=["从 {} 往后数 {} 个，得到 {}".format(a, b, total)],
                    hint_chain=hints,
                    error_rules=off_by_rules(total),
                )
            )
    return out


def gen_sd_add_10_applied() -> List[GeneratedItem]:
    out: List[GeneratedItem] = []
    for a in range(2, 8):
        for b in range(1, 10 - a + 1):
            total = a + b
            hints = ["「一共」要用加法，还是减法？"]
            if total >= 9:
                hints.append("先数出一部分，再接着数另一部分")
            out.append(
                GeneratedItem(
                    code="s10c_{}_{}".format(a, b),
                    competency="sd_add_10",
                    pattern="combine",
                    difficulty=sd_add_10_difficulty(total),
                    scaffold_level="direct",
                    interaction_type="number_pad",
                    estimated_seconds=10,
                    problem={"a": a, "b": b, "prompt": "{} 和 {} 合起来一共是多少？".format(a, b)},
                    answer=total,
                    steps=["求一共就是相加", "{} + {} = {}".format(a, b, total)],
                    hint_chain=hints,
                    error_rules=[
                        {"code": "operation_confusion", "match": {"answer_equals": abs(a - b)}}
                    ],
                )
            )
    return out


def gen_sd_sub_10() -> List[GeneratedItem]:
    out: List[GeneratedItem] = []
    for a in range(2, 11):
        for b in range(1, a):
            diff = a - b
            hints = ["从 {} 开始，一个一个往前数".format(a)]
            if a >= 9:
                hints.append("数过的数用手指记着，数完看看还剩几个")
            out.append(
                GeneratedItem(
                    code="s10s_{}_{}".format(a, b),
                    competency="sd_sub_10",
                    pattern="direct_compute",
                    difficulty=sd_sub_10_difficulty(a),
                    scaffold_level="direct",
                    interaction_type="number_pad",
                    estimated_seconds=6,
                    problem={"a": a, "b": b, "op": "sub", "prompt": "{} - {} = ?".format(a, b)},
                    answer=diff,
                    steps=["从 {} 往前数 {} 个，得到 {}".format(a, b, diff)],
                    # 提示里不能写「往前数 b 个」：b 恰好等于答案时（2-1、4-2、6-3…）
                    # 提示就直接把答案说出来了。孩子已经从题面知道要减几，
                    # 提示只需要给出方向。
                    hint_chain=hints,
                    error_rules=off_by_rules(diff),
                )
            )
    return out


def gen_sd_sub_10_missing_part() -> List[GeneratedItem]:
    """10 以内减法的另一半：已知总数和一个部分，求"还差多少"（missing_part）。

    与 direct_compute（拿走剩下的）刻意区分：同一个 9 - 4 = 5，
    这里问的是"还差几个"，孩子要先判断该不该用减法 —— 这是另一种认知结构，
    也是 sd_sub_10 升级所缺的第二个 pattern。

    target 刻意取 5~9：凑满 10 的结构已经由 make_ten 的 number_friends 承担，
    再出"凑满 10"会让两个能力的内容互相撞车。

    难度按"支持的多少"分四档（blocks → decompose → direct → choice），
    与 make_ten / place_value 的档位约定一致：支持越少越难。这样 sd_sub_10 的
    practice / challenge 槽声明的难度区间才真的有内容可推进，而不是全压在难度 1。
    """
    out: List[GeneratedItem] = []
    for target in range(5, 10):
        for known in range(1, target):
            diff = target - known
            steps = [
                "求还差多少，用要凑满的数减去已经有的",
                "{} - {} = {}".format(target, known, diff),
            ]
            # 提示刻意不带数字：known 恰好等于答案时（6 已有 3 个、8 已有 4 个…），
            # 一旦把 known 写进提示就等于把答案说出来。
            hints = [
                "这里问的是「还差多少」，还是「一共多少」？",
                "用要凑满的数减去已经有的",
            ]
            rules = [{"code": "question_structure_missed", "match": {"answer_equals": target + known}}]

            out.append(
                GeneratedItem(
                    code="s10m_blk_{}_{}".format(target, known),
                    competency="sd_sub_10",
                    pattern="missing_part",
                    difficulty=1,
                    scaffold_level="blocks",
                    interaction_type="blocks",
                    estimated_seconds=14,
                    problem={
                        "known": known, "target": target,
                        "prompt": "盘子里已经摆了 {} 个，要凑满 {} 个。还差几个？".format(known, target),
                    },
                    answer=diff,
                    steps=["先摆出已有的 {} 个，再数还缺几个".format(known)] + steps,
                    hint_chain=hints,
                    error_rules=rules,
                )
            )
            out.append(
                GeneratedItem(
                    code="s10m_dec_{}_{}".format(target, known),
                    competency="sd_sub_10",
                    pattern="missing_part",
                    difficulty=2,
                    scaffold_level="decompose",
                    interaction_type="number_pad",
                    estimated_seconds=12,
                    problem={
                        "known": known, "target": target,
                        "prompt": "已经有 {} 个，凑满 {} 个还差几个？".format(known, target),
                    },
                    answer=diff,
                    steps=steps,
                    hint_chain=hints,
                    error_rules=rules,
                )
            )
            out.append(
                GeneratedItem(
                    code="s10m_dir_{}_{}".format(target, known),
                    competency="sd_sub_10",
                    pattern="missing_part",
                    difficulty=3,
                    scaffold_level="direct",
                    interaction_type="number_pad",
                    estimated_seconds=8,
                    problem={
                        "known": known, "target": target,
                        "prompt": "要凑满 {} 个，已经有了 {} 个，还差几个？".format(target, known),
                    },
                    answer=diff,
                    steps=steps,
                    hint_chain=hints,
                    error_rules=rules,
                )
            )
            # 第四档：不给任何算式支撑，只留一条心算通路（choice 四选一）
            out.append(
                GeneratedItem(
                    code="s10m_chc_{}_{}".format(target, known),
                    competency="sd_sub_10",
                    pattern="missing_part",
                    difficulty=4,
                    scaffold_level="direct",
                    interaction_type="choice",
                    estimated_seconds=10,
                    problem={
                        "known": known, "target": target,
                        "prompt": "再加几个就有 {} 个了？现在已经有 {} 个。".format(target, known),
                    },
                    answer=diff,
                    steps=steps,
                    hint_chain=hints,
                    error_rules=rules,
                )
            )
    return out


def gen_place_value() -> List[GeneratedItem]:
    """位值表征：必须真的是两位数，且明确问 ten 还是 one。"""
    out: List[GeneratedItem] = []
    values = [12, 15, 18, 21, 23, 25, 32, 34, 36, 41, 45, 47,
              52, 54, 58, 63, 67, 71, 76, 82, 85, 94, 97]
    for value in values:
        t, o = value // 10, value % 10
        out.append(
            GeneratedItem(
                code="pv_t_{}".format(value),
                competency="place_value",
                pattern="represent_place_value",
                difficulty=1,
                scaffold_level="blocks",
                interaction_type="blocks",
                estimated_seconds=20,
                problem={"a": value, "ask": "tens", "prompt": "{} 里面有几个十？".format(value)},
                answer=t,
                steps=["{} 是 {} 个十和 {} 个一".format(value, t, o),
                       "问的是几个十，所以是 {}".format(t)],
                hint_chain=["它有几位数？", "十位上的数字是几？"],
                error_rules=[{"code": "place_value_confusion", "match": {"answer_equals": o}}],
            )
        )
        out.append(
            GeneratedItem(
                code="pv_o_{}".format(value),
                competency="place_value",
                pattern="represent_place_value",
                difficulty=1,
                scaffold_level="blocks",
                interaction_type="blocks",
                estimated_seconds=20,
                problem={"a": value, "ask": "ones", "prompt": "{} 里面有几个一？".format(value)},
                answer=o,
                steps=["{} 是 {} 个十和 {} 个一".format(value, t, o),
                       "问的是几个一，所以是 {}".format(o)],
                hint_chain=["个位上的数字是几？", "个位是最右边那一位"],
                error_rules=[{"code": "place_value_confusion", "match": {"answer_equals": t}}],
            )
        )
    return out


def gen_place_value_compose() -> List[GeneratedItem]:
    """位值的另一半：从「几个十 + 几个一」把数合起来（combine）。

    与 represent_place_value（读一个数里有几个十/几个一）刻意区分：
    读数是**分析**，合成是**综合** —— 同一个数、两种认知操作，
    这正是 place_value 升级所缺的第二个 pattern。

    数值沿用 gen_place_value 的那份列表：同一批数换一个结构，
    迁移测试测的才是"结构"本身，而不是"没见过的新数字"。
    """
    out: List[GeneratedItem] = []
    values = [12, 15, 18, 21, 23, 25, 32, 34, 36, 41, 45, 47,
              52, 54, 58, 63, 67, 71, 76, 82, 85, 94, 97]
    for value in values:
        t, o = value // 10, value % 10
        tens = t * 10
        # 典型错误：把"2 个十和 3 个一"当成 2 + 3
        rules = [{"code": "place_value_confusion", "match": {"answer_equals": t + o}}]
        out.append(
            GeneratedItem(
                code="pvc_blk_{}".format(value),
                competency="place_value",
                pattern="combine",
                difficulty=1,
                scaffold_level="blocks",
                interaction_type="blocks",
                estimated_seconds=20,
                problem={
                    "a": tens, "b": o,
                    "prompt": "摆出 {} 个十和 {} 个一，合起来是多少？".format(t, o),
                },
                answer=value,
                steps=[
                    "{} 个十就是 {}".format(t, tens),
                    "{} + {} = {}".format(tens, o, value),
                ],
                hint_chain=["{} 个十是哪一个整十数？".format(t), "再添上 {} 个一".format(o)],
                error_rules=rules,
            )
        )
        out.append(
            GeneratedItem(
                code="pvc_dec_{}".format(value),
                competency="place_value",
                pattern="combine",
                difficulty=2,
                scaffold_level="decompose",
                interaction_type="number_pad",
                estimated_seconds=15,
                problem={
                    "a": tens, "b": o,
                    "prompt": "{} 个十和 {} 个一合起来是多少？".format(t, o),
                },
                answer=value,
                steps=[
                    "{} 个十是 {}，{} 个一是 {}".format(t, tens, o, o),
                    "{} + {} = {}".format(tens, o, value),
                ],
                hint_chain=["先把 {} 个十看成一个整十数".format(t), "再添上 {} 个一".format(o)],
                error_rules=rules,
            )
        )
        out.append(
            GeneratedItem(
                code="pvc_dir_{}".format(value),
                competency="place_value",
                pattern="combine",
                difficulty=3,
                scaffold_level="direct",
                interaction_type="number_pad",
                estimated_seconds=10,
                problem={
                    "a": tens, "b": o,
                    "prompt": "把 {} 个十和 {} 个一写成一个数，是多少？".format(t, o),
                },
                answer=value,
                steps=[
                    "十位上写 {}，个位上写 {}".format(t, o),
                    "{} + {} = {}".format(tens, o, value),
                ],
                hint_chain=["十位写 {}，个位写 {}".format(t, o), "合起来读一读这个数"],
                error_rules=rules,
            )
        )
        # 第四档：只给十位/个位上的数字，不给"几个十"的现成说法 ——
        # 孩子要把"数字所在的位置"翻译成"几个十、几个一"，比 pvc_dir 更靠近读写的本质。
        out.append(
            GeneratedItem(
                code="pvc_chc_{}".format(value),
                competency="place_value",
                pattern="combine",
                difficulty=4,
                scaffold_level="direct",
                interaction_type="choice",
                estimated_seconds=8,
                problem={
                    "a": tens, "b": o,
                    "prompt": "十位上的数字是 {}，个位上的数字是 {}。这个数是多少？".format(t, o),
                },
                answer=value,
                steps=[
                    "十位上的 {} 表示 {} 个十，就是 {}".format(t, t, tens),
                    "个位上的 {} 表示 {} 个一".format(o, o),
                    "{} + {} = {}".format(tens, o, value),
                ],
                # 提示不带数字：answer（value）不能出现在提示里
                hint_chain=["左边那一位是十位", "右边那一位是个位"],
                error_rules=rules,
            )
        )
    return out


def gen_td_add_nocarry() -> List[GeneratedItem]:
    out: List[GeneratedItem] = []
    for a in range(10, 60, 3):
        for b in range(10, 40, 4):
            if (a % 10) + (b % 10) >= 10:
                continue
            total = a + b
            steps, hints = col_add_steps(a, b)
            out.append(
                GeneratedItem(
                    code="tda_{}_{}".format(a, b),
                    competency="td_add_nocarry",
                    pattern="combine",
                    difficulty=3,
                    scaffold_level="decompose",
                    interaction_type="number_pad",
                    estimated_seconds=15,
                    problem={"a": a, "b": b, "prompt": "{} + {} = ?".format(a, b)},
                    answer=total,
                    steps=steps,
                    hint_chain=hints,
                    error_rules=off_by_rules(total),
                )
            )
    return out


def gen_carry_add() -> List[GeneratedItem]:
    out: List[GeneratedItem] = []
    for a in range(13, 60, 7):
        for b in range(8, 40, 5):
            if (a % 10) + (b % 10) < 10:
                continue
            total = a + b
            steps, hints = col_add_steps(a, b)
            out.append(
                GeneratedItem(
                    code="cra_{}_{}".format(a, b),
                    competency="carry_add",
                    pattern="increase",
                    difficulty=4,
                    scaffold_level="decompose",
                    interaction_type="number_pad",
                    estimated_seconds=20,
                    problem={"a": a, "b": b, "prompt": "{} + {} = ?".format(a, b)},
                    answer=total,
                    steps=steps,
                    hint_chain=hints,
                    error_rules=[
                        {"code": "carry_missed", "match": {"answer_equals": total - 10}},
                        {"code": "place_value_confusion",
                         "match": {"answer_off_by_multiple_of": 10}},
                    ],
                )
            )
    return out


def gen_td_sub_nocarry() -> List[GeneratedItem]:
    out: List[GeneratedItem] = []
    for a in range(30, 90, 6):
        for b in range(11, 30, 4):
            if (a % 10) < (b % 10) or b >= a:
                continue
            diff = a - b
            steps, hints = col_sub_steps(a, b)
            out.append(
                GeneratedItem(
                    code="tds_{}_{}".format(a, b),
                    competency="td_sub_nocarry",
                    pattern="direct_compute",
                    difficulty=3,
                    scaffold_level="decompose",
                    interaction_type="number_pad",
                    estimated_seconds=15,
                    problem={"a": a, "b": b, "op": "sub", "prompt": "{} - {} = ?".format(a, b)},
                    answer=diff,
                    steps=steps,
                    hint_chain=hints,
                    error_rules=off_by_rules(diff),
                )
            )
    return out


def gen_td_sub_nocarry_decompose() -> List[GeneratedItem]:
    """不退位减法的策略结构：把减数拆成整十和个位，分两步减（decompose）。

    与 direct_compute（一口算完）刻意区分：这里练的是"怎么算更省力"。
    对不退位减法这个结构永远成立 —— 个位够减，先减整十数绝不会借位，
    所以"先减整十、再减个位"是一条孩子能自己复现的稳定路径。
    """
    out: List[GeneratedItem] = []
    for a in range(30, 90, 6):
        for b in range(11, 30, 4):
            if (a % 10) < (b % 10) or b >= a:
                continue
            diff = a - b
            tens_part, ones_part = b // 10 * 10, b % 10
            after_tens = a - tens_part
            steps = [
                "把 {} 拆成 {} 和 {}".format(b, tens_part, ones_part),
                "{} - {} = {}".format(a, tens_part, after_tens),
                "{} - {} = {}".format(after_tens, ones_part, diff),
            ]
            # 提示不带数字：避免与答案撞车，也逼孩子自己去找"拆哪一个"
            hints = ["先把减数拆成整十和个位", "先减整十，再减个位"]
            rules = off_by_rules(diff)

            out.append(
                GeneratedItem(
                    code="tdsd_blk_{}_{}".format(a, b),
                    competency="td_sub_nocarry",
                    pattern="decompose",
                    difficulty=2,
                    scaffold_level="blocks",
                    interaction_type="blocks",
                    estimated_seconds=22,
                    problem={
                        "a": a, "b": b, "op": "sub",
                        "prompt": "摆出 {}，要拿走 {}。先拿走整十的，再拿走个位的，还剩多少？".format(a, b),
                    },
                    answer=diff,
                    steps=["先拿走整十的数，再拿走个位的数"] + steps,
                    hint_chain=hints,
                    error_rules=rules,
                )
            )
            out.append(
                GeneratedItem(
                    code="tdsd_dec_{}_{}".format(a, b),
                    competency="td_sub_nocarry",
                    pattern="decompose",
                    difficulty=3,
                    scaffold_level="decompose",
                    interaction_type="number_pad",
                    estimated_seconds=18,
                    problem={
                        "a": a, "b": b, "op": "sub",
                        "prompt": "{} - {}：先把减数拆成整十和个位，分两步减，结果是多少？".format(a, b),
                    },
                    answer=diff,
                    steps=steps,
                    hint_chain=hints,
                    error_rules=rules,
                )
            )
            out.append(
                GeneratedItem(
                    code="tdsd_dir_{}_{}".format(a, b),
                    competency="td_sub_nocarry",
                    pattern="decompose",
                    difficulty=4,
                    scaffold_level="direct",
                    interaction_type="number_pad",
                    estimated_seconds=12,
                    problem={
                        "a": a, "b": b, "op": "sub",
                        "prompt": "{} - {} = ?（先减整十，再减个位）".format(a, b),
                    },
                    answer=diff,
                    steps=steps,
                    hint_chain=hints,
                    error_rules=rules,
                )
            )
    return out


def gen_borrow_sub() -> List[GeneratedItem]:
    out: List[GeneratedItem] = []
    for a in range(31, 90, 7):
        for b in range(13, 40, 6):
            if (a % 10) >= (b % 10) or b >= a:
                continue
            diff = a - b
            steps, hints = col_sub_steps(a, b)
            out.append(
                GeneratedItem(
                    code="bws_{}_{}".format(a, b),
                    competency="borrow_sub",
                    pattern="direct_compute",
                    difficulty=4,
                    scaffold_level="decompose",
                    interaction_type="number_pad",
                    estimated_seconds=22,
                    problem={"a": a, "b": b, "op": "sub", "prompt": "{} - {} = ?".format(a, b)},
                    answer=diff,
                    steps=steps,
                    hint_chain=hints,
                    error_rules=[
                        {"code": "borrow_missed", "match": {"answer_equals": diff + 10}},
                        {"code": "place_value_confusion",
                         "match": {"answer_off_by_multiple_of": 10}},
                    ],
                )
            )
            # 同一减法结构换成"还差多少"的问法（missing_part）
            out.append(
                GeneratedItem(
                    code="bwm_{}_{}".format(a, b),
                    competency="borrow_sub",
                    pattern="missing_part",
                    difficulty=4,
                    scaffold_level="decompose",
                    interaction_type="number_pad",
                    estimated_seconds=22,
                    problem={
                        "known": b, "target": a,
                        "prompt": "已经有 {} 个，凑满 {} 个还差几个？".format(b, a),
                    },
                    answer=diff,
                    steps=[
                        "求还差多少，用目标减去已有的",
                        "{} - {} = {}".format(a, b, diff),
                    ],
                    hint_chain=[
                        "这里问的是「还差多少」，还是「一共多少」？",
                        "用目标减去已有的",
                    ],
                    error_rules=[
                        {"code": "question_structure_missed", "match": {"answer_equals": a + b}},
                    ],
                )
            )
    return out


# ── 脚手架三档补齐 ─────────────────────────────────────────
# 脚手架递退（blocks → decompose → direct）要能真的生效，前提是**每一档都有题**。
# 否则 selector 只能跨档放宽（见 selector._scaffold_order），孩子的支持力度会突然跳变：
# 明明该"看积木"，系统却塞给他一道纯口算题。
#
# compiler 的 _lint_coverage 会为每个能力报出缺失的档位，这个生成器就是来消掉那些警告的。
# 各档位对应的交互类型必须落在前端已实现的六种之内：
#   number_pad / choice / blocks / decompose_drag / carry_exchange / number_line


def gen_sd_add_10_scaffold() -> List[GeneratedItem]:
    """10 以内加法：补 blocks（摆圆片）与 decompose（数轴往后走）。"""
    out: List[GeneratedItem] = []
    for a in range(2, 10):
        for b in range(1, 10 - a + 1):
            total = a + b
            blocks_hints = ["把两部分放在一起，一个一个数"]
            line_hints = ["从 {} 开始，一格一格往后走".format(a)]
            if total >= 9:
                blocks_hints.append("数的时候用手指点着圆片")
                line_hints.append("走一格就多一个，走完为止")
            out.append(
                GeneratedItem(
                    code="s10b_{}_{}".format(a, b),
                    competency="sd_add_10",
                    pattern="combine",
                    difficulty=sd_add_10_difficulty(total),
                    scaffold_level="blocks",
                    interaction_type="blocks",
                    estimated_seconds=14,
                    problem={
                        "a": a, "b": b, "target": 10,
                        "prompt": "摆出 {} 个圆片，再摆出 {} 个。一共是多少个？".format(a, b),
                    },
                    answer=total,
                    steps=[
                        "{} 个和 {} 个合起来".format(a, b),
                        "从 {} 往后数 {} 个，数到 {}".format(a, b, total),
                    ],
                    hint_chain=blocks_hints,
                    error_rules=[{"code": "counting_dependency", "match": {"answer_off_by": 1}}],
                )
            )
            out.append(
                GeneratedItem(
                    code="s10l_{}_{}".format(a, b),
                    competency="sd_add_10",
                    pattern="direct_compute",
                    difficulty=sd_add_10_difficulty(total),
                    scaffold_level="decompose",
                    interaction_type="number_line",
                    estimated_seconds=10,
                    problem={
                        "a": a, "b": b, "min": 0, "max": 20,
                        "prompt": "从 {} 出发，在数轴上往后走 {} 格，走到几？".format(a, b),
                    },
                    answer=total,
                    steps=[
                        "从 {} 出发，一格一格往后走 {} 格".format(a, b),
                        "停在 {}".format(total),
                    ],
                    hint_chain=line_hints,
                    error_rules=[{"code": "counting_dependency", "match": {"answer_off_by": 1}}],
                )
            )
    return out


def gen_sd_sub_10_scaffold() -> List[GeneratedItem]:
    """10 以内减法：补 blocks（拿走）与 decompose（数轴往回走）。"""
    out: List[GeneratedItem] = []
    for a in range(3, 11):
        for b in range(1, a):
            diff = a - b
            blocks_hints = ["把要拿走的那几个先划掉，再数剩下的"]
            line_hints = ["从 {} 开始，一格一格往回走".format(a)]
            if a >= 9:
                blocks_hints.append("划掉以后，从头一个一个数剩下的")
                line_hints.append("走一格就少一个，走完为止")
            out.append(
                GeneratedItem(
                    code="s10sb_{}_{}".format(a, b),
                    competency="sd_sub_10",
                    pattern="direct_compute",
                    difficulty=sd_sub_10_difficulty(a),
                    scaffold_level="blocks",
                    interaction_type="blocks",
                    estimated_seconds=14,
                    problem={
                        "a": a, "b": b, "op": "sub",
                        "prompt": "摆出 {} 个圆片，拿走 {} 个。还剩多少个？".format(a, b),
                    },
                    answer=diff,
                    steps=[
                        "{} 个拿走 {} 个".format(a, b),
                        "剩下的数一数是 {}".format(diff),
                    ],
                    hint_chain=blocks_hints,
                    error_rules=off_by_rules(diff),
                )
            )
            out.append(
                GeneratedItem(
                    code="s10sl_{}_{}".format(a, b),
                    competency="sd_sub_10",
                    pattern="direct_compute",
                    difficulty=sd_sub_10_difficulty(a),
                    scaffold_level="decompose",
                    interaction_type="number_line",
                    estimated_seconds=10,
                    problem={
                        "a": a, "b": b, "op": "sub", "min": 0, "max": 20,
                        "prompt": "从 {} 出发，在数轴上往回走 {} 格，走到几？".format(a, b),
                    },
                    answer=diff,
                    steps=[
                        "从 {} 出发，一格一格往回走 {} 格".format(a, b),
                        "停在 {}".format(diff),
                    ],
                    # 提示里不写步数：b 恰好等于答案时（6-3、8-4）会把答案直接说出来
                    hint_chain=line_hints,
                    error_rules=off_by_rules(diff),
                )
            )
    return out


def gen_place_value_scaffold() -> List[GeneratedItem]:
    """位值：补 decompose（先给出 20 + 3 再问）与 direct（直接问十位/个位）。

    ⚠️ decompose 档只出"几个十"的方向。因为一旦把 {value} = {十}0 + {个}
    写出来，再问"几个一"就等于把答案摆在眼前。问十位则不同 ——
    孩子还要自己把 20 读成"2 个十"，这一步才是他想练的。
    """
    out: List[GeneratedItem] = []
    values = [12, 15, 18, 21, 23, 25, 32, 34, 36, 41, 45, 47,
              52, 54, 58, 63, 67, 71, 76, 82, 85, 94, 97]
    for value in values:
        t, o = value // 10, value % 10
        out.append(
            GeneratedItem(
                code="pvd_{}".format(value),
                competency="place_value",
                pattern="represent_place_value",
                difficulty=2,
                scaffold_level="decompose",
                interaction_type="number_pad",
                estimated_seconds=14,
                problem={
                    "a": value, "ask": "tens",
                    "prompt": "{} = {} + {}。十位上的数字是几？".format(value, t * 10, o),
                },
                answer=t,
                steps=[
                    "{} 拆成 {} 和 {}".format(value, t * 10, o),
                    "{} 是 {} 个十，所以十位上的数字是 {}".format(t * 10, t, t),
                ],
                hint_chain=["几个十就是几十，数一数它是几十"],
                error_rules=[{"code": "place_value_confusion", "match": {"answer_equals": o}}],
            )
        )
        out.append(
            GeneratedItem(
                code="pvd_d_{}".format(value),
                competency="place_value",
                pattern="represent_place_value",
                difficulty=3,
                scaffold_level="direct",
                interaction_type="number_pad",
                estimated_seconds=8,
                problem={
                    "a": value, "ask": "tens",
                    "prompt": "{} 里面有几个十？".format(value),
                },
                answer=t,
                steps=[
                    "{} 是 {} 个十和 {} 个一".format(value, t, o),
                    "问的是几个十，所以是 {}".format(t),
                ],
                hint_chain=["这个数是几位数？", "十位在左边那一位，它的数字是几？"],
                error_rules=[{"code": "place_value_confusion", "match": {"answer_equals": o}}],
            )
        )
        out.append(
            GeneratedItem(
                code="pvd_e_{}".format(value),
                competency="place_value",
                pattern="represent_place_value",
                difficulty=3,
                scaffold_level="direct",
                interaction_type="number_pad",
                estimated_seconds=8,
                problem={
                    "a": value, "ask": "ones",
                    "prompt": "{} 里面有几个一？".format(value),
                },
                answer=o,
                steps=[
                    "{} 是 {} 个十和 {} 个一".format(value, t, o),
                    "问的是几个一，所以是 {}".format(o),
                ],
                hint_chain=["个位是最右边那一位", "它上面的数字是几？"],
                error_rules=[{"code": "place_value_confusion", "match": {"answer_equals": t}}],
            )
        )
    return out


def _two_digit_ids() -> List[Tuple[int, int]]:
    """两位数加减的参数网格，控制总量避免内容膨胀。"""
    add_pairs, sub_pairs = [], []
    for a in range(11, 60, 7):
        for b in range(11, 40, 9):
            add_pairs.append((a, b))
    for a in range(31, 90, 11):
        for b in range(12, 30, 7):
            sub_pairs.append((a, b))
    return add_pairs, sub_pairs


def gen_two_digit_scaffold() -> List[GeneratedItem]:
    """两位数加减：补 blocks（用积木摆）与 direct（纯口算）。"""
    out: List[GeneratedItem] = []
    add_pairs, sub_pairs = _two_digit_ids()

    # ── 不进位加法 ──
    for a, b in add_pairs:
        if (a % 10) + (b % 10) >= 10:
            continue
        total = a + b
        steps, hints = col_add_steps(a, b)
        out.append(
            GeneratedItem(
                code="tda_b_{}_{}".format(a, b),
                competency="td_add_nocarry",
                pattern="combine",
                difficulty=2,
                scaffold_level="blocks",
                interaction_type="blocks",
                estimated_seconds=26,
                problem={
                    "a": a, "b": b,
                    "prompt": "用积木摆出 {}，再摆出 {}。合起来是多少？".format(a, b),
                },
                answer=total,
                steps=["十位和十位放在一起，个位和个位放在一起"] + steps,
                hint_chain=["十位的一起数，个位的一起数"],
                error_rules=off_by_rules(total),
            )
        )
        out.append(
            GeneratedItem(
                code="tda_d_{}_{}".format(a, b),
                competency="td_add_nocarry",
                pattern="direct_compute",
                difficulty=4,
                scaffold_level="direct",
                interaction_type="number_pad",
                estimated_seconds=12,
                problem={"a": a, "b": b, "prompt": "{} + {} = ?".format(a, b)},
                answer=total,
                steps=steps,
                hint_chain=hints,
                error_rules=off_by_rules(total),
            )
        )

    # ── 进位加法 ──
    for a, b in add_pairs:
        if (a % 10) + (b % 10) < 10:
            continue
        total = a + b
        steps, hints = col_add_steps(a, b)
        carry_rules = [
            {"code": "carry_missed", "match": {"answer_equals": total - 10}},
            {"code": "place_value_confusion", "match": {"answer_off_by_multiple_of": 10}},
        ]
        out.append(
            GeneratedItem(
                code="cra_b_{}_{}".format(a, b),
                competency="carry_add",
                pattern="carry_exchange",
                difficulty=3,
                scaffold_level="blocks",
                interaction_type="carry_exchange",
                estimated_seconds=30,
                problem={
                    "a": a, "b": b,
                    "prompt": "摆出 {} 再摆出 {}。个位凑满十个就换成一整条，一共是多少？".format(a, b),
                },
                answer=total,
                steps=["个位凑满十个，把它们换成一整条"] + steps,
                hint_chain=["先看看个位上一共有几个", "满十的时候可以换成一整条试一试"],
                error_rules=carry_rules,
            )
        )
        out.append(
            GeneratedItem(
                code="cra_d_{}_{}".format(a, b),
                competency="carry_add",
                pattern="direct_compute",
                difficulty=5,
                scaffold_level="direct",
                interaction_type="number_pad",
                estimated_seconds=14,
                problem={"a": a, "b": b, "prompt": "{} + {} = ?".format(a, b)},
                answer=total,
                steps=steps,
                hint_chain=hints,
                error_rules=carry_rules,
            )
        )

    # ── 不退位减法 ──
    for a, b in sub_pairs:
        if (a % 10) < (b % 10) or b >= a:
            continue
        diff = a - b
        steps, hints = col_sub_steps(a, b)
        out.append(
            GeneratedItem(
                code="tds_b_{}_{}".format(a, b),
                competency="td_sub_nocarry",
                pattern="direct_compute",
                difficulty=2,
                scaffold_level="blocks",
                interaction_type="blocks",
                estimated_seconds=26,
                problem={
                    "a": a, "b": b, "op": "sub",
                    "prompt": "用积木摆出 {}，拿走 {}。还剩多少？".format(a, b),
                },
                answer=diff,
                steps=["十位拿走十位的，个位拿走个位的"] + steps,
                hint_chain=["十位的一起拿走，个位的一起拿走"],
                error_rules=off_by_rules(diff),
            )
        )
        out.append(
            GeneratedItem(
                code="tds_d_{}_{}".format(a, b),
                competency="td_sub_nocarry",
                pattern="direct_compute",
                difficulty=4,
                scaffold_level="direct",
                interaction_type="number_pad",
                estimated_seconds=12,
                problem={"a": a, "b": b, "op": "sub", "prompt": "{} - {} = ?".format(a, b)},
                answer=diff,
                steps=steps,
                hint_chain=hints,
                error_rules=off_by_rules(diff),
            )
        )

    # ── 退位减法 ──
    for a, b in sub_pairs:
        if (a % 10) >= (b % 10) or b >= a:
            continue
        diff = a - b
        steps, hints = col_sub_steps(a, b)
        borrow_rules = [
            {"code": "borrow_missed", "match": {"answer_equals": diff + 10}},
            {"code": "place_value_confusion", "match": {"answer_off_by_multiple_of": 10}},
        ]
        out.append(
            GeneratedItem(
                code="bws_b_{}_{}".format(a, b),
                competency="borrow_sub",
                pattern="carry_exchange",
                difficulty=3,
                scaffold_level="blocks",
                interaction_type="carry_exchange",
                estimated_seconds=30,
                problem={
                    "a": a, "b": b, "op": "sub",
                    "prompt": "摆出 {}，要拿走 {}。个位不够，把一整条拆开，还剩多少？".format(a, b),
                },
                answer=diff,
                steps=["个位不够拿，把一整条拆成十个一"] + steps,
                hint_chain=["先看看个位够不够拿", "不够的时候可以拆开一整条试一试"],
                error_rules=borrow_rules,
            )
        )
        out.append(
            GeneratedItem(
                code="bws_d_{}_{}".format(a, b),
                competency="borrow_sub",
                pattern="direct_compute",
                difficulty=5,
                scaffold_level="direct",
                interaction_type="number_pad",
                estimated_seconds=14,
                problem={"a": a, "b": b, "op": "sub", "prompt": "{} - {} = ?".format(a, b)},
                answer=diff,
                steps=steps,
                hint_chain=hints,
                error_rules=borrow_rules,
            )
        )

    return out


def gen_sd_add_20() -> List[GeneratedItem]:
    """20 以内加法（和落在 11~20）。

    与 make_ten 刻意区分：这里**不**在 steps 里规定凑十路径。
    make_ten 练的是"策略"，sd_add_20 练的是"这类算式本身"——
    如果把凑十步骤写死在 sd_add_20 的示范里，孩子就只剩一条路可走，
    而 `pattern` 的多样性（total / direct_compute）才是迁移的来源。
    """
    out: List[GeneratedItem] = []
    for a in range(5, 10):
        for b in range(2, 10):
            total = a + b
            if not (10 < total <= 20):
                continue

            out.append(
                GeneratedItem(
                    code="s20b_{}_{}".format(a, b),
                    competency="sd_add_20",
                    pattern="total",
                    difficulty=1,
                    scaffold_level="blocks",
                    interaction_type="blocks",
                    estimated_seconds=18,
                    problem={
                        "a": a, "b": b, "target": 20,
                        "prompt": "摆出 {} 个，再摆出 {} 个。一共是多少个？".format(a, b),
                    },
                    answer=total,
                    steps=[
                        "{} 个和 {} 个合起来".format(a, b),
                        "先数满 10 个，剩下的接着数",
                        "一共是 {}".format(total),
                    ],
                    hint_chain=["先把 10 个圈在一起，剩下的再数"],
                    error_rules=off_by_rules(total),
                )
            )
            out.append(
                GeneratedItem(
                    code="s20l_{}_{}".format(a, b),
                    competency="sd_add_20",
                    pattern="direct_compute",
                    difficulty=2,
                    scaffold_level="decompose",
                    interaction_type="number_line",
                    estimated_seconds=12,
                    problem={
                        "a": a, "b": b, "min": 0, "max": 20,
                        "prompt": "从 {} 出发，在数轴上往后走 {} 格，走到几？".format(a, b),
                    },
                    answer=total,
                    steps=[
                        "从 {} 出发，先走到 10".format(a),
                        "再接着走剩下的，停在 {}".format(total),
                    ],
                    hint_chain=["从 {} 开始往后走，先停在 10".format(a)],
                    error_rules=off_by_rules(total),
                )
            )
            out.append(
                GeneratedItem(
                    code="s20d_{}_{}".format(a, b),
                    competency="sd_add_20",
                    pattern="direct_compute",
                    difficulty=3,
                    scaffold_level="direct",
                    interaction_type="number_pad",
                    estimated_seconds=8,
                    problem={"a": a, "b": b, "prompt": "{} + {} = ?".format(a, b)},
                    answer=total,
                    steps=["先算到 10，再加上剩下的", "{} + {} = {}".format(a, b, total)],
                    hint_chain=[
                        "{} 离 10 还差几个？".format(a),
                        "先凑到 10，再把剩下的加上",
                    ],
                    error_rules=off_by_rules(total),
                )
            )

            # 语义结构换一个：从"两部分合起来"变成"又来了多少"
            out.append(
                GeneratedItem(
                    code="s20i_{}_{}".format(a, b),
                    competency="sd_add_20",
                    pattern="increase",
                    difficulty=3,
                    scaffold_level="decompose",
                    interaction_type="number_pad",
                    estimated_seconds=14,
                    problem={
                        "a": a, "b": b,
                        "prompt": "车上原来有 {} 个人，又上来 {} 个，现在有多少人？".format(a, b),
                    },
                    answer=total,
                    steps=["「又上来」是变多，用加法", "{} + {} = {}".format(a, b, total)],
                    hint_chain=["「又来了」是变多还是变少？", "变多就用加法，先算到 10"],
                    error_rules=[
                        {"code": "operation_confusion", "match": {"answer_equals": abs(a - b)}}
                    ],
                )
            )
    return out


def gen_sd_sub_20() -> List[GeneratedItem]:
    """20 以内退位减法（被减数 11~20，个位不够减）。

    cognitive 规则要求个位不够减，所以这里的数对天然是"要退位"的。
    """
    out: List[GeneratedItem] = []
    for a in range(11, 21):
        for b in range(2, 10):
            diff = a - b
            if diff < 0:
                continue
            if (a % 10) >= (b % 10):
                continue  # 不退位的不属于这个能力

            out.append(
                GeneratedItem(
                    code="s20sb_{}_{}".format(a, b),
                    competency="sd_sub_20",
                    pattern="direct_compute",
                    difficulty=2,
                    scaffold_level="blocks",
                    interaction_type="blocks",
                    estimated_seconds=20,
                    problem={
                        "a": a, "b": b, "op": "sub",
                        "prompt": "摆出 {} 个，要拿走 {} 个。个位不够拿，把一整条拆开，还剩多少？".format(a, b),
                    },
                    answer=diff,
                    steps=[
                        "个位不够拿，把一整条拆成十个一",
                        "{} - {} = {}".format(a, b, diff),
                    ],
                    hint_chain=["个位不够拿的时候，可以拆开一整条试一试"],
                    error_rules=off_by_rules(diff),
                )
            )
            out.append(
                GeneratedItem(
                    code="s20sl_{}_{}".format(a, b),
                    competency="sd_sub_20",
                    pattern="direct_compute",
                    difficulty=2,
                    scaffold_level="decompose",
                    interaction_type="number_line",
                    estimated_seconds=12,
                    problem={
                        "a": a, "b": b, "op": "sub", "min": 0, "max": 20,
                        "prompt": "从 {} 出发，在数轴上往回走 {} 格，走到几？".format(a, b),
                    },
                    answer=diff,
                    steps=[
                        "从 {} 出发，先退回 10".format(a),
                        "再接着退剩下的，停在 {}".format(diff),
                    ],
                    # 提示不写步数：b 恰等于答案时会把答案说出来
                    hint_chain=["从 {} 开始往回走，先退到 10".format(a)],
                    error_rules=off_by_rules(diff),
                )
            )
            out.append(
                GeneratedItem(
                    code="s20sd_{}_{}".format(a, b),
                    competency="sd_sub_20",
                    pattern="direct_compute",
                    difficulty=3,
                    scaffold_level="direct",
                    interaction_type="number_pad",
                    estimated_seconds=8,
                    problem={"a": a, "b": b, "op": "sub", "prompt": "{} - {} = ?".format(a, b)},
                    answer=diff,
                    steps=["先减到 10，再减剩下的", "{} - {} = {}".format(a, b, diff)],
                    hint_chain=["个位够不够减？", "先退到 10，还差多少没减？"],
                    error_rules=off_by_rules(diff),
                )
            )

            # 语义结构换一个：从"拿走"变成"还差多少"
            out.append(
                GeneratedItem(
                    code="s20m_{}_{}".format(a, b),
                    competency="sd_sub_20",
                    pattern="missing_part",
                    difficulty=3,
                    scaffold_level="decompose",
                    interaction_type="number_pad",
                    estimated_seconds=14,
                    problem={
                        "known": b, "target": a,
                        "prompt": "已经有 {} 个，凑满 {} 个还差几个？".format(b, a),
                    },
                    answer=diff,
                    steps=[
                        "求还差多少，用目标减去已有的",
                        "{} - {} = {}".format(a, b, diff),
                    ],
                    hint_chain=[
                        "这里问的是「还差多少」，还是「一共多少」？",
                        "用目标减去已有的",
                    ],
                    error_rules=[
                        {"code": "question_structure_missed", "match": {"answer_equals": a + b}}
                    ],
                )
            )
    return out


GENERATORS: Dict[str, Callable[[], List[GeneratedItem]]] = {
    # 脚手架补齐（blocks / decompose / direct 三档都要有题）
    "scaffold_variants": lambda: (
        gen_sd_add_10_scaffold()
        + gen_sd_sub_10_scaffold()
        + gen_place_value_scaffold()
        + gen_two_digit_scaffold()
    ),
    # 各能力的主批内容
    "number_friends": gen_number_friends,
    "make_ten": gen_make_ten,
    "applied_make_ten": gen_applied_make_ten,
    "sd_add_10": gen_sd_add_10,
    "sd_add_10_applied": gen_sd_add_10_applied,
    "sd_add_20": gen_sd_add_20,
    "sd_sub_10": gen_sd_sub_10,
    "sd_sub_20": gen_sd_sub_20,
    "place_value": gen_place_value,
    "td_add_nocarry": gen_td_add_nocarry,
    "carry_add": gen_carry_add,
    "td_sub_nocarry": gen_td_sub_nocarry,
    "borrow_sub": gen_borrow_sub,
    # 第二个认知结构（升级硬条件要求"至少 2 个不同 pattern 成功过"）
    "sd_sub_10_missing_part": gen_sd_sub_10_missing_part,
    "place_value_compose": gen_place_value_compose,
    "td_sub_nocarry_decompose": gen_td_sub_nocarry_decompose,
}


# ── 生成 → 校验 → 落盘 ─────────────────────────────────────
def generate(
    families: Optional[Iterable[str]] = None,
    existing_codes: Optional[Iterable[str]] = None,
) -> Tuple[List[GeneratedItem], List[str]]:
    """生成候选 item，返回（通过校验的, 被拦下的问题描述）。"""
    names = list(families) if families else list(GENERATORS)
    accepted: List[GeneratedItem] = []
    rejected: List[str] = []
    seen = set(existing_codes or ())

    for name in names:
        generator = GENERATORS.get(name)
        if generator is None:
            rejected.append("未知的内容家族: {}".format(name))
            continue
        for candidate in generator():
            if candidate.code in seen:
                rejected.append("item code 与已有内容冲突: {}".format(candidate.code))
                continue
            seen.add(candidate.code)
            problems = check_all(candidate.as_item())
            if problems:
                for problem in problems:
                    rejected.append("{}: {}".format(candidate.code, problem))
                continue
            accepted.append(candidate)

    return accepted, rejected


def write_yaml(items: List[GeneratedItem], filename: str) -> str:
    """写盘。filename 可含子目录，例如 'generated/core_number_sense.yaml'。"""
    path = os.path.join(ITEM_DIR, filename)
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    header = (
        "# ⚠️ 本文件由 `math-content generate` 生成，请勿手工编辑。\n"
        "# 修改生成规则请改 backend/content/generators.py，然后重新生成。\n"
        "# 生成器产出的每一道题都经过 cognitive.check_all 复核（认知有效性 + 答案正确性）。\n\n"
    )
    payload = {"items": [item.to_yaml_dict() for item in items]}
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(header)
        yaml.safe_dump(
            payload, fh, allow_unicode=True, sort_keys=False, default_flow_style=False
        )
    return path
