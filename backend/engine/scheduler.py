"""间隔复习调度（P3）。

复习的粒度是 **pattern_key**（"{competency}::{pattern}"，见 types.pattern_key），
不是"某一道题"：孩子需要重新激活的是一种**问题结构**，不是某个具体数字。

间隔序列来自 config/algorithm/v0.yaml 的 `review_intervals_days`（[1, 3, 7, 14, 30]）：

  - 第 n 次连续答对 → 进入第 n+1 档间隔（第 1 次答对 → 1 天后见，第 2 次 → 3 天后见…）
  - 答错 → 退回第 1 档（明天再来）

"错一次就退回起点"是刻意设计的：目标人群是基础偏弱的孩子，遗忘曲线更陡，
宁可多复习一次，也不要让孩子在已经松动的结构上"以为会了"。

**只有"会了"的东西才值得复习**：能力 mastery 低于 `review.min_mastery` 的 pattern
不进复习队列 —— 还没学会的东西属于教学，不属于复习。

调度状态是可直接 JSON 序列化的普通 dict（要落进 review_schedule 表）：

    {pattern_key: {"interval_index": int, "consecutive_correct": int,
                   "last_correct_day": Optional[int], "due_day": int}}

所有阈值来自 AlgorithmConfig（ADR-0002），本模块不出现阈值字面量。
本模块是纯函数：不读数据库、不写日志、不依赖当前时间（"今天是第几天"由调用方给）。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from backend.engine.config import AlgorithmConfig
from backend.engine.types import Attempt, ChildLearningState, pattern_key, split_pattern_key


@dataclass
class ReviewItem:
    """一条到期复习项 —— 描述"哪个问题结构该复习了"，不描述"该做哪一道题"。"""

    pattern_key: str
    competency_id: str
    pattern_id: str
    due_day: int
    interval_index: int
    last_correct_day: Optional[int]
    consecutive_correct: int
    overdue_days: int


# ── 调度状态 ───────────────────────────────────────────────
def new_schedule() -> Dict[str, Dict[str, Any]]:
    """空调度表。"""
    return {}


def _copy_schedule(schedule: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {key: dict(entry) for key, entry in schedule.items()}


def _interval_days(interval_index: int, cfg: AlgorithmConfig) -> int:
    """第 interval_index 档的间隔天数；超出序列长度则封顶在最后一档。"""
    intervals = cfg.review_intervals_days
    index = max(0, min(int(interval_index), len(intervals) - 1))
    return int(intervals[index])


def update_schedule(
    schedule: Dict[str, Dict[str, Any]],
    attempt: Attempt,
    day: int,
    cfg: AlgorithmConfig,
) -> Dict[str, Dict[str, Any]]:
    """一次作答后推进调度（纯函数：返回新 dict，不修改入参）。

    只按 pattern_key 记账，与"具体做了哪道题"无关 —— 同一结构的另一道题
    同样是这个结构的证据。

    约定：
      - 答对：连续答对 +1，进入下一档间隔（封顶在最后一档）
      - 答错：连续答对清零、退回第 1 档，明天再来
      - `last_correct_day` 只在答对时更新（答错时保留"上次做对是哪天"，
        对"到底忘了多久"这类诊断有用）
    """
    intervals = cfg.review_intervals_days
    if not intervals:
        return _copy_schedule(schedule)

    updated = _copy_schedule(schedule)
    key = pattern_key(attempt.competency_id, attempt.pattern_id)
    entry = updated.get(key)
    if entry is None:
        entry = {
            "interval_index": 0,
            "consecutive_correct": 0,
            "last_correct_day": None,
            "due_day": day,
        }

    if attempt.correct:
        entry["consecutive_correct"] = int(entry.get("consecutive_correct", 0)) + 1
        # 连续答对 n 次 → 第 n+1 档；跑完全部档位后封顶在最后一档
        entry["interval_index"] = min(
            int(entry["consecutive_correct"]) - 1, len(intervals) - 1
        )
        entry["last_correct_day"] = day
    else:
        entry["consecutive_correct"] = 0
        entry["interval_index"] = 0

    entry["due_day"] = int(day) + _interval_days(entry["interval_index"], cfg)
    updated[key] = entry
    return updated


# ── 到期查询 ───────────────────────────────────────────────
def _is_reviewable(
    competency_id: str, state: ChildLearningState, cfg: AlgorithmConfig
) -> bool:
    """只有"会了"的东西才值得复习。"""
    signals = state.competencies.get(competency_id)
    if signals is None or signals.mastery is None:
        return False
    return signals.mastery >= float(cfg.get("review", "min_mastery"))


def pending_reviews(
    schedule: Dict[str, Dict[str, Any]],
    day: int,
    state: ChildLearningState,
    cfg: AlgorithmConfig,
) -> List[ReviewItem]:
    """当天全部到期复习项（**未**做每日上限截断），按"最该复习"排序。

    排序键：逾期天数降序（逾期越久越该复习），同逾期按 pattern_key 稳定排序
    —— 排序必须确定，否则同一天两次调用会给出不同的计划。
    """
    items: List[ReviewItem] = []
    for key, entry in schedule.items():
        due_day = int(entry.get("due_day", day))
        if due_day > day:
            continue
        competency_id, pattern_id = split_pattern_key(key)
        if not _is_reviewable(competency_id, state, cfg):
            continue
        items.append(
            ReviewItem(
                pattern_key=key,
                competency_id=competency_id,
                pattern_id=pattern_id,
                due_day=due_day,
                interval_index=int(entry.get("interval_index", 0)),
                last_correct_day=entry.get("last_correct_day"),
                consecutive_correct=int(entry.get("consecutive_correct", 0)),
                overdue_days=int(day) - due_day,
            )
        )
    items.sort(key=lambda row: (-row.overdue_days, row.pattern_key))
    return items


def release_pressure(
    items: List[ReviewItem], cfg: AlgorithmConfig
) -> List[ReviewItem]:
    """复习洪峰控制：只保留"最该复习"的前 N 项（N = review.max_per_day）。

    这里不"删除"任何东西 —— 被压下去的项仍留在 schedule 里，due_day 不变，
    次日以更大的逾期天数重新参与排序（自然顺延），不会丢。
    """
    max_per_day = int(cfg.get("review", "max_per_day"))
    if max_per_day <= 0:
        return []
    return list(items[:max_per_day])


def due_reviews(
    schedule: Dict[str, Dict[str, Any]],
    day: int,
    state: ChildLearningState,
    cfg: AlgorithmConfig,
) -> List[ReviewItem]:
    """今天该复习哪些（已做每日上限截断，按逾期天数降序）。

    这是 Planner 的输入：复习必须能挤进当天计划，而不是"明天再说"。
    """
    return release_pressure(pending_reviews(schedule, day, state, cfg), cfg)


def next_review_day(
    schedule: Dict[str, Dict[str, Any]], pattern_key_value: str, cfg: AlgorithmConfig
) -> Optional[int]:
    """某个问题结构的下一档复习日期；不在调度表里则返回 None。"""
    _ = cfg  # 签名与其余接口保持一致：后续若支持按配置换算档位，不必改调用方
    entry = schedule.get(pattern_key_value)
    if entry is None:
        return None
    return int(entry.get("due_day", 0))


__all__ = [
    "ReviewItem",
    "new_schedule",
    "update_schedule",
    "pending_reviews",
    "release_pressure",
    "due_reviews",
    "next_review_day",
]
