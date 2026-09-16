"""内容加载与轻量校验。

原则：内容与代码分离。题目、提示链、故事、错误规则全部来自 content/**/*.yaml，
代码里不允许出现题目字面量。

P0 只做加载 + 结构性校验；完整的认知有效性校验与 Compiler CLI 属于 P1。
"""
from __future__ import annotations

import glob
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import yaml

from backend.paths import (
    COMPETENCY_DIR,
    ITEM_DIR,
    MISCONCEPTION_DIR,
    PATTERN_DIR,
    SLOT_DIR,
    STORY_DIR,
)

ALLOWED_COGNITIVE_TYPES = {"compute", "represent", "strategy", "apply", "reverse"}
ALLOWED_SCAFFOLD_LEVELS = {"blocks", "decompose", "direct"}
AUTO_SCAFFOLD = "auto"
# 槽位用途。warmup/thinking/review 与规划器分段同名，practice/challenge 是更粗的写法。
# 一个槽位可以被多个分段复用，purpose 只用来表达"这个槽在什么语境下合适"。
ALLOWED_PURPOSES = {
    "warmup",
    "core",
    "practice",
    "story",
    "thinking",
    "challenge",
    "review",
    "probe",
}
# steps 的写法意图：
#   guide   —— 示范"方法"，最后一步刻意留给孩子（凑十法就该停在「10 + 3」）
#   conclude —— 示范"完整解答"，最后一步必须写出答案
# 默认 guide：这个项目里的 steps 是给孩子看的策略示范，不是答案复述。
ALLOWED_STEPS_STYLES = {"guide", "conclude"}

_NUMBER_TOKEN = re.compile(r"\d+")


# ── 内容模型 ───────────────────────────────────────────────
@dataclass
class Competency:
    code: str
    name: str
    description: str = ""
    prerequisites: List[str] = field(default_factory=list)
    stage: int = 1
    # 该能力特有的说法，供 AI 教练的"不超纲"护栏使用
    terms: List[str] = field(default_factory=list)


@dataclass
class Pattern:
    code: str
    name: str
    cognitive_type: str
    primary_competency: str
    applicable_competencies: List[str] = field(default_factory=list)
    description: str = ""

    def applies_to(self, competency_code: str) -> bool:
        return competency_code in set(self.applicable_competencies) | {self.primary_competency}


@dataclass
class Misconception:
    code: str
    name: str
    description: str = ""
    severity: int = 1
    remediation_competency: Optional[str] = None


@dataclass
class Item:
    code: str
    competency_id: str
    pattern_id: str
    difficulty: int
    scaffold_level: str
    interaction_type: str
    estimated_seconds: int
    problem: Dict[str, Any]
    answer: Any
    steps: List[str] = field(default_factory=list)
    hint_chain: List[str] = field(default_factory=list)
    error_rules: List[Dict[str, Any]] = field(default_factory=list)
    steps_style: str = "guide"

    @property
    def difficulty_band(self) -> str:
        return self.scaffold_level


@dataclass
class ChallengeSlot:
    """题目槽位 —— 故事与题目之间的唯一桥梁（ADR-0001）。

    故事只声明"这里需要一个什么类型的挑战"，具体做哪一道由 Planner 运行时决定。
    因此同一句"小熊需要把篮子装满"，强孩子拿到 8+5，弱孩子拿到 7+3。

    story_beat_id 为 None 表示这是一个独立训练槽（核心训练段在用），
    与故事解耦 —— 槽位机制不属于故事，故事只是它的一种使用场景。
    """

    code: str
    competency_id: str
    difficulty_min: int
    difficulty_max: int
    purpose: str = "practice"
    pattern_id: Optional[str] = None
    scaffold_level: Optional[str] = AUTO_SCAFFOLD
    estimated_seconds: int = 20
    story_beat_id: Optional[str] = None
    selection_policy: Dict[str, Any] = field(default_factory=dict)
    review_policy: Dict[str, Any] = field(default_factory=dict)


ALLOWED_BEAT_TYPES = {"narration", "challenge", "reward"}


@dataclass
class StoryBeat:
    """故事里的一个节拍。

    beat_type='challenge' 的节拍**必须**挂一个 challenge_slot ——
    故事说到"这里需要算一算"的时候，系统必须知道"算什么类型"。
    但具体出哪一道题，故事不管（ADR-0001）。
    """

    code: str
    story_code: str
    sequence: int
    beat_type: str
    narration: str = ""
    character: str = ""
    slot_code: Optional[str] = None

    @property
    def local_code(self) -> str:
        return self.code.split("__", 1)[-1]


@dataclass
class Story:
    code: str
    title: str
    universe: str
    summary: str = ""
    order_index: int = 0
    duration_min: int = 8
    target_competencies: List[str] = field(default_factory=list)
    beats: List[StoryBeat] = field(default_factory=list)

    def ordered_beats(self) -> List[StoryBeat]:
        return sorted(self.beats, key=lambda b: b.sequence)

    def challenge_beats(self) -> List[StoryBeat]:
        return [b for b in self.ordered_beats() if b.beat_type == "challenge"]


@dataclass
class ContentBundle:
    competencies: Dict[str, Competency] = field(default_factory=dict)
    patterns: Dict[str, Pattern] = field(default_factory=dict)
    items: Dict[str, Item] = field(default_factory=dict)
    misconceptions: Dict[str, Misconception] = field(default_factory=dict)
    slots: Dict[str, ChallengeSlot] = field(default_factory=dict)
    stories: Dict[str, Story] = field(default_factory=dict)
    # 加载阶段发现的问题。
    #
    # 最典型的是 **code 重复**：上面这些都是 dict，重复 code 会静默覆盖，
    # 结果就是"我明明写了这道题，系统里却没有"—— 这种 bug 找起来非常费时间。
    # 所以加载器把重复记录下来，validate_content 把它当错误报出来。
    load_problems: List[str] = field(default_factory=list)

    def items_for(
        self,
        competency_id: Optional[str] = None,
        pattern_id: Optional[str] = None,
        scaffold_level: Optional[str] = None,
    ) -> List[Item]:
        out = []
        for item in self.items.values():
            if competency_id and item.competency_id != competency_id:
                continue
            if pattern_id and item.pattern_id != pattern_id:
                continue
            if scaffold_level and item.scaffold_level != scaffold_level:
                continue
            out.append(item)
        return sorted(out, key=lambda i: (i.difficulty, i.code))

    def stories_for_competency(self, competency_id: str) -> List[Story]:
        return [
            story
            for story in self.stories.values()
            if competency_id in story.target_competencies
        ]


# ── 加载 ───────────────────────────────────────────────────
def _read_yaml_dir(directory: str) -> List[Dict[str, Any]]:
    """递归读取目录下的 *.yaml（生成内容放在子目录里）。"""
    documents = []
    for path in sorted(glob.glob(os.path.join(directory, "**", "*.yaml"), recursive=True)):
        with open(path, "r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        data["__file__"] = os.path.relpath(path, directory)
        documents.append(data)
    return documents


def _sink(problems: Optional[List[str]]) -> List[str]:
    return problems if problems is not None else []


def put_unique(
    out: Dict[str, Any],
    key: str,
    value: Any,
    kind: str,
    problems: Optional[List[str]],
    source: str = "",
) -> None:
    """写入 dict 并记录重复。

    不用 `out[key] = value` 直接写 —— 静默覆盖会让"内容明明写了却不在系统里"
    变成一场长时间的排查。
    """
    if key in out:
        where = "（{}）".format(source) if source else ""
        problems_sink = _sink(problems)
        if problems_sink is not None:
            problems_sink.append(
                "{} code 重复：{}{}，后出现的那条会覆盖前一条".format(kind, key, where)
            )
        return
    out[key] = value


def load_competencies(problems: Optional[List[str]] = None) -> Dict[str, Competency]:
    out: Dict[str, Competency] = {}
    for doc in _read_yaml_dir(COMPETENCY_DIR):
        stage = doc.get("stage", 1)
        for row in doc.get("competencies", []) or []:
            comp = Competency(
                code=row["code"],
                name=row.get("name", row["code"]),
                description=row.get("description", ""),
                prerequisites=list(row.get("prerequisites", []) or []),
                stage=stage,
                terms=list(row.get("terms", []) or []),
            )
            put_unique(out, comp.code, comp, "competency", problems, doc.get("__file__", ""))
    return out


def load_patterns(problems: Optional[List[str]] = None) -> Dict[str, Pattern]:
    out: Dict[str, Pattern] = {}
    for doc in _read_yaml_dir(PATTERN_DIR):
        for row in doc.get("patterns", []) or []:
            pattern = Pattern(
                code=row["code"],
                name=row.get("name", row["code"]),
                cognitive_type=row["cognitive_type"],
                primary_competency=row["primary_competency"],
                applicable_competencies=list(row.get("applicable_competencies", []) or []),
                description=row.get("description", ""),
            )
            put_unique(out, pattern.code, pattern, "pattern", problems, doc.get("__file__", ""))
    return out


def load_misconceptions(problems: Optional[List[str]] = None) -> Dict[str, Misconception]:
    out: Dict[str, Misconception] = {}
    for doc in _read_yaml_dir(MISCONCEPTION_DIR):
        for row in doc.get("misconceptions", []) or []:
            misc = Misconception(
                code=row["code"],
                name=row.get("name", row["code"]),
                description=row.get("description", ""),
                severity=int(row.get("severity", 1)),
                remediation_competency=row.get("remediation_competency"),
            )
            put_unique(out, misc.code, misc, "misconception", problems, doc.get("__file__", ""))
    return out


def load_items(problems: Optional[List[str]] = None) -> Dict[str, Item]:
    out: Dict[str, Item] = {}
    for doc in _read_yaml_dir(ITEM_DIR):
        for row in doc.get("items", []) or []:
            item = Item(
                code=row["code"],
                competency_id=row["competency"],
                pattern_id=row["pattern"],
                difficulty=int(row.get("difficulty", 1)),
                scaffold_level=row.get("scaffold_level", "direct"),
                interaction_type=row.get("interaction_type", "number_pad"),
                estimated_seconds=int(row.get("estimated_seconds", 15)),
                problem=dict(row.get("problem", {}) or {}),
                answer=row.get("answer"),
                steps=list(row.get("steps", []) or []),
                hint_chain=list(row.get("hint_chain", []) or []),
                error_rules=list(row.get("error_rules", []) or []),
                steps_style=row.get("steps_style", "guide"),
            )
            put_unique(out, item.code, item, "item", problems, doc.get("__file__", ""))
    return out


def load_slots(problems: Optional[List[str]] = None) -> Dict[str, ChallengeSlot]:
    out: Dict[str, ChallengeSlot] = {}
    docs = _read_yaml_dir(SLOT_DIR) + _read_yaml_dir(STORY_DIR)
    for doc in docs:
        for row in doc.get("slots", []) or []:
            slot = ChallengeSlot(
                code=row["code"],
                competency_id=row["competency"],
                difficulty_min=int(row.get("difficulty_min", 1)),
                difficulty_max=int(row.get("difficulty_max", 5)),
                purpose=row.get("purpose", "practice"),
                pattern_id=row.get("pattern"),
                scaffold_level=row.get("scaffold_level", AUTO_SCAFFOLD),
                estimated_seconds=int(row.get("estimated_seconds", 20)),
                story_beat_id=row.get("story_beat_id"),
                selection_policy=dict(row.get("selection_policy", {}) or {}),
                review_policy=dict(row.get("review_policy", {}) or {}),
            )
            put_unique(out, slot.code, slot, "slot", problems, doc.get("__file__", ""))
    return out


def load_stories() -> Dict[str, Story]:
    """故事叙事与节拍。

    一个故事 YAML 同时含 `story`（叙事）、`beats`（节拍）和 `slots`（挑战槽）。
    story_beat.code 约定为 "{story_code}__{local}"，所以 beat 天然归属唯一的故事，
    而 slot 通过 `story_beat_id` 反向指回 beat —— 单一事实来源，不双向声明。
    """
    out: Dict[str, Story] = {}
    for doc in _read_yaml_dir(STORY_DIR):
        row = doc.get("story") or {}
        code = row.get("code")
        if not code:
            continue

        story = Story(
            code=code,
            title=row.get("title", code),
            universe=row.get("universe", ""),
            summary=row.get("summary", ""),
            order_index=int(row.get("order_index", 0)),
            duration_min=int(row.get("duration_min", 8)),
            target_competencies=list(row.get("target_competencies", []) or []),
        )

        # 先建 beat，位置由 sequence 决定；slot 稍后回填
        for raw in doc.get("beats", []) or []:
            local = raw.get("code")
            story.beats.append(
                StoryBeat(
                    code="{}__{}".format(code, local),
                    story_code=code,
                    sequence=int(raw.get("sequence", len(story.beats) + 1)),
                    beat_type=raw.get("type", "narration"),
                    narration=raw.get("text", ""),
                    character=raw.get("character", ""),
                )
            )

        out[code] = story

    # 回填：哪个 challenge beat 挂了哪个 slot（slot 是唯一声明方）
    return out


def link_slots_to_beats(
    stories: Dict[str, Story], slots: Dict[str, ChallengeSlot]
) -> None:
    """把 slot 挂回它所属的 challenge beat，就地修改 stories。"""
    beat_index = {beat.code: beat for story in stories.values() for beat in story.beats}
    for slot in slots.values():
        if not slot.story_beat_id:
            continue
        beat = beat_index.get(slot.story_beat_id)
        if beat is None or beat.slot_code is not None:
            # 引用不存在 / 一个 beat 挂两个 slot，都属于内容错误，
            # 交给 validate_content 报出来，加载阶段不抛异常。
            continue
        beat.slot_code = slot.code


def load_bundle() -> ContentBundle:
    problems: List[str] = []
    slots = load_slots(problems)
    stories = load_stories()
    link_slots_to_beats(stories, slots)
    return ContentBundle(
        competencies=load_competencies(problems),
        patterns=load_patterns(problems),
        items=load_items(problems),
        misconceptions=load_misconceptions(problems),
        slots=slots,
        stories=stories,
        load_problems=problems,
    )


# ── 轻量校验 ───────────────────────────────────────────────
def _hint_leaks_answer(hint: str, answer: Any) -> bool:
    if not isinstance(answer, int):
        return False
    tokens = {int(t) for t in _NUMBER_TOKEN.findall(hint)}
    return answer in tokens


def _load_min_patterns() -> Optional[int]:
    """升级要求"至少几个不同 pattern 成功过"。

    ADR-0002：阈值必须全部走配置，禁止硬编码。这里用与 state_machine 判升级
    同一个入口 —— AlgorithmConfig.new_pattern_success_rule() 读
    upgrade_requires.new_pattern_success.min_patterns，校验规则与运行时门
    因此不可能各自漂移。

    刻意延迟到函数内 import：backend.engine 反向依赖 backend.content，
    内容层模块顶部反向 import 引擎会埋下循环导入的地雷，也会让"只加载内容"
    的场景被迫拖起整个引擎（已实测 `import backend.content.loader` 与
    `from backend.engine import planner` 都不受影响）。
    配置里没写这个键时返回 None，由调用方跳过该检查，而不是退回硬编码值。
    """
    from backend.engine.config import load_config

    value = load_config(0).new_pattern_success_rule().get("min_patterns")
    return int(value) if value is not None else None


def _dependents(bundle: ContentBundle, code: str) -> List[str]:
    """（传递）依赖 code 的能力 —— 自己用 prerequisites 反推，不依赖 engine 层。"""
    reverse: Dict[str, List[str]] = {}
    for comp in bundle.competencies.values():
        for prereq in comp.prerequisites:
            reverse.setdefault(prereq, []).append(comp.code)

    seen = set()
    stack = list(reverse.get(code, ()))
    while stack:
        current = stack.pop()
        if current in seen or current == code:
            continue
        seen.add(current)
        stack.extend(reverse.get(current, ()))
    return sorted(seen)


def _supported_patterns(bundle: ContentBundle, competency_code: str) -> List[str]:
    """该能力下"有题支撑"的 pattern 名单（去重、排序）。

    只认 item.competency_id 命中、且 pattern 真的适用于该能力的题：
    运行时 count_successful_patterns 只在 patterns_for(competency) 上累计信号，
    pattern 不适用或没有题，孩子就永远"成功"不了它。
    """
    codes = set()
    for item in bundle.items.values():
        if item.competency_id != competency_code:
            continue
        pattern = bundle.patterns.get(item.pattern_id)
        if pattern is not None and pattern.applies_to(competency_code):
            codes.add(pattern.code)
    return sorted(codes)


def _validate_upgradable_patterns(
    bundle: ContentBundle, min_patterns: Optional[int] = None
) -> List[str]:
    """结构性死路：能力有题支撑的 pattern 数不足，永远无法升级。

    升级硬条件要求"至少 N 个不同 pattern 成功过"（N 来自 config）。但 pattern
    只有真的产出了题目，孩子才可能把它成功一次 —— 所以这里数的是**有题支撑**的
    pattern。某个能力只有 < N 个 pattern 的题时，它在结构上就永远升不了级，
    而且会沿 prerequisites 把整条下游一起拖死。

    这类缺陷过去只能靠人工读模拟报告发现（tools/simulate.py 的 Q7），
    现在编译器直接拦住。

    min_patterns 为 None 时才去读算法配置（阈值禁止硬编码）。
    """
    need = _load_min_patterns() if min_patterns is None else int(min_patterns)
    if need is None or need < 1:
        return []

    problems: List[str] = []
    for code in sorted(bundle.competencies):
        patterns = _supported_patterns(bundle, code)
        if len(patterns) >= need:
            continue
        message = (
            "{}：只有 {} 个 pattern 有题支撑（{}），升级需要 {} 个 → "
            "该能力永远无法升级".format(
                code, len(patterns), "、".join(patterns) or "无", need
            )
        )
        downstream = _dependents(bundle, code)
        if downstream:
            message += "；受牵连的下游能力 {} 个：{}".format(
                len(downstream), "、".join(downstream)
            )
        problems.append(message)
    return problems


def validate_content(bundle: ContentBundle, min_patterns: Optional[int] = None) -> List[str]:
    """内容体检。任何一条问题都会让 Compiler 判定内容不可用。

    min_patterns：升级门要求的 pattern 数，供测试注入；
    None 时惰性从算法配置读 —— 阈值只允许有一个来源（ADR-0002）。
    """
    # 先报加载阶段的问题：code 重复会让后面所有检查都建立在"残缺的内容"上
    problems: List[str] = list(bundle.load_problems)

    for comp in bundle.competencies.values():
        for prereq in comp.prerequisites:
            if prereq not in bundle.competencies:
                problems.append(
                    "competency {} 的前置 {} 不存在".format(comp.code, prereq)
                )
            if prereq == comp.code:
                problems.append("competency {} 依赖自己".format(comp.code))

    for pattern in bundle.patterns.values():
        if pattern.cognitive_type not in ALLOWED_COGNITIVE_TYPES:
            problems.append(
                "pattern {} 的 cognitive_type 非法: {}".format(
                    pattern.code, pattern.cognitive_type
                )
            )
        for comp_code in set(pattern.applicable_competencies) | {pattern.primary_competency}:
            if comp_code not in bundle.competencies:
                problems.append(
                    "pattern {} 关联了不存在的 competency {}".format(pattern.code, comp_code)
                )

    for item in bundle.items.values():
        if item.competency_id not in bundle.competencies:
            problems.append(
                "item {} 的 competency {} 不存在".format(item.code, item.competency_id)
            )
        if item.pattern_id not in bundle.patterns:
            problems.append(
                "item {} 的 pattern {} 不存在".format(item.code, item.pattern_id)
            )
        else:
            pattern = bundle.patterns[item.pattern_id]
            if not pattern.applies_to(item.competency_id):
                problems.append(
                    "item {} 的 pattern {} 不允许用于 competency {}".format(
                        item.code, pattern.code, item.competency_id
                    )
                )
        if item.scaffold_level not in ALLOWED_SCAFFOLD_LEVELS:
            problems.append(
                "item {} 的 scaffold_level 非法: {}".format(item.code, item.scaffold_level)
            )
        if item.answer is None:
            problems.append("item {} 缺少 answer".format(item.code))
        if item.steps_style not in ALLOWED_STEPS_STYLES:
            problems.append(
                "item {} 的 steps_style 非法: {}".format(item.code, item.steps_style)
            )
        if not item.hint_chain:
            problems.append("item {} 缺少 hint_chain".format(item.code))
        for hint in item.hint_chain:
            if _hint_leaks_answer(hint, item.answer):
                problems.append("item {} 的提示泄漏了答案: {}".format(item.code, hint))
        for rule in item.error_rules:
            code = rule.get("code")
            if code not in bundle.misconceptions:
                problems.append(
                    "item {} 引用了不存在的 misconception {}".format(item.code, code)
                )
            if "match" not in rule:
                problems.append("item {} 的 error_rule 缺少 match".format(item.code))

    for slot in bundle.slots.values():
        if slot.competency_id not in bundle.competencies:
            problems.append(
                "slot {} 的 competency {} 不存在".format(slot.code, slot.competency_id)
            )
        if slot.pattern_id:
            pattern = bundle.patterns.get(slot.pattern_id)
            if pattern is None:
                problems.append(
                    "slot {} 的 pattern {} 不存在".format(slot.code, slot.pattern_id)
                )
            elif not pattern.applies_to(slot.competency_id):
                problems.append(
                    "slot {} 的 pattern {} 不允许用于 competency {}".format(
                        slot.code, slot.pattern_id, slot.competency_id
                    )
                )
        if slot.scaffold_level not in (ALLOWED_SCAFFOLD_LEVELS | {AUTO_SCAFFOLD, None}):
            problems.append(
                "slot {} 的 scaffold_level 非法: {}".format(slot.code, slot.scaffold_level)
            )
        if slot.purpose not in ALLOWED_PURPOSES:
            problems.append(
                "slot {} 的 purpose 非法: {}".format(slot.code, slot.purpose)
            )
        if slot.difficulty_min > slot.difficulty_max:
            problems.append(
                "slot {} 的难度区间倒置: {} > {}".format(
                    slot.code, slot.difficulty_min, slot.difficulty_max
                )
            )
        # ADR-0001：必须保证候选池非空，否则运行时会出现"故事走到这里却没题可出"
        candidates = [
            item
            for item in bundle.items.values()
            if item.competency_id == slot.competency_id
            and (slot.pattern_id is None or item.pattern_id == slot.pattern_id)
            and slot.difficulty_min <= item.difficulty <= slot.difficulty_max
        ]
        if not candidates:
            problems.append("slot {} 的候选池为空（没有任何 item 能满足）".format(slot.code))

    problems.extend(_validate_stories(bundle))
    problems.extend(_validate_upgradable_patterns(bundle, min_patterns))
    return problems


def _validate_stories(bundle: ContentBundle) -> List[str]:
    """故事叙事与挑战槽必须严丝合缝。

    最容易出的错是"故事讲到要算一算，系统却不知道该算什么"——
    孩子看到一个挑战节拍，却没有题可出。所以这里逐条核对。
    """
    problems: List[str] = []
    beat_to_story: Dict[str, str] = {}

    for story in bundle.stories.values():
        if not story.title:
            problems.append("story {} 缺少 title".format(story.code))
        for competency in story.target_competencies:
            if competency not in bundle.competencies:
                problems.append(
                    "story {} 指向了不存在的 competency {}".format(story.code, competency)
                )

        sequences = [b.sequence for b in story.beats]
        if len(sequences) != len(set(sequences)):
            problems.append("story {} 的 beat sequence 有重复".format(story.code))
        if story.beats and sorted(sequences) != list(range(1, len(sequences) + 1)):
            problems.append(
                "story {} 的 beat sequence 必须是 1..N 连续（当前 {}）".format(
                    story.code, sorted(sequences)
                )
            )

        for beat in story.beats:
            prefix = "{}__".format(story.code)
            if not beat.code.startswith(prefix):
                problems.append(
                    "story_beat {} 的 code 必须以「{}」开头（约定：story_code__local）".format(
                        beat.code, prefix
                    )
                )
            if beat.code in beat_to_story:
                problems.append("story_beat {} 重复出现在多个故事里".format(beat.code))
            beat_to_story[beat.code] = story.code
            if beat.beat_type not in ALLOWED_BEAT_TYPES:
                problems.append(
                    "story_beat {} 的 type 非法: {}".format(beat.code, beat.beat_type)
                )
            if not beat.narration:
                problems.append("story_beat {} 没有 text".format(beat.code))
            if beat.beat_type == "challenge" and not beat.slot_code:
                problems.append(
                    "挑战节拍 {} 没有挂 challenge_slot —— 故事走到这里会无题可出".format(
                        beat.code
                    )
                )

        if not story.challenge_beats():
            problems.append(
                "story {} 没有任何挑战节拍（故事必须包含数学训练）".format(story.code)
            )

    # slot 侧的反向核对
    for slot in bundle.slots.values():
        if not slot.story_beat_id:
            continue
        if slot.story_beat_id not in beat_to_story:
            problems.append(
                "slot {} 引用了不存在的 story_beat {}".format(slot.code, slot.story_beat_id)
            )
            continue
        owner = beat_to_story[slot.story_beat_id]
        beat = next(
            (b for b in bundle.stories[owner].beats if b.code == slot.story_beat_id), None
        )
        if beat is not None and beat.beat_type != "challenge":
            problems.append(
                "slot {} 挂在了非挑战节拍 {}（type={}）上".format(
                    slot.code, beat.code, beat.beat_type
                )
            )

    return problems
