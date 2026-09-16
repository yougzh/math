"""算法配置加载。

ADR-0002 配套约束：
  - 阈值、权重、时间语义全部来自 config/algorithm/v{N}.yaml
  - 代码里禁止出现阈值字面量
  - 状态必须 pin 住自己是用哪个 version 算出来的
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

import yaml

from backend.paths import ALGORITHM_CONFIG_DIR

_LEVEL_ORDER = ["encountering", "understanding", "can_do", "proficient", "automatic"]

_LEVEL_LABELS = {
    "encountering": "🌱 接触",
    "understanding": "🌿 理解",
    "can_do": "🌳 会做",
    "proficient": "⭐ 熟练",
    "automatic": "🔥 自动化",
}

SCAFFOLD_LEVELS = ["blocks", "decompose", "direct"]

_cache = {}


class AlgorithmConfig:
    """算法配置的只读视图。

    不把 YAML 结构复制成一堆 dataclass 字段是刻意的：
    配置的演进速度远快于代码，硬编字段会让每次调参都要改代码。
    """

    def __init__(self, raw: Dict[str, Any]):
        self.raw = raw
        self.version = int(raw["version"])

    # ── 通用访问 ────────────────────────────────────────
    def section(self, *path):
        node = self.raw
        for key in path:
            node = node[key]
        return node

    def get(self, *path, **kw):
        node = self.raw
        for key in path:
            if key not in node:
                if "default" in kw:
                    return kw["default"]
                raise KeyError("配置缺失: {}".format(".".join(path)))
            node = node[key]
        return node

    # ── 平滑 ────────────────────────────────────────────
    @property
    def ewma_alpha(self) -> float:
        return float(self.get("smoothing", "ewma_alpha"))

    @property
    def min_samples_for_level(self) -> int:
        return int(self.get("smoothing", "min_samples_for_level"))

    def alpha_for(self, is_assessment: bool) -> float:
        """probe attempt 的权重折扣（D5：冷启动不影响正式判定）。"""
        alpha = self.ewma_alpha
        if is_assessment and self.get("assessment", "weight", default=None):
            alpha *= float(self.get("assessment", "weight"))
        return alpha

    @property
    def assessment_blocks_upgrade(self) -> bool:
        return bool(self.get("assessment", "blocks_upgrade", default=True))

    # ── 等级派生 ────────────────────────────────────────
    @property
    def level_order(self) -> List[str]:
        return list(_LEVEL_ORDER)

    def level_label(self, level: str) -> str:
        return _LEVEL_LABELS.get(level, level)

    def level_thresholds(self, level: str) -> Dict[str, float]:
        return dict(self.get("level_thresholds", level, default={}))

    # ── 采样规则 ────────────────────────────────────────
    def mastery_sample(self, correct: bool, hints_used: int) -> float:
        if not correct:
            return float(self.get("mastery_sampling", "incorrect"))
        if hints_used > 0:
            return float(self.get("mastery_sampling", "correct_with_hint"))
        return float(self.get("mastery_sampling", "correct_without_hint"))

    def independence_sample(self, hints_used: int) -> float:
        penalty = float(self.get("independence_sampling", "hint_penalty"))
        floor = float(self.get("independence_sampling", "min_sample"))
        return max(floor, 1.0 - penalty * max(0, hints_used))

    def fluency_score_for_ratio(self, ratio: float) -> float:
        for band in self.get("fluency_sampling", "ratio_scores"):
            if ratio <= float(band["max_ratio"]):
                return float(band["score"])
        return 0.0

    def confidence_sample(self, correct: bool) -> float:
        key = "correct" if correct else "incorrect"
        return float(self.get("confidence_sampling", key))

    @property
    def confidence_alpha(self) -> float:
        return float(self.get("confidence_sampling", "alpha"))

    # ── 升级 / 回退 ─────────────────────────────────────
    def upgrade_requires(self) -> Dict[str, Any]:
        return dict(self.get("upgrade_requires"))

    @property
    def min_practice_samples(self) -> int:
        """升级只认正式练习样本；probe attempt 不计入（D5）。"""
        requires = self.get("upgrade_requires")
        return int(requires.get("min_practice_samples", requires.get("min_samples", 0)))

    def new_pattern_success_rule(self) -> Dict[str, Any]:
        return dict(
            self.get("upgrade_requires", "new_pattern_success", default={})
        )

    def fallback_triggers(self) -> Dict[str, Any]:
        return dict(self.get("fallback_triggers"))

    # ── 脚手架递退 ──────────────────────────────────────
    def scaffold_for_mastery(self, mastery: Optional[float]) -> str:
        if mastery is None:
            return SCAFFOLD_LEVELS[0]
        if mastery < float(self.get("scaffold_fading", "blocks_below_mastery")):
            return "blocks"
        if mastery < float(self.get("scaffold_fading", "decompose_below_mastery")):
            return "decompose"
        return "direct"

    # ── 题目选择（ADR-0001：Selector 只决定"具体做哪一道"） ──
    def default_avoid_recent(self) -> int:
        """槽位没有显式声明 avoid_recent 时的缺省避重窗口。"""
        return int(self.get("selection", "default_avoid_recent"))

    def min_avoid_recent(self) -> int:
        """避重窗口的下限（跨天不重复的硬约束）。

        一天的计划是整批生成的：窗口只数"最近 N 次作答"，而当天最后几次作答
        会把整个窗口占满，核心训练槽昨天做的题根本不在窗口里 —— 这就是
        "每天出同一道题"的机制。下限保证窗口至少覆盖一整天。
        """
        return int(self.get("selection", "min_avoid_recent"))

    def max_difficulty_step_up(self) -> int:
        """相邻两次作答允许的难度上升档数上限（防止跳级）。"""
        return int(self.get("selection", "max_difficulty_step_up"))

    def target_difficulty(
        self,
        mastery: Optional[float],
        difficulty_min: int,
        difficulty_max: int,
    ) -> float:
        """把熟练度映射成 slot 难度区间内的目标难度。

        mastery 为 None 表示"这个能力还没采到证据"，用配置里的 unknown_position
        —— 默认贴着区间下限：没有证据时从最简单的开始。
        slot 的 difficulty_min / difficulty_max 是权威边界，返回值保证落在这个闭区间内。

        返回值不必是整数：Selector 取"离目标最近"的那道题即可，
        所以这里不做分档，也就不会出现跨级的难度跳变。
        """
        low = int(difficulty_min)
        high = int(difficulty_max)
        if high <= low:
            return float(low)

        conf = self.get("selection", "difficulty_target")
        if mastery is None:
            position = float(conf.get("unknown_position", 0.0))
        else:
            floor = float(conf.get("mastery_floor", 0.0))
            ceiling = float(conf.get("mastery_ceiling", 1.0))
            if ceiling <= floor:
                position = 1.0 if float(mastery) >= ceiling else 0.0
            else:
                position = (float(mastery) - floor) / (ceiling - floor)
        position = max(0.0, min(1.0, position))
        return low + position * (high - low)

    # ── 时间语义（ADR-0003） ────────────────────────────
    @property
    def thinking_normal_max_ms(self) -> int:
        return int(self.get("time_semantics", "thinking_normal_max_ms"))

    @property
    def uncertain_max_ms(self) -> int:
        return int(self.get("time_semantics", "uncertain_max_ms"))

    @property
    def idle_dominated_ratio(self) -> float:
        return float(self.get("time_semantics", "idle_dominated_ratio", default=0.5))

    def fluency_threshold_ms(self, pattern_id: str, interaction_type: str) -> int:
        """fluency 阈值必须按 (pattern, interaction_type) 区分。"""
        by_pattern = self.get("fluency_thresholds", default={}).get(pattern_id, {})
        seconds = by_pattern.get(interaction_type)
        if seconds is None:
            seconds = self.get("fluency_thresholds", "default", default={}).get(
                interaction_type, 20
            )
        return int(float(seconds) * 1000)

    # ── 复习间隔 ────────────────────────────────────────
    @property
    def review_intervals_days(self) -> List[int]:
        return list(self.get("review_intervals_days"))

    # ── 每日计划 ────────────────────────────────────────
    def daily_plan(self) -> Dict[str, Any]:
        return dict(self.get("daily_plan"))

    # ── 学习意图 ────────────────────────────────────────
    def intent_config(self) -> Dict[str, Any]:
        return dict(self.get("intent"))

    # ── 历史窗口 ────────────────────────────────────────
    @property
    def recent_attempt_window(self) -> int:
        return int(self.get("history", "recent_attempt_window", default=20))

    # ── 通用错误规则（内容层未命中时的兜底诊断） ─────────
    def generic_error_rules(self) -> List[Dict[str, Any]]:
        return list(self.get("generic_error_rules", default=[]))


def load_config(version: int = 0) -> AlgorithmConfig:
    if version in _cache:
        return _cache[version]
    path = os.path.join(ALGORITHM_CONFIG_DIR, "v{}.yaml".format(version))
    if not os.path.exists(path):
        raise FileNotFoundError("找不到算法配置: {}".format(path))
    with open(path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    cfg = AlgorithmConfig(raw)
    _cache[version] = cfg
    return cfg


def clear_cache():
    """仅供测试使用。"""
    _cache.clear()
