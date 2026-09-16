"""熟练度状态机：等级派生 / 升级判定 / 回退判定。

两个概念必须分开（这是本模块最重要的设计）：

  1. **等级（level）** —— 描述"孩子现在处于什么状态"，是派生值（ADR-0002）。
     未采样过的信号不参与判定，不因为"没测过"而卡住等级。

  2. **升级（upgrade）** —— 一个严格门：必须集齐全部证据才允许推进到下一个能力。
     缺任何一项都不升级。等级到了 ⭐ 也不等于自动升级。

  这样设计的原因：等级是给孩子和家长看的"当前状态"，升级是 Planner 决定
  "要不要换能力"的门槛，两者混淆会导致孩子被过早推向下一个知识点。
"""
from __future__ import annotations

from typing import Callable, List, Optional

from backend.engine.config import AlgorithmConfig
from backend.engine.graph import CompetencyGraph
from backend.engine.types import (
    Attempt,
    ChildLearningState,
    Decision,
    Signals,
    pattern_key,
)


# 浮点比较容差：避免出现 "accuracy=0.90 < 0.90" 这种看起来像 bug 的判定
_EPS = 1e-9


# ── 等级派生 ───────────────────────────────────────────────
def _thresholds_satisfied(signals: Signals, thresholds: dict) -> bool:
    for name, threshold in thresholds.items():
        if not signals.is_sampled(name):
            # 从未采样 → 该条件不参与判定（"没测过"不等于"不达标"）
            continue
        if signals.value(name) + _EPS < float(threshold):
            return False
    return True


def derive_level(signals: Signals, cfg: AlgorithmConfig) -> str:
    if signals.sample_count < cfg.min_samples_for_level:
        return cfg.level_order[0]

    best = cfg.level_order[0]
    for level in cfg.level_order[1:]:
        if _thresholds_satisfied(signals, cfg.level_thresholds(level)):
            best = level
        else:
            break  # 等级阈值是累积的，一旦不满足就停止升级
    return best


def level_label(level: str, cfg: AlgorithmConfig) -> str:
    return cfg.level_label(level)


# ── 升级判定 ───────────────────────────────────────────────
def count_successful_patterns(
    state: ChildLearningState,
    competency_code: str,
    graph: CompetencyGraph,
    cfg: AlgorithmConfig,
) -> int:
    rule = cfg.new_pattern_success_rule()
    min_accuracy = float(rule.get("min_accuracy", 0.5))
    count = 0
    for pattern in graph.patterns_for(competency_code):
        signals = state.patterns.get(pattern_key(competency_code, pattern.code))
        if signals is None or signals.sample_count < 1:
            continue
        accuracy = signals.accuracy
        if accuracy is not None and accuracy >= min_accuracy:
            count += 1
    return count


def is_mastered(
    state: ChildLearningState,
    competency_code: str,
    graph: CompetencyGraph,
    cfg: AlgorithmConfig,
) -> bool:
    return upgrade_decision(state, competency_code, graph, cfg).action == "upgrade"


def upgrade_decision(
    state: ChildLearningState,
    competency_code: str,
    graph: CompetencyGraph,
    cfg: AlgorithmConfig,
) -> Decision:
    """严格门：全部条件 AND。任一项不满足都 hold，并给出可读原因。"""
    requires = cfg.upgrade_requires()
    signals = state.competencies.get(competency_code)
    reasons: List[str] = []

    if signals is None:
        return Decision("hold", competency_code, reasons=["还没有任何作答记录"])

    if cfg.assessment_blocks_upgrade and signals.practice_samples <= 0:
        reasons.append("目前只有探测题，没有正式练习样本")

    if signals.practice_samples < cfg.min_practice_samples:
        reasons.append(
            "正式练习样本不足：{} < {}".format(signals.practice_samples, cfg.min_practice_samples)
        )

    for name in ("accuracy", "mastery", "independence", "transfer", "fluency"):
        if name not in requires:
            continue
        threshold = float(requires[name])
        value = signals.value(name)
        if value is None:
            reasons.append("{} 尚无证据（需要专门采样）".format(name))
        elif value + _EPS < threshold:
            reasons.append("{}={:.4f} < {:.4f}".format(name, value, threshold))

    if requires.get("require_prerequisites", True):
        for prereq in graph.prerequisites(competency_code):
            if not is_mastered(state, prereq, graph, cfg):
                reasons.append("前置能力未达标：{}".format(prereq))

    if requires.get("require_new_pattern_success", True):
        rule = cfg.new_pattern_success_rule()
        need = int(rule.get("min_patterns", 2))
        got = count_successful_patterns(state, competency_code, graph, cfg)
        if got < need:
            reasons.append("成功过的 pattern 数不足：{} < {}".format(got, need))

    if reasons:
        return Decision("hold", competency_code, reasons=reasons)
    return Decision("upgrade", competency_code, reasons=["全部升级条件满足"])


def next_competency(
    state: ChildLearningState,
    graph: CompetencyGraph,
    cfg: AlgorithmConfig,
) -> Optional[str]:
    """当前应该聚焦的能力。

    优先返回"孩子最近落脚、且尚未达标"的能力 —— 否则冷启动时会把焦点放到
    孩子完全没接触过的能力上（例如明明在练 make_ten，却被指向 place_value）。

    没有任何作答历史时，退回能力图入口（P3 会改由冷启动 Probe 定位入口）。
    """
    touched = sorted(
        (
            (seq, code)
            for code, seq in state.last_touched_seq.items()
            if state.competencies.get(code) is not None
        ),
        key=lambda row: (-row[0], row[1]),
    )
    for _, code in touched:
        if not is_mastered(state, code, graph, cfg):
            return code

    return graph.next_unmastered(
        lambda code: is_mastered(state, code, graph, cfg)
    )


# ── 回退判定 ───────────────────────────────────────────────
def _trailing_wrong_run(attempts: List[Attempt]) -> int:
    run = 0
    for attempt in reversed(attempts):
        if attempt.correct:
            break
        run += 1
    return run


def _mastery_score(state: ChildLearningState) -> Callable[[str], float]:
    def score(code: str) -> float:
        signals = state.competencies.get(code)
        if signals is None or signals.mastery is None:
            return 0.0
        return signals.mastery

    return score


def fallback_decision(
    state: ChildLearningState,
    current_competency: str,
    graph: CompetencyGraph,
    cfg: AlgorithmConfig,
) -> Decision:
    """判断是否需要回退到前置能力。不需要回退时返回 action='hold'。"""
    triggers = cfg.fallback_triggers()
    reasons: List[str] = []
    recent = list(state.recent_attempts)

    if not recent:
        return Decision("hold", current_competency, reasons=["没有近期作答"])

    consecutive_wrong = int(triggers.get("consecutive_wrong", 3))
    run = _trailing_wrong_run(recent)
    if run >= consecutive_wrong:
        reasons.append("连续答错 {} 次".format(run))

    hint_delta = int(triggers.get("hint_spike_delta", 2))
    if len(recent) >= 2:
        if recent[-1].hints_used - recent[-2].hints_used >= hint_delta:
            reasons.append(
                "提示使用突然增加：{} → {}".format(
                    recent[-2].hints_used, recent[-1].hints_used
                )
            )

    misconception_target: Optional[str] = None
    if triggers.get("misconception_prerequisite_trigger", True):
        prereq_closure = set(graph.prerequisites(current_competency, transitive=True))
        for misc_state in state.misconceptions.values():
            if misc_state.resolved or misc_state.last_seq is None:
                continue
            if misc_state.last_seq < recent[-1].seq - 1:
                continue
            # 只在错误认知指向前置能力时触发回退
            if misc_state.remediation_competency in prereq_closure:
                misconception_target = misc_state.remediation_competency
                reasons.append(
                    "近期命中错误认知：{}（指向前置能力 {}）".format(
                        misc_state.code, misc_state.remediation_competency
                    )
                )
                break

    if not reasons:
        return Decision("hold", current_competency, reasons=["未触发回退条件"])

    # 回退目标：先看诊断，再看图。
    # 错误认知已经指名道姓说根子在哪（remediation_competency），就用它 ——
    # 别再另算"最弱前置"：熟练度是 EWMA，每天都在波动，另算出来的目标
    # 也每天在换（模拟实测：同一个孩子第 4 天退到不进位减法、第 5 天退到
    # 位值、第 6 天退到凑十、第 7 天退到 10 以内加法 —— 孩子等于每天换
    # 一个补习班，哪一个都学不下去）。
    if misconception_target is not None:
        return Decision(
            "fallback",
            current_competency,
            target_competency_id=misconception_target,
            reasons=reasons
            + ["回退目标：{}（错误认知指名的补习对象）".format(misconception_target)],
        )

    target = graph.weakest_prerequisite(current_competency, _mastery_score(state))
    if target is None:
        return Decision(
            "hold",
            current_competency,
            reasons=reasons + ["该能力没有前置能力可回退"],
        )

    return Decision(
        "fallback",
        current_competency,
        target_competency_id=target,
        reasons=reasons + ["回退目标：{}（前置能力中最薄弱）".format(target)],
    )
