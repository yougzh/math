"""内容工作台命令行主入口。

    python3 -m tools.content_cli validate
    python3 -m tools.content_cli lint
    python3 -m tools.content_cli stats
    python3 -m tools.content_cli preview item mt_blk_8_5
    python3 -m tools.content_cli preview story station_01
    python3 -m tools.content_cli generate [--families make_ten,sd_add_10] [--out generated/core.yaml]
    python3 -m tools.content_cli dump [--out build/content_dump.json]
    python3 -m tools.content_cli schema [--out build/schema]

退出码约定：
    validate 发现问题 → 1（CI 必须拦住）
    lint     发现问题 → 0（警告不阻塞，但要有人看）
    其余命令出错 → 1
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import List, Optional

import yaml

from backend.content import compiler
from backend.content import generators
from backend.content.loader import load_bundle
from backend.paths import ROOT
from tools.content_cli.schema import ALL_SCHEMAS


BUILD_DIR = os.path.join(ROOT, "build")


def _print_list(title: str, rows: List[str], limit: int = 200) -> None:
    if not rows:
        return
    print("\n{}（{} 条）".format(title, len(rows)))
    for row in rows[:limit]:
        print("  • {}".format(row))
    if len(rows) > limit:
        print("  … 还有 {} 条未显示".format(len(rows) - limit))


# ── validate ───────────────────────────────────────────────
def cmd_validate(args) -> int:
    report = compiler.compile_bundle()
    print(report.summary())
    _print_list("❌ 错误", report.problems)
    _print_list("⚠️ 警告", report.warnings, limit=50)
    if report.problems:
        print("\n内容有错误，禁止入库。修完再跑一次。")
        return 1
    print("\n内容可以入库。")
    if report.warnings:
        print("（上面 {} 条警告请人工过目，不阻塞入库）".format(len(report.warnings)))
    return 0


# ── lint ───────────────────────────────────────────────────
def cmd_lint(args) -> int:
    report = compiler.compile_bundle()
    if report.problems:
        print("❌ 有 {} 条错误，先跑 validate 修好再来 lint。".format(len(report.problems)))
        _print_list("❌ 错误", report.problems)
        return 1
    print("✅ 无错误")
    if not report.warnings:
        print("✅ 无警告，内容很干净")
        return 0
    _print_list("⚠️ 警告", report.warnings)
    return 0


# ── stats ──────────────────────────────────────────────────
def cmd_stats(args) -> int:
    report = compiler.compile_bundle()
    if report.problems:
        print("❌ 有 {} 条错误，统计结果不可信。".format(len(report.problems)))
        return 1

    print(compiler.render_stats(report.stats))
    return 0


# ── preview ────────────────────────────────────────────────
def cmd_preview(args) -> int:
    bundle = load_bundle()
    if args.kind == "item":
        print(compiler.preview_item(bundle, args.code))
        return 0
    if args.kind == "story":
        print(compiler.preview_story(bundle, args.code))
        return 0
    if args.kind == "slot":
        slot = bundle.slots.get(args.code)
        if slot is None:
            print("找不到 slot {}".format(args.code))
            return 1
        candidates = [
            item.code
            for item in bundle.items_for(
                competency_id=slot.competency_id, pattern_id=slot.pattern_id
            )
            if slot.difficulty_min <= item.difficulty <= slot.difficulty_max
        ]
        print("槽位 {}".format(slot.code))
        print("  能力 {} ｜ 结构 {} ｜ 难度 {}~{} ｜ 脚手架 {}".format(
            slot.competency_id, slot.pattern_id or "(由状态决定)",
            slot.difficulty_min, slot.difficulty_max, slot.scaffold_level,
        ))
        print("  用途 {} ｜ 预估 {}s ｜ 故事 {}".format(
            slot.purpose, slot.estimated_seconds, slot.story_beat_id or "(独立训练槽)"
        ))
        print("  选择策略 {}".format(slot.selection_policy or "{}"))
        print("  复习策略 {}".format(slot.review_policy or "{}"))
        print("  候选池 {} 道".format(len(candidates)))
        for code in candidates[:20]:
            print("    - {}".format(code))
        return 0
    print("未知的预览类型 {}".format(args.kind))
    return 1


# ── generate ───────────────────────────────────────────────
def _existing_codes_excluding_out(out: str) -> set:
    """全量已有题码，但扣掉即将被本次生成**整体覆盖**的那个文件。

    生成产物本身就躺在 content/items/generated/ 里，`load_bundle()` 会把它们
    也算进"已有内容" —— 不扣掉的话，重新生成时每一道题都会被判成
    "item code 与已有内容冲突"，生成器永远跑不出东西。
    其他文件（不在本次 --out 里的）仍然算冲突：它们不会被覆盖，重复生成
    会造成真正的题码撞车。
    """
    from backend.paths import ITEM_DIR

    codes = set(load_bundle().items)
    path = os.path.join(ITEM_DIR, out)
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            doc = yaml.safe_load(fh) or {}
        for row in doc.get("items") or []:
            code = row.get("code")
            if code:
                codes.discard(code)
    return codes


def cmd_generate(args) -> int:
    out = args.out or "generated/core_number_sense.yaml"
    existing = _existing_codes_excluding_out(out)
    families = args.families.split(",") if args.families else None

    if args.dry_run:
        items, rejected = _generate_without_disk(families, existing)
        print("生成 {} 道，拦下 {} 道（dry-run，未写盘）".format(len(items), len(rejected)))
        _print_list("被拦下的候选", rejected)
        return 0

    items, rejected = generators.generate(families=families, existing_codes=existing)
    if rejected:
        _print_list("被拦下的候选", rejected)
    if not items:
        print("没有生成任何题目。")
        return 1
    path = generators.write_yaml(items, out)
    print("生成 {} 道题 → {}".format(len(items), os.path.relpath(path, ROOT)))
    print("提示：生成内容已通过 cognitive.check_all 复核，仍建议跑一次 "
          "`math-content stats` 看覆盖度。")
    return 0


def _generate_without_disk(families, existing):
    """dry-run：只跑生成+校验，不落盘。"""
    accepted, rejected = [], []
    from backend.content.cognitive import check_all

    names = families or list(generators.GENERATORS)
    seen = set(existing)
    for name in names:
        generator = generators.GENERATORS.get(name)
        if generator is None:
            rejected.append("未知的内容家族: {}".format(name))
            continue
        for candidate in generator():
            if candidate.code in seen:
                rejected.append("item code 与已有内容冲突: {}".format(candidate.code))
                continue
            seen.add(candidate.code)
            problems = check_all(candidate.as_item())
            if problems:
                rejected.extend("{}: {}".format(candidate.code, p) for p in problems)
                continue
            accepted.append(candidate)
    return accepted, rejected


# ── dump ───────────────────────────────────────────────────
def cmd_dump(args) -> int:
    """导出规范化 JSON —— P2 数据库导入的唯一输入格式。"""
    report = compiler.compile_bundle()
    if report.problems:
        print("❌ 有 {} 条错误，禁止导出。".format(len(report.problems)))
        _print_list("❌ 错误", report.problems)
        return 1

    bundle = load_bundle()
    payload = {
        "content_version": args.version,
        "counts": {
            "competencies": len(bundle.competencies),
            "patterns": len(bundle.patterns),
            "items": len(bundle.items),
            "misconceptions": len(bundle.misconceptions),
            "slots": len(bundle.slots),
            "stories": len(bundle.stories),
        },
        "competencies": [
            {
                "code": c.code,
                "name": c.name,
                "description": c.description,
                "stage": c.stage,
                "prerequisites": c.prerequisites,
            }
            for c in sorted(bundle.competencies.values(), key=lambda c: (c.stage, c.code))
        ],
        "patterns": [
            {
                "code": p.code,
                "name": p.name,
                "cognitive_type": p.cognitive_type,
                "primary_competency": p.primary_competency,
                "applicable_competencies": sorted(
                    set(p.applicable_competencies) | {p.primary_competency}
                ),
                "description": p.description,
            }
            for p in sorted(bundle.patterns.values(), key=lambda p: p.code)
        ],
        "misconceptions": [
            {
                "code": m.code,
                "name": m.name,
                "description": m.description,
                "severity": m.severity,
                "remediation_competency": m.remediation_competency,
            }
            for m in sorted(bundle.misconceptions.values(), key=lambda m: m.code)
        ],
        # 注意：answer 只进数据库，永不下发前端（见 docs/api-contract.md）
        "items": [
            {
                "code": i.code,
                "competency": i.competency_id,
                "pattern": i.pattern_id,
                "difficulty": i.difficulty,
                "scaffold_level": i.scaffold_level,
                "interaction_type": i.interaction_type,
                "estimated_seconds": i.estimated_seconds,
                "problem": i.problem,
                "answer": i.answer,
                "steps": i.steps,
                "steps_style": i.steps_style,
                "hint_chain": i.hint_chain,
                "error_rules": i.error_rules,
            }
            for i in sorted(bundle.items.values(), key=lambda i: i.code)
        ],
        "stories": [
            {
                "code": s.code,
                "universe": s.universe,
                "title": s.title,
                "summary": s.summary,
                "duration_min": s.duration_min,
                "order_index": s.order_index,
                "target_competencies": list(s.target_competencies),
                "beats": [
                    {
                        "code": b.code,
                        "sequence": b.sequence,
                        "beat_type": b.beat_type,
                        "narration": b.narration,
                        "character": b.character,
                        # 挑战节拍挂的槽位（slot 是声明方，这里只是快照回填）；
                        # 故事播放器逐 beat 出题靠它映射，narration/reward 节拍为 null
                        "slot_code": b.slot_code,
                        "visual": {},
                        "reward": {},
                    }
                    for b in s.ordered_beats()
                ],
            }
            for s in sorted(bundle.stories.values(), key=lambda s: s.code)
        ],
        "slots": [
            {
                "code": s.code,
                "story_beat_id": s.story_beat_id,
                "competency": s.competency_id,
                "pattern": s.pattern_id,
                "difficulty_min": s.difficulty_min,
                "difficulty_max": s.difficulty_max,
                "purpose": s.purpose,
                "scaffold_level": s.scaffold_level,
                "estimated_seconds": s.estimated_seconds,
                "selection_policy": s.selection_policy,
                "review_policy": s.review_policy,
            }
            for s in sorted(bundle.slots.values(), key=lambda s: s.code)
        ],
    }

    out = args.out or os.path.join(BUILD_DIR, "content_dump.json")
    out = out if os.path.isabs(out) else os.path.join(ROOT, out)
    directory = os.path.dirname(out)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=False)

    print("已导出 {}".format(os.path.relpath(out, ROOT)))
    for key, value in payload["counts"].items():
        print("  {:<16} {}".format(key, value))
    print("\n这个文件是 P2 数据库导入的唯一输入。改内容 → 重新 dump → 重新导入。")
    return 0


# ── schema ─────────────────────────────────────────────────
def cmd_schema(args) -> int:
    out = args.out or os.path.join(BUILD_DIR, "schema")
    out = out if os.path.isabs(out) else os.path.join(ROOT, out)
    if not os.path.isdir(out):
        os.makedirs(out)
    index = {}
    for name, schema in ALL_SCHEMAS.items():
        path = os.path.join(out, "{}.schema.json".format(name))
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(schema, fh, ensure_ascii=False, indent=2)
        index[name] = os.path.relpath(path, ROOT)

    # 顺手把 vscode 的关联写出来，编辑器里写 YAML 就有补全
    vscode_dir = os.path.join(ROOT, ".vscode")
    if not os.path.isdir(vscode_dir):
        os.makedirs(vscode_dir)
    settings_path = os.path.join(vscode_dir, "settings.json")
    existing = {}
    if os.path.isfile(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as fh:
                existing = json.load(fh) or {}
        except (ValueError, OSError):
            existing = {}
    associations = existing.setdefault("yaml.schemas", {})
    for name, rel in index.items():
        associations[rel] = [
            "content/{}s/*.yaml".format(name),
            "content/{}s/**/*.yaml".format(name),
        ]
    with open(settings_path, "w", encoding="utf-8") as fh:
        json.dump(existing, fh, ensure_ascii=False, indent=2)

    print("已生成 {} 个 JSON Schema → {}".format(len(index), os.path.relpath(out, ROOT)))
    for name, rel in index.items():
        print("  {:<16} {}".format(name, rel))
    print("已更新 .vscode/settings.json（写 content YAML 时会有字段补全）")
    return 0


# ── 入口 ───────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="math-content",
        description="数学世界内容工作台",
    )
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("validate", help="检查内容错误（有错退出码 1）")
    sub.add_parser("lint", help="检查可疑内容（警告不阻塞）")
    sub.add_parser("stats", help="覆盖度报表")

    preview = sub.add_parser("preview", help="查看某道题 / 某个故事 / 某个槽位")
    preview.add_argument("kind", choices=["item", "story", "slot"])
    preview.add_argument("code")

    gen = sub.add_parser("generate", help="用模板批量生成候选题")
    gen.add_argument("--families", help="逗号分隔的生成家族，默认全部")
    gen.add_argument("--out", help="输出文件（相对 content/items/）")
    gen.add_argument("--dry-run", action="store_true", help="只生成不写盘")

    dump = sub.add_parser("dump", help="导出 JSON 供数据库导入")
    dump.add_argument("--out", help="输出路径")
    dump.add_argument("--version", default="v0.1.0", help="内容版本号")

    sch = sub.add_parser("schema", help="导出 JSON Schema")
    sch.add_argument("--out", help="输出目录")

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0

    handlers = {
        "validate": cmd_validate,
        "lint": cmd_lint,
        "stats": cmd_stats,
        "preview": cmd_preview,
        "generate": cmd_generate,
        "dump": cmd_dump,
        "schema": cmd_schema,
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
