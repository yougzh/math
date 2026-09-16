"""家长报告（契约 §10）。

所有数字都来自孩子真实的 attempt / session / 状态表；文案规则集中在
`_headline` / `_advice`，P6 接入 LLM 时替换这两处即可。

免责声明是硬性要求：数据仅供家庭参考，不作为学业评价。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, List

from backend.content.loader import ContentBundle
from backend.db import models
from backend.engine.config import AlgorithmConfig
from backend.engine.graph import CompetencyGraph
from backend.engine.replay import replay
from backend.engine.state_machine import derive_level
from backend.engine.types import ChildLearningState
from backend.service.growth import completed_story_codes
from backend.service.learning import attempt_from_row

DISCLAIMER = "数据来自孩子在应用内的真实作答，仅供家庭参考，不作为学业评价。"

_LEVEL_ORDER = ["encountering", "understanding", "can_do", "proficient", "automatic"]


def _level_index(level: str) -> int:
    try:
        return _LEVEL_ORDER.index(level)
    except ValueError:
        return 0


def _thresholds(cfg: AlgorithmConfig) -> Dict[str, float]:
    """weak point 判定用的粗阈值 —— 全部取自配置，不写字面量（ADR-0002）。

    缺省字面量已迁入 config/algorithm/v0.yaml 的 report.weak_thresholds 段；
    配置缺失时直接抛 KeyError（宁可启动失败，也不要悄悄退回代码字面量）。
    """
    return {
        key: float(value)
        for key, value in cfg.get("report", "weak_thresholds").items()
    }


def _weak_points(state: ChildLearningState, bundle: ContentBundle, cfg: AlgorithmConfig) -> List[Dict[str, Any]]:
    thresholds = _thresholds(cfg)
    rows = []
    for code in sorted(state.competencies.keys()):
        signals = state.competencies[code]
        name = bundle.competencies[code].name if code in bundle.competencies else code
        accuracy = signals.accuracy
        fluency = signals.fluency
        independence = signals.independence
        transfer = signals.transfer

        if independence is not None and independence < thresholds["independence"]:
            rows.append(
                {
                    "type": "independence",
                    "competency": code,
                    "text": "{} 还需要提示才能做下去；下次先让他自己试一分钟，再给提示。".format(name),
                }
            )
        elif (
            accuracy is not None
            and accuracy >= thresholds["fluency_accuracy_floor"]
            and (fluency is None or fluency < thresholds["fluency"])
        ):
            rows.append(
                {
                    "type": "fluency",
                    "competency": code,
                    "text": "{} 能独立做对，但每次要多想几秒；建议继续用「先凑十」的方法，不要退回逐个数。".format(name),
                }
            )
        elif accuracy is not None and accuracy < thresholds["accuracy"]:
            rows.append(
                {
                    "type": "accuracy",
                    "competency": code,
                    "text": "{} 的正确率还不稳定；建议降一级脚手架，用积木或拆分摆一摆再算。".format(name),
                }
            )
        elif transfer is not None and transfer < thresholds["transfer"]:
            rows.append(
                {
                    "type": "transfer",
                    "competency": code,
                    "text": "{} 在同一题型上很熟，但换个问法还不太行；这周换一种问法再练。".format(name),
                }
            )
    return rows[:3]


def _headline(weak_points: List[Dict[str, Any]], bundle: ContentBundle) -> str:
    if not weak_points:
        return "本周学习状态平稳，继续保持每天 10～15 分钟。"
    first = weak_points[0]
    code = first["competency"]
    name = bundle.competencies[code].name if code in bundle.competencies else code
    if first["type"] == "fluency":
        return "本周不是「不会{}」，而是「已经理解，但流畅度不足」。".format(name)
    if first["type"] == "independence":
        return "本周{}的独立完成度还不够，多给一点自己尝试的时间。".format(name)
    if first["type"] == "transfer":
        return "本周{}已经练熟，但换个问法就会卡住，需要更多变式。".format(name)
    return "本周{}的正确率还不稳定，先把脚手架加回来。".format(name)


def _advice(weak_points: List[Dict[str, Any]], bundle: ContentBundle) -> List[str]:
    advice = ["每天 10～15 分钟即可，不要延长。"]
    if weak_points:
        first = weak_points[0]
        code = first["competency"]
        name = bundle.competencies[code].name if code in bundle.competencies else code
        if first["type"] == "fluency":
            advice.append("本周重点是「快一点」，可以玩「限时{}」，但不要催。".format(name))
        elif first["type"] == "independence":
            advice.append("孩子卡住时先等一分钟，让他自己找方法，再给提示。")
        elif first["type"] == "transfer":
            advice.append("把「{}」换成生活中的问法问一问，练变式。".format(name))
        else:
            advice.append("先把「{}」的积木 / 拆分玩法拿出来，重新走一遍过程。".format(name))
    else:
        advice.append("可以让孩子当小老师，把今天学的方法讲一遍。")
    return advice


def _engagement(
    session,
    child_id: int,
    start: datetime,
    bundle: ContentBundle,
    graph: CompetencyGraph,
) -> Dict[str, Any]:
    sessions = (
        session.query(models.LearningSession)
        .filter(
            models.LearningSession.child_id == child_id,
            models.LearningSession.started_at >= start,
        )
        .all()
    )
    total_minutes = 0.0
    for row in sessions:
        if row.duration_ms:
            total_minutes += float(row.duration_ms) / 60000.0
    count = len(sessions)

    # next_day_return_rate：有作答的日子里，"第二天也来"的比例
    days = {
        row[0].date()
        for row in session.query(models.Attempt.created_at)
        .filter(
            models.Attempt.child_id == child_id,
            models.Attempt.created_at >= start,
        )
        .all()
        if row[0] is not None
    }
    base_days = {day for day in days if (day + timedelta(days=1)) <= date.today()}
    returns = {day for day in base_days if (day + timedelta(days=1)) in days}
    return_rate = (len(returns) / len(base_days)) if base_days else 0.0

    total_stories = len(bundle.stories)
    done_stories = len(completed_story_codes(session, child_id, bundle))
    return {
        "sessions": count,
        "total_minutes": round(total_minutes, 1),
        "avg_minutes_per_session": round(total_minutes / count, 1) if count else 0.0,
        "next_day_return_rate": round(return_rate, 4),
        "story_completion_rate": round(done_stories / total_stories, 4) if total_stories else 0.0,
    }


def _progress_events(
    child_id: str,
    session,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    graph: CompetencyGraph,
    start: datetime,
) -> List[Dict[str, Any]]:
    rows = (
        session.query(models.Attempt)
        .filter(models.Attempt.child_id == int(child_id))
        .order_by(models.Attempt.seq)
        .all()
    )
    attempts = [attempt_from_row(row, bundle) for row in rows]
    if not attempts:
        return []
    result = replay(child_id, attempts, bundle, cfg, graph)
    events: List[Dict[str, Any]] = []
    previous_level: Dict[str, str] = {}
    for snapshot in result.snapshots:
        previous = previous_level.get(snapshot.competency_id)
        previous_level[snapshot.competency_id] = snapshot.level
        if previous is None or _level_index(snapshot.level) <= _level_index(previous):
            continue
        row = next((r for r in rows if r.seq == snapshot.seq), None)
        if row is None or row.created_at is None or row.created_at < start:
            continue
        name = (
            bundle.competencies[snapshot.competency_id].name
            if snapshot.competency_id in bundle.competencies
            else snapshot.competency_id
        )
        events.append(
            {
                "date": row.created_at.date().isoformat(),
                "level": snapshot.level,
                "note": "{} 达到「{}」".format(name, snapshot.level_label),
            }
        )
    return events[-8:]


def report_payload(
    session,
    child: models.Child,
    state: ChildLearningState,
    cfg: AlgorithmConfig,
    bundle: ContentBundle,
    graph: CompetencyGraph,
    days: int,
) -> Dict[str, Any]:
    today = date.today()
    start_day = today - timedelta(days=max(1, days) - 1)
    start = datetime.combine(start_day, datetime.min.time())

    competencies = []
    for code in graph.topological_order():
        signals = state.competencies.get(code)
        if signals is None or signals.sample_count == 0:
            continue
        name = bundle.competencies[code].name if code in bundle.competencies else code
        level = derive_level(signals, cfg)
        competencies.append(
            {
                "code": code,
                "name": name,
                "level": level,
                "level_label": cfg.level_label(level),
                "score": round(float(signals.mastery or 0.0), 4),
                "signals": {
                    "mastery": signals.mastery,
                    "accuracy": signals.accuracy,
                    "fluency": signals.fluency,
                    "independence": signals.independence,
                    "transfer": signals.transfer,
                },
            }
        )

    misconceptions = []
    for code, misc in sorted(state.misconceptions.items()):
        definition = bundle.misconceptions.get(code)
        misconceptions.append(
            {
                "code": code,
                "name": definition.name if definition else code,
                "hit_count": misc.hit_count,
                "text": "近一周出现 {} 次。".format(misc.hit_count),
            }
        )

    weak_points = _weak_points(state, bundle, cfg)
    return {
        "child": {"id": child.id, "name": child.name},
        "range": {"days": max(1, days), "from": start_day.isoformat(), "to": today.isoformat()},
        "headline": _headline(weak_points, bundle),
        "competencies": competencies,
        "weak_points": weak_points,
        "misconceptions": misconceptions,
        "progress": _progress_events(
            str(child.id), session, bundle, cfg, graph, start
        ),
        "engagement": _engagement(session, child.id, start, bundle, graph),
        "advice": _advice(weak_points, bundle),
        "disclaimer": DISCLAIMER,
    }


__all__ = ["report_payload", "DISCLAIMER"]
