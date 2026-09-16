"""ORM 模型：与 db/migrations/0001_init.sql 逐列对齐。

**重要约定**：表名 / 列名必须与 SQL 完全一致。`tests/test_db.py` 会解析
0001_init.sql 并逐表比对列集合，任何偏差都会让测试失败。这份 SQL 是部署事实，
改 schema 前先读 ADR，并且要同步改 SQL 与这里。

设计约束（ADR）：
  - ADR-0002：proficiency_state / pattern_state **没有** level 列。
    等级永远是 derive_level(signals, cfg) 的派生结果，读的时候现算。
  - ADR-0003：attempt 只存 response / active / idle；thinking 由计算得出，
    不落库（避免两个真相）。
  - ADR-0004：attempt 是学习系统唯一事实入口；reward_log / learning_event
    与 attempt 在同一事务写入。

幂等键说明：契约要求 `(child_id, client_attempt_id)` 唯一。SQL 里 attempt
已有 `uuid` 列（"这次提交的唯一标识"），直接把客户端 attempt id 写进该列即可，
不需要新增列 —— UNIQUE(uuid) 比组合唯一更严格，且语义完全吻合。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)

from backend.db.base import Base, BigInt

# NUMERIC(5,4)：0~1 的信号值。asdecimal=False → 两端都返回 float，
# 避免 SQLite 的 Decimal 警告与 PG/SQLite 的行为差异。
NUM_5_4 = Numeric(5, 4, asdecimal=False)
NUM_4_3 = Numeric(4, 3, asdecimal=False)
TS = DateTime(timezone=True)


def utcnow() -> datetime:
    return datetime.utcnow()


# ═══════════════════════════════════════════════════════════
# 学习域：能力图谱与内容
# ═══════════════════════════════════════════════════════════
class Competency(Base):
    __tablename__ = "competency"

    code = Column(Text, primary_key=True)
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=False, default="")
    stage = Column(Integer, nullable=False, default=1)
    active = Column(Boolean, nullable=False, default=True)


class CompetencyPrerequisite(Base):
    __tablename__ = "competency_prerequisite"

    competency_code = Column(
        Text, ForeignKey("competency.code", ondelete="CASCADE"), primary_key=True
    )
    prerequisite_code = Column(
        Text, ForeignKey("competency.code", ondelete="CASCADE"), primary_key=True
    )
    weight = Column(NUM_4_3, nullable=False, default=1.0)


class ProblemPattern(Base):
    __tablename__ = "problem_pattern"

    code = Column(Text, primary_key=True)
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=False, default="")
    cognitive_type = Column(Text, nullable=False)


class PatternCompetency(Base):
    __tablename__ = "pattern_competency"

    pattern_code = Column(
        Text, ForeignKey("problem_pattern.code", ondelete="CASCADE"), primary_key=True
    )
    competency_code = Column(
        Text, ForeignKey("competency.code", ondelete="CASCADE"), primary_key=True
    )
    is_primary = Column(Boolean, nullable=False, default=False)


class Misconception(Base):
    __tablename__ = "misconception"

    code = Column(Text, primary_key=True)
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=False, default="")
    severity = Column(SmallInteger, nullable=False, default=1)
    remediation_competency = Column(Text, ForeignKey("competency.code"))


class Item(Base):
    __tablename__ = "item"

    code = Column(Text, primary_key=True)
    competency_code = Column(Text, ForeignKey("competency.code"), nullable=False)
    pattern_code = Column(Text, ForeignKey("problem_pattern.code"), nullable=False)
    difficulty = Column(SmallInteger, nullable=False, default=1)
    scaffold_level = Column(Text, nullable=False)
    interaction_type = Column(Text, nullable=False)
    estimated_seconds = Column(Integer, nullable=False, default=15)
    problem_json = Column(JSON, nullable=False)
    answer_json = Column(JSON, nullable=False)
    steps_json = Column(JSON, nullable=False, default=list)
    hint_chain_json = Column(JSON, nullable=False, default=list)
    error_rules_json = Column(JSON, nullable=False, default=list)
    source_template = Column(Text)
    review_status = Column(Text, nullable=False, default="draft")
    content_release_id = Column(BigInt, ForeignKey("content_release.id"))


# ═══════════════════════════════════════════════════════════
# 内容版本 / 算法配置
# ═══════════════════════════════════════════════════════════
class ContentRelease(Base):
    __tablename__ = "content_release"

    id = Column(BigInt, primary_key=True, autoincrement=True)
    version = Column(Text, nullable=False, unique=True)
    checksum = Column(Text, nullable=False)
    imported_at = Column(TS, nullable=False, default=utcnow)
    stats_json = Column(JSON, nullable=False, default=dict)


class AlgorithmConfig(Base):
    __tablename__ = "algorithm_config"

    version = Column(Integer, primary_key=True)
    payload_json = Column(JSON, nullable=False)
    is_active = Column(Boolean, nullable=False, default=False)
    created_at = Column(TS, nullable=False, default=utcnow)


# ═══════════════════════════════════════════════════════════
# 账号（MVP 极简）
# ═══════════════════════════════════════════════════════════
class Child(Base):
    __tablename__ = "child"

    id = Column(BigInt, primary_key=True, autoincrement=True)
    name = Column(Text, nullable=False)
    birth_year = Column(Integer)
    created_at = Column(TS, nullable=False, default=utcnow)
    active = Column(Boolean, nullable=False, default=True)


# ═══════════════════════════════════════════════════════════
# 事件域：学习事实
# ═══════════════════════════════════════════════════════════
class LearningSession(Base):
    __tablename__ = "learning_session"

    id = Column(BigInt, primary_key=True, autoincrement=True)
    child_id = Column(BigInt, ForeignKey("child.id", ondelete="CASCADE"), nullable=False)
    started_at = Column(TS, nullable=False, default=utcnow)
    ended_at = Column(TS)
    duration_ms = Column(Integer)
    planned_minutes = Column(Integer)
    item_count = Column(Integer, nullable=False, default=0)
    story_count = Column(Integer, nullable=False, default=0)
    completion = Column(NUM_4_3)
    quit_reason = Column(Text)
    device = Column(Text)


class Attempt(Base):
    __tablename__ = "attempt"
    __table_args__ = (UniqueConstraint("child_id", "seq", name="attempt_child_seq_uniq"),)

    id = Column(BigInt, primary_key=True, autoincrement=True)
    # 幂等键：客户端生成的 client_attempt_id 写在这里（见模块 docstring）
    uuid = Column(String(36), nullable=False, unique=True)
    session_id = Column(
        BigInt, ForeignKey("learning_session.id", ondelete="SET NULL")
    )
    child_id = Column(BigInt, ForeignKey("child.id", ondelete="CASCADE"), nullable=False)
    item_code = Column(Text, ForeignKey("item.code"), nullable=False)
    competency_code = Column(Text, ForeignKey("competency.code"), nullable=False)
    pattern_code = Column(Text, ForeignKey("problem_pattern.code"), nullable=False)
    slot_code = Column(Text)
    # item 属性快照（见 0001_init.sql）：attempt 不随 item 内容漂移
    scaffold_level = Column(String(16), nullable=False, default="direct")
    interaction_type = Column(String(32), nullable=False, default="number_pad")
    seq = Column(BigInt, nullable=False)
    submitted_json = Column(JSON)
    correct = Column(Boolean, nullable=False)
    judgement_mismatch = Column(Boolean, nullable=False, default=False)
    response_time_ms = Column(Integer, nullable=False)
    active_time_ms = Column(Integer, nullable=False)
    idle_time_ms = Column(Integer, nullable=False, default=0)
    hints_used = Column(SmallInteger, nullable=False, default=0)
    hint_level_max = Column(SmallInteger, nullable=False, default=0)
    method_used = Column(Text)
    is_assessment = Column(Boolean, nullable=False, default=False)
    is_transfer_probe = Column(Boolean, nullable=False, default=False)
    misconception_codes_json = Column(JSON, nullable=False, default=list)
    created_at = Column(TS, nullable=False, default=utcnow)


class LearningEvent(Base):
    __tablename__ = "learning_event"

    id = Column(BigInt, primary_key=True, autoincrement=True)
    child_id = Column(BigInt, ForeignKey("child.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(BigInt, ForeignKey("learning_session.id", ondelete="SET NULL"))
    attempt_id = Column(BigInt, ForeignKey("attempt.id", ondelete="CASCADE"))
    event_type = Column(Text, nullable=False)
    payload_json = Column(JSON, nullable=False, default=dict)
    ts = Column(TS, nullable=False, default=utcnow)


class CoachMessage(Base):
    __tablename__ = "coach_message"

    id = Column(BigInt, primary_key=True, autoincrement=True)
    attempt_id = Column(BigInt, ForeignKey("attempt.id", ondelete="CASCADE"))
    role = Column(Text, nullable=False)
    source = Column(Text, nullable=False)
    hint_level = Column(SmallInteger)
    text = Column(Text, nullable=False)
    validator_result_json = Column(JSON, nullable=False, default=dict)
    fallback_used = Column(Boolean, nullable=False, default=False)
    latency_ms = Column(Integer)
    ts = Column(TS, nullable=False, default=utcnow)


# ═══════════════════════════════════════════════════════════
# 状态域：熟练度（ADR-0002 —— 没有 level 列）
# ═══════════════════════════════════════════════════════════
class ProficiencyState(Base):
    __tablename__ = "proficiency_state"

    child_id = Column(
        BigInt, ForeignKey("child.id", ondelete="CASCADE"), primary_key=True
    )
    competency_code = Column(
        Text, ForeignKey("competency.code"), primary_key=True
    )
    mastery = Column(NUM_5_4)
    accuracy = Column(NUM_5_4)
    fluency = Column(NUM_5_4)
    independence = Column(NUM_5_4)
    transfer = Column(NUM_5_4)
    confidence = Column(NUM_5_4)
    signal_sample_counts = Column(JSON, nullable=False, default=dict)
    sample_count = Column(Integer, nullable=False, default=0)
    assessment_samples = Column(Integer, nullable=False, default=0)
    probe_status = Column(Text, nullable=False, default="unknown")
    algorithm_version = Column(
        Integer, ForeignKey("algorithm_config.version"), nullable=False
    )
    updated_at = Column(TS, nullable=False, default=utcnow)


class PatternState(Base):
    __tablename__ = "pattern_state"

    child_id = Column(
        BigInt, ForeignKey("child.id", ondelete="CASCADE"), primary_key=True
    )
    competency_code = Column(
        Text, ForeignKey("competency.code"), primary_key=True
    )
    pattern_code = Column(
        Text, ForeignKey("problem_pattern.code"), primary_key=True
    )
    mastery = Column(NUM_5_4)
    accuracy = Column(NUM_5_4)
    fluency = Column(NUM_5_4)
    independence = Column(NUM_5_4)
    transfer = Column(NUM_5_4)
    confidence = Column(NUM_5_4)
    signal_sample_counts = Column(JSON, nullable=False, default=dict)
    sample_count = Column(Integer, nullable=False, default=0)
    algorithm_version = Column(
        Integer, ForeignKey("algorithm_config.version"), nullable=False
    )
    updated_at = Column(TS, nullable=False, default=utcnow)


class MisconceptionState(Base):
    __tablename__ = "misconception_state"

    child_id = Column(
        BigInt, ForeignKey("child.id", ondelete="CASCADE"), primary_key=True
    )
    misconception_code = Column(
        Text, ForeignKey("misconception.code"), primary_key=True
    )
    hit_count = Column(Integer, nullable=False, default=0)
    last_attempt_seq = Column(BigInt)
    last_seen_at = Column(TS)
    resolved = Column(Boolean, nullable=False, default=False)
    remediation_competency = Column(Text, ForeignKey("competency.code"))


class ReviewSchedule(Base):
    __tablename__ = "review_schedule"

    child_id = Column(
        BigInt, ForeignKey("child.id", ondelete="CASCADE"), primary_key=True
    )
    target_type = Column(Text, primary_key=True)
    target_code = Column(Text, primary_key=True)
    stage_index = Column(SmallInteger, nullable=False, default=0)
    interval_days = Column(Integer, nullable=False)
    due_at = Column(TS, nullable=False)
    ease = Column(NUM_4_3, nullable=False, default=1.0)


# ═══════════════════════════════════════════════════════════
# 故事域（ADR-0001：故事 → challenge_slot → item）
# ═══════════════════════════════════════════════════════════
class Universe(Base):
    __tablename__ = "universe"

    code = Column(Text, primary_key=True)
    name = Column(Text, nullable=False)
    theme = Column(Text, nullable=False, default="")
    unlock_rule_json = Column(JSON, nullable=False, default=dict)
    order_index = Column(Integer, nullable=False, default=0)


class Story(Base):
    __tablename__ = "story"

    code = Column(Text, primary_key=True)
    universe_code = Column(Text, ForeignKey("universe.code"), nullable=False)
    title = Column(Text, nullable=False)
    summary = Column(Text, nullable=False, default="")
    duration_min = Column(SmallInteger)
    target_competencies_json = Column(JSON, nullable=False, default=list)
    order_index = Column(Integer, nullable=False, default=0)


class StoryBeat(Base):
    __tablename__ = "story_beat"
    __table_args__ = (
        UniqueConstraint("story_code", "sequence", name="story_beat_seq_uniq"),
    )

    code = Column(Text, primary_key=True)
    story_code = Column(
        Text, ForeignKey("story.code", ondelete="CASCADE"), nullable=False
    )
    sequence = Column(SmallInteger, nullable=False)
    beat_type = Column(Text, nullable=False)
    narration = Column(Text)
    character = Column(Text)
    visual_json = Column(JSON, nullable=False, default=dict)
    reward_json = Column(JSON, nullable=False, default=dict)


class ChallengeSlot(Base):
    __tablename__ = "challenge_slot"

    code = Column(Text, primary_key=True)
    story_beat_code = Column(
        Text, ForeignKey("story_beat.code", ondelete="CASCADE")
    )
    competency_code = Column(Text, ForeignKey("competency.code"), nullable=False)
    pattern_code = Column(Text, ForeignKey("problem_pattern.code"))
    difficulty_min = Column(SmallInteger, nullable=False, default=1)
    difficulty_max = Column(SmallInteger, nullable=False, default=5)
    scaffold_level = Column(Text, nullable=False, default="auto")
    purpose = Column(Text, nullable=False, default="practice")
    estimated_seconds = Column(Integer, nullable=False, default=20)
    selection_policy_json = Column(JSON, nullable=False, default=dict)
    review_policy_json = Column(JSON, nullable=False, default=dict)


# ═══════════════════════════════════════════════════════════
# 游戏域（P5 接入；游戏状态永远不是学习状态的权威）
# ═══════════════════════════════════════════════════════════
class Inventory(Base):
    __tablename__ = "inventory"

    child_id = Column(
        BigInt, ForeignKey("child.id", ondelete="CASCADE"), primary_key=True
    )
    item_code = Column(Text, primary_key=True)
    count = Column(Integer, nullable=False, default=0)


class Unlock(Base):
    __tablename__ = "unlock"

    child_id = Column(
        BigInt, ForeignKey("child.id", ondelete="CASCADE"), primary_key=True
    )
    unlock_code = Column(Text, primary_key=True)
    unlocked_at = Column(TS, nullable=False, default=utcnow)


class RewardLog(Base):
    __tablename__ = "reward_log"

    id = Column(BigInt, primary_key=True, autoincrement=True)
    child_id = Column(BigInt, ForeignKey("child.id", ondelete="CASCADE"), nullable=False)
    attempt_id = Column(BigInt, ForeignKey("attempt.id", ondelete="SET NULL"))
    reward_json = Column(JSON, nullable=False)
    ts = Column(TS, nullable=False, default=utcnow)


__all__ = [
    "Competency",
    "CompetencyPrerequisite",
    "ProblemPattern",
    "PatternCompetency",
    "Misconception",
    "Item",
    "ContentRelease",
    "AlgorithmConfig",
    "Child",
    "LearningSession",
    "Attempt",
    "LearningEvent",
    "CoachMessage",
    "ProficiencyState",
    "PatternState",
    "MisconceptionState",
    "ReviewSchedule",
    "Universe",
    "Story",
    "StoryBeat",
    "ChallengeSlot",
    "Inventory",
    "Unlock",
    "RewardLog",
    "utcnow",
]
