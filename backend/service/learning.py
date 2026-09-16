"""学习状态与作答提交。

两条硬性规则：

1. **在线更新与 Replay 共用同一段代码**（ADR-0002 / replay 可信的前提）。
   做法：把 DB 里的历史 attempt 读出来 → 构造成引擎的 `Attempt` → 调
   `engine.learner.apply_attempt` → 把结果写回状态表。本模块**不重新实现**
   任何信号计算。

   为什么是"全量重放"而不是"读状态增量更新"：`ChildLearningState` 里有
   `first_scaffold` / `last_touched_seq` / `recent_attempts` 这些窗口字段，
   增量更新需要在库里另存它们（SQL 里没有）。全量重放让在线路径与
   `engine.replay.replay()` 逐字段等价，代价是每次提交 O(历史条数) ——
   儿童学习场景每天几十条，可接受；数据量变大后再做增量，但那时增量与
   replay 的一致性必须单独证明。

2. **attempt 是唯一事实入口**（ADR-0004）。attempt 行 + learning_event +
   reward_log + 四张状态表 + 会话计数，全部在同一个事务里提交。

幂等：`client_attempt_id` 写进 `attempt.uuid`（UNIQUE）。重复提交直接返回
首次结果，不再推进状态。
"""
from __future__ import annotations

import uuid as uuid_module
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import func

from backend.content.loader import ContentBundle, Item
from backend.db import models
from backend.engine.config import AlgorithmConfig
from backend.engine.diagnosis import diagnose
from backend.engine.learner import apply_attempts, new_state
from backend.engine.scheduler import new_schedule, update_schedule
from backend.engine.selector import select_item
from backend.engine.state_machine import derive_level
from backend.engine.types import (
    Attempt,
    ChildLearningState,
    Signals,
    Telemetry,
    split_pattern_key,
)
from backend.service import errors
from backend.service.content import item_payload

# 每次有效提交的基础奖励（占位规则，P5 成长体系接管）。
# 契约 §4 示例：答错也有参与奖励。
REWARD_WOOD = 1
REWARD_COINS = 1


@dataclass
class AttemptSubmission:
    """POST /v1/attempts 的领域输入。"""

    client_attempt_id: str
    child_id: int
    item_code: str
    answer: Any
    telemetry: Telemetry
    session_id: Optional[int] = None
    slot_code: Optional[str] = None
    client_correct: Optional[bool] = None
    hints_used: int = 0
    hint_level_max: int = 0
    method_used: Optional[str] = None
    is_transfer_probe: bool = False
    is_assessment: bool = False


# ── DB → 引擎对象 ──────────────────────────────────────────
def _as_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def judge_answer(item: Item, answer: Any) -> bool:
    """服务端独立判定 —— 判定永远以后端为准（ADR-0004 双轨判定）。"""
    expected = item.answer
    if isinstance(expected, int) and not isinstance(expected, bool):
        got = _as_int(answer)
        return got is not None and got == expected
    if expected is None:
        return False
    return str(answer).strip() == str(expected).strip()


def _submitted_blob(row: models.Attempt) -> Dict[str, Any]:
    return dict(row.submitted_json or {})


def attempt_from_row(row: models.Attempt, bundle: ContentBundle) -> Attempt:
    """把 DB 行还原成引擎的 Attempt。

    `scaffold_level` / `interaction_type` 是 fluency 阈值与"今日发现"的输入，
    attempt 表已有这两列（0001 修订）：提交时随行写入，replay **优先读列**。

    读取顺序：列 → submitted_json 快照 → item 表 → 缺省值。为什么要兜底：
    attempt 是历史事实（ADR-0004），**必须不随 item 内容漂移** —— item 后来
    被修改或下架时，历史 replay 仍要按"作答那一刻"的脚手架与交互类型计算。
    列是权威；快照只服务于补列之前的旧行；item 表是最后手段（会漂移）。
    """
    blob = _submitted_blob(row)
    item = bundle.items.get(row.item_code)
    scaffold = (
        row.scaffold_level
        or blob.get("scaffold_level")
        or (item.scaffold_level if item else None)
        or "direct"
    )
    interaction = (
        row.interaction_type
        or blob.get("interaction_type")
        or (item.interaction_type if item else None)
        or "number_pad"
    )
    return Attempt(
        attempt_id=str(row.id),
        child_id=str(row.child_id),
        item_id=row.item_code,
        competency_id=row.competency_code,
        pattern_id=row.pattern_code,
        correct=bool(row.correct),
        telemetry=Telemetry(
            response_time_ms=row.response_time_ms,
            active_time_ms=row.active_time_ms,
            idle_time_ms=row.idle_time_ms,
        ),
        seq=row.seq,
        hints_used=row.hints_used,
        hint_level_max=row.hint_level_max,
        method_used=row.method_used,
        scaffold_level=scaffold,
        interaction_type=interaction,
        is_assessment=bool(row.is_assessment),
        is_transfer_probe=bool(row.is_transfer_probe),
        misconception_codes=list(row.misconception_codes_json or []),
        submitted_answer=blob.get("answer"),
        created_at=row.created_at.isoformat() if row.created_at else None,
    )


def load_attempts(session, child_id: int) -> List[models.Attempt]:
    return (
        session.query(models.Attempt)
        .filter(models.Attempt.child_id == child_id)
        .order_by(models.Attempt.seq)
        .all()
    )


def load_state(
    session,
    child_id: int,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    upto_seq: Optional[int] = None,
) -> ChildLearningState:
    """从持久化的历史 attempt 完整重建学习状态（= Replay）。

    `upto_seq` 用于重建"某次作答那一刻"的状态（重复提交要返回首次结果）。
    """
    rows = load_attempts(session, child_id)
    if upto_seq is not None:
        rows = [row for row in rows if row.seq <= upto_seq]
    attempts = [attempt_from_row(row, bundle) for row in rows]
    return apply_attempts(new_state(str(child_id)), attempts, bundle, cfg)


# ── 状态写回 ───────────────────────────────────────────────
def _quantize(value: Optional[float]) -> Optional[float]:
    """NUMERIC(5,4)：写库前统一到 4 位小数，避免 PG / SQLite 精度表现不一致。"""
    if value is None:
        return None
    return round(float(value), 4)


def persist_state(
    session,
    child_id: int,
    state: ChildLearningState,
    cfg: AlgorithmConfig,
    now: datetime,
) -> None:
    """把重放得到的状态写回四张状态表（proficiency / pattern / misconception / review）。

    注意：**不写 level**（ADR-0002）。等级每次读的时候由 derive_level 现算。
    """
    existing_prof = {
        row.competency_code: row
        for row in session.query(models.ProficiencyState)
        .filter(models.ProficiencyState.child_id == child_id)
        .all()
    }
    for code, signals in state.competencies.items():
        row = existing_prof.get(code) or models.ProficiencyState(
            child_id=child_id, competency_code=code
        )
        _apply_signals(row, signals, cfg, now)
        session.add(row)

    existing_patterns = {
        (row.competency_code, row.pattern_code): row
        for row in session.query(models.PatternState)
        .filter(models.PatternState.child_id == child_id)
        .all()
    }
    for key, signals in state.patterns.items():
        competency_code, pattern_code = split_pattern_key(key)
        row = existing_patterns.get((competency_code, pattern_code)) or models.PatternState(
            child_id=child_id,
            competency_code=competency_code,
            pattern_code=pattern_code,
        )
        _apply_signals(row, signals, cfg, now)
        session.add(row)

    existing_misc = {
        row.misconception_code: row
        for row in session.query(models.MisconceptionState)
        .filter(models.MisconceptionState.child_id == child_id)
        .all()
    }
    for code, misc in state.misconceptions.items():
        row = existing_misc.get(code) or models.MisconceptionState(
            child_id=child_id, misconception_code=code
        )
        row.hit_count = misc.hit_count
        row.last_attempt_seq = misc.last_seq
        row.resolved = misc.resolved
        if misc.remediation_competency is not None:
            row.remediation_competency = misc.remediation_competency
        session.add(row)
    # 本轮命中的误区才刷新 last_seen_at
    for code, misc in state.misconceptions.items():
        row = existing_misc.get(code)
        if row is not None and row.last_attempt_seq == misc.last_seq:
            row.last_seen_at = now


def _apply_signals(row, signals: Signals, cfg: AlgorithmConfig, now: datetime) -> None:
    row.mastery = _quantize(signals.mastery)
    row.accuracy = _quantize(signals.accuracy)
    row.fluency = _quantize(signals.fluency)
    row.independence = _quantize(signals.independence)
    row.transfer = _quantize(signals.transfer)
    row.confidence = _quantize(signals.confidence)
    row.signal_sample_counts = dict(signals.signal_sample_counts)
    row.sample_count = signals.sample_count
    if hasattr(row, "assessment_samples"):
        row.assessment_samples = signals.assessment_samples
        row.probe_status = signals.probe_status
    row.algorithm_version = cfg.version
    row.updated_at = now


def update_review_schedule(
    session,
    child_id: int,
    history: List[Attempt],
    cfg: AlgorithmConfig,
    now: datetime,
) -> None:
    """复习调度：调用引擎调度器 engine.scheduler.update_schedule（P3 起真实现）。

    调度器是纯函数，粒度是 pattern_key（"{competency}::{pattern}"），状态形状：

        {pattern_key: {"interval_index", "consecutive_correct",
                       "last_correct_day", "due_day"}}

    两处与现实的对齐方式：

    - **day（"今天是第几天"）**：DB 没有天序概念。这里用"该孩子第几个学习日"——
      学习日 := 该孩子有作答记录的 UTC 自然日，按时间先后编号（1 起），
      由 attempt 历史推导，与状态推进共用同一份 history。
      （MVP 简化：日界取 UTC 零点，不含时区偏移。）
    - **存储形状**：review_schedule 表没有 consecutive_correct / last_correct_day /
      due_day 列，增量读回会有损。与四张状态表同一哲学 —— **从 attempt 全量重放**：
      每次提交都对全部历史调 update_schedule，再把结果投影到表里对齐调度器的键：
      target_type='pattern'、target_code=pattern_key、stage_index=interval_index、
      interval_days=该档间隔天数。due_at 是日历近似（当前学习日日期 + 间隔天数），
      只供 ops 按时间查询；调度的权威是重放结果，孩子跳过几天时以学习日为准。

    probe（is_assessment）不推进复习调度：探测题可以估计状态，不应制造复习档位。
    事务边界不变：由 submit_attempt 在 attempt 提交的同一事务里调用。
    """
    intervals = list(cfg.review_intervals_days or [])
    if not intervals or not history:
        return

    # 学习日 := 有作答记录的 UTC 自然日，按时间先后编号（1 起）
    day_of_date: Dict[Any, int] = {}
    days: List[Optional[int]] = []
    for attempt in history:
        if attempt.created_at is None:
            days.append(None)
            continue
        date = datetime.fromisoformat(attempt.created_at).date()
        days.append(day_of_date.setdefault(date, len(day_of_date) + 1))

    schedule = new_schedule()
    for attempt, day in zip(history, days):
        if day is None or attempt.is_assessment:
            continue
        schedule = update_schedule(schedule, attempt, day, cfg)

    existing = {
        row.target_code: row
        for row in session.query(models.ReviewSchedule)
        .filter(
            models.ReviewSchedule.child_id == child_id,
            models.ReviewSchedule.target_type == "pattern",
        )
        .all()
    }
    for key in sorted(schedule):
        entry = schedule[key]
        stage = max(0, min(int(entry["interval_index"]), len(intervals) - 1))
        row = existing.get(key) or models.ReviewSchedule(
            child_id=child_id, target_type="pattern", target_code=key
        )
        row.stage_index = stage
        row.interval_days = int(intervals[stage])
        row.due_at = now + timedelta(days=int(intervals[stage]))
        session.add(row)


# ── 奖励（占位规则，P5 接管） ──────────────────────────────
def build_reward() -> Dict[str, Any]:
    return {
        "materials": [{"code": "wood", "count": REWARD_WOOD}],
        "coins": REWARD_COINS,
        "unlocks": [],
    }


def record_reward(session, child_id: int, attempt_id: int, reward: Dict[str, Any]) -> None:
    session.add(
        models.RewardLog(
            child_id=child_id, attempt_id=attempt_id, reward_json=reward
        )
    )
    for material in reward.get("materials", []):
        code = material.get("code")
        count = int(material.get("count", 0))
        if not code or count <= 0:
            continue
        row = (
            session.query(models.Inventory)
            .filter(
                models.Inventory.child_id == child_id,
                models.Inventory.item_code == code,
            )
            .one_or_none()
        )
        if row is None:
            row = models.Inventory(child_id=child_id, item_code=code, count=0)
        row.count = (row.count or 0) + count
        session.add(row)
    coins = int(reward.get("coins", 0))
    if coins > 0:
        row = (
            session.query(models.Inventory)
            .filter(
                models.Inventory.child_id == child_id,
                models.Inventory.item_code == "coin",
            )
            .one_or_none()
        )
        if row is None:
            row = models.Inventory(child_id=child_id, item_code="coin", count=0)
        row.count = (row.count or 0) + coins
        session.add(row)


def record_learning_event(
    session,
    child_id: int,
    session_id: Optional[int],
    attempt_id: Optional[int],
    payload: Dict[str, Any],
) -> None:
    session.add(
        models.LearningEvent(
            child_id=child_id,
            session_id=session_id,
            attempt_id=attempt_id,
            event_type="answer_submitted",
            payload_json=payload,
        )
    )


# ── 响应组装 ───────────────────────────────────────────────
def progress_payload(
    state: ChildLearningState, competency_code: str, cfg: AlgorithmConfig
) -> Dict[str, Any]:
    signals = state.competencies.get(competency_code) or Signals()
    level = derive_level(signals, cfg)
    return {
        "competency": competency_code,
        "level": level,
        "level_label": cfg.level_label(level),
        "scaffold_level": cfg.scaffold_for_mastery(signals.mastery),
        "signals": {
            "mastery": _quantize(signals.mastery),
            "accuracy": _quantize(signals.accuracy),
            "fluency": _quantize(signals.fluency),
            "independence": _quantize(signals.independence),
            "transfer": _quantize(signals.transfer),
        },
        "sample_count": signals.sample_count,
    }


def next_payload(
    session,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    state: ChildLearningState,
    slot_code: Optional[str],
) -> Dict[str, Any]:
    """提交后的"下一步"提示：同一个槽位里选下一道题。"""
    result = {"kind": "next_item", "beat_index": None, "item": None}
    if not slot_code:
        return result
    slot = bundle.slots.get(slot_code)
    if slot is None:
        return result
    item = select_item(slot, state, bundle, cfg)
    if item is not None:
        result["item"] = item_payload(item)
    if slot.story_beat_id:
        beat = (
            session.query(models.StoryBeat)
            .filter(models.StoryBeat.code == slot.story_beat_id)
            .one_or_none()
        )
        if beat is not None:
            result["beat_index"] = beat.sequence
    return result


def _feedback_payload(coach, item: Item, row: models.Attempt) -> Dict[str, Any]:
    message = coach.feedback(
        item,
        bool(row.correct),
        int(row.hints_used or 0),
        misconception_codes=list(row.misconception_codes_json or []),
        seed=int(row.seq or 0),
    )
    return message.to_dict()


def _reward_from_db(session, attempt_id: int) -> Dict[str, Any]:
    row = (
        session.query(models.RewardLog)
        .filter(models.RewardLog.attempt_id == attempt_id)
        .order_by(models.RewardLog.id.desc())
        .first()
    )
    if row is None:
        return {"materials": [], "coins": 0, "unlocks": []}
    reward = dict(row.reward_json or {})
    reward.setdefault("materials", [])
    reward.setdefault("coins", 0)
    reward.setdefault("unlocks", [])
    return reward


def attempt_response(
    session,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    coach,
    row: models.Attempt,
    duplicate: bool,
) -> Dict[str, Any]:
    """把一次已落库的 attempt 渲染成契约 §4 的响应。

    重复提交时用"截止到该 attempt 的重放状态"计算 progress / next，
    因此与非重复路径逐字等价。
    """
    state = load_state(session, row.child_id, bundle, cfg, upto_seq=row.seq)
    signals = state.competencies.get(row.competency_code) or Signals()
    item = bundle.items.get(row.item_code)
    feedback = (
        _feedback_payload(coach, item, row)
        if item is not None
        else {"tone": "encourage", "text": "我们继续。", "character": "小助手"}
    )
    return {
        "attempt_id": row.id,
        "seq": row.seq,
        "duplicate": duplicate,
        "correct": bool(row.correct),
        "judgement_mismatch": bool(row.judgement_mismatch),
        "misconceptions": list(row.misconception_codes_json or []),
        "feedback": feedback,
        "reward": _reward_from_db(session, row.id),
        "progress": progress_payload(state, row.competency_code, cfg),
        "next": next_payload(session, bundle, cfg, state, row.slot_code),
    }


# ── 提交（唯一事实入口） ───────────────────────────────────
def submit_attempt(
    session,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    coach,
    submission: AttemptSubmission,
) -> Dict[str, Any]:
    """POST /v1/attempts 的全部业务，单事务。任何一步失败 → 整体回滚。"""
    try:
        child = (
            session.query(models.Child)
            .filter(models.Child.id == submission.child_id)
            .one_or_none()
        )
        if child is None:
            raise errors.child_missing(submission.child_id)

        # 幂等：同一 (child, client_attempt_id) 只写一次。
        # 放在 item 校验之前 —— 即使内容后来变了，重放也必须能拿到首次结果。
        existing = (
            session.query(models.Attempt)
            .filter(
                models.Attempt.child_id == submission.child_id,
                models.Attempt.uuid == submission.client_attempt_id,
            )
            .one_or_none()
        )
        if existing is not None:
            return attempt_response(session, bundle, cfg, coach, existing, True)

        item = bundle.items.get(submission.item_code)
        if item is None:
            raise errors.item_missing(submission.item_code)

        if submission.session_id is not None:
            learning_session = (
                session.query(models.LearningSession)
                .filter(models.LearningSession.id == submission.session_id)
                .one_or_none()
            )
            if learning_session is None:
                raise errors.session_missing(submission.session_id)

        now = datetime.utcnow()
        correct = judge_answer(item, submission.answer)
        mismatch = (
            submission.client_correct is not None
            and bool(submission.client_correct) != correct
        )

        # 误区诊断：写库前先算出来（attempt 行需要快照）
        probe = Attempt(
            attempt_id="pending",
            child_id=str(submission.child_id),
            item_id=item.code,
            competency_id=item.competency_id,
            pattern_id=item.pattern_id,
            correct=correct,
            telemetry=submission.telemetry,
            hints_used=submission.hints_used,
            hint_level_max=submission.hint_level_max,
            method_used=submission.method_used,
            scaffold_level=item.scaffold_level,
            interaction_type=item.interaction_type,
            is_assessment=submission.is_assessment,
            is_transfer_probe=submission.is_transfer_probe,
            submitted_answer=submission.answer,
        )
        misconception_codes = diagnose(probe, item, cfg)

        next_seq = (
            session.query(func.max(models.Attempt.seq))
            .filter(models.Attempt.child_id == submission.child_id)
            .scalar()
        )
        next_seq = int(next_seq or 0) + 1

        row = models.Attempt(
            uuid=submission.client_attempt_id,
            session_id=submission.session_id,
            child_id=submission.child_id,
            item_code=item.code,
            competency_code=item.competency_id,
            pattern_code=item.pattern_id,
            slot_code=submission.slot_code,
            scaffold_level=item.scaffold_level,
            interaction_type=item.interaction_type,
            seq=next_seq,
            submitted_json={
                "answer": submission.answer,
                "client_correct": submission.client_correct,
            },
            correct=correct,
            judgement_mismatch=mismatch,
            response_time_ms=submission.telemetry.response_time_ms,
            active_time_ms=submission.telemetry.active_time_ms,
            idle_time_ms=submission.telemetry.idle_time_ms,
            hints_used=submission.hints_used,
            hint_level_max=submission.hint_level_max,
            method_used=submission.method_used,
            is_assessment=submission.is_assessment,
            is_transfer_probe=submission.is_transfer_probe,
            misconception_codes_json=misconception_codes,
            created_at=now,
        )
        session.add(row)
        session.flush()  # 拿到 attempt.id（后续 reward / event 要引用）

        record_learning_event(
            session,
            submission.child_id,
            submission.session_id,
            row.id,
            {
                "item_code": item.code,
                "answer": submission.answer,
                "correct": correct,
                "judgement_mismatch": mismatch,
                "misconception_codes": misconception_codes,
                "telemetry": submission.telemetry.to_dict(),
            },
        )

        reward = build_reward()
        record_reward(session, submission.child_id, row.id, reward)

        if submission.session_id is not None:
            learning_session = (
                session.query(models.LearningSession)
                .filter(models.LearningSession.id == submission.session_id)
                .one_or_none()
            )
            if learning_session is not None:
                learning_session.item_count = (learning_session.item_count or 0) + 1
                session.add(learning_session)

        # 状态推进：读全部历史 attempt → 复算 → 写回（与 replay 同一段代码）
        history = [
            attempt_from_row(existing_row, bundle)
            for existing_row in load_attempts(session, submission.child_id)
        ]
        updated_state = apply_attempts(
            new_state(str(submission.child_id)), history, bundle, cfg
        )
        persist_state(session, submission.child_id, updated_state, cfg, now)

        # review_schedule：ADR-0004 的事务清单成员。从全部 attempt 重放真调度器
        # （engine.scheduler），probe 不推进复习 —— 见 update_review_schedule。
        update_review_schedule(session, submission.child_id, history, cfg, now)

        session.commit()
    except Exception:
        session.rollback()
        raise

    return attempt_response(session, bundle, cfg, coach, row, False)


def new_client_attempt_id() -> str:
    return str(uuid_module.uuid4())


def iso_utc(value: Optional[datetime]) -> Optional[str]:
    """契约里的时间是 ISO-8601 UTC（`2026-09-15T10:00:00Z`）。"""
    if value is None:
        return None
    text = value.isoformat()
    if value.tzinfo is None:
        text += "Z"
    return text


__all__ = [
    "AttemptSubmission",
    "judge_answer",
    "attempt_from_row",
    "load_attempts",
    "load_state",
    "persist_state",
    "submit_attempt",
    "attempt_response",
    "progress_payload",
    "next_payload",
    "new_client_attempt_id",
    "iso_utc",
]
