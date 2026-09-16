"""内容层校验测试。"""
from __future__ import annotations

from backend.content.loader import (
    ChallengeSlot,
    Competency,
    ContentBundle,
    Item,
    Pattern,
    validate_content,
)
from backend.engine.graph import CompetencyGraph


def test_bundle_loads(bundle):
    assert len(bundle.competencies) == 10
    assert len(bundle.patterns) >= 7
    assert len(bundle.items) >= 20
    assert len(bundle.slots) >= 1
    assert len(bundle.misconceptions) >= 7


def test_content_validates_clean(bundle):
    assert validate_content(bundle) == []


def test_graph_validates_clean(graph):
    assert graph.validate() == []
    assert graph.find_cycles() == []


def test_topological_order_respects_prerequisites(graph):
    order = graph.topological_order()
    position = {code: idx for idx, code in enumerate(order)}
    for code in order:
        for prereq in graph.prerequisites(code):
            assert position[prereq] < position[code], "{} 必须排在 {} 之前".format(
                prereq, code
            )


def test_prerequisite_closure(graph):
    assert set(graph.prerequisites("carry_add")) == {
        "td_add_nocarry",
        "make_ten",
        "place_value",
    }
    closure = set(graph.prerequisites("carry_add", transitive=True))
    assert {"sd_add_10", "place_value", "make_ten", "td_add_nocarry"} <= closure


def test_every_slot_has_candidates(bundle):
    for slot in bundle.slots.values():
        candidates = [
            item
            for item in bundle.items.values()
            if item.competency_id == slot.competency_id
            and (slot.pattern_id is None or item.pattern_id == slot.pattern_id)
            and slot.difficulty_min <= item.difficulty <= slot.difficulty_max
        ]
        assert candidates, "slot {} 的候选池不能为空".format(slot.code)


def test_hint_leak_is_detected(bundle):
    """提示里出现答案数字必须被拦下。"""
    bad_item = Item(
        code="bad_item",
        competency_id="make_ten",
        pattern_id="decompose",
        difficulty=2,
        scaffold_level="decompose",
        interaction_type="decompose_drag",
        estimated_seconds=15,
        problem={"a": 8, "b": 5},
        answer=13,
        steps=["8+2=10", "10+3=13"],
        hint_chain=["先算 8+2=10，再加上 3 得到 13"],
        error_rules=[],
    )
    polluted = ContentBundle(
        competencies=dict(bundle.competencies),
        patterns=dict(bundle.patterns),
        items={"bad_item": bad_item},
        misconceptions=dict(bundle.misconceptions),
        slots={},
    )
    problems = validate_content(polluted)
    assert any("泄漏了答案" in p for p in problems), problems


def test_hint_with_unrelated_number_is_not_flagged(bundle):
    """提示里出现无关数字（如凑十目标 10）不应误报。"""
    ok_item = Item(
        code="ok_item",
        competency_id="make_ten",
        pattern_id="decompose",
        difficulty=2,
        scaffold_level="decompose",
        interaction_type="decompose_drag",
        estimated_seconds=15,
        problem={"a": 8, "b": 5},
        answer=13,
        steps=[],
        hint_chain=["8 和几凑成 10？"],
        error_rules=[],
    )
    bundle_like = ContentBundle(
        competencies=dict(bundle.competencies),
        patterns=dict(bundle.patterns),
        items={"ok_item": ok_item},
        misconceptions=dict(bundle.misconceptions),
        slots={},
    )
    assert [p for p in validate_content(bundle_like) if "泄漏" in p] == []


def test_slot_with_empty_pool_is_detected(bundle):
    """候选池为空必须被拦下。

    空池区间是**从内容里算出来的**，不是写死的难度数字 ——
    这道测试曾经用 borrow_sub 难度 5~5 构造空池，内容补齐 12 道 d5 的
    borrow_sub 之后就静默失效了：测试还在跑，前提已经不成立。
    """
    competency_id = "make_ten"
    difficulties = [
        i.difficulty for i in bundle.items.values() if i.competency_id == competency_id
    ]
    assert difficulties, "该能力必须有题，否则这道测试的前提不成立"
    empty_difficulty = max(difficulties) + 1

    empty_slot = ChallengeSlot(
        code="empty_slot",
        competency_id=competency_id,
        difficulty_min=empty_difficulty,
        difficulty_max=empty_difficulty,
        purpose="practice",
    )
    problems = validate_content(
        ContentBundle(
            competencies=dict(bundle.competencies),
            patterns=dict(bundle.patterns),
            items=dict(bundle.items),
            misconceptions=dict(bundle.misconceptions),
            slots={"empty_slot": empty_slot},
        )
    )
    assert any("候选池为空" in p for p in problems), problems


def test_competency_with_too_few_patterns_is_detected(bundle, cfg):
    """结构性死路必须在编译器里被拦下，而不是靠人工读模拟报告。

    升级硬条件要求"至少 N 个不同 pattern 成功过"（N 从 config 读，不写死），
    但 pattern 只有真的产出了题目，孩子才可能把它成功一次 —— 所以只挂了 1 个
    pattern 题目的能力在结构上永远升不了级，还会沿 prerequisites 拖住下游。
    这里从真实内容里**动态**摘掉一个 pattern 的题来构造这条死路。
    """
    need = int(cfg.new_pattern_success_rule().get("min_patterns", 2))
    assert need >= 2, "升级门槛小于 2 时这条规则不适用，测试前提不成立"

    victim = "sd_sub_10"
    patterns = sorted(
        {i.pattern_id for i in bundle.items.values() if i.competency_id == victim}
    )
    assert len(patterns) >= need, "{} 本来就必须有 ≥ {} 个 pattern".format(victim, need)
    dropped = patterns[-1]  # 只留第一个 pattern，其余全摘掉

    slim_items = {
        code: item
        for code, item in bundle.items.items()
        if not (item.competency_id == victim and item.pattern_id != patterns[0])
    }
    problems = validate_content(
        ContentBundle(
            competencies=dict(bundle.competencies),
            patterns=dict(bundle.patterns),
            items=slim_items,
            misconceptions=dict(bundle.misconceptions),
            slots={},
        )
    )
    matched = [p for p in problems if p.startswith("{}：".format(victim))]
    assert matched, "只挂 1 个 pattern 的能力必须被拦下：{}".format(problems)
    assert "永远无法升级" in matched[0]
    assert dropped not in matched[0], "文案应只列剩余的 pattern"
    for downstream in ("borrow_sub", "sd_sub_20", "td_sub_nocarry"):
        assert downstream in matched[0], "文案必须说清拖住了哪些下游能力"


def test_cycle_is_detected(bundle):
    """人为制造一个环，必须被拦下。"""
    from backend.content.loader import Competency

    cyclic = dict(bundle.competencies)
    cyclic["sd_add_10"] = Competency(
        code="sd_add_10",
        name="10 以内加法",
        prerequisites=["carry_add"],
        stage=1,
    )
    graph = CompetencyGraph(
        ContentBundle(
            competencies=cyclic,
            patterns=dict(bundle.patterns),
            items=dict(bundle.items),
            misconceptions=dict(bundle.misconceptions),
        )
    )
    assert graph.find_cycles(), "应当检测到环"


# ── 升级可达性：有题支撑的 pattern 数不足 ─────────────────────
# 这些用例全部用合成数据，不依赖 content/** 的当期货量
# （那个数字会随内容扩充而变，写死就会像 borrow_sub 那道空池测试一样静默失效）。
def _mk_pattern(code, competency_id):
    return Pattern(
        code=code,
        name=code,
        cognitive_type="compute",
        primary_competency=competency_id,
    )


def _mk_item(code, competency_id, pattern_id):
    return Item(
        code=code,
        competency_id=competency_id,
        pattern_id=pattern_id,
        difficulty=1,
        scaffold_level="direct",
        interaction_type="number_pad",
        estimated_seconds=15,
        problem={"a": 3, "b": 4},
        answer=7,
        steps=[],
        hint_chain=["数一数"],
        error_rules=[],
    )


def _chain_bundle(supported_counts):
    """合成一条 root → weak → down → far 的能力链。

    supported_counts 只给需要定制的环节，其余能力按 2 个有题 pattern 给。
    """
    prereqs = {"root": [], "weak": ["root"], "down": ["weak"], "far": ["down"]}
    competencies, patterns, items = {}, {}, {}
    for code, prereq in prereqs.items():
        competencies[code] = Competency(code=code, name=code, prerequisites=prereq)
        for idx in range(supported_counts.get(code, 2)):
            pattern = _mk_pattern("{}_p{}".format(code, idx), code)
            patterns[pattern.code] = pattern
            item = _mk_item("{}_i{}".format(code, idx), code, pattern.code)
            items[item.code] = item
    return ContentBundle(competencies=competencies, patterns=patterns, items=items)


def test_insufficient_supported_patterns_is_detected():
    """有题支撑的 pattern 数不足必须被拦下，并列出传递阻塞的下游能力。"""
    problems = validate_content(_chain_bundle({"weak": 1}), min_patterns=2)

    hits = [p for p in problems if "永远无法升级" in p]
    assert len(hits) == 1, problems
    message = hits[0]
    assert message.startswith("weak：只有 1 个 pattern 有题支撑（weak_p0）")
    assert "升级需要 2 个" in message
    assert "受牵连的下游能力 2 个：down、far" in message
    # 达标的能力不能被误报
    assert not [p for p in problems if p.startswith(("root：", "down：", "far："))]


def test_pattern_without_items_is_not_support():
    """pattern 声明了但一道题都没有，孩子成功不了它 —— 不能算"有题支撑"。"""
    bundle_like = _chain_bundle({"weak": 1})
    declared_only = _mk_pattern("weak_declared_only", "weak")
    bundle_like.patterns[declared_only.code] = declared_only

    problems = validate_content(bundle_like, min_patterns=2)
    hits = [p for p in problems if "永远无法升级" in p]
    assert len(hits) == 1, problems
    assert "只有 1 个 pattern 有题支撑（weak_p0）" in hits[0], hits[0]


def test_enough_supported_patterns_pass():
    """达标的内容不能被误报。"""
    assert validate_content(_chain_bundle({"weak": 2}), min_patterns=2) == []


def test_threshold_is_read_from_algorithm_config():
    """阈值来自 config/algorithm/v0.yaml，不是硬编码的 2。"""
    from backend.engine.config import load_config

    need = int(load_config(0).new_pattern_success_rule()["min_patterns"])
    # 低于阈值 1 个：默认调用（不注入阈值）必须拦下
    below = _chain_bundle({"weak": max(0, need - 1)})
    assert [
        p for p in validate_content(below) if p.startswith("weak：") and "永远无法升级" in p
    ], "默认阈值应来自算法配置 min_patterns={}".format(need)
    # 恰好达到阈值：不能报
    assert validate_content(_chain_bundle({"weak": need}), min_patterns=need) == []


def test_real_content_has_enough_patterns(bundle):
    """真实 content/** 必须满足升级门的 pattern 数要求。"""
    problems = [p for p in validate_content(bundle) if "永远无法升级" in p]
    assert problems == [], "存在永远无法升级的能力：\n" + "\n".join(problems)
