"""熟练度纯函数。

约束：
  - 本模块是纯函数，不读数据库、不写日志、不依赖时间
  - 所有阈值来自 AlgorithmConfig（ADR-0002）
  - 时间使用 thinking_time（ADR-0003）
"""
from __future__ import annotations

from typing import Optional, Tuple

from backend.engine.config import AlgorithmConfig
from backend.engine.types import (
    Attempt,
    QualityBreakdown,
    Signals,
    SIGNAL_NAMES,
)


def time_factor(attempt: Attempt, cfg: AlgorithmConfig) -> float:
    """把 thinking_time 映射成 0~1 的流畅度因子。

    fluency 阈值按 (pattern, interaction_type) 区分 —— direct 题是秒级，
    blocks 类操作题可以到几十秒，不能用一个标准套所有题型。
    """
    threshold_ms = cfg.fluency_threshold_ms(attempt.pattern_id, attempt.interaction_type)
    thinking = attempt.telemetry.thinking_time_ms
    if threshold_ms <= 0:
        return 1.0
    return cfg.fluency_score_for_ratio(thinking / float(threshold_ms))


def attempt_quality(attempt: Attempt, cfg: AlgorithmConfig) -> QualityBreakdown:
    accuracy = 1.0 if attempt.correct else 0.0
    independence = cfg.independence_sample(attempt.hints_used)
    factor = time_factor(attempt, cfg)
    return QualityBreakdown(
        quality=accuracy * independence * factor,
        accuracy=accuracy,
        independence=independence,
        time_factor=factor,
    )


def samples_for_attempt(attempt: Attempt, cfg: AlgorithmConfig) -> dict:
    """由一次作答生成各信号的单次采样值。

    返回 None 表示"该信号本次不采样"，而不是"采样为 0"。
    这个区分很重要：没测过 ≠ 做得差。
    """
    samples = {}

    # mastery：靠提示做对不算真正理解
    samples["mastery"] = cfg.mastery_sample(attempt.correct, attempt.hints_used)

    # accuracy：只看对错
    samples["accuracy"] = 1.0 if attempt.correct else 0.0

    # independence：只看提示使用量，与对错无关
    samples["independence"] = cfg.independence_sample(attempt.hints_used)

    # fluency：只有做对了才谈得上"流畅"；做错时的速度不是流畅度
    samples["fluency"] = time_factor(attempt, cfg) if attempt.correct else None

    # transfer：只在 Planner 标记的迁移测试上采样
    samples["transfer"] = (1.0 if attempt.correct else 0.0) if attempt.is_transfer_probe else None

    # confidence：长期信心趋势（答错但仍在尝试本身是正向信号）
    samples["confidence"] = cfg.confidence_sample(attempt.correct)

    return samples


def _ewma(current: Optional[float], sample: float, alpha: float) -> float:
    """首条证据直接作为初值，之后走 EWMA。

    若首条证据也按 current=0 平滑，孩子的第一个正确答案只能得 0.25，
    会让冷启动阶段的状态严重低估。
    """
    if current is None:
        return sample
    return current + alpha * (sample - current)


def update_signals(
    signals: Signals,
    attempt: Attempt,
    cfg: AlgorithmConfig,
) -> Signals:
    """返回更新后的 Signals（不修改入参，保证 replay 可重现）。"""
    updated = signals.copy()
    updated.algorithm_version = cfg.version

    alpha = cfg.alpha_for(attempt.is_assessment)
    samples = samples_for_attempt(attempt, cfg)

    for name in SIGNAL_NAMES:
        sample = samples.get(name)
        if sample is None:
            continue
        if name == "confidence":
            # confidence 是长期趋势，用更慢的系数
            current = updated.confidence
            updated.confidence = (
                sample if current is None else current + cfg.confidence_alpha * (sample - current)
            )
        else:
            setattr(updated, name, _ewma(getattr(updated, name), sample, alpha))
        updated.signal_sample_counts[name] = updated.sample_count_for(name) + 1

    updated.sample_count += 1
    if attempt.is_assessment:
        updated.assessment_samples += 1

    # 冷启动 probe 状态推进（D5）
    if attempt.is_assessment:
        probe_items = int(cfg.get("assessment", "probe_items"))
        if updated.sample_count >= probe_items:
            updated.probe_status = "estimated"
        else:
            updated.probe_status = "probing"
    elif updated.probe_status in ("unknown", "probing"):
        updated.probe_status = "estimated" if updated.sample_count >= cfg.min_samples_for_level else updated.probe_status
    if updated.sample_count >= cfg.min_samples_for_level and updated.probe_status != "stable":
        updated.probe_status = "stable"

    return updated


def signal_summary(signals: Signals) -> str:
    parts = []
    for name in SIGNAL_NAMES:
        value = signals.value(name)
        parts.append("{}={}".format(name, "—" if value is None else "{:.2f}".format(value)))
    return " ".join(parts)
