"""P0 端到端演示：attempts → proficiency update → replay → planner decision

对应开发计划 P0-07 的验收场景。

    make demo

第 1 部分严格按约定的 5 次作答跑：
    1. 8+5   错
    2. 8+5   提示后对
    3. 7+6   对
    4. 9+4   对
    5. 8+7   无提示对
然后检查 mastery / accuracy / independence / fluency 是否上升。

第 2 部分跟着 Planner 的计划继续跑，验证：
    - 脚手架从 blocks → decompose → direct 自然递退
    - 不会突然跳到两位数进位
    - transfer 信号被专门采样
    - Replay 能重建完全相同的状态
"""
from __future__ import annotations

from typing import List

from backend.content.loader import Item, load_bundle, validate_content
from backend.engine.config import load_config
from backend.engine.graph import CompetencyGraph
from backend.engine.intent import describe_intents
from backend.engine.learner import apply_attempt, new_state
from backend.engine.planner import build_daily_plan, render_plan
from backend.engine.replay import replay, states_equal
from backend.engine.selector import select_item
from backend.engine.state_machine import (
    derive_level,
    next_competency,
    upgrade_decision,
)
from backend.engine.types import Attempt, Telemetry

LINE = "─" * 74

# (fact, scaffold) → 内容里的 item code
FACT_ITEM = {
    (8, 5): {"blocks": "mt_blk_8_5", "decompose": "mt_dec_8_5", "direct": "mt_dir_8_5"},
    (7, 6): {"blocks": "mt_blk_7_6", "decompose": "mt_dec_7_6", "direct": "mt_dir_7_6"},
    (9, 4): {"blocks": "mt_blk_9_4", "decompose": "mt_dec_9_4", "direct": "mt_dir_9_4"},
    (8, 7): {"blocks": "mt_blk_8_7", "decompose": "mt_dec_8_7", "direct": "mt_dir_8_7"},
    (9, 6): {"direct": "mt_dir_9_6"},
    (6, 5): {"direct": "mt_dir_6_5"},
}

# 第 1 部分：约定的 5 次作答
#   (a, b, correct, hints_used, thinking_ms, submitted)
SCRIPTED = [
    (8, 5, False, 0, 6800, 12),
    (8, 5, True, 1, 9200, 13),
    (7, 6, True, 0, 7400, 13),
    (9, 4, True, 0, 6100, 13),
    (8, 7, True, 0, 8900, 15),
]

# 第 2 部分：跟着计划跑的 4 次作答（题目由 Planner/Selector 决定）
CONTINUATION = [
    (True, 0, 8200, None),
    (True, 0, 7000, None),
    (True, 0, 5200, None),
    (True, 0, 4900, None),
]


def build_attempt(
    seq: int,
    child_id: str,
    item: Item,
    correct: bool,
    hints_used: int,
    thinking_ms: int,
    submitted,
    is_transfer_probe: bool = False,
) -> Attempt:
    """构造一次作答。

    active 时间取一个合理的操作耗时，剩余部分全部算 thinking ——
    短停顿属于思考，不剔除（ADR-0003）。
    """
    active = min(2000, max(600, thinking_ms // 4))
    method = {
        "blocks": "visual_blocks",
        "decompose": "decompose",
        "direct": "mental",
    }.get(item.scaffold_level, "unknown")
    if hints_used:
        method = "counting"
    return Attempt(
        attempt_id="att_{:02d}".format(seq),
        child_id=child_id,
        item_id=item.code,
        competency_id=item.competency_id,
        pattern_id=item.pattern_id,
        correct=correct,
        telemetry=Telemetry(
            response_time_ms=thinking_ms + active,
            active_time_ms=active,
        ),
        seq=seq,
        hints_used=hints_used,
        hint_level_max=hints_used,
        method_used=method,
        scaffold_level=item.scaffold_level,
        interaction_type=item.interaction_type,
        is_transfer_probe=is_transfer_probe,
        submitted_answer=submitted if submitted is not None else item.answer,
    )


def print_signals(state, competency_id: str, cfg) -> None:
    signals = state.competencies.get(competency_id)
    if signals is None:
        print("    （尚无状态）")
        return
    level = derive_level(signals, cfg)
    rows = []
    for name in ("mastery", "accuracy", "fluency", "independence", "transfer"):
        value = signals.value(name)
        rows.append("{}={}".format(name, "—" if value is None else "{:.2f}".format(value)))
    print(
        "    {}  样本={}（练习 {}）  {}".format(
            cfg.level_label(level),
            signals.sample_count,
            signals.practice_samples,
            "  ".join(rows),
        )
    )


def main() -> int:  # noqa: C901
    bundle = load_bundle()
    problems = validate_content(bundle)
    if problems:
        print("❌ 内容校验未通过：")
        for problem in problems:
            print("   -", problem)
        return 1

    graph = CompetencyGraph(bundle)
    graph_problems = graph.validate()
    if graph_problems:
        print("❌ 能力图校验未通过：")
        for problem in graph_problems:
            print("   -", problem)
        return 1

    cfg = load_config(0)
    child_id = "demo_child"
    state = new_state(child_id)
    log: List[Attempt] = []
    first_item_by_fact = {}

    print(LINE)
    print("数学世界 · P0 学习引擎端到端演示")
    print("算法配置 v{} ｜ 内容 {} 个 item / {} 个 competency".format(
        cfg.version, len(bundle.items), len(bundle.competencies)))
    print(LINE)

    # ── 第 1 部分：约定的 5 次作答 ──────────────────────────
    print("\n【第 1 部分】约定的 5 次作答（检验四个信号是否上升）\n")

    for index, (a, b, correct, hints, thinking, submitted) in enumerate(SCRIPTED, start=1):
        signals = state.competencies.get("make_ten")
        scaffold = cfg.scaffold_for_mastery(signals.mastery if signals else None)
        item = bundle.items[FACT_ITEM[(a, b)][scaffold]]

        attempt = build_attempt(
            index, child_id, item, correct, hints, thinking, submitted
        )
        state = apply_attempt(state, attempt, bundle, cfg)
        log.append(attempt)

        mark = "✅" if correct else "❌"
        hint_text = "（用了 {} 次提示）".format(hints) if hints else "（无提示）"
        print(
            "  第 {} 次 {} {}{}  题={} 脚手架={} 思考 {:.1f}s".format(
                index, mark, item.problem.get("prompt", item.code),
                hint_text, item.code, scaffold, thinking / 1000.0,
            )
        )
        print_signals(state, "make_ten", cfg)

    print("\n  ▸ 四个信号趋势检查：")
    signals = state.competencies["make_ten"]
    for name in ("mastery", "accuracy", "independence"):
        print("      {} ↑  {:.3f}".format(name, signals.value(name)))
    print("      fluency = {}（做对了才开始采样）".format(
        "{:.3f}".format(signals.fluency) if signals.fluency is not None else "—"))

    # ── 第 2 部分：跟着 Planner 的计划继续 ───────────────────
    print("\n" + LINE)
    print("【第 2 部分】跟着 Planner 的计划继续跑（题目由 Slot → Selector 决定）")
    print(LINE)

    for step, (correct, hints, thinking, submitted) in enumerate(CONTINUATION, start=6):
        plan = build_daily_plan(state, graph, bundle, cfg)

        print("\n  ── 第 {} 次作答前，Planner 的计划 ──".format(step))
        print("  学习意图（注意：决定的是「做什么」，不是「做哪道题」）：")
        if plan.intents:
            for line in describe_intents(plan.intents):
                print("     " + line)
        else:
            print("     （无）")

        # 为了在有限的演示步数里展示迁移采样，优先执行 thinking 段
        # （真实会话按 warmup → core → story → thinking 顺序执行）
        chosen = None
        for segment_type in ("thinking", "core", "warmup", "story"):
            segment = next((s for s in plan.segments if s.type == segment_type), None)
            if segment and segment.items:
                chosen = (segment, segment.items[0])
                break

        if chosen is None:
            print("  ⚠️ 计划里没有可用题目，演示终止")
            break

        segment, item = chosen
        is_probe = any(
            i.kind == "probe_transfer" and i.competency_id == item.competency_id
            for i in segment.intents
        )
        print(
            "  落题：段={} 槽={} 脚手架={} → {}".format(
                segment.type, segment.slot_code, segment.scaffold_level, item.code
            )
        )
        print(
            "        题目：{}（pattern={}）".format(
                item.problem.get("prompt", ""), item.pattern_id
            )
        )
        if is_probe:
            print("        ↑ 迁移测试：换一个没做过的问题结构，用来给 transfer 采样")

        attempt = build_attempt(
            step, child_id, item, correct, hints, thinking, submitted or item.answer,
            is_transfer_probe=is_probe,
        )
        state = apply_attempt(state, attempt, bundle, cfg)
        log.append(attempt)

        print("  结果：{}".format("✅ 正确" if correct else "❌ 错误"))
        print_signals(state, "make_ten", cfg)
        print("  脚手架建议：{} → {}".format(
            item.scaffold_level,
            cfg.scaffold_for_mastery(state.competencies["make_ten"].mastery),
        ))

    # ── 脚手架递退轨迹 ─────────────────────────────────────
    print("\n" + LINE)
    print("【脚手架递退轨迹】blocks → decompose → direct")
    print(LINE)
    for attempt in log:
        if attempt.competency_id != "make_ten":
            continue
        print(
            "  #{:>2}  {:<14} {:<10} 思考 {:>5.1f}s".format(
                attempt.seq, attempt.item_id, attempt.scaffold_level,
                attempt.telemetry.thinking_time_ms / 1000.0,
            )
        )

    # ── 升级判定：为什么还不能往前走 ────────────────────────
    print("\n" + LINE)
    print("【升级判定】系统不会让孩子跳步")
    print(LINE)
    for code in ("sd_add_10", "make_ten", "carry_add"):
        decision = upgrade_decision(state, code, graph, cfg)
        if decision.action == "upgrade":
            print("  {} → ✅ 可以推进".format(code))
        else:
            print("  {} → ⏸ 暂不推进".format(code))
            for reason in decision.reasons:
                print("        · {}".format(reason))

    print("\n  ▸ 焦点能力仍是：{}".format(next_competency(state, graph, cfg)))

    # ── 今日计划 ───────────────────────────────────────────
    final_plan = build_daily_plan(state, graph, bundle, cfg)
    print("\n" + LINE)
    print("【今日计划】")
    print(LINE)
    print(render_plan(final_plan, graph, cfg))

    # ── Replay 一致性 ──────────────────────────────────────
    print("\n" + LINE)
    print("【Replay】历史重放必须重建出完全相同的状态")
    print(LINE)
    result_a = replay(child_id, log, bundle, cfg, graph)
    result_b = replay(child_id, log, bundle, cfg, graph)
    incremental = state
    print("  重放 {} 条 attempt".format(len(log)))
    print("  两次重放一致          : {}".format(states_equal(result_a.final_state, result_b.final_state)))
    print("  重放 == 在线增量更新  : {}".format(states_equal(result_a.final_state, incremental)))
    print("  pin 的算法版本        : v{}".format(result_a.algorithm_version))
    print("  最终焦点能力 / 等级   : {} / {}".format(
        result_a.final_competency, cfg.level_label(result_a.final_level)))
    print("  最终脚手架建议        : {}".format(result_a.final_scaffold))
    print("  make_ten 最终 transfer: {}".format(
        "{:.2f}".format(state.competencies["make_ten"].transfer)
        if state.competencies["make_ten"].transfer is not None else "—"))

    ok = states_equal(result_a.final_state, result_b.final_state) and states_equal(
        result_a.final_state, incremental
    )
    print("\n" + LINE)
    print("P0 验证结果：{}".format("✅ 通过" if ok else "❌ 失败"))
    print(LINE)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
