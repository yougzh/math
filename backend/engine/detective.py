"""数学侦探：谜题生成与独立求解。

侦探模式不是"换个壳的计算题"——它的认知目标是**逻辑推理**：
从若干条线索里排除不可能，剩下的就是答案。

因此这里有一条硬性不变量：

    把所有线索都用上，候选集必须恰好只剩一个数，且它就是答案。

否则孩子不是在推理，是在猜。这条不变量由 `Puzzle.validate()` 强制，
并且有测试对全部种类 × 上千个种子做穷举验证。

两个刻意的设计：

1. **无状态**：`puzzle_id` 里编码了种子，答案不落库。
   GET 出题和 POST 判题各自独立地从 puzzle_id 重新生成一次，
   两次结果必然一致，省掉一张表和一个会话状态。

2. **线索按"由宽到窄"的书写顺序揭示**，不做"筛得最多优先"的排序——
   因为"它就是下一项"这种决定性的线索排除得最多，排在前面等于直接给答案。
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

PUZZLE_ID_PREFIX = "det"

KIND_GUESS_NUMBER = "guess_number"
KIND_FIND_PATTERN = "find_pattern"
KIND_BALANCE = "balance"
ALL_KINDS = [KIND_GUESS_NUMBER, KIND_FIND_PATTERN, KIND_BALANCE]

Predicate = Callable[[int], bool]


# ── 谜题模型 ───────────────────────────────────────────────
@dataclass
class Clue:
    text: str
    predicate: Optional[Predicate] = None
    revealed: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {"text": self.text, "revealed": self.revealed}


@dataclass
class Puzzle:
    puzzle_id: str
    kind: str
    prompt: str
    clues: List[Clue]
    answer: int
    # domain 是**下发给孩子的候选项**，不是全部可能的数。
    # 它是"看起来都像对的"那几个（典型的错法），孩子要靠线索把它们排掉。
    domain: List[int] = field(default_factory=list)

    # ── 求解 ──────────────────────────────────────────────
    def candidates(self, revealed_count: Optional[int] = None) -> List[int]:
        """只用**已揭示**的线索求候选集。"""
        if revealed_count is None:
            revealed_count = sum(1 for c in self.clues if c.revealed)
        active = [c for c in self.clues[:revealed_count] if c.predicate is not None]
        return [v for v in self.domain if all(c.predicate(v) for c in active)]

    @property
    def clues_remaining(self) -> int:
        return sum(1 for c in self.clues if not c.revealed)

    def reveal_next(self) -> Optional[str]:
        for clue in self.clues:
            if not clue.revealed:
                clue.revealed = True
                return clue.text
        return None

    def solve(self) -> List[int]:
        """独立求解：不信任 answer 字段，用线索自己算。"""
        return self.candidates(revealed_count=len(self.clues))

    # ── 不变量 ────────────────────────────────────────────
    def validate(self) -> List[str]:
        """内容错误的机器判定：孩子能不能靠推理得到唯一答案。

        两条硬性要求：
          1. 全部线索用上后，候选集恰好只剩 [answer]
          2. **每个非答案候选项都能被至少一条线索排除**
             —— 排不掉的候选项是"陷阱"，孩子无论怎么推理都走不出来，
             最后只能猜。这是侦探模式最致命的缺陷，必须机器拦住。
        """
        problems: List[str] = []
        if not self.clues:
            problems.append("谜题没有任何线索")
        for clue in self.clues:
            if clue.predicate is None:
                problems.append("线索「{}」没有判定逻辑，无法参与求解".format(clue.text))
        if not self.domain:
            problems.append("候选域为空")
        if self.answer not in self.domain:
            problems.append("答案 {} 不在候选域 {}".format(self.answer, self.domain))
        if problems:
            return problems

        final = self.solve()
        if final != [self.answer]:
            problems.append(
                "全部线索用上后候选集是 {}，应当恰好只剩 [{}]".format(final, self.answer)
            )

        for value in self.domain:
            if value == self.answer:
                continue
            if all(clue.predicate(value) for clue in self.clues):
                problems.append(
                    "候选项 {} 没有任何线索能排除它，孩子只能靠猜".format(value)
                )
        return problems

    def weak_clues(self) -> List[str]:
        """信息量低的线索：揭示了却一个候选项都没排除。

        不算错误 —— 建立范围感的线索（"它大于 20"）本来就不负责排除，
        但生成器如果产出一堆这种线索，值得人看一眼。
        """
        weak = []
        for index, clue in enumerate(self.clues):
            before = len(self.candidates(revealed_count=index))
            after = len(self.candidates(revealed_count=index + 1))
            if after == before:
                weak.append(clue.text)
        return weak

    def is_trivial(self, reveal_count: int) -> bool:
        """一开局就已经唯一确定 —— 孩子不用推理，点一下就行。

        这种题比"太难"更糟：它把侦探模式变成了点击训练。
        """
        return len(self.candidates(revealed_count=reveal_count)) <= 1

    # ── 下发 ──────────────────────────────────────────────
    def to_dict(self) -> Dict[str, Any]:
        """契约 §8 的形状。**不含 answer** —— 答案永不下发。"""
        return {
            "puzzle_id": self.puzzle_id,
            "kind": self.kind,
            "prompt": self.prompt,
            "clues": [c.to_dict() for c in self.clues],
            "candidates": self.candidates(),
            "answer_type": "number",
            "clues_remaining": self.clues_remaining,
        }


# ── puzzle_id：种子即身份 ──────────────────────────────────
def make_puzzle_id(seed: int) -> str:
    return "{}_{:04d}".format(PUZZLE_ID_PREFIX, seed % 10000)


def parse_puzzle_id(puzzle_id: str) -> Optional[int]:
    if not puzzle_id or not puzzle_id.startswith(PUZZLE_ID_PREFIX + "_"):
        return None
    tail = puzzle_id[len(PUZZLE_ID_PREFIX) + 1:]
    return int(tail) if tail.isdigit() else None


def _distractors(answer: int, variants: List[int], low: int = 1, high: int = 99) -> List[int]:
    """候选项 = 答案 + 几个"典型错法"，去重排序。"""
    pool = {answer}
    for value in variants:
        if low <= value <= high:
            pool.add(value)
    return sorted(pool)


# ── 生成器 ─────────────────────────────────────────────────
def _gen_guess_number(rng: random.Random, puzzle_id: str) -> Puzzle:
    """猜数字：范围 → 奇偶 → 个位 → 十位，逐步锁定。"""
    tens = rng.randint(2, 8)
    ones = rng.randint(2, 9)
    answer = tens * 10 + ones

    domain = _distractors(
        answer,
        [
            tens * 10 + (ones + 1 if ones < 9 else ones - 1),   # 个位记错
            tens * 10 + (ones - 1),                             # 个位差一
            (tens + 1) * 10 + ones,                             # 十位记错
            (tens - 1) * 10 + ones,                             # 十位差一
        ],
        low=11,
        high=99,
    )

    # 线索顺序 = 揭示顺序：由宽到窄。前两条是"框定范围"，
    # 但第 2 条已经带上奇偶，孩子一开始就有东西可排，不至于面对一堆废话。
    clues = [
        Clue("它大于 20", predicate=lambda n: n > 20),
        Clue(
            "它是{}数".format("偶" if answer % 2 == 0 else "奇"),
            predicate=lambda n: n % 2 == (answer % 2),
        ),
        Clue("它小于 90", predicate=lambda n: n < 90),
        Clue("它的个位是 {}".format(ones), predicate=lambda n: n % 10 == ones),
        Clue("它的十位是 {}".format(tens), predicate=lambda n: n // 10 == tens),
    ]
    return Puzzle(
        puzzle_id=puzzle_id,
        kind=KIND_GUESS_NUMBER,
        prompt="我想了一个数字。",
        clues=clues,
        answer=answer,
        domain=domain,
    )


def _gen_find_pattern(rng: random.Random, puzzle_id: str) -> Puzzle:
    """找规律：三种适龄规律，逐步给线索。"""
    variant = rng.choice(["step", "alternate", "growing_step"])

    if variant == "step":
        start = rng.randint(1, 8)
        step = rng.randint(2, 5)
        seq = [start + step * i for i in range(5)]
        answer = seq[-1] + step
        domain = _distractors(
            answer,
            [seq[-1] + 1, seq[-1] + step - 1, seq[-1] + step + 1, seq[-1] + 2 * step],
            low=1,
            high=99,
        )
        clues = [
            Clue("每一步加的数都一样", predicate=lambda n: (n - start) % step == 0),
            Clue("它比 {} 大".format(seq[-1]), predicate=lambda n: n > seq[-1]),
            Clue("它比 {} 小".format(answer + 4), predicate=lambda n: n < answer + 4),
            # 最后一条也是**真线索**，不是"就是它"——
            # 孩子的推理路径不能被一句宣告代替
            Clue(
                "它和 {} 相差 {}".format(seq[-1], step),
                predicate=lambda n: abs(n - seq[-1]) == step,
            ),
        ]
    elif variant == "alternate":
        low = rng.randint(1, 5)
        high = low + rng.randint(3, 6)
        seq = [low, high, low, high, low]
        answer = high
        domain = _distractors(
            answer, [low, answer - 1, answer + 1, answer + 2], low=1, high=99
        )
        # 交替规律的"规律"本身没法写成一个数的谓词：
        # 真正的推理发生在孩子看序列的时候，线索只负责把范围收紧。
        clues = [
            Clue("它比 {} 大".format(low), predicate=lambda n: n > low),
            Clue("它比 {} 小".format(high + 3), predicate=lambda n: n < high + 3),
            Clue("它和刚才那个数不一样", predicate=lambda n: n != low),
            Clue("它比 {} 小".format(high + 1), predicate=lambda n: n < high + 1),
            Clue(
                "它是{}数".format("偶" if answer % 2 == 0 else "奇"),
                predicate=lambda n: n % 2 == (answer % 2),
            ),
        ]
    else:
        start = rng.randint(1, 4)
        seq, value = [], start
        for gap in range(1, 6):
            seq.append(value)
            value += gap
        answer = seq[-1] + 5
        domain = _distractors(
            answer,
            [seq[-1] + 1, seq[-1] + 4, seq[-1] + 5, seq[-1] + 6],
            low=1,
            high=99,
        )
        clues = [
            Clue("它比 {} 大".format(seq[-1]), predicate=lambda n: n > seq[-1]),
            Clue("它比 {} 小".format(answer + 3), predicate=lambda n: n < answer + 3),
            Clue(
                "它是{}数".format("偶" if answer % 2 == 0 else "奇"),
                predicate=lambda n: n % 2 == (answer % 2),
            ),
            Clue(
                "它和 {} 相差 5".format(seq[-1]),
                predicate=lambda n: abs(n - seq[-1]) == 5,
            ),
        ]

    return Puzzle(
        puzzle_id=puzzle_id,
        kind=KIND_FIND_PATTERN,
        prompt="看看这串数的规律：{}。下一个是多少？".format("、".join(map(str, seq))),
        clues=clues,
        answer=answer,
        domain=domain,
    )


def _gen_balance(rng: random.Random, puzzle_id: str) -> Puzzle:
    """天平：方框里填几，两边才一样重。

    这是最容易做到"线索全都有信息量"的一种，
    因为答案天然被限制在 1~9（孩子能口算的范围）。
    """
    box = rng.randint(2, 9)
    other = rng.randint(2, 9)
    total = box + other

    domain = _distractors(
        box, [other, box - 1, box + 1, total - 1], low=1, high=18
    )

    clues = [
        Clue("它比 {} 小".format(total), predicate=lambda n: n < total),
        Clue(
            "它是{}数".format("偶" if box % 2 == 0 else "奇"),
            predicate=lambda n: n % 2 == (box % 2),
        ),
        Clue(
            "{} 加上它等于 {}".format(other, total),
            predicate=lambda n: n + other == total,
        ),
        Clue("它小于 {}".format(box + 2), predicate=lambda n: n < box + 2),
    ]
    return Puzzle(
        puzzle_id=puzzle_id,
        kind=KIND_BALANCE,
        prompt="天平左边是 □ + {}，右边是 {}。□ 是几才能平衡？".format(other, total),
        clues=clues,
        answer=box,
        domain=domain,
    )


GENERATORS = {
    KIND_GUESS_NUMBER: _gen_guess_number,
    KIND_FIND_PATTERN: _gen_find_pattern,
    KIND_BALANCE: _gen_balance,
}


def generate_puzzle(
    puzzle_id: str,
    kind: Optional[str] = None,
    reveal_count: int = 2,
    max_attempts: int = 40,
) -> Puzzle:
    """从 puzzle_id 确定性地重建一道谜题。

    GET /v1/detective/puzzle 与 POST /v1/detective/answer 各自调用一次，
    得到的结果必然一致 —— 答案不需要落库。

    `max_attempts` 是一道保险：某个种子碰巧生成了不自洽的谜题（线索排不掉候选项、
    或者一开局就唯一确定），就顺延到下一个种子。搜索过程是确定性的，
    所以同一 puzzle_id 永远得到同一道题。
    这类"被顺延掉"的种子在测试里会被穷举找出来，所以不会长期潜伏。
    """
    base = parse_puzzle_id(puzzle_id)
    if base is None:
        raise ValueError("非法的 puzzle_id: {}".format(puzzle_id))

    for offset in range(max_attempts):
        seed = base + offset
        rng = random.Random(seed * 7919 + 13)
        chosen = kind or ALL_KINDS[seed % len(ALL_KINDS)]
        generator = GENERATORS.get(chosen)
        if generator is None:
            raise ValueError("未知的谜题类型: {}".format(chosen))

        puzzle = generator(rng, make_puzzle_id(seed))
        if puzzle.validate():
            continue

        reveal_count = max(1, min(reveal_count, len(puzzle.clues) - 1))
        if puzzle.is_trivial(reveal_count):
            continue

        for clue in puzzle.clues[:reveal_count]:
            clue.revealed = True
        return puzzle

    raise RuntimeError(
        "从 {} 起连续 {} 个种子都生成不出自洽的谜题，生成器有问题".format(
            puzzle_id, max_attempts
        )
    )


def judge(puzzle: Puzzle, answer: Any) -> bool:
    try:
        return int(str(answer).strip()) == puzzle.answer
    except (TypeError, ValueError):
        return False


def reveal_after_attempt(puzzle: Puzzle, correct: bool) -> List[str]:
    """答错了就多给一条线索；答对了不再揭。"""
    if correct:
        return []
    text = puzzle.reveal_next()
    return [text] if text else []
