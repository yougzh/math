"""引擎领域类型。

这些是纯数据对象，不依赖数据库、不依赖框架。
Replay 的确定性要求它们保持可比较、可序列化。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# 五个原始信号 + confidence（长期趋势）。等级由它们派生（ADR-0002）。
SIGNAL_NAMES = ("mastery", "accuracy", "fluency", "independence", "transfer", "confidence")

PROBE_STATUS_UNKNOWN = "unknown"
PROBE_STATUS_PROBING = "probing"
PROBE_STATUS_ESTIMATED = "estimated"
PROBE_STATUS_STABLE = "stable"


def pattern_key(competency_id: str, pattern_id: str) -> str:
    """pattern 状态的键必须带上能力。

    `decompose` 用在 make_ten 上和用在 td_add_nocarry 上不是同一个技能；
    而"迁移"的定义恰恰是"同一能力、不同 pattern"。
    因此 pattern_state 的唯一键是 (child, competency, pattern)，不是 pattern 单独。
    """
    return "{}::{}".format(competency_id, pattern_id)


def split_pattern_key(key: str):
    competency_id, _, pattern_id = key.partition("::")
    return competency_id, pattern_id


# ── 时间语义（ADR-0003，冻结） ─────────────────────────────
@dataclass
class Telemetry:
    """一次作答的时间分解。

    response  = 题目出现 → 提交答案
    active    = 实际鼠标 / 触摸 / 键盘操作时间
    idle      = 被判定为"疑似离开"的分段之和（> uncertain_max_ms 的停顿）
    thinking  = response - active - idle

    思考时间不是无效时间：短暂停顿属于 thinking，不剔除。
    """

    response_time_ms: int
    active_time_ms: int
    idle_time_ms: int = 0

    @property
    def thinking_time_ms(self) -> int:
        return max(0, self.response_time_ms - self.active_time_ms - self.idle_time_ms)

    def idle_ratio(self) -> float:
        if self.response_time_ms <= 0:
            return 0.0
        return self.idle_time_ms / float(self.response_time_ms)

    def is_idle_dominated(self, ratio_threshold: float) -> bool:
        return self.idle_ratio() > ratio_threshold

    def to_dict(self) -> Dict[str, int]:
        return {
            "response_time_ms": self.response_time_ms,
            "active_time_ms": self.active_time_ms,
            "idle_time_ms": self.idle_time_ms,
            "thinking_time_ms": self.thinking_time_ms,
        }


# ── 事实入口 ───────────────────────────────────────────────
@dataclass
class Attempt:
    """学习系统唯一事实入口（ADR-0004）。

    `is_assessment`：冷启动 probe（D5），权重打折且不参与升级判定。
    `is_transfer_probe`：由 Planner 标记的迁移测试，用于给 transfer 信号采样。
    """

    attempt_id: str
    child_id: str
    item_id: str
    competency_id: str
    pattern_id: str
    correct: bool
    telemetry: Telemetry
    seq: int = 0
    hints_used: int = 0
    hint_level_max: int = 0
    method_used: Optional[str] = None
    scaffold_level: str = "direct"
    interaction_type: str = "number_pad"
    is_assessment: bool = False
    is_transfer_probe: bool = False
    misconception_codes: List[str] = field(default_factory=list)
    submitted_answer: Optional[Any] = None
    created_at: Optional[str] = None

    def is_clean_correct(self) -> bool:
        return self.correct and self.hints_used == 0


# ── 熟练度状态 ─────────────────────────────────────────────
@dataclass
class Signals:
    """一个（孩子 × 能力）或（孩子 × pattern）的信号集合。

    未采样过的信号保持 None —— 这是"不知道该信号"的显式表达，
    等级派生时该条件直接跳过，避免"没测过"被误当成"不达标"。
    """

    mastery: Optional[float] = None
    accuracy: Optional[float] = None
    fluency: Optional[float] = None
    independence: Optional[float] = None
    transfer: Optional[float] = None
    confidence: Optional[float] = None
    sample_count: int = 0
    assessment_samples: int = 0
    signal_sample_counts: Dict[str, int] = field(default_factory=dict)
    probe_status: str = PROBE_STATUS_UNKNOWN
    algorithm_version: int = 0

    @property
    def practice_samples(self) -> int:
        """正式练习样本数（不含冷启动 probe）。

        升级判定只看 practice_samples —— 探测题可以估计初始状态，
        但不能直接产生"连续答对所以升级"。
        """
        return max(0, self.sample_count - self.assessment_samples)

    def value(self, name: str) -> Optional[float]:
        return getattr(self, name)

    def is_sampled(self, name: str) -> bool:
        return getattr(self, name) is not None

    def sample_count_for(self, name: str) -> int:
        return self.signal_sample_counts.get(name, 0)

    def copy(self) -> "Signals":
        return Signals(
            mastery=self.mastery,
            accuracy=self.accuracy,
            fluency=self.fluency,
            independence=self.independence,
            transfer=self.transfer,
            confidence=self.confidence,
            sample_count=self.sample_count,
            assessment_samples=self.assessment_samples,
            signal_sample_counts=dict(self.signal_sample_counts),
            probe_status=self.probe_status,
            algorithm_version=self.algorithm_version,
        )

    def to_dict(self) -> Dict[str, Any]:
        out = {name: getattr(self, name) for name in SIGNAL_NAMES}
        out.update(
            {
                "sample_count": self.sample_count,
                "assessment_samples": self.assessment_samples,
                "practice_samples": self.practice_samples,
                "signal_sample_counts": dict(self.signal_sample_counts),
                "probe_status": self.probe_status,
                "algorithm_version": self.algorithm_version,
            }
        )
        return out


@dataclass
class MisconceptionState:
    code: str
    hit_count: int = 0
    last_seq: Optional[int] = None
    resolved: bool = False
    remediation_competency: Optional[str] = None

    def copy(self) -> "MisconceptionState":
        return MisconceptionState(
            code=self.code,
            hit_count=self.hit_count,
            last_seq=self.last_seq,
            resolved=self.resolved,
            remediation_competency=self.remediation_competency,
        )


@dataclass
class ChildLearningState:
    """孩子的完整学习状态。

    游戏状态不在这里 —— 游戏状态与学习状态分离，两者通过 attempt 连接。
    """

    child_id: str
    competencies: Dict[str, Signals] = field(default_factory=dict)
    patterns: Dict[str, Signals] = field(default_factory=dict)
    misconceptions: Dict[str, MisconceptionState] = field(default_factory=dict)
    attempts_seen: int = 0
    assessment_attempts: int = 0
    recent_attempts: List[Attempt] = field(default_factory=list)
    first_scaffold: Dict[str, str] = field(default_factory=dict)
    last_touched_seq: Dict[str, int] = field(default_factory=dict)

    def competency(self, code: str) -> Signals:
        if code not in self.competencies:
            self.competencies[code] = Signals()
        return self.competencies[code]

    def pattern(self, competency_id: str, pattern_id: str) -> Signals:
        key = pattern_key(competency_id, pattern_id)
        if key not in self.patterns:
            self.patterns[key] = Signals()
        return self.patterns[key]

    def pattern_signals(self, competency_id: str, pattern_id: str) -> Optional[Signals]:
        return self.patterns.get(pattern_key(competency_id, pattern_id))

    def copy(self) -> "ChildLearningState":
        return ChildLearningState(
            child_id=self.child_id,
            competencies={k: v.copy() for k, v in self.competencies.items()},
            patterns={k: v.copy() for k, v in self.patterns.items()},
            misconceptions={k: v.copy() for k, v in self.misconceptions.items()},
            attempts_seen=self.attempts_seen,
            assessment_attempts=self.assessment_attempts,
            recent_attempts=list(self.recent_attempts),
            first_scaffold=dict(self.first_scaffold),
            last_touched_seq=dict(self.last_touched_seq),
        )


# ── 决策对象 ───────────────────────────────────────────────
@dataclass
class LearningIntent:
    """学习意图 —— Planner 的输入单位，不是题目。"""

    kind: str  # repair | teach | strengthen_fluency | probe_transfer | warmup
    competency_id: str
    reason: str
    pattern_id: Optional[str] = None
    scaffold_level: Optional[str] = None
    target_seconds: int = 60
    priority: int = 0


@dataclass
class Decision:
    """升级 / 回退判定的结果，附带可解释的 reasons。"""

    action: str  # hold | upgrade | fallback
    competency_id: str
    target_competency_id: Optional[str] = None
    reasons: List[str] = field(default_factory=list)

    @property
    def decided(self) -> bool:
        return self.action != "hold"


@dataclass
class QualityBreakdown:
    """单次作答的"证据质量"。

    设计说明（与产品方案 §50 的一处有意偏离）：
      方案原式是 quality = accuracy × independence × time_factor × transfer_factor。
      实现时**去掉了 transfer_factor**，理由是：transfer 尚未被证明时该因子小于 1，
      会系统性地拖慢"最需要进步的那些孩子"的成长速度 —— 形成负反馈。
      transfer 因此作为独立信号单独采样（只在 transfer probe 上更新），
      不作为乘数惩罚常规练习。

    time_factor 使用 thinking_time（ADR-0003），不是 response_time。
    """

    quality: float
    accuracy: float
    independence: float
    time_factor: float

    def to_dict(self) -> Dict[str, float]:
        return {
            "quality": round(self.quality, 4),
            "accuracy": round(self.accuracy, 4),
            "independence": round(self.independence, 4),
            "time_factor": round(self.time_factor, 4),
        }
