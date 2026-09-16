"""Content Compiler：把 content/**/*.yaml 编译成可入库、可校验、可统计的内容资产。

    YAML → Validate → Lint → (Preview) → Import → DB

validate 与 lint 的区别：
  validate 失败 = 内容**错误**，绝不能入库（答案错、认知结构不成立、引用不存在）
  lint   失败 = 内容**可疑或缺失**，可以入库但必须让人看见（覆盖缺口、时长与题量不匹配）
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from backend.content.cognitive import check_all, lint_all
from backend.content.loader import (
    ALLOWED_SCAFFOLD_LEVELS,
    AUTO_SCAFFOLD,
    ContentBundle,
    Item,
    load_bundle,
    validate_content,
)

SCAFFOLD_ORDER = ["blocks", "decompose", "direct"]
_NUMBER_TOKEN = re.compile(r"\d+")


@dataclass
class CompileReport:
    problems: List[str] = field(default_factory=list)   # 错误：不能入库
    warnings: List[str] = field(default_factory=list)   # 可疑：需人工过目
    stats: Dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.problems

    def summary(self) -> str:
        lines = [
            "内容编译结果：{}".format("✅ 通过" if self.ok else "❌ 未通过"),
            "  错误 {} 条 / 警告 {} 条".format(len(self.problems), len(self.warnings)),
        ]
        return "\n".join(lines)


# ── Validate ───────────────────────────────────────────────
def validate_bundle(bundle: ContentBundle) -> List[str]:
    """结构性校验 + 认知有效性 + 答案独立复核。"""
    problems = list(validate_content(bundle))

    for item in bundle.items.values():
        for problem in check_all(item):
            problems.append("item {}: {}".format(item.code, problem))

    problems.extend(_validate_graph(bundle))
    return problems


def _validate_graph(bundle: ContentBundle) -> List[str]:
    from backend.engine.graph import CompetencyGraph

    return CompetencyGraph(bundle).validate()


# ── Lint ───────────────────────────────────────────────────
def lint_bundle(bundle: ContentBundle) -> List[str]:
    warnings: List[str] = []

    warnings.extend(_lint_coverage(bundle))
    warnings.extend(_lint_time_estimates(bundle))
    warnings.extend(_lint_duplicates(bundle))
    warnings.extend(_lint_hint_depth(bundle))
    warnings.extend(_lint_slot_pools(bundle))
    warnings.extend(_lint_story_shape(bundle))
    warnings.extend(_lint_steps(bundle))
    warnings.extend(_lint_prompt_self_contained(bundle))
    warnings.extend(_lint_slot_ceiling(bundle))

    return warnings


def _lint_prompt_self_contained(bundle: ContentBundle) -> List[str]:
    """题面必须自包含。

    题目参数里有数字（8 和 5），题面却写成「一共有多少个？」——
    这道题一旦被**没有故事**的核心训练槽选中，孩子看到的是一道无法回答的题。
    故事只能叠加情境，不能补齐题面。
    """
    warnings: List[str] = []
    for item in bundle.items.values():
        prompt = str(item.problem.get("prompt", "")).strip()
        if not prompt:
            warnings.append("item {} 没有 prompt".format(item.code))
            continue
        prompt_numbers = {int(tok) for tok in _NUMBER_TOKEN.findall(prompt)}
        param_numbers = {
            int(tok)
            for value in item.problem.values()
            if isinstance(value, int) and not isinstance(value, bool)
            for tok in _NUMBER_TOKEN.findall(str(value))
        }
        if param_numbers and not prompt_numbers:
            warnings.append(
                "item {} 题面「{}」里一个数字都没有，但参数是 {} —— "
                "题面依赖故事补齐信息，被独立训练槽选中时会无法回答".format(
                    item.code, prompt, sorted(param_numbers)
                )
            )
    return warnings


def _lint_steps(bundle: ContentBundle) -> List[str]:
    warnings: List[str] = []
    for item in bundle.items.values():
        for warning in lint_all(item):
            warnings.append("item {}: {}".format(item.code, warning))
    return warnings


def _lint_slot_ceiling(bundle: ContentBundle) -> List[str]:
    """槽位声明的难度区间，右端必须真的够得着。

    两类缺口（模拟体检规则 1 的两个根因）：

      a) **难度档缺口** —— 槽声明 [1,4]，但该能力的题最高只到 3。
         区间右端是死的，熟练度再高也推不进最后一段；
      b) **绑定 pattern 的档覆盖收缩** —— 槽绑了 pattern，但这个 pattern
         在区间内（或某个脚手架层里）没有题。运行时选择器会在"整个区间
         都没有该 pattern 的题"时静默放宽 pattern 兜底 —— 于是迁移/挑战槽
         「必须换一个没做过的结构」的意图在运行时落空，transfer 证据攒不出来，
         而这一层只在体检报告里显示为"迁移测试落地率低"，看不出真正原因。

    这是 lint（警告）不是 validate（错误）：内容缺一档题不会让孩子做不了题，
    只是训练意图打折；但如果哪天缺口大到影响升级链路，应该升级为硬规则。
    """
    warnings: List[str] = []
    for slot in bundle.slots.values():
        items = [
            i
            for i in bundle.items.values()
            if i.competency_id == slot.competency_id
            and slot.difficulty_min <= i.difficulty <= slot.difficulty_max
        ]
        label = "slot {}（{} 难度 {}~{}）".format(
            slot.code, slot.competency_id, slot.difficulty_min, slot.difficulty_max
        )

        # a) 上限档无题
        at_ceiling = [i for i in items if i.difficulty == slot.difficulty_max]
        if not at_ceiling:
            reachable = max(
                (i.difficulty for i in items), default=None
            )
            warnings.append(
                "{} 声明的上限难度 {} 在内容里不存在任何题（实际最高 {}）—— "
                "熟练度高的孩子永远推不到这个槽位的顶".format(
                    label, slot.difficulty_max, reachable
                )
            )

        # b) 绑定 pattern 的覆盖
        if not slot.pattern_id:
            continue
        bound = [i for i in items if i.pattern_id == slot.pattern_id]
        if not bound:
            warnings.append(
                "{} 绑定 pattern {}，但该 pattern 在难度区间内没有题 —— "
                "运行时会静默放宽成别的 pattern，这个槽声明的训练意图会落空".format(
                    label, slot.pattern_id
                )
            )
            continue
        by_scaffold: Dict[str, set] = {}
        bound_scaffolds: Dict[str, set] = {}
        for i in items:
            by_scaffold.setdefault(i.scaffold_level, set()).add(i.difficulty)
        for i in bound:
            bound_scaffolds.setdefault(i.scaffold_level, set()).add(i.difficulty)
        # 槽位显式声明脚手架（非 auto）时只查那一层 —— 别的层它根本不会用
        if slot.scaffold_level and slot.scaffold_level != AUTO_SCAFFOLD:
            layers = [slot.scaffold_level]
        else:
            layers = sorted(by_scaffold)
        for scaffold in layers:
            if scaffold in bound_scaffolds:
                continue
            if scaffold not in by_scaffold:
                continue  # 该层没有题是另一个问题（coverage lint 已覆盖）
            warnings.append(
                "{} 绑定 pattern {}，但脚手架 {} 层在区间内只有别的 pattern 的题 {} —— "
                "处于该层的孩子会拿到不是 {} 的题".format(
                    label,
                    slot.pattern_id,
                    scaffold,
                    sorted(by_scaffold[scaffold]),
                    slot.pattern_id,
                )
            )
    return warnings


def _lint_coverage(bundle: ContentBundle) -> List[str]:
    warnings: List[str] = []
    for competency in bundle.competencies.values():
        items = bundle.items_for(competency_id=competency.code)
        if not items:
            continue  # 完全没有题由 validate 报错（不可训练）
        present = {item.scaffold_level for item in items}
        missing = [s for s in SCAFFOLD_ORDER if s not in present]
        if missing:
            warnings.append(
                "competency {} 缺少脚手架级别 {} 的题目：脚手架递退会在此处跳级".format(
                    competency.code, "/".join(missing)
                )
            )
    return warnings


def _lint_time_estimates(bundle: ContentBundle) -> List[str]:
    """同 interaction_type 内，难度与预估耗时应单调。"""
    warnings: List[str] = []
    by_interaction: Dict[str, List[Item]] = {}
    for item in bundle.items.values():
        by_interaction.setdefault(item.interaction_type, []).append(item)

    for interaction, items in sorted(by_interaction.items()):
        if len(items) < 3:
            continue
        items = sorted(items, key=lambda i: i.difficulty)
        cheapest = items[0].estimated_seconds
        dearest = items[-1].estimated_seconds
        if cheapest > dearest:
            warnings.append(
                "interaction {} 的预估耗时与难度反向：难度 {} 用 {}s，难度 {} 用 {}s".format(
                    interaction, items[0].difficulty, cheapest,
                    items[-1].difficulty, dearest,
                )
            )
        for item in items:
            if item.estimated_seconds <= 0:
                warnings.append("item {} 的 estimated_seconds 不合理".format(item.code))
    return warnings


def _lint_duplicates(bundle: ContentBundle) -> List[str]:
    warnings: List[str] = []
    seen: Dict[Tuple[str, str], Item] = {}
    for item in bundle.items.values():
        prompt = str(item.problem.get("prompt", "")).strip()
        if not prompt:
            continue
        key = (item.interaction_type, prompt)
        other = seen.get(key)
        if other is not None and other.answer != item.answer:
            warnings.append(
                "题面完全相同但答案不同：{} / {}（「{}」）".format(
                    other.code, item.code, prompt
                )
            )
        seen[key] = item
    return warnings


def _lint_hint_depth(bundle: ContentBundle) -> List[str]:
    warnings: List[str] = []
    for item in bundle.items.values():
        if item.difficulty >= 3 and len(item.hint_chain) < 2:
            warnings.append(
                "item {} 难度 {} 但只有 {} 级提示，孩子卡住时没有台阶".format(
                    item.code, item.difficulty, len(item.hint_chain)
                )
            )
    return warnings


def _lint_slot_pools(bundle: ContentBundle) -> List[str]:
    """槽位候选池过窄会导致同一道题反复出现。"""
    warnings: List[str] = []
    for slot in bundle.slots.values():
        candidates = [
            item
            for item in bundle.items.values()
            if item.competency_id == slot.competency_id
            and (slot.pattern_id is None or item.pattern_id == slot.pattern_id)
            and slot.difficulty_min <= item.difficulty <= slot.difficulty_max
        ]
        if 0 < len(candidates) < 3:
            warnings.append(
                "slot {} 候选池只有 {} 道题，容易重复出现".format(
                    slot.code, len(candidates)
                )
            )
    return warnings


def _lint_story_shape(bundle: ContentBundle) -> List[str]:
    """故事时长与挑战数量应当匹配：每个挑战约 1 分钟。"""
    warnings: List[str] = []
    stories: Dict[str, Dict[str, Any]] = {}
    for slot in bundle.slots.values():
        if not slot.story_beat_id:
            continue
        story_code = slot.story_beat_id.split("__")[0]
        row = stories.setdefault(story_code, {"challenges": 0, "seconds": 0})
        row["challenges"] += 1
        row["seconds"] += slot.estimated_seconds

    for story_code, row in sorted(stories.items()):
        minutes = row["seconds"] / 60.0
        if minutes < 4:
            warnings.append(
                "故事 {} 的挑战内容只有约 {:.1f} 分钟，不足 5 分钟的下限".format(
                    story_code, minutes
                )
            )
        if minutes > 10:
            warnings.append(
                "故事 {} 的挑战内容约 {:.1f} 分钟，超过 10 分钟上限".format(
                    story_code, minutes
                )
            )
    return warnings


# ── Stats ──────────────────────────────────────────────────
def compute_stats(bundle: ContentBundle) -> Dict[str, Any]:
    competencies = {}
    for competency in bundle.competencies.values():
        items = bundle.items_for(competency_id=competency.code)
        by_scaffold = {s: 0 for s in SCAFFOLD_ORDER}
        for item in items:
            if item.scaffold_level in by_scaffold:
                by_scaffold[item.scaffold_level] += 1
        competencies[competency.code] = {
            "name": competency.name,
            "items": len(items),
            "by_scaffold": by_scaffold,
            "patterns": sorted({i.pattern_id for i in items}),
        }

    patterns: Dict[str, int] = {}
    for item in bundle.items.values():
        patterns[item.pattern_id] = patterns.get(item.pattern_id, 0) + 1

    by_steps_style: Dict[str, int] = {"guide": 0, "conclude": 0}
    for item in bundle.items.values():
        if item.steps_style in by_steps_style:
            by_steps_style[item.steps_style] += 1

    return {
        "competencies": len(bundle.competencies),
        "patterns": len(bundle.patterns),
        "items": len(bundle.items),
        "slots": len(bundle.slots),
        "story_slots": sum(1 for s in bundle.slots.values() if s.story_beat_id),
        "standalone_slots": sum(1 for s in bundle.slots.values() if not s.story_beat_id),
        "misconceptions": len(bundle.misconceptions),
        "coverage": competencies,
        "items_by_pattern": dict(sorted(patterns.items())),
        "items_by_steps_style": by_steps_style,
        "slots_detail": {
            slot.code: len(
                [
                    item
                    for item in bundle.items.values()
                    if item.competency_id == slot.competency_id
                    and (slot.pattern_id is None or item.pattern_id == slot.pattern_id)
                    and slot.difficulty_min <= item.difficulty <= slot.difficulty_max
                ]
            )
            for slot in bundle.slots.values()
        },
    }


def render_coverage(stats: Dict[str, Any]) -> str:
    lines = ["{:<22} {:>5} {:>7} {:>7} {:>7}  {}".format(
        "competency", "items", "blocks", "decomp", "direct", "patterns")]
    lines.append("-" * 92)
    for code, row in sorted(stats["coverage"].items()):
        lines.append(
            "{:<22} {:>5} {:>7} {:>7} {:>7}  {}".format(
                code,
                row["items"],
                row["by_scaffold"]["blocks"],
                row["by_scaffold"]["decompose"],
                row["by_scaffold"]["direct"],
                ", ".join(row["patterns"]) or "—",
            )
        )
    return "\n".join(lines)


def render_stats(stats: Dict[str, Any]) -> str:
    """覆盖度报表的整份文本 —— 内容总览 / 覆盖表 / 按结构分布 / 示范路径写法 / 候选池宽度。

    从 `tools/content_cli/main.py` 的 `cmd_stats` 里提出来（那段原来是内联的 print），
    目的是让 `dump_fixtures.py` 能与 TypeScript 侧同源对拍 —— CLI 里的 print 语句
    没法被 fixture 读，而"只在人肉看的时候才对"的排版是留不住回归的。
    """
    lines = [
        "内容总览",
        "  能力 {} ｜ 结构 {} ｜ 题目 {} ｜ 槽位 {}（故事 {} / 独立 {}）｜ 误区 {}".format(
            stats["competencies"], stats["patterns"], stats["items"], stats["slots"],
            stats["story_slots"], stats["standalone_slots"], stats["misconceptions"],
        ),
        "",
        render_coverage(stats),
        "",
        "按认知结构分布",
    ]
    for pattern, count in stats["items_by_pattern"].items():
        lines.append("  {:<22} {:>4}".format(pattern, count))

    style = stats["items_by_steps_style"]
    lines.append("")
    lines.append(
        "示范路径写法：guide（最后一步留给孩子）{} 道 ｜ conclude（写出答案）{} 道".format(
            style["guide"], style["conclude"]
        )
    )
    lines.append("")
    lines.append("槽位候选池宽度")
    for slot_code, width in sorted(stats["slots_detail"].items()):
        mark = "⚠️" if width < 3 else "  "
        lines.append("  {} {:<32} {:>3} 道".format(mark, slot_code, width))

    return "\n".join(lines)


# ── Preview ────────────────────────────────────────────────
def preview_item(bundle: ContentBundle, code: str) -> str:
    item = bundle.items.get(code)
    if item is None:
        return "找不到 item {}".format(code)
    lines = [
        "┌─ {} {}".format(item.code, "─" * max(0, 60 - len(item.code))),
        "│ 能力 {} ｜ 结构 {} ｜ 难度 {} ｜ 脚手架 {}".format(
            item.competency_id, item.pattern_id, item.difficulty, item.scaffold_level
        ),
        "│ 交互 {} ｜ 预估 {}s".format(item.interaction_type, item.estimated_seconds),
        "├─ 题面",
    ]
    lines.append("│   {}".format(item.problem.get("prompt", "(无题面)")))
    lines.append("│   参数 {}".format(item.problem))
    lines.append("├─ 答案")
    lines.append("│   {}".format(item.answer))
    lines.append("├─ 步骤（steps_style={}）".format(item.steps_style))
    for index, step in enumerate(item.steps, start=1):
        lines.append("│   {}. {}".format(index, step))
    lines.append("├─ 提示链（逐级给出）")
    for index, hint in enumerate(item.hint_chain, start=1):
        lines.append("│   {}. {}".format(index, hint))
    lines.append("├─ 错误规则")
    for rule in item.error_rules:
        lines.append("│   {} ← {}".format(rule.get("code"), rule.get("match")))
    lines.append("└" + "─" * 61)
    return "\n".join(lines)


def preview_story(bundle: ContentBundle, story_code: str) -> str:
    slots = [s for s in bundle.slots.values() if (s.story_beat_id or "").startswith(story_code)]
    if not slots:
        return "找不到故事 {} 的挑战槽".format(story_code)
    lines = ["故事 {}（{} 个挑战）".format(story_code, len(slots))]
    for slot in sorted(slots, key=lambda s: s.story_beat_id or ""):
        lines.append(
            "  {}  能力={} 结构={} 难度={}~{} 脚手架={} 预估={}s".format(
                slot.story_beat_id,
                slot.competency_id,
                slot.pattern_id or "(状态决定)",
                slot.difficulty_min,
                slot.difficulty_max,
                slot.scaffold_level,
                slot.estimated_seconds,
            )
        )
    return "\n".join(lines)


# ── 主入口 ─────────────────────────────────────────────────
def compile_bundle(bundle: Optional[ContentBundle] = None) -> CompileReport:
    bundle = bundle or load_bundle()
    return CompileReport(
        problems=validate_bundle(bundle),
        warnings=lint_bundle(bundle),
        stats=compute_stats(bundle),
    )
