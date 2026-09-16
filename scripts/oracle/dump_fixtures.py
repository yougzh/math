"""把 Python 侧的行为固化成 fixture —— 迁移期唯一的对拍基准。

⚠️ 只读脚本：不碰 content/、config/，也不往 build/ 写东西，
   只往 tests/oracle/fixtures/ 写。

为什么必须有
------------
Python 最终会被整体删除（S6）。删除之后，这些 fixture 就是"正确行为"的
唯一权威描述 —— 没有第二个实现可以对照了。所以：

  * S1~S3 期间必须把全部 fixture dump 出来并 `git add`；
  * S4 之后不再允许改 Python；
  * S6 删除前先确认 fixture 已提交、且 CI 只依赖 fixture 不再依赖 Python。

序列化为什么是 sort_keys=True + 紧凑分隔符
------------------------------------------
**键有序 + 无空白 = 字节确定的黄金文件**，diff 干净、不因格式化噪声抖动。
注意 sort_keys 只影响对象键的顺序，**数组顺序原样保留** —— 数组顺序恰恰是
要断言的东西（items / slots / stories 的排序、story beats 的 sequence 顺序）。

用法
----
    python3 scripts/oracle/dump_fixtures.py content     # 只 dump 内容
    python3 scripts/oracle/dump_fixtures.py all         # 全部（随阶段增补）
"""
from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

FIXTURE_DIR = os.path.join(ROOT, "tests", "oracle", "fixtures")


def _write(name: str, payload) -> str:
    if not os.path.isdir(FIXTURE_DIR):
        os.makedirs(FIXTURE_DIR)
    path = os.path.join(FIXTURE_DIR, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fh.write("\n")
    return path


# ── content ────────────────────────────────────────────────
def dump_content() -> str:
    """`content_cli dump` 的全量输出 + loader 的两项运行时事实。

    为什么不直接 `python3 -m tools.content_cli dump` 捞文件：
      那个命令写的是 build/content_dump.json，而且格式（indent=2）与 fixture 不同。
      这里直接调同一个代码路径，再按 fixture 的规范序列化 —— 少一次"读文件再解析"
      的往返，也避免 build/ 里的陈旧文件把 fixture 带偏。

    多 dump 的两项（load_order / competency_terms）是 `cmd_dump` 不含、
    但 TS 运行时必须有的内容事实，理由见 src/content/types.ts 的 ContentIndex。
    """
    from backend.content.loader import load_bundle

    dump_path = os.path.join(ROOT, "build", "content_dump.json")
    if not os.path.isfile(dump_path):
        raise SystemExit(
            "找不到 build/content_dump.json。\n"
            "先跑 `make content-dump`（或 python3 -m tools.content_cli dump）再 dump fixture ——\n"
            "fixture 必须与 build/ 里那份是同一份产物，否则对拍比的是两个东西。"
        )
    with open(dump_path, encoding="utf-8") as fh:
        payload = json.load(fh)

    bundle = load_bundle()
    if bundle.load_problems:
        raise SystemExit(
            "内容存在加载期问题，fixture 不可信：\n  "
            + "\n  ".join(bundle.load_problems)
        )

    # 交叉核对：build/content_dump.json 必须与当前内容一致。
    # 内容改过但忘了重新 dump 时，这里会立刻发现 —— 否则 fixture 会固化成
    # 一份"过期的正确"，之后 TS 对拍全绿但两边都是错的。
    counts = payload.get("counts") or {}
    expected = {
        "competencies": len(bundle.competencies),
        "patterns": len(bundle.patterns),
        "items": len(bundle.items),
        "misconceptions": len(bundle.misconceptions),
        "slots": len(bundle.slots),
        "stories": len(bundle.stories),
    }
    if counts != expected:
        raise SystemExit(
            "build/content_dump.json 已过期，先重新跑 `make content-dump`：\n"
            "  build/ 里: {}\n  当前内容: {}".format(counts, expected)
        )

    payload["load_order"] = {
        "competencies": list(bundle.competencies),
        "patterns": list(bundle.patterns),
        "misconceptions": list(bundle.misconceptions),
        "items": list(bundle.items),
        "slots": list(bundle.slots),
        "stories": list(bundle.stories),
    }
    payload["competency_terms"] = {
        code: list(comp.terms) for code, comp in bundle.competencies.items()
    }
    return _write("content_parity.json", payload)


# ── cognitive ──────────────────────────────────────────────
#
# 为什么这一块**不用真实内容**，而是手工合成的题
# --------------------------------------------------
# 实测：真实内容的 1373 道题在 check_all / lint_all 下**一条报错都没有**。
# 也就是说，"拿真实内容对拍"这件事在这里的约束力是**零** —— TS 侧哪怕把
# 13 条规则全删光、只剩 `return []`，对拍依然全绿。
#
# 所以这里的每一道题都是**为触发某个分支而构造的**，并且 fixture 里带上
# `rules`（Python 侧 STRUCTURE_RULES 的完整快照）。TS 测试要交叉断言两件事：
#   1. 自己的规则表与 fixture.rules 逐字段一致（顺序、label、patterns 都不能变）
#   2. 每条规则至少被某条 case 触发过（否则 fixture 本身在空转）
#
# 分支覆盖是**逐 `if` 行**做的，不是"每个函数一条"。死分支也要覆盖：
# `_rule_make_ten` 的第三段（`10 - a >= b`）在前一段 `a + b <= 10` 之后
# 恒不可达 —— 保留它（逐字照抄），并由一条 case 证明"它确实不报"。


def _probe(**kw):
    """构造一道合成题。只喂给 check_all / lint_all，不进任何索引。"""
    from backend.content.loader import Item

    base = dict(
        code="probe",
        competency_id="probe_comp",
        pattern_id="direct_compute",
        difficulty=1,
        scaffold_level="direct",
        interaction_type="numeric",
        estimated_seconds=10,
        problem={},
        answer=0,
        steps=[],
        hint_chain=[],
        error_rules=[],
        steps_style="guide",
    )
    base.update(kw)
    return Item(**base)


# (名称, 说明, 构造参数) —— 名称即"想触发什么"，说明写清期望
CASES = [
    # ── sd_add_10 / 和不超过 10 ───────────────────────────
    ("sd_add_10.和超10", "a+b=14>10",
     dict(competency_id="sd_add_10", problem={"a": 9, "b": 5}, answer=14)),
    ("sd_add_10.两位数操作数", "a=10 时 a+b=10 不触发第一条，走第二条",
     dict(competency_id="sd_add_10", problem={"a": 10, "b": 0}, answer=10)),
    ("sd_add_10.正常", "3+4=7 全部通过",
     dict(competency_id="sd_add_10", problem={"a": 3, "b": 4}, answer=7)),

    # ── sd_sub_10 / 10 以内减法 ───────────────────────────
    # 注意这些题必须带 op="sub"：solve() 的默认分支按 op 决定加减，
    # 少了它独立求解会算成加法，check_answer 会跟着报"答案不一致" —— 那是在
    # 测 solve 而不是在测这条认知规则。（真实内容里 0 报错，反证它们都带了 op。）
    ("sd_sub_10.被减数超10", "a=13>10",
     dict(competency_id="sd_sub_10", problem={"a": 13, "b": 2, "op": "sub"}, answer=11)),
    ("sd_sub_10.减数为0", "b=0<1",
     dict(competency_id="sd_sub_10", problem={"a": 5, "b": 0, "op": "sub"}, answer=5)),
    ("sd_sub_10.负数结果", "3-5=-2",
     dict(competency_id="sd_sub_10", problem={"a": 3, "b": 5, "op": "sub"}, answer=-2)),
    ("sd_sub_10.正常", "9-4=5",
     dict(competency_id="sd_sub_10", problem={"a": 9, "b": 4, "op": "sub"}, answer=5)),
    # 同一条 case 同时命中「10 以内减法」与 null 能力的「目标大于已知部分」，
    # 用来钉住**多条规则同时命中时的顺序**
    ("sd_sub_10.missing_part_双规则", "pattern=missing_part 走 sub_pair 换算，且命中两条规则",
     dict(competency_id="sd_sub_10", pattern_id="missing_part",
          problem={"known": 9, "target": 4}, answer=-5)),

    # ── sd_sub_20 / 20 以内退位减法 ───────────────────────
    ("sd_sub_20.被减数越界", "a=9 不在 11~20",
     dict(competency_id="sd_sub_20", problem={"a": 9, "b": 2, "op": "sub"}, answer=7)),
    ("sd_sub_20.负数结果", "15-20=-5（在个位判断之前）",
     dict(competency_id="sd_sub_20", problem={"a": 15, "b": 20, "op": "sub"}, answer=-5)),
    ("sd_sub_20.个位够减", "15-3：个位 5≥3 不是退位",
     dict(competency_id="sd_sub_20", problem={"a": 15, "b": 3, "op": "sub"}, answer=12)),
    ("sd_sub_20.正常", "15-8：个位 5<8 且结果 7",
     dict(competency_id="sd_sub_20", problem={"a": 15, "b": 8, "op": "sub"}, answer=7)),
    ("sd_sub_20.边界20", "20-18：a=20 是闭区间上界，个位 0<8",
     dict(competency_id="sd_sub_20", problem={"a": 20, "b": 18, "op": "sub"}, answer=2)),

    # ── sd_add_20 / 和在 11~20 ────────────────────────────
    ("sd_add_20.和太小", "3+4=7",
     dict(competency_id="sd_add_20", problem={"a": 3, "b": 4}, answer=7)),
    ("sd_add_20.和太大", "9+9=18 正常，10+11=21 越界",
     dict(competency_id="sd_add_20", problem={"a": 10, "b": 11}, answer=21)),
    ("sd_add_20.边界11", "5+6=11 是闭区间下界",
     dict(competency_id="sd_add_20", pattern_id="total", problem={"a": 5, "b": 6}, answer=11)),
    ("sd_add_20.边界20", "10+10=20 是闭区间上界",
     dict(competency_id="sd_add_20", pattern_id="total", problem={"a": 10, "b": 10}, answer=20)),

    # ── make_ten / 必须需要凑十 ───────────────────────────
    ("make_ten.加数超10", "a=12≥10",
     dict(competency_id="make_ten", pattern_id="decompose",
          problem={"a": 12, "b": 5}, answer=17)),
    ("make_ten.和不足10", "3+5=8 用不上凑十",
     dict(competency_id="make_ten", pattern_id="decompose",
          problem={"a": 3, "b": 5}, answer=8)),
    ("make_ten.和恰为10", "9+1=10：不算大于 10，报「和不足」而非第三段",
     dict(competency_id="make_ten", pattern_id="decompose",
          problem={"a": 9, "b": 1}, answer=10)),
    ("make_ten.正常", "8+5=13：需要凑十",
     dict(competency_id="make_ten", pattern_id="decompose",
          problem={"a": 8, "b": 5}, answer=13)),

    # ── carry_add / 个位相加满十 ──────────────────────────
    ("carry_add.个位不满十", "11+12：个位 1+2=3",
     dict(competency_id="carry_add", problem={"a": 11, "b": 12}, answer=23)),
    ("carry_add.个位恰为10", "个位 4+6=10 是闭边界，不报",
     dict(competency_id="carry_add", pattern_id="combine",
          problem={"a": 14, "b": 6}, answer=20)),
    ("carry_add.正常", "8+7=15：个位 8+7=15≥10",
     dict(competency_id="carry_add", problem={"a": 8, "b": 7}, answer=15)),
    ("carry_add.非direct_pattern", "carry_exchange 也在 patterns 里，同样受检",
     dict(competency_id="carry_add", pattern_id="carry_exchange",
          problem={"a": 21, "b": 13}, answer=34)),

    # ── td_add_nocarry / 个位不进位 ───────────────────────
    ("td_add_nocarry.个位满十", "15+17：个位 5+7=12",
     dict(competency_id="td_add_nocarry", problem={"a": 15, "b": 17}, answer=32)),
    ("td_add_nocarry.全是位数", "3+4=7：没有两位数操作数",
     dict(competency_id="td_add_nocarry", problem={"a": 3, "b": 4}, answer=7)),
    ("td_add_nocarry.正常", "12+3=15：个位 2+3=5 且有一个两位数",
     dict(competency_id="td_add_nocarry", problem={"a": 12, "b": 3}, answer=15)),

    # ── borrow_sub / 个位不够减 ───────────────────────────
    ("borrow_sub.个位够减", "15-3：个位 5≥3 不是退位",
     dict(competency_id="borrow_sub", problem={"a": 15, "b": 3, "op": "sub"}, answer=12)),
    ("borrow_sub.正常", "15-8：个位 5<8",
     dict(competency_id="borrow_sub", problem={"a": 15, "b": 8, "op": "sub"}, answer=7)),
    ("borrow_sub.missing_part_换算", "missing_part 下 sub_pair 读 target/known",
     dict(competency_id="borrow_sub", pattern_id="missing_part",
          problem={"known": 8, "target": 15}, answer=7)),

    # ── td_sub_nocarry / 个位够减 ─────────────────────────
    ("td_sub_nocarry.个位不够减", "15-8：个位 5<8",
     dict(competency_id="td_sub_nocarry", problem={"a": 15, "b": 8, "op": "sub"}, answer=7)),
    ("td_sub_nocarry.正常", "15-3：个位 5≥3",
     dict(competency_id="td_sub_nocarry", problem={"a": 15, "b": 3, "op": "sub"}, answer=12)),

    # ── represent_place_value / 必须是两位数（competency 不限）──
    ("place_value.一位数", "7<10",
     dict(competency_id="probe_comp", pattern_id="represent_place_value",
          problem={"a": 7, "ask": "tens"}, answer=0)),
    ("place_value.ask_非法", "ask=hundreds",
     dict(competency_id="probe_comp", pattern_id="represent_place_value",
          problem={"a": 42, "ask": "hundreds"}, answer=2)),
    ("place_value.ask_缺失", "problem 里没有 ask 键",
     dict(competency_id="probe_comp", pattern_id="represent_place_value",
          problem={"a": 42}, answer=2)),
    ("place_value.ask_空值", "ask 键存在但是 null —— pyGet 不取默认值（与 ?? 的差异在此不可观测，但语义必须一致）",
     dict(competency_id="probe_comp", pattern_id="represent_place_value",
          problem={"a": 42, "ask": None}, answer=2)),
    ("place_value.问十位", "ask=tens，42→4",
     dict(competency_id="probe_comp", pattern_id="represent_place_value",
          problem={"a": 42, "ask": "tens"}, answer=4)),
    ("place_value.问个位", "ask=ones，42→2",
     dict(competency_id="probe_comp", pattern_id="represent_place_value",
          problem={"a": 42, "ask": "ones"}, answer=2)),

    # ── decompose / 拆分必须有意义（competency 不限）──────
    ("decompose.两数都太小", "max(3,4)=4<5",
     dict(competency_id="probe_comp", pattern_id="decompose",
          problem={"a": 3, "b": 4}, answer=7)),
    ("decompose.恰好5", "max(5,3)=5 是闭边界，不报",
     dict(competency_id="probe_comp", pattern_id="decompose",
          problem={"a": 5, "b": 3}, answer=8)),

    # ── missing_part / 目标大于已知部分（competency 不限）──
    ("missing_part.目标不大于已知", "target=5 <= known=8",
     dict(competency_id="probe_comp", pattern_id="missing_part",
          problem={"known": 8, "target": 5}, answer=-3)),
    ("missing_part.正常", "known=5 target=13",
     dict(competency_id="probe_comp", pattern_id="missing_part",
          problem={"known": 5, "target": 13}, answer=8)),

    # ── reverse / 结果大于增加量（competency 不限）────────
    ("reverse.增加量不小于结果", "added=13 >= result=10",
     dict(competency_id="probe_comp", pattern_id="reverse",
          problem={"result": 10, "added": 13}, answer=-3)),
    ("reverse.正常", "result=13 added=5",
     dict(competency_id="probe_comp", pattern_id="reverse",
          problem={"result": 13, "added": 5}, answer=8)),

    # ── problem 缺失 / 类型异常 ───────────────────────────
    ("空problem", "所有规则都拿不到数，全部跳过",
     dict(competency_id="sd_add_10", problem={}, answer=0)),
    ("字符串数字", 'a="8" —— Python int("8")',
     dict(competency_id="sd_add_10", problem={"a": "8", "b": "5"}, answer=13)),
    ("下划线数字", 'a="1_000" —— Python int("1_000")==1000',
     dict(competency_id="sd_add_10", problem={"a": "1_000", "b": 5}, answer=1005)),
    ("非法数字", 'a="abc" → int() 抛 ValueError → None → 规则跳过',
     dict(competency_id="sd_add_10", problem={"a": "abc", "b": 5}, answer=5)),
    ("布尔值不是整数", "a=True —— isinstance(True, bool) 先判，不能当 1",
     dict(competency_id="sd_add_10", problem={"a": True, "b": 5}, answer=5)),

    # ── solve / check_answer ──────────────────────────────
    # 这一节用 probe_comp：没有任何规则匹配这个能力，输出里就只有 check_answer
    # 的声音，不会被认知规则混进来。
    ("check_answer.不一致", "内容写 6，独立求解 13",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=6)),
    ("check_answer.不是整数", 'answer="abc"',
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer="abc")),
    ("check_answer.小数答案", "answer=13.5 —— Python 里 isinstance(13.5,int) 为假，走 int('13.5') 抛错",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13.5)),
    ("check_answer.字符串答案", 'answer="13" 可转 → 通过',
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer="13")),
    ("check_answer.op_sub", "op=sub → a-b",
     dict(competency_id="probe_comp", problem={"a": 13, "b": 5, "op": "sub"}, answer=8)),
    ("check_answer.op_空值", "op=null → str(None)='None' ≠ 'sub' → 走加法",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5, "op": None}, answer=13)),
    ("check_answer.op_中文加", 'op="加" —— 只有 "sub" 走减法，其余一律加法',
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5, "op": "加"}, answer=13)),
    ("check_answer.number_friends", "pattern=number_friends → target-a",
     dict(competency_id="probe_comp", pattern_id="number_friends",
          problem={"a": 8, "target": 13}, answer=5)),
    ("check_answer.solve_返回None", "problem 缺 a → solve 为 None → 不产生问题",
     dict(competency_id="probe_comp", pattern_id="direct_compute",
          problem={"b": 5}, answer=999)),

    # ── check_steps / step_equalities ─────────────────────
    ("steps.算错", "8+5 写成 12",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["8 + 5 = 12"])),
    ("steps.连算正常", "2+3+4=9",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["2 + 3 + 4 = 9"])),
    ("steps.中文别名", "「13 减去 3 = 10」",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["13 减去 3 = 10"])),
    ("steps.全角等号", "「8 + 5 ＝ 13」",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["8 + 5 ＝ 13"])),
    ("steps.乘法", "「3 × 4 = 12」",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["3 × 4 = 12"])),
    ("steps.除法整除", "「12 ÷ 4 = 3」",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["12 ÷ 4 = 3"])),
    ("steps.除法不整除", "7÷2 不整除 → _eval_chain 返回 None → 等式被跳过",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["7 ÷ 2 = 3"])),
    ("steps.除零", "7÷0 → 返回 None → 跳过",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["7 ÷ 0 = 0"])),
    ("steps.结论与答案矛盾", "答案 13，步骤写的是 8+4=12（从别的题复制）",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["8 + 4 = 12"])),
    ("steps.答案以数字出现", "答案 13 出现在步骤正文里 → 不报矛盾",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["先凑十，再算 13"])),
    ("steps.无等式且无答案", "只有文字，没有等式 → 矛盾检查的 for 循环不执行",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["先凑十", "再心算"])),
    ("steps.算错时短路", "有算式错误时，不再检查结论矛盾",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["8 + 5 = 12"])),
    ("steps.多个等式", "同一题多个等式，逐个校验",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["8 + 2 = 10", "10 + 3 = 13"])),
    ("steps.多余token不解析", "「8 + 5 = 13 因为…」尾部文字不影响等式匹配",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["8 + 5 = 13 因为凑十"])),
    ("steps.答案非整数时跳过", "answer 是 None → 不做矛盾检查",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=None,
          steps=["8 + 4 = 12"])),
    # 连算里插中文别名 —— 表达式本身含中文时 _TOKEN 的切分是否正确
    ("steps.中文连算", "「13 减去 3 + 1 = 11」",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["13 减去 3 + 1 = 11"])),
    # 只写中文运算符不加空格
    ("steps.无空格", "「8+5=13」",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["8+5=13"])),
    # 星号/斜杠（ASCII）也是别名
    ("steps.ASCII别名", "「3 * 4 = 12」「12 / 4 = 3」",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["3 * 4 = 12", "12 / 4 = 3"])),

    # ── lint_steps ────────────────────────────────────────
    ("lint.conclude未到答案", "steps_style=conclude 但全程没有 13",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["8 + 5"], steps_style="conclude")),
    ("lint.conclude已到答案", "等式写到了 13 → 不报",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["8 + 5 = 13"], steps_style="conclude")),
    ("lint.conclude答案只是出现", "答案以普通数字出现也算 → 不报",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["凑十后剩下 13"], steps_style="conclude")),
    ("lint.guide不检查", "默认 guide：最后一步就该留给孩子",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=["8 + 5"], steps_style="guide")),
    ("lint.conclude答案非整数", "answer 不是整数 → 不检查",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer="abc",
          steps=["8 + 5"], steps_style="conclude")),
    ("lint.conclude无steps", "空 steps 且答案不在文本里 → 报",
     dict(competency_id="probe_comp", problem={"a": 8, "b": 5}, answer=13,
          steps=[], steps_style="conclude")),
]


def dump_cognitive() -> str:
    """check_all / lint_all 的分支覆盖 fixture（合成题，不依赖真实内容）。"""
    import dataclasses

    from backend.content.cognitive import STRUCTURE_RULES, check_all, lint_all

    cases = []
    for name, note, kwargs in CASES:
        item = _probe(**kwargs)
        cases.append(
            {
                "name": name,
                "note": note,
                "item": dataclasses.asdict(item),
                "check": check_all(item),
                "lint": lint_all(item),
            }
        )

    payload = {
        # 规则表的完整快照 —— TS 侧要断言自己的表与它逐字段一致
        "rules": [
            {
                "competency": competency,
                "patterns": list(patterns) if patterns is not None else None,
                "label": label,
            }
            for competency, patterns, label, _ in STRUCTURE_RULES
        ],
        "cases": cases,
    }
    return _write("cognitive_parity.json", payload)


# ── config ─────────────────────────────────────────────────
#
# 为什么这里**主要靠真实配置**（与 cognitive 相反）
# ------------------------------------------------
# v0.yaml 有几十个阈值，而 AlgorithmConfig 的每个访问器都会读到其中至少一个 ——
# 拿真实配置跑一遍就是一次接近全量的覆盖。真正测不到的只有"配置写错/缺段"那类
# 分支（缺 default、weight 为 0、ceiling<=floor……），那部分用合成配置补。
#
# 对拍方式：**调用表达式即 key**，参数由 Python 侧生成成 JSON 字面量
# （`target_difficulty[null,1,5]`），TS 侧原样解析再调用。
# 这样两侧用的**是同一组参数** —— 不会出现"我以为你测的是 (0.5,1,5)"这类偏差。

CONFIG_EXPRESSIONS = [
    # 属性
    "version",
    "ewma_alpha",
    "min_samples_for_level",
    "assessment_blocks_upgrade",
    "level_order",
    "confidence_alpha",
    "min_practice_samples",
    "thinking_normal_max_ms",
    "uncertain_max_ms",
    "idle_dominated_ratio",
    "review_intervals_days",
    "recent_attempt_window",
    # 无参方法
    "upgrade_requires[]",
    "new_pattern_success_rule[]",
    "fallback_triggers[]",
    "default_avoid_recent[]",
    "min_avoid_recent[]",
    "max_difficulty_step_up[]",
    "daily_plan[]",
    "intent_config[]",
    "generic_error_rules[]",
    # 评估权重
    "alpha_for[false]",
    "alpha_for[true]",
    # 等级
    "level_label[\"encountering\"]",
    "level_label[\"automatic\"]",
    "level_label[\"nope\"]",
    "level_label[\"\"]",
    "level_thresholds[\"encountering\"]",
    "level_thresholds[\"understanding\"]",
    "level_thresholds[\"can_do\"]",
    "level_thresholds[\"proficient\"]",
    "level_thresholds[\"automatic\"]",
    "level_thresholds[\"nope\"]",
    # 采样
    "mastery_sample[true,0]",
    "mastery_sample[true,1]",
    "mastery_sample[true,3]",
    "mastery_sample[false,0]",
    "mastery_sample[false,5]",
    "independence_sample[0]",
    "independence_sample[1]",
    "independence_sample[2]",
    "independence_sample[5]",
    # 负数提示次数：Python 是 max(0, hints_used)，不能写成 hints_used
    "independence_sample[-1]",
    "fluency_score_for_ratio[-1]",
    "fluency_score_for_ratio[0]",
    "fluency_score_for_ratio[0.5]",
    "fluency_score_for_ratio[0.75]",
    "fluency_score_for_ratio[0.76]",
    "fluency_score_for_ratio[1.0]",
    "fluency_score_for_ratio[1.01]",
    "fluency_score_for_ratio[1.5]",
    "fluency_score_for_ratio[1.51]",
    "fluency_score_for_ratio[2.5]",
    "fluency_score_for_ratio[2.51]",
    "fluency_score_for_ratio[999.0]",
    "fluency_score_for_ratio[1000]",
    "confidence_sample[true]",
    "confidence_sample[false]",
    # 脚手架
    "scaffold_for_mastery[null]",
    "scaffold_for_mastery[0]",
    "scaffold_for_mastery[0.29]",
    "scaffold_for_mastery[0.3]",
    "scaffold_for_mastery[0.59]",
    "scaffold_for_mastery[0.6]",
    "scaffold_for_mastery[1.0]",
    # 目标难度
    "target_difficulty[null,1,5]",
    "target_difficulty[0,1,5]",
    "target_difficulty[0.5,1,5]",
    "target_difficulty[0.75,1,5]",
    "target_difficulty[1,1,5]",
    "target_difficulty[1.5,1,5]",
    "target_difficulty[-0.5,1,5]",
    "target_difficulty[0.5,3,3]",
    "target_difficulty[0.5,5,3]",
    # position≠0 的倒置区间：high<=low 的短路与后面的公式只在 position≠0 时有区别
    # （变异测试发现：原用例 mastery=0.5 恰好让 position=0，短路被删掉都测不出来）
    "target_difficulty[1.0,5,3]",
    "target_difficulty[1.0,-1,-3]",
    "target_difficulty[0.75,0,10]",
    "target_difficulty[null,0,0]",
    # fluency 阈值
    "fluency_threshold_ms[\"carry_exchange\",\"carry_exchange\"]",
    "fluency_threshold_ms[\"combine\",\"choice\"]",
    "fluency_threshold_ms[\"combine\",\"blocks\"]",
    "fluency_threshold_ms[\"direct_compute\",\"number_pad\"]",
    "fluency_threshold_ms[\"nope\",\"choice\"]",
    "fluency_threshold_ms[\"direct_compute\",\"nope\"]",
    "fluency_threshold_ms[\"nope\",\"nope\"]",
    "fluency_threshold_ms[\"represent_place_value\",\"blocks\"]",
    # section
    "section[\"smoothing\",\"ewma_alpha\"]",
    "section[\"daily_plan\"]",
]

# 合成配置：只针对"真实配置里到不了"的分支
CONFIG_SYNTHETIC = [
    (
        "difficulty_target 的 ceiling<=floor 退化为阈值比较",
        {"version": 0, "selection": {"difficulty_target": {
            "mastery_floor": 0.8, "mastery_ceiling": 0.8, "unknown_position": 0.5}}},
        ["target_difficulty[0.0,1,5]", "target_difficulty[0.79,1,5]",
         "target_difficulty[0.8,1,5]", "target_difficulty[0.81,1,5]",
         "target_difficulty[null,1,5]"],
    ),
    (
        "缺 assessment 段：alphaFor 不加权、blocks_upgrade 默认 True",
        {"version": 0, "smoothing": {"ewma_alpha": 0.4}},
        ["ewma_alpha", "alpha_for[false]", "alpha_for[true]", "assessment_blocks_upgrade"],
    ),
    (
        "assessment.weight=0 是 falsy：不加权",
        {"version": 0, "smoothing": {"ewma_alpha": 0.4},
         "assessment": {"weight": 0, "blocks_upgrade": False}},
        ["alpha_for[true]", "assessment_blocks_upgrade"],
    ),
    (
        "assessment.weight 键存在但为 null：falsy，不加权",
        {"version": 0, "smoothing": {"ewma_alpha": 0.4}, "assessment": {"weight": None}},
        ["alpha_for[true]"],
    ),
    (
        "assessment.weight=0.25 是真值：加权",
        {"version": 0, "smoothing": {"ewma_alpha": 0.4}, "assessment": {"weight": 0.25}},
        ["alpha_for[true]"],
    ),
    (
        "upgrade_requires 只有旧键 min_samples",
        {"version": 0, "upgrade_requires": {"min_samples": 7}},
        ["min_practice_samples"],
    ),
    (
        "upgrade_requires 两个键都有：新键优先",
        {"version": 0, "upgrade_requires": {"min_samples": 7, "min_practice_samples": 2}},
        ["min_practice_samples"],
    ),
    (
        "upgrade_requires 都为 0（falsy 但存在）",
        {"version": 0, "upgrade_requires": {"min_samples": 0, "min_practice_samples": 0}},
        ["min_practice_samples"],
    ),
    (
        "new_pattern_success 缺失 → {}",
        {"version": 0, "upgrade_requires": {}},
        ["new_pattern_success_rule[]"],
    ),
    (
        "fluency_thresholds 整段缺失 → 回退硬编码 20 秒",
        {"version": 0},
        ["fluency_threshold_ms[\"direct_compute\",\"choice\"]"],
    ),
    (
        "pattern 命中但 interaction 未命中 → 回退 default 段",
        {"version": 0, "fluency_thresholds": {
            "direct_compute": {"blocks": 9}, "default": {"choice": 7}}},
        ["fluency_threshold_ms[\"direct_compute\",\"choice\"]",
         "fluency_threshold_ms[\"direct_compute\",\"blocks\"]"],
    ),
    (
        "配了 0 秒：是有效值，不能当成缺失去回退",
        {"version": 0, "fluency_thresholds": {
            "direct_compute": {"choice": 0}, "default": {"choice": 7}}},
        ["fluency_threshold_ms[\"direct_compute\",\"choice\"]"],
    ),
    (
        "小数秒数：int(float(x)*1000) 的浮点截断",
        {"version": 0, "fluency_thresholds": {"default": {"choice": 2.675}}},
        ["fluency_threshold_ms[\"direct_compute\",\"choice\"]"],
    ),
    (
        "idle_dominated_ratio / recent_attempt_window / generic_error_rules 的 default",
        {"version": 0},
        ["idle_dominated_ratio", "recent_attempt_window", "generic_error_rules[]"],
    ),
    (
        "level_thresholds 缺失 → {}",
        {"version": 0},
        ["level_thresholds[\"can_do\"]"],
    ),
    (
        "scaffold_fading 两个阈值相等：第二档不可达",
        {"version": 0, "scaffold_fading": {
            "blocks_below_mastery": 0.4, "decompose_below_mastery": 0.4}},
        ["scaffold_for_mastery[0.39]", "scaffold_for_mastery[0.4]"],
    ),
]


def _eval_expression(subject, expression: str):
    """执行 `name` 或 `name[arg,arg]` 形式的调用表达式。

    参数是 JSON 字面量（由这里生成、由 TS 侧解析），保证两侧**同一组参数**。
    subject 可以是 AlgorithmConfig、CompetencyGraph —— 只要求有同名成员。
    """
    import re as _re

    matched = _re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?", expression)
    if matched is None:
        raise SystemExit("无法解析的调用表达式: {}".format(expression))
    name, args_text = matched.group(1), matched.group(2)
    target = getattr(subject, name)
    if args_text is None:
        return target
    args = json.loads("[" + args_text + "]") if args_text else []
    return target(*args)


def _run_expressions(config, expressions):
    return {expr: _eval_expression(config, expr) for expr in expressions}


def dump_config() -> str:
    """AlgorithmConfig 的全部访问器 —— 真实配置为主，合成配置补边界。"""
    from backend.engine.config import AlgorithmConfig, load_config

    real = load_config(0)
    payload = {
        "real": _run_expressions(real, CONFIG_EXPRESSIONS),
        "expressions": CONFIG_EXPRESSIONS,
        "synthetic": [
            {
                "name": name,
                "raw": raw,
                "expressions": expressions,
                "values": _run_expressions(AlgorithmConfig(raw), expressions),
            }
            for name, raw, expressions in CONFIG_SYNTHETIC
        ],
    }
    return _write("config_parity.json", payload)


# ── graph ──────────────────────────────────────────────────
#
# 真实图 + 合成图，缺一不可：
#
#   * 真实图（10 个能力）覆盖"正常查询"：前置、传递闭包、依赖者、pattern 列表、
#     拓扑序。表达式按能力 code **动态生成**，内容加一个能力就自动多三条。
#   * 合成图覆盖**真实内容里到不了的分支**：环、自依赖、孤立节点、没有 pattern
#     的能力、以及 —— 最容易被忽略的一条 —— **stage 不同的能力**。
#
#     最后这条是本次迁移反复出现的同一个盲区：真实内容里 10 个能力**全是
#     stage 1**，于是 `topological_order` 的排序键 `(stage, code)` 退化成 `code`，
#     把 stage 那一维删掉也照样对拍全绿。合成图里必须放一个 stage 不同的能力，
#     让两种排序给出**不同**的拓扑序。

GRAPH_EXPRESSIONS_REAL = [
    "topological_order[]",
    "validate[]",
    "find_cycles[]",
]


def _plain(value):
    """dataclass / dict / list → 纯 JSON 结构（fixture 里不能有 Python 对象）"""
    import dataclasses

    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: _plain(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def _graph_expressions_for(codes):
    """每个能力三条查询 —— 动态生成，避免 fixture 里硬编 code"""
    out = []
    for code in codes:
        out.append('prerequisites["{}",false]'.format(code))
        out.append('prerequisites["{}",true]'.format(code))
        out.append('dependents["{}"]'.format(code))
        out.append('patterns_for["{}"]'.format(code))
    out.append('prerequisites["nope",false]')
    out.append('prerequisites["nope",true]')
    out.append('dependents["nope"]')
    out.append('patterns_for["nope"]')
    return out


def _synth_bundle(competencies, patterns=None, stages=None):
    """造一张合成图。competencies: {code: [前置…]}；patterns: {code: (认知类型, 主能力)}。

    patterns 缺省时给**每个能力**配一个 pattern —— 这样 validate 的输出里
    只有被刻意制造的那条问题，不会被"没有可用 pattern"淹没。
    """
    from backend.content.loader import Competency, ContentBundle, Pattern

    stages = stages or {}
    comps = {}
    for code, prereqs in competencies.items():
        comps[code] = Competency(
            code=code, name=code, prerequisites=list(prereqs), stage=int(stages.get(code, 1))
        )
    if patterns is None:
        patterns = {
            "p_" + code: ("compute", code) for code in competencies
        }
    pats = {}
    for code, spec in patterns.items():
        ctype, primary = spec[0], spec[1]
        applicable = list(spec[2]) if len(spec) > 2 else []
        pats[code] = Pattern(
            code=code,
            name=code,
            cognitive_type=ctype,
            primary_competency=primary,
            applicable_competencies=applicable,
        )
    # 返回**实际用到**的 patterns —— fixture 里必须存生效的那份，
    # 否则 TS 侧拿到空的 patterns，会报出一堆"没有可用 pattern"
    return ContentBundle(competencies=comps, patterns=pats), patterns


GRAPH_SYNTHETIC = [
    (
        "环 a→b→a",
        {"a": ["b"], "b": ["a"]},
        None,
        None,
        ["find_cycles[]", "validate[]", "topological_order[]"],
    ),
    (
        # 插入顺序 z,y 与字典序 y,z 不同 —— find_cycles 迭代的是 sorted(keys)，
        # 所以环的入口是 y 而不是 z（报出来的环路径整体不同）
        "环 z→y→z：入口用排序后的最小 code",
        {"z": ["y"], "y": ["z"]},
        None,
        None,
        ["find_cycles[]", "validate[]", "topological_order[]"],
    ),
    (
        "自依赖 a→a",
        {"a": ["a"]},
        None,
        None,
        ["find_cycles[]", "validate[]", "topological_order[]"],
    ),
    (
        "孤立节点（无前置也无人依赖）：x 被 a 依赖、y 谁都不理",
        {"x": [], "a": ["x"], "y": []},
        None,
        None,
        ["validate[]", "topological_order[]"],
    ),
    (
        "没有可用 pattern 的能力：只给 b 配 pattern",
        {"a": ["b"], "b": []},
        {"p_b": ("compute", "b")},
        None,
        ["validate[]", "patterns_for[\"a\"]", "patterns_for[\"b\"]"],
    ),
    (
        "三节点环 + 挂在外面的尾巴",
        {"a": ["b"], "b": ["c"], "c": ["a"], "d": ["a"]},
        None,
        None,
        ["find_cycles[]", "validate[]", "topological_order[]"],
        # 拓扑序是 c,b,a,d。空集合时：无前置检查会返回 c，有检查则返回 None
        # （c 的前置 a 未掌握）。这是"next_unmastered 里那两个条件不是冗余的"
        # 唯一可观测场景 —— 无环图上第一个未掌握的节点必然满足前置条件。
        [[], ["b"]],
    ),
    (
        "菱形依赖：传递闭包要去重",
        {"a": ["b", "c"], "b": ["d"], "c": ["d"], "d": []},
        None,
        None,
        ["prerequisites[\"a\",true]", "prerequisites[\"a\",false]",
         "dependents[\"d\"]", "topological_order[]"],
        None,
        # a 的传递前置是 {b,c,d}，分数（len）全是 1 —— **全并列**，正好钉住
        # "并列时取 code 较小者"。实测真实内容 10 个能力里一个并列都没有
        # （用 len 当分数），所以这条只能在合成图上测。
        ["a"],
    ),
    (
        "stage 不同：topological_order 必须按 (stage, code) 而不是 code",
        {"z": [], "a": []},
        None,
        {"z": 1, "a": 2},
        ["topological_order[]", "validate[]"],
    ),
    (
        "stage 与前置混合：a 的 stage 更大但它是 z 的前置",
        {"a": [], "z": ["a"]},
        None,
        {"z": 1, "a": 9},
        ["topological_order[]"],
    ),
    (
        # code 序是 p0,p1,p2,p3，而 (cognitive_type, code) 序是 p3,p1,p2,p0 ——
        # 两种排序必须给出不同答案，否则这条用例抓不到"排序键退化"
        "patterns_for 的排序键是 (cognitive_type, code)：code 序与它不同",
        {"a": []},
        {"p3": ("apply", "a"), "p1": ("compute", "a"), "p2": ("compute", "a"),
         "p0": ("represent", "a")},
        None,
        ["patterns_for[\"a\"]"],
    ),
    (
        "dependents 必须排序：插入顺序与字典序不同",
        {"a": ["d"], "c": ["d"], "b": ["d"], "d": []},
        None,
        None,
        ["dependents[\"d\"]", "topological_order[]"],
    ),
    (
        "applicable_competencies 也能让 pattern 挂上（不只是 primary）",
        {"a": [], "b": []},
        {"p1": ("compute", "b", ["a"])},
        None,
        ["patterns_for[\"a\"]", "patterns_for[\"b\"]"],
    ),
    (
        "插入顺序影响 validate 的报错顺序（故意用逆字典序插入）",
        {"z": [], "m": [], "a": []},
        None,
        None,
        ["validate[]"],
    ),
]


def _graph_value(graph, expression):
    """求值 + 按查询类型做规范化。

    `patterns_for` 只留 code 列表：`cmd_dump` 会把 `applicable_competencies`
    规范化成 `sorted(set(...) | {primary})`（tools/content_cli/main.py:257），
    而 Python 运行时的 Pattern 保留 YAML 里的原始顺序 —— 两边这一项本来就不同，
    属于"S1-1 的 dump 形状损失"第三例（前两例：competency.terms 被丢掉、
    story.beats 从声明顺序变成 sequence 顺序）。

    该字段的唯一语义用途是 `applies_to` 的**成员检查**（loader.py / graph.py），
    顺序在所有使用点都无影响；字段值的正确性由 content-parity 对
    content.json 的逐字段比对负责。这里要比的是"哪些 pattern 挂到哪个能力、
    按什么顺序"—— code 列表恰好是这件事的完整描述。
    """
    value = _eval_expression(graph, expression)
    if expression.startswith("patterns_for["):
        return [pattern.code for pattern in value]
    return _plain(value)


def dump_graph() -> str:
    """CompetencyGraph 的全部查询 —— 真实图 + 合成图。"""
    from backend.content.loader import load_bundle
    from backend.engine.graph import CompetencyGraph

    bundle = load_bundle()
    graph = CompetencyGraph(bundle)

    expressions = GRAPH_EXPRESSIONS_REAL + _graph_expressions_for(bundle.competencies)
    real = {expr: _graph_value(graph, expr) for expr in expressions}

    # next_unmastered：把拓扑序的前 k 个当作"已掌握"，k 从 0 走到全部
    order = graph.topological_order()
    mastery_probes = []
    for k in range(len(order) + 1):
        mastered = order[:k]

        def is_mastered(code, _mastered=set(mastered)):
            return code in _mastered

        mastery_probes.append(
            {
                "name": "已掌握拓扑序前 {} 个".format(k),
                "mastered": list(mastered),
                "expect": graph.next_unmastered(is_mastered),
            }
        )

    # weakest_prerequisite：分数用 len(code)，天然会出现并列 → 顺便钉住"并列取 code 小"
    weakest_probes = [
        {
            "name": "{} 的最低分传递前置（分数 = code 长度）".format(code),
            "code": code,
            "expect": graph.weakest_prerequisite(code, len),
        }
        for code in bundle.competencies
    ]

    synthetic = []
    for row in GRAPH_SYNTHETIC:
        name, competencies, patterns, stages, exprs = row[:5]
        mastery_seeds = row[5] if len(row) > 5 else None
        weakest_seeds = row[6] if len(row) > 6 else None
        bundle_obj, effective_patterns = _synth_bundle(competencies, patterns, stages)
        synth_graph = CompetencyGraph(bundle_obj)
        entry = {
                "name": name,
                "competencies": competencies,
                # ⚠️ 顺序必须**单独存一份数组**：fixture 是 json.dump(sort_keys=True) 的，
                # 对象键会被字典序重排 —— 而 validate 迭代的正是 competencies 的
                # **插入顺序**。不存这个，"插入顺序影响报错顺序"那条用例就永远测不到
                # （TS 侧会按 a,m,z 建 Map，与 Python 的 z,m,a 不同）。
                "competency_order": list(competencies),
                "patterns": {
                    code: list(spec) for code, spec in effective_patterns.items()
                },
                "stages": stages or {},
                "expressions": exprs,
            "values": {expr: _graph_value(synth_graph, expr) for expr in exprs},
        }
        if mastery_seeds is not None:
            entry["mastery_probes"] = []
            for seed in mastery_seeds:
                mastered_set = set(seed)

                def is_mastered(code, _mastered=mastered_set):
                    return code in _mastered

                entry["mastery_probes"].append(
                    {
                        "mastered": list(seed),
                        "expect": synth_graph.next_unmastered(is_mastered),
                    }
                )
        if weakest_seeds is not None:
            entry["weakest_probes"] = [
                {
                    "code": seed,
                    "expect": synth_graph.weakest_prerequisite(seed, len),
                }
                for seed in weakest_seeds
            ]
        synthetic.append(entry)

    payload = {
        "real": real,
        "expressions": expressions,
        "mastery_probes": mastery_probes,
        "weakest_probes": weakest_probes,
        "synthetic": synthetic,
    }
    return _write("graph_parity.json", payload)


# ── pyint / pyre ───────────────────────────────────────────
#
# 这两个是"移植原语"，错了会渗透到所有用到它们的地方 —— 而且**静默**：
# int("1_000") 在 JS 里会被 parseInt 截成 1，正则少一个 alternation 只会少匹配。
# 所以这里用**穷举边界表**，而不是等业务对拍撞上。
#
# 已知差异（刻意保留、在 src/py/pyint.ts 里写明了）：
#   * Python 的 int() 接受全角/阿拉伯-印度数字（int("３") == 3），这里只认 ASCII ——
#     构建脚本断言内容里不含非 ASCII 十进制数字，所以这条在内容层不可观测；
#   * Python 的 3.0 是 float，走 int("3.0") 会抛错；JSON 里 3.0 与 3 不可区分，
#     这里当整数接受 —— 同样由构建脚本的"无小数常量"断言兜住。
# 这两个差异**故意不进 fixture**：进了就等于把"已知差异"固化成"期望行为"，
# 将来真修好了反而会报红。

PYINT_TEXT_CASES = [
    "3", " 3 ", "\t3\n", "+3", "-3", "0", "-0", "007", "+007",
    "1_000", "1_0_0", "_3", "3_", "1__0", "3abc", "abc", "3.0", "3.5", "0x10",
    "1e3", "inf", "nan", "True", "False", "None", "", "   ", "-", "+", "--3",
    "1 000", "  -42  ", "9" * 30,
]

# 刻意**不放** 3.0：Python 里它是 float（_int 走 int("3.0") → ValueError → None），
# 而 JSON 里 3.0 与 3 不可区分，ts 侧只会看到整数 3。这是 src/py/pyint.ts
# 头部记录的已知差异 —— 放进 fixture 就等于把它固化成"期望行为"。
PYINT_VALUE_CASES = [
    3, -3, 0, 7, 3.5, -0.5, True, False, None, "8", "-8", "1_000", "abc",
    " 42 ", 2 ** 40,
]

PYSTR_CASES = ["sub", "", "add", True, False, None, 0, 1, -1, 42]

EQUALITY_TEXTS = [
    "8 + 5 = 13",
    "8+5=13",
    "8 + 5 ＝ 13",
    "13 减去 3 = 10",
    "13 减 3 = 10",
    "3 × 4 = 12",
    "3 * 4 = 12",
    "12 ÷ 4 = 3",
    "12 / 4 = 3",
    "12 除以 4 = 3",
    "2 + 3 + 4 = 9",
    "2 + 3 + 4 + 5 = 14",
    "8 + 5 = 13 因为凑十",
    "先算 8 + 5 = 13",
    "8 + 5",
    "= 13",
    "8 + 5 = ",
    "8 + 5 = 12 = 13",
    "10 加 3 = 13",
    "10 加上 3 = 13",
    "18 - 5 - 3 = 10",
    "1 + 2 = 3 和 4 + 5 = 9",
    "",
    "没有任何算式",
    "7 + x = 10",
    "3.5 + 1 = 4",
    "008 + 005 = 13",
]

ARITH_TEXTS = [
    "8 + 5",
    "8+5",
    "13 减去 3",
    "13 减 3",
    "12 除以 4",
    "3 × 4",
    "3 * 4",
    "12 / 4",
    "10 加上 3",
    "2 + 3 + 4",
    "abc",
    "",
    "7 + x",
    "3.5 + 1",
    "＋3",     # 全角加号 —— 不匹配（不在 _OP_ALIASES 里）
    "1 2 3",
    "+-*/",
]

NUMBER_TEXTS = [
    "8 + 5 = 13",
    "先凑十，再算 13",
    "008 005",
    "abc",
    "",
    "3.5",
    "a1b2c3",
]

# Python round() 的边界表。混进 NSIG 的每一档，因为分歧只在特定位数上出现：
#   - 二进制精确半值（0.5 / 0.0625 / 0.4375…）→ 必须 half-even
#   - 十进制字面量的"假半值"（2.675 / 1.005 / 0.615）→ double 真值其实偏下，
#     Python 给 2.67、1.00、0.61 —— 任何"先乘后取整"的实现都会给成 2.68
#   - 1e21 / 1e22 → JS 的 toFixed 在这里转科学计数法（pyFormat1f 的已知失效点），
#     同时它们是指数 e >= 0 的分支（整数不需要除法，但要乘 2^e）
#   - 5e-324 → 最小次正规数，指数固定 -1074
#   - 0.0 / -0.0 → Python 的 int 没有负零，float 有
PYROUND_VALUES = [
    0.0, -0.0, 0.5, 1.5, 2.5, 3.5, 4.5, -0.5, -1.5, -2.5, -3.5, -4.5,
    0.05, 0.25, 0.125, 0.0625, 0.03125, 0.4375, 0.5625,
    2.675, 1.005, 0.615, 0.1, 0.2, 0.3, 0.1 + 0.2, 0.9999999999999999,
    1.0 / 3, 2.0 / 3, 1.0 / 7,
    1.0, 7.0, 20.25, 60.5, 123456789.987654321,
    1e15, 1e21, 1e22, 1e308, -1e308,
    5e-324, 2.2250738585072014e-308, 1e-10, 1e-20,
    0.16660000000000003, 0.72, 0.7999999999999999,
]

PYROUND_NDIGITS = [None, 0, 1, 2, 3, 4, 5, 6, 8, 10, -1, -2, -3, -5, 100]

# 随机 fuzz：手挑的边界再密也覆盖不到"随机位模式"里的次正规与极端指数。
# 刻意记下种子 —— fixture 必须能被独立重算出来，否则它只是一堆魔法数字。
#
# 定在 3000 而不是更多：开发期曾用 20000 例跑过（零差异），但那条的价值是**发现
# 未知 bug**，不是当回归基准 —— 回归靠的是上面那张手挑的边界表。20000 例会让
# fixture 从 3 KB 涨到 1.2 MB，对一个原语来说不成比例。要临时加大就改这个数。
PYROUND_FUZZ_SEED = 20260916
PYROUND_FUZZ_COUNT = 3000


def _pyround_fuzz_cases():
    import math
    import random
    import struct

    rng = random.Random(PYROUND_FUZZ_SEED)
    out = []
    while len(out) < PYROUND_FUZZ_COUNT:
        kind = rng.randrange(6)
        if kind == 0:
            value = rng.uniform(-1000, 1000)
        elif kind == 1:
            value = rng.random()  # quality / ratio 的真实域
        elif kind == 2:
            value = struct.unpack("<d", rng.getrandbits(64).to_bytes(8, "little"))[0]
            if not math.isfinite(value):
                continue  # JSON 表达不了 inf/nan
        elif kind == 3:
            value = rng.randrange(-100000, 100000) / 10 ** rng.randrange(1, 6)
        elif kind == 4:
            value = rng.randrange(-64, 64) / 2 ** rng.randrange(1, 12)
        else:
            value = rng.uniform(-1e18, 1e18)
        out.append((value, rng.choice(PYROUND_NDIGITS)))
    return out


def _round_case(value, ndigits):
    return {
        "value": value,
        "ndigits": ndigits,
        "expect": round(value) if ndigits is None else round(value, ndigits),
    }


def dump_py() -> str:
    """pyint / pyre / pyround 的边界表。"""
    from backend.content import cognitive

    def int_from_text(text):
        try:
            return int(text.strip())
        except (TypeError, ValueError):
            return None

    payload = {
        "py_int_from_text": [
            {"input": text, "expect": int_from_text(text)} for text in PYINT_TEXT_CASES
        ],
        "py_int": [
            {"input": value, "expect": cognitive._int(value)} for value in PYINT_VALUE_CASES
        ],
        "py_str": [{"input": value, "expect": str(value)} for value in PYSTR_CASES],
        "equality": {
            text: [
                [match.group(1), match.group(2)]
                for match in cognitive._EQUALITY.finditer(text)
            ]
            for text in EQUALITY_TEXTS
        },
        "arith_tokens": {
            text: cognitive._TOKEN.findall(text) for text in ARITH_TEXTS
        },
        "number_tokens": {
            text: sorted({int(token) for token in cognitive._NUMBER_TOKEN.findall(text)})
            for text in NUMBER_TEXTS
        },
        "op_pattern": cognitive._OP_PATTERN,
        "op_aliases": dict(cognitive._OP_ALIASES),
        "py_round": [
            _round_case(value, ndigits)
            for value in PYROUND_VALUES
            for ndigits in PYROUND_NDIGITS
        ],
        "py_round_fuzz": {
            "seed": PYROUND_FUZZ_SEED,
            "cases": [_round_case(v, n) for v, n in _pyround_fuzz_cases()],
        },
    }
    return _write("py_parity.json", payload)


# ── engine: proficiency ────────────────────────────────────
#
# 为什么是「序列」而不是「单次调用」
# --------------------------------
# `update_signals` 是**累积**的：EWMA 的收敛、`signal_sample_counts` 的增长、
# 尤其是 probe_status 的推进，都只在**连续多次作答**之后才显出差异。
# 单次调用的对拍只能证明「第一条证据直取初值」，证明不了
# 「第四次 probe 之后状态是 probing 还是 estimated」。
#
# 唯一适合单次调用的是 `time_factor` 的波段表：它是纯查表，一次就覆盖全。
#
# 两侧各自的解释器（Python 侧是本文件，TS 侧是 tests/helpers/engine-probes.ts）
# 必须给出**逐字段相同**的 Attempt / Signals —— 所以描述里的每个字段都要显式，
# 缺省值靠同一个约定补，而不是各自"顺手"写一个。

ENGINE_ATTEMPT_DEFAULTS = {
    "competency": "make_ten",
    "pattern": "decompose",
    "interaction": "number_pad",
    "scaffold": "direct",
    "correct": True,
    "hints": 0,
    "active_ms": 1000,
    "idle_ms": 0,
    "is_assessment": False,
    "is_transfer_probe": False,
}

# 时间波段的边界（pattern=decompose + interaction=number_pad 走 default 的 20 秒）。
# ratio = thinking / threshold，波段是 `ratio <= max_ratio` 的**闭**区间：
# 0.75 / 1.00 / 1.50 / 2.50 各自落在"含"的一侧，而 999.0 是最后一档的上界 ——
# 越过它（1000.0）会掉出波段表，`fluency_score_for_ratio` 返回 **0.0**。
ENGINE_TIME_CASES = [
    ("ratio_at_075", 15000),
    ("ratio_over_075", 15200),
    ("ratio_at_100", 20000),
    ("ratio_over_100", 20200),
    ("ratio_at_150", 30000),
    ("ratio_over_150", 30200),
    ("ratio_at_250", 50000),
    ("ratio_over_250", 50200),
    ("ratio_at_999", 19980000),
    ("ratio_over_999", 20000000),
]


def _engine_attempt_desc(case_id, thinking_ms=None, **overrides):
    desc = dict(ENGINE_ATTEMPT_DEFAULTS)
    desc["id"] = case_id
    if thinking_ms is not None:
        desc["response_ms"] = thinking_ms + desc["active_ms"] + desc["idle_ms"]
    desc.update(overrides)
    return desc


ENGINE_ATTEMPTS = [
    # 主用例：probe 序列
    _engine_attempt_desc("probe_clean", 4000, is_assessment=True),
    _engine_attempt_desc("probe_wrong", 4000, is_assessment=True, correct=False),
    # 正式练习
    _engine_attempt_desc("practice_clean", 4000),
    _engine_attempt_desc("practice_wrong", 4000, correct=False),
    _engine_attempt_desc("practice_hinted", 4000, hints=3),
    _engine_attempt_desc("practice_max_hint", 4000, hints=9),
    # 迁移测试
    _engine_attempt_desc("transfer_ok", 4000, is_transfer_probe=True),
    _engine_attempt_desc("transfer_bad", 4000, is_transfer_probe=True, correct=False),
    # 时间波段：逐个边界
    *[_engine_attempt_desc(name, ms) for name, ms in ENGINE_TIME_CASES],
    # 别的 pattern / interaction（decompose + decompose_drag 走 15 秒而不是 default）
    _engine_attempt_desc("alt_interaction", 7500, interaction="decompose_drag"),
    # 别的 pattern / competency —— scheduler 按 pattern_key 记账，
    # 只有 decompose 的话"多条 pattern 交错推进"这条路径覆盖不到。
    # 顺带覆盖另外两行 fluency_thresholds（number_friends/choice=5s、
    # carry_exchange/carry_exchange=18s）。
    _engine_attempt_desc("other_pattern_clean", 4000, pattern="number_friends", interaction="choice"),
    _engine_attempt_desc("other_pattern_wrong", 4000, pattern="number_friends",
                         interaction="choice", correct=False),
    _engine_attempt_desc("other_competency_clean", 9000, competency="carry_add",
                         pattern="carry_exchange", interaction="carry_exchange"),
    # idle 占大头：response 60s、active 2s、idle 50s → thinking 8s → ratio 0.4
    _engine_attempt_desc("idle_heavy", None, response_ms=60000, active_ms=2000, idle_ms=50000),
    # 三个时间互相矛盾（active + idle > response）：thinking 夹到 0，ratio 0
    _engine_attempt_desc("impossible_times", None, response_ms=1000, active_ms=2000, idle_ms=3000),
]
ENGINE_ATTEMPTS_BY_ID = {desc["id"]: desc for desc in ENGINE_ATTEMPTS}


def _signals_desc(**overrides):
    """Signals 的完整声明式描述 —— 缺的键按这里的约定补，两侧必须一致。"""
    desc = {
        "mastery": None,
        "accuracy": None,
        "fluency": None,
        "independence": None,
        "transfer": None,
        "confidence": None,
        "sample_count": 0,
        "assessment_samples": 0,
        "signal_sample_counts": {},
        "probe_status": "unknown",
        "algorithm_version": 0,
    }
    desc.update(overrides)
    return desc


def _engine_signals_from(desc):
    from backend.engine.types import Signals

    return Signals(
        mastery=desc["mastery"],
        accuracy=desc["accuracy"],
        fluency=desc["fluency"],
        independence=desc["independence"],
        transfer=desc["transfer"],
        confidence=desc["confidence"],
        sample_count=desc["sample_count"],
        assessment_samples=desc["assessment_samples"],
        signal_sample_counts=dict(desc["signal_sample_counts"]),
        probe_status=desc["probe_status"],
        algorithm_version=desc["algorithm_version"],
    )


def _engine_attempt_from(desc):
    from backend.engine.types import Attempt, Telemetry

    return Attempt(
        attempt_id=desc["id"],
        child_id="child_probe",
        item_id="item_{}".format(desc["id"]),
        competency_id=desc["competency"],
        pattern_id=desc["pattern"],
        correct=desc["correct"],
        telemetry=Telemetry(
            response_time_ms=desc["response_ms"],
            active_time_ms=desc["active_ms"],
            idle_time_ms=desc["idle_ms"],
        ),
        hints_used=desc["hints"],
        scaffold_level=desc["scaffold"],
        interaction_type=desc["interaction"],
        is_assessment=desc["is_assessment"],
        is_transfer_probe=desc["is_transfer_probe"],
    )


# 每条序列的 note 写清楚"这一步在覆盖哪个分支" —— 未来某条 case 挂掉时，
# 从 note 就能判断是"实现错了"还是"这条 case 本来就该重新设计"。
ENGINE_SIGNAL_SEQUENCES = [
    {
        "id": "probe_four_steps",
        "note": "四次 probe：前三次 probing（sample_count < probe_items=4），第四次 estimated",
        "initial": _signals_desc(),
        "attempts": ["probe_clean"] * 3 + ["probe_wrong"],
    },
    {
        "id": "probe_then_practice",
        "note": "四次 probe 后接正式练习：estimated 不在 (unknown, probing) 里，elif 不成立；"
        "第六条样本触发无条件的 stable",
        "initial": _signals_desc(),
        "attempts": ["probe_clean"] * 4 + ["practice_clean"] * 2,
    },
    {
        "id": "practice_only_to_stable",
        "note": "零 probe 直接练习：前五条保持 unknown，第六条**同一行里**从 unknown 经 estimated 到 stable",
        "initial": _signals_desc(),
        "attempts": ["practice_clean"] * 6,
    },
    {
        "id": "from_probing_state",
        "note": "初值就是 probing（DB 回填的形态）：一条练习就够 min_samples_for_level → stable",
        "initial": _signals_desc(probe_status="probing", sample_count=5, assessment_samples=5),
        "attempts": ["practice_clean"] * 2,
    },
    {
        "id": "probe_past_min_samples",
        "note": "probe 分支把状态设成 estimated 之后，第三段立刻把它推成 stable",
        "initial": _signals_desc(probe_status="probing", sample_count=5, assessment_samples=5),
        "attempts": ["probe_clean", "probe_clean"],
    },
    {
        "id": "from_stable_state",
        "note": "已经是 stable：三段全不成立，只更新信号值（stable 是终态，不回退）",
        "initial": _signals_desc(
            mastery=0.9,
            accuracy=0.95,
            independence=0.9,
            transfer=0.85,
            fluency=0.8,
            confidence=0.9,
            sample_count=20,
            assessment_samples=4,
            probe_status="stable",
            signal_sample_counts={
                "mastery": 20,
                "accuracy": 20,
                "independence": 20,
                "transfer": 3,
                "fluency": 18,
                "confidence": 20,
            },
        ),
        "attempts": ["practice_wrong", "practice_hinted", "transfer_ok"],
    },
    {
        "id": "ewma_from_seeded_values",
        "note": "初值非 None：走 EWMA 而不是首条证据直取；做错的 fluency 不采样（保持原值）",
        "initial": _signals_desc(
            mastery=0.5,
            accuracy=0.5,
            independence=0.5,
            confidence=0.5,
            sample_count=4,
            assessment_samples=2,
            signal_sample_counts={"mastery": 4, "accuracy": 4, "independence": 4, "confidence": 4},
        ),
        "attempts": ["practice_wrong", "practice_clean", "practice_hinted", "practice_max_hint"],
    },
    {
        "id": "ewma_from_zero_values",
        "note": "初值是**精确的 0.0**（不是 None）：必须继续走 EWMA，不能把 0 当成「未采样」"
        "而重新直取 —— `if not current:` 这类写法会在这里露馅",
        "initial": _signals_desc(
            mastery=0.0,
            accuracy=0.0,
            independence=0.0,
            confidence=0.0,
            sample_count=4,
            assessment_samples=1,
            signal_sample_counts={
                "mastery": 4,
                "accuracy": 4,
                "independence": 4,
                "confidence": 4,
            },
        ),
        "attempts": ["practice_clean", "practice_clean", "practice_wrong"],
    },
    {
        "id": "transfer_sampling",
        "note": "transfer 只在 is_transfer_probe 上采样；同一序列里正式练习不动它",
        "initial": _signals_desc(),
        "attempts": ["practice_clean", "transfer_ok", "practice_wrong", "transfer_bad"],
    },
    {
        "id": "assessment_alpha_discount",
        "note": "probe 的 alpha 是 0.25 × assessment.weight(0.5) = 0.125，"
        "与下面 retry 序列逐字对比就能看出折扣；confidence 不受折扣影响（独立 alpha）",
        "initial": _signals_desc(
            mastery=0.2,
            accuracy=0.2,
            confidence=0.8,
            sample_count=4,
            probe_status="estimated",
        ),
        "attempts": ["probe_clean", "probe_clean"],
    },
    {
        "id": "practice_alpha_full",
        "note": "与 assessment_alpha_discount 同样的初值，只是换成正式练习 —— 差异应只来自 alpha",
        "initial": _signals_desc(
            mastery=0.2,
            accuracy=0.2,
            confidence=0.8,
            sample_count=4,
            probe_status="estimated",
        ),
        "attempts": ["practice_clean", "practice_clean"],
    },
    {
        "id": "fluency_bands_drive_update",
        "note": "同样的对错、不同的思考时长：fluency 采样值走遍波段表",
        "initial": _signals_desc(),
        "attempts": [
            "ratio_at_075",
            "ratio_over_075",
            "ratio_at_100",
            "ratio_over_100",
            "ratio_at_150",
            "ratio_over_150",
            "ratio_at_250",
            "ratio_over_250",
            "ratio_at_999",
            "ratio_over_999",
        ],
    },
    {
        "id": "degraded_telemetry",
        "note": "idle 占大头与时间互相矛盾（thinking 夹到 0）两种退化输入",
        "initial": _signals_desc(),
        "attempts": ["idle_heavy", "impossible_times", "alt_interaction"],
    },
]

# signal_summary 的输入：覆盖"全未采样 / 部分采样 / 全采样"三种形态，
# 以及 `—`（em dash）与 `0.00` 必须区分这一条。
#
# 后三条是 `{:.2f}` 的**真分歧点** —— 没有它们，`signal_summary` 只是被走过：
#   * 0.125 与 0.375 是二进制精确的 .xx5，Python 取偶（"0.12" / "0.38"），
#     而 JS 的 `toFixed(2)` 一律向大（"0.13" / "0.38"）；
#   * -0.0 要显示成 "-0.00"（`-0.0 < 0` 为假，靠符号位判断）。
ENGINE_SUMMARY_CASES = [
    _signals_desc(),
    _signals_desc(mastery=0.0, accuracy=0.0),
    _signals_desc(mastery=0.9123456, accuracy=0.5, fluency=1.0, independence=0.33125),
    _signals_desc(
        mastery=1.0,
        accuracy=0.9876,
        fluency=0.125,
        independence=0.3,
        transfer=0.70625,
        confidence=0.2,
    ),
    _signals_desc(accuracy=0.125, fluency=0.375),
    _signals_desc(mastery=-0.0, accuracy=-0.0, confidence=-0.001),
]


# ── engine: diagnosis ──────────────────────────────────────
#
# 诊断的三个函数是层层包含的：`rule_matches` ⊂ `match_rules` ⊂ `diagnose`。
# 三层各自对拍，因为**它们的失败模式不同**：
#   - rule_matches 错 → 某条规则该命中没命中（归因丢失）；
#   - match_rules 错 → 去重/保序/空 code 的处理不对（归因串味）；
#   - diagnose 错 → 优先级搞反（内容规则与通用规则互相顶掉）。
#
# 四处刻意覆盖的"反直觉"行为（都写在 diagnosis.ts 的模块头）：
#   ① 四个 match 键是**独立 if**，同时写就是"都要满足"；
#   ② 认不出的 match 键 **返回 True**（非空 dict 恒真）；
#   ③ `answer_off_by_multiple_of` 的 step=0 要挡（`not step` 真值判断）；
#   ④ `diagnose` 对 item=None 仍跑通用规则，只是 expected 为 None。

# (id, match, submitted, expected)
ENGINE_RULE_MATCH_CASES = [
    ("equals_hit", {"answer_equals": 3}, 3, 13),
    ("equals_miss", {"answer_equals": 3}, 4, 13),
    ("equals_string_coerced", {"answer_equals": 13}, "13", 13),
    ("equals_match_value_string", {"answer_equals": "13"}, 13, 5),
    ("equals_submitted_null", {"answer_equals": 13}, None, 13),
    # 「submitted 是 None」与「None 等于转换失败的匹配值」是两件事：
    # 去掉 `sub === null` 守卫后，`null !== asInt("x")` 即 `null !== null` 为假，
    # 函数会跳过这个 if 一路落到 `return true`。下面三条是那三个守卫的区分输入。
    ("equals_null_vs_uncoercible", {"answer_equals": "x"}, None, 5),
    ("equals_ignores_expected", {"answer_equals": 13}, 13, None),
    ("equals_submitted_bool", {"answer_equals": 1}, True, 5),
    ("equals_submitted_list", {"answer_equals": 1}, [1], 5),
    ("equals_whitespace_string", {"answer_equals": 13}, "  13  ", 5),
    ("in_hit", {"answer_in": [11, 12, 14]}, 12, 13),
    ("in_miss", {"answer_in": [11, 12, 14]}, 13, 13),
    ("in_submitted_null", {"answer_in": [11, 12]}, None, 13),
    ("in_null_vs_uncoercible_set", {"answer_in": ["x"]}, None, 5),
    ("in_with_uncoercible", {"answer_in": [11, "x", None]}, 11, 13),
    ("in_all_uncoercible", {"answer_in": ["x", None]}, 5, 13),
    ("in_string_value_splits_chars", {"answer_in": "123"}, 2, 13),
    ("in_empty_list", {"answer_in": []}, 5, 13),
    ("off_by_hit", {"answer_off_by": 1}, 12, 13),
    ("off_by_miss", {"answer_off_by": 1}, 15, 13),
    ("off_by_negative_sub", {"answer_off_by": 10}, 27, 37),
    ("off_by_expected_null", {"answer_off_by": 1}, 12, None),
    # expected 为 None 时 `Math.abs(sub - null)` 会把 None 当 0 —— 取 delta 恰好
    # 等于 sub 才能把"漏掉 exp === null 守卫"与正确实现区分开
    ("off_by_null_expected_masquerades_as_zero", {"answer_off_by": 12}, 12, None),
    ("off_by_delta_null", {"answer_off_by": "x"}, 12, 13),
    ("off_by_zero_delta", {"answer_off_by": 0}, 13, 13),
    ("multiple_of_hit", {"answer_off_by_multiple_of": 10}, 47, 37),
    ("multiple_of_miss", {"answer_off_by_multiple_of": 10}, 38, 37),
    ("multiple_of_same_answer", {"answer_off_by_multiple_of": 10}, 37, 37),
    ("multiple_of_step_zero", {"answer_off_by_multiple_of": 0}, 47, 37),
    ("multiple_of_negative_delta", {"answer_off_by_multiple_of": 10}, 27, 37),
    ("multiple_of_negative_step", {"answer_off_by_multiple_of": -10}, 47, 37),
    ("multiple_of_expected_null", {"answer_off_by_multiple_of": 10}, 47, None),
    ("empty_match_never_hits", {}, 5, 13),
    ("unknown_key_matches_everything", {"answer_near": 3}, 5, 13),
    ("two_keys_both_hold", {"answer_off_by": 1, "answer_equals": 12}, 12, 13),
    ("two_keys_one_fails", {"answer_off_by": 1, "answer_equals": 13}, 12, 13),
    # 下面两条专门用来区分「四个独立 if」与「else if」：
    # 前者要求**每个写了的键都成立**，后者只检查第一个满足"已进入分支"的键。
    # 两组 case 都让"后写的键不成立"——若把后续 if 改成 else if，它们会被跳过，
    # 函数就会错误地落到 `return bool(match)` 给出 True。
    ("later_key_fails_after_in", {"answer_in": [47], "answer_off_by": 999}, 47, 37),
    ("later_key_fails_after_equals", {"answer_equals": 47, "answer_in": [1, 2]}, 47, 37),
    ("all_four_keys_hold",
     {"answer_equals": 12, "answer_in": [12, 99], "answer_off_by": 1,
      "answer_off_by_multiple_of": 1}, 12, 13),
]

# (id, rules, submitted, expected)
ENGINE_MATCH_RULES_CASES = [
    ("dedup_keeps_first_position",
     [{"code": "a", "match": {"answer_off_by_multiple_of": 10}},
      {"code": "b", "match": {"answer_equals": 47}},
      {"code": "a", "match": {"answer_equals": 47}}],
     47, 37),
    ("dedup_when_second_hits_first_misses",
     [{"code": "a", "match": {"answer_off_by": 1}},
      {"code": "b", "match": {"answer_off_by_multiple_of": 10}},
      {"code": "a", "match": {"answer_equals": 47}}],
     47, 37),
    ("order_follows_rules",
     [{"code": "z", "match": {"answer_off_by_multiple_of": 10}},
      {"code": "a", "match": {"answer_equals": 47}}],
     47, 37),
    ("empty_code_skipped",
     [{"code": "", "match": {"answer_equals": 47}},
      {"code": "ok", "match": {"answer_equals": 47}}],
     47, 37),
    ("null_code_skipped",
     [{"code": None, "match": {"answer_equals": 47}}], 47, 37),
    ("missing_code_key", [{"match": {"answer_equals": 47}}], 47, 37),
    ("missing_match_key", [{"code": "x"}], 47, 37),
    ("no_rules", [], 47, 37),
    ("nothing_matches",
     [{"code": "a", "match": {"answer_off_by": 1}}], 47, 37),
]

# item 用 None 或 {"answer": ..., "error_rules": [...]} 表达；
# 只有这两个字段影响 diagnose（其余字段在 TS 侧由 itemFromDesc 补默认值）
ENGINE_DIAGNOSE_CASES = [
    {
        "id": "correct_answer_short_circuits",
        "note": "correct=True 时完全不看 item —— 这条 item 的规则**本来会命中**"
        "（submitted=99 与 answer_equals:99 相等），短路失效时它就会漏出来",
        "correct": True,
        "submitted": 99,
        "misconception_codes": [],
        "item": {"answer": 13, "error_rules": [{"code": "should_not_fire", "match": {"answer_equals": 99}}]},
    },
    {
        "id": "correct_with_carried_codes",
        "note": "correct=True 且调用方挂了 code：带出来的是**调用方那份**，"
        "item 里会命中的规则（generic_look_alike）不该出现 —— 两条路径的输出都能对上才说明短路是对的",
        "correct": True,
        "submitted": 13,
        "misconception_codes": ["question_structure_missed"],
        "item": {"answer": 13, "error_rules": [{"code": "generic_look_alike", "match": {"answer_equals": 13}}]},
    },
    {
        "id": "item_rule_hits",
        "note": "内容层声明了规则且命中 → 不再看通用规则",
        "correct": False,
        "submitted": 12,
        "misconception_codes": [],
        "item": {"answer": 13, "error_rules": [{"code": "counting_dependency", "match": {"answer_off_by": 1}}]},
    },
    {
        "id": "item_rule_misses_then_generic",
        "note": "内容层有规则但没命中 → 走配置的通用规则（47 vs 37 差整十）",
        "correct": False,
        "submitted": 47,
        "misconception_codes": [],
        "item": {"answer": 37, "error_rules": [{"code": "counting_dependency", "match": {"answer_off_by": 1}}]},
    },
    {
        "id": "empty_error_rules_falls_back",
        "note": "error_rules 为空列表（真值判断）→ 走通用规则",
        "correct": False,
        "submitted": 23,
        "misconception_codes": [],
        "item": {"answer": 13, "error_rules": []},
    },
    {
        "id": "generic_off_by_one",
        "note": "通用规则第二条：answer_off_by: 1 → counting_dependency",
        "correct": False,
        "submitted": 14,
        "misconception_codes": [],
        "item": {"answer": 13, "error_rules": []},
    },
    {
        "id": "item_null_generic_needs_expected",
        "note": "item=None 时通用规则拿不到 expected → 两条规则都不匹配（它们都依赖 exp）",
        "correct": False,
        "submitted": 23,
        "misconception_codes": [],
        "item": None,
    },
    {
        "id": "wrong_but_no_rule_matches",
        "note": "答错但差得既不是整十也不是 1 → 空列表",
        "correct": False,
        "submitted": 5,
        "misconception_codes": [],
        "item": {"answer": 13, "error_rules": []},
    },
    {
        "id": "carried_codes_appended",
        "note": "调用方给的 code 不在命中列表里 → 追加到末尾",
        "correct": False,
        "submitted": 47,
        "misconception_codes": ["carry_forgot", "place_value_confusion"],
        "item": {"answer": 37, "error_rules": []},
    },
    {
        "id": "carried_codes_deduped",
        "note": "调用方给的 code 已经在命中列表里 → 不重复",
        "correct": False,
        "submitted": 47,
        "misconception_codes": ["place_value_confusion"],
        "item": {"answer": 37, "error_rules": []},
    },
    {
        "id": "unknown_key_rule_swallows",
        "note": "内容里写错键名的规则会命中**所有**错误答案（见 diagnosis.ts ②）",
        "correct": False,
        "submitted": 5,
        "misconception_codes": [],
        "item": {"answer": 13, "error_rules": [{"code": "typo_rule", "match": {"answer_near": 3}}]},
    },
]


# ── engine: scheduler ──────────────────────────────────────
#
# 复习调度的状态是一张**普通 dict**（要落进 review_schedule 表），
# 所以这里的对拍与 proficiency 不同：不是比"对象字段"，而是比**整张表的序列化**。
#
# 三条刻意覆盖的形态：
#   * 连对跑完全部五档间隔（[1,3,7,14,30]）—— 覆盖 `min(streak-1, len-1)` 的封顶；
#   * 答错退回起点，但 `last_correct_day` **保留**（诊断"到底忘了多久"要用）；
#   * 初始 entry 只带部分键（DB 老数据的形态）—— 覆盖每处 `.get(k, default)`。

ENGINE_SCHEDULE_SEQUENCES = [
    {
        "id": "streak_through_all_intervals",
        "note": "同一 pattern 连对七次：interval_index 0→1→2→3→4 然后封顶在 4",
        "initial": {},
        "steps": [
            {"attempt": "practice_clean", "day": 1},
            {"attempt": "practice_clean", "day": 2},
            {"attempt": "practice_clean", "day": 5},
            {"attempt": "practice_clean", "day": 12},
            {"attempt": "practice_clean", "day": 26},
            {"attempt": "practice_clean", "day": 56},
            {"attempt": "practice_clean", "day": 86},
        ],
    },
    {
        "id": "wrong_resets_but_keeps_last_correct_day",
        "note": "连对三次后答错：consecutive_correct 归零、interval_index 归零，"
        "但 last_correct_day 保留在最后一次答对那天",
        "initial": {},
        "steps": [
            {"attempt": "practice_clean", "day": 1},
            {"attempt": "practice_clean", "day": 2},
            {"attempt": "practice_clean", "day": 5},
            {"attempt": "practice_wrong", "day": 9},
            {"attempt": "practice_clean", "day": 10},
        ],
    },
    {
        "id": "multi_pattern_interleaved",
        "note": "三条 pattern 交错推进：每次作答只动自己那条，另外两条原样",
        "initial": {},
        "steps": [
            {"attempt": "practice_clean", "day": 1},
            {"attempt": "other_pattern_clean", "day": 1},
            {"attempt": "other_competency_clean", "day": 2},
            {"attempt": "practice_clean", "day": 3},
            {"attempt": "other_pattern_wrong", "day": 4},
            {"attempt": "other_competency_clean", "day": 20},
        ],
    },
    {
        "id": "partial_entry_from_db",
        "note": "初始 entry 缺 consecutive_correct / last_correct_day（老数据形态）："
        "缺的键走 `.get(k, default)`，已有的键原样沿用",
        "initial": {
            "make_ten::decompose": {"interval_index": 2, "due_day": 7},
            "make_ten::number_friends": {"consecutive_correct": 4, "due_day": 30},
        },
        "steps": [
            {"attempt": "practice_clean", "day": 10},
            {"attempt": "other_pattern_clean", "day": 31},
        ],
    },
    {
        "id": "existing_key_keeps_position",
        "note": "已存在的键在更新后**保持原位置**（Python 的 `d[k] = v` 不移动键）"
        "—— 新键才追加到末尾。这条钉的是 Map 与 dict 的一致语义",
        "initial": {
            "make_ten::number_friends": {"interval_index": 0, "due_day": 5},
            "make_ten::decompose": {"interval_index": 0, "due_day": 5},
        },
        "steps": [{"attempt": "practice_clean", "day": 5}],
    },
]

# pending_reviews / due_reviews 的输入：
#   competencies 里 **不在字典中** = 没有 Signals（signals is None）；
#   **值为 null** = 有 Signals 但 mastery 未采样。
# 两者都要返回 False，但走的是 `_is_reviewable` 里两个不同的分支。
ENGINE_PENDING_CASES = [
    {
        "id": "due_today_sorted_by_overdue",
        "note": "三项都到期，逾期天数分别是 5 / 0 / 12 → 按逾期降序",
        "day": 20,
        "competencies": {"make_ten": 0.9},
        "schedule": {
            "make_ten::decompose": {"interval_index": 1, "consecutive_correct": 2,
                                    "last_correct_day": 15, "due_day": 15},
            "make_ten::number_friends": {"interval_index": 0, "consecutive_correct": 1,
                                         "last_correct_day": 20, "due_day": 20},
            "make_ten::carry_exchange": {"interval_index": 2, "consecutive_correct": 3,
                                         "last_correct_day": 8, "due_day": 8},
        },
    },
    {
        "id": "future_not_due",
        "note": "due_day > day 的项不出现",
        "day": 10,
        "competencies": {"make_ten": 0.9},
        "schedule": {
            "make_ten::decompose": {"due_day": 10},
            "make_ten::number_friends": {"due_day": 11},
        },
    },
    {
        "id": "mastery_below_threshold",
        "note": "mastery 低于 review.min_mastery(0.60) → 不进复习队列（还没学会的属于教学）",
        "day": 10,
        "competencies": {"make_ten": 0.59, "carry_add": 0.60},
        "schedule": {
            "make_ten::decompose": {"due_day": 1},
            "carry_add::increase": {"due_day": 1},
        },
    },
    {
        "id": "missing_signals_vs_unsampled_mastery",
        "note": "没有 Signals 的能力与 mastery 未采样的能力都不复习 —— 走的是两个不同分支",
        "day": 10,
        "competencies": {"make_ten": None, "carry_add": 0.9},
        "schedule": {
            "make_ten::decompose": {"due_day": 1},
            "carry_add::increase": {"due_day": 1},
            "td_add_nocarry::decompose": {"due_day": 1},
        },
    },
    {
        "id": "tie_breaks_on_pattern_key",
        "note": "逾期天数相同的项按 pattern_key 升序（排序键的第二分量）",
        "day": 10,
        "competencies": {"make_ten": 0.9, "carry_add": 0.9},
        "schedule": {
            "make_ten::number_friends": {"due_day": 5},
            "make_ten::decompose": {"due_day": 5},
            "carry_add::increase": {"due_day": 5},
        },
    },
    {
        # 唯一一条到期项数**超过** review.max_per_day(3) 的 case：
        # due_reviews 的截断只能靠它进黄金语料 —— 否则 due 恒等于 pending，
        # 把 release_pressure 换成 `return list(items)` 也没人发现。
        "id": "over_max_per_day_truncates",
        "note": "四项到期、上限三项：due_reviews 砍掉第四条，pending_reviews 不砍",
        "day": 10,
        "competencies": {"make_ten": 0.9},
        "schedule": {
            "make_ten::a_first": {"due_day": 1},
            "make_ten::b_second": {"due_day": 2},
            "make_ten::c_third": {"due_day": 3},
            "make_ten::d_fourth": {"due_day": 4},
        },
    },
    {
        "id": "entry_missing_due_day_uses_today",
        "note": "entry 缺 due_day 时**按今天到期**处理（不是跳过，也不是 0）",
        "day": 42,
        "competencies": {"make_ten": 0.9},
        "schedule": {
            "make_ten::decompose": {"interval_index": 3, "consecutive_correct": 4},
        },
    },
    {
        "id": "empty_schedule",
        "note": "空表 → 空列表",
        "day": 1,
        "competencies": {"make_ten": 0.9},
        "schedule": {},
    },
]

# next_review_day：(schedule, key) → int | None
ENGINE_NEXT_REVIEW_CASES = [
    {"id": "present", "schedule": {"make_ten::decompose": {"due_day": 17}},
     "key": "make_ten::decompose", "expect": 17},
    {"id": "absent", "schedule": {"make_ten::decompose": {"due_day": 17}},
     "key": "make_ten::number_friends", "expect": None},
    # 与 pending_reviews 不同：这里缺 due_day 给 **0**（见 scheduler.ts 模块头 ③）
    {"id": "missing_due_day_gives_zero", "schedule": {"make_ten::decompose": {"interval_index": 1}},
     "key": "make_ten::decompose", "expect": 0},
    {"id": "empty_schedule_absent", "schedule": {}, "key": "make_ten::decompose", "expect": None},
    # 空 key：split_pattern_key("") 给 ("", "")，但 next_review_day 只看表里有没有
    {"id": "empty_key", "schedule": {"make_ten::decompose": {"due_day": 3}},
     "key": "", "expect": None},
]


def _engine_state_from(mastery_by_code):
    """按"在不在字典里 / 值是不是 null"两种形态造 ChildLearningState.competencies"""
    from backend.engine.types import ChildLearningState, Signals

    state = ChildLearningState(child_id="child_sched")
    for code, mastery in mastery_by_code.items():
        state.competencies[code] = Signals(mastery=mastery)
    return state


def dump_engine() -> str:
    """proficiency / diagnosis / scheduler 的画像对拍。"""
    from backend.content.loader import Item
    from backend.engine.config import load_config
    from backend.engine.diagnosis import diagnose, match_rules, rule_matches
    from backend.engine.proficiency import (
        attempt_quality,
        samples_for_attempt,
        signal_summary,
        time_factor,
        update_signals,
    )
    from backend.engine.scheduler import (
        due_reviews,
        new_schedule,
        next_review_day,
        pending_reviews,
        release_pressure,
        update_schedule,
    )
    from backend.engine.types import Attempt, ChildLearningState, Telemetry

    cfg = load_config(0)
    attempts = {desc["id"]: _engine_attempt_from(desc) for desc in ENGINE_ATTEMPTS}

    sequences = []
    for spec in ENGINE_SIGNAL_SEQUENCES:
        signals = _engine_signals_from(spec["initial"])
        steps = []
        for attempt_id in spec["attempts"]:
            signals = update_signals(signals, attempts[attempt_id], cfg)
            steps.append(signals.to_dict())
        sequences.append(
            {
                "id": spec["id"],
                "note": spec["note"],
                "initial": spec["initial"],
                "attempts": spec["attempts"],
                "steps": steps,
            }
        )

    diagnose_cases = []
    for spec in ENGINE_DIAGNOSE_CASES:
        attempt = Attempt(
            attempt_id="a_" + spec["id"],
            child_id="child_probe",
            item_id="item",
            competency_id="make_ten",
            pattern_id="direct_compute",
            correct=spec["correct"],
            telemetry=Telemetry(response_time_ms=5000, active_time_ms=1000),
            submitted_answer=spec["submitted"],
            misconception_codes=list(spec["misconception_codes"]),
        )
        item = None
        if spec["item"] is not None:
            item = Item(
                code="item",
                competency_id="make_ten",
                pattern_id="direct_compute",
                difficulty=3,
                scaffold_level="direct",
                interaction_type="number_pad",
                estimated_seconds=6,
                problem={},
                answer=spec["item"]["answer"],
                error_rules=spec["item"]["error_rules"],
            )
        diagnose_cases.append(
            {
                **spec,
                "expect": diagnose(attempt, item, cfg),
            }
        )

    payload = {
        "config_version": cfg.version,
        "attempts": ENGINE_ATTEMPTS,
        "time_factor": [
            {"id": desc["id"], "value": time_factor(attempts[desc["id"]], cfg)}
            for desc in ENGINE_ATTEMPTS
        ],
        "attempt_quality": [
            {"id": desc["id"], "quality": attempt_quality(attempts[desc["id"]], cfg).to_dict()}
            for desc in ENGINE_ATTEMPTS
        ],
        "samples_for_attempt": [
            {
                "id": desc["id"],
                "samples": samples_for_attempt(attempts[desc["id"]], cfg),
            }
            for desc in ENGINE_ATTEMPTS
        ],
        "update_signals": sequences,
        "signal_summary": [
            {"signals": desc, "text": signal_summary(_engine_signals_from(desc))}
            for desc in ENGINE_SUMMARY_CASES
        ],
        "diagnosis": {
            "rule_matches": [
                {
                    "id": case_id,
                    "match": match,
                    "submitted": submitted,
                    "expected": expected,
                    "result": rule_matches(match, submitted, expected),
                }
                for case_id, match, submitted, expected in ENGINE_RULE_MATCH_CASES
            ],
            "match_rules": [
                {
                    "id": case_id,
                    "rules": rules,
                    "submitted": submitted,
                    "expected": expected,
                    "codes": match_rules(rules, submitted, expected),
                }
                for case_id, rules, submitted, expected in ENGINE_MATCH_RULES_CASES
            ],
            "diagnose": diagnose_cases,
        },
        "scheduler": _dump_scheduler(
            cfg, attempts, update_schedule, pending_reviews, release_pressure,
            due_reviews, next_review_day,
        ),
    }
    return _write("engine_parity.json", payload)


def _dump_scheduler(
    cfg, attempts, update_schedule, pending_reviews, release_pressure,
    due_reviews, next_review_day,
):
    """scheduler 的对拍段 —— 拆出来只是为了让 dump_engine 主体还能读。"""
    from backend.engine.types import ChildLearningState, Signals

    sequences = []
    for spec in ENGINE_SCHEDULE_SEQUENCES:
        schedule = {key: dict(entry) for key, entry in spec["initial"].items()}
        results = []
        for step in spec["steps"]:
            schedule = update_schedule(schedule, attempts[step["attempt"]], step["day"], cfg)
            results.append(schedule)
        # `steps` 保持输入（attempt id + day），结果另起一个键 ——
        # 早先写成 `{**spec, "steps": results}` 会把输入覆盖掉，
        # 逼得 TS 侧手抄一份"同一份输入"，抄错就变成对拍两个错误实现。
        sequences.append({**spec, "results": results})

    pending_cases = []
    for spec in ENGINE_PENDING_CASES:
        state = ChildLearningState(child_id="child_sched")
        for code, mastery in spec["competencies"].items():
            state.competencies[code] = Signals(mastery=mastery)
        schedule = {key: dict(entry) for key, entry in spec["schedule"].items()}
        pending = pending_reviews(schedule, spec["day"], state, cfg)
        pending_cases.append(
            {
                **spec,
                "expect": [_plain(row) for row in pending],
                "kept": [_plain(row) for row in release_pressure(pending, cfg)],
                "due": [_plain(row) for row in due_reviews(schedule, spec["day"], state, cfg)],
            }
        )

    next_cases = []
    for spec in ENGINE_NEXT_REVIEW_CASES:
        schedule = {key: dict(entry) for key, entry in spec["schedule"].items()}
        next_cases.append(
            {**spec, "actual": next_review_day(schedule, spec["key"], cfg)}
        )

    return {
        "sequences": sequences,
        "pending": pending_cases,
        "next_review_day": next_cases,
        "max_per_day": int(cfg.get("review", "max_per_day")),
        "min_mastery": float(cfg.get("review", "min_mastery")),
        "intervals": list(cfg.review_intervals_days),
    }


# ── pyrandom（MT19937）─────────────────────────────────────
#
# 为什么需要一个**逐位**对齐的伪随机数
# ------------------------------------
# `engine/detective.py` 的谜题生成器用 `random.Random(seed)`，而谜题的 seed 是
# `seed * 7919 + 13`（detective.py:365）——**同一道题必须永远生成同一份谜面**，
# 否则孩子的答案会对不上、重放也不确定。
#
# 这里最容易出**静默错误**：`_randbelow` 用的是拒绝采样，取值越界时会**再取一次**，
# 于是消耗的 32 位字数随取值变化。TS 侧只要少消耗一个字，后续序列全错 ——
# 而 `Puzzle.validate()` 只查自洽性（数是不是在范围内），**错位的谜面仍然"合法"**，
# 不会报任何错，只是不再是孩子看到过的那道题。
#
# 所以 fixture 分三层：
#   1. `seed_state` —— 种子算完后的 624 个状态字 + index。**逐位**比对，
#      把「种子算法」这一层单独钉死（写错这里的话后面全错，但错法很隐蔽）；
#   2. `raw_words` / `getrandbits` —— 单个原语；
#   3. `mixed` —— 交错调用序列。这一层才验"消耗顺序"，前两层都验不了。

PYRANDOM_SEEDS = [
    0,
    1,
    2,
    5,
    42,
    12345,
    7919 * 3 + 13,
    2**31 - 1,
    2**31,
    2**32 - 1,
    2**32,
    2**63,
    2**64 - 1,
    2**64,
    10**30,
    -1,
    -5,
    -12345,
    -(2**40),
]

# `_randbelow(n)` 的 n。刻意覆盖三种形态：
#   * 2 的幂（k = log2(n)，取不满 → 几乎不拒绝）
#   * 2 的幂减一（k = log2(n+1)，拒绝率高 —— n=1 时约 50%）
#   * 跨 32 位的（要一次消耗两个状态字）
PYRANDOM_RANDBELOW_N = [1, 2, 3, 4, 7, 8, 9, 100, 255, 624, 625, 1000, 2**32 - 1, 2**32, 2**53]

# `getrandbits(k)` 的 k：跨过 32 位的边界以及 32 的整倍数
PYRANDOM_GETRANDBITS_K = [1, 2, 5, 8, 16, 31, 32, 33, 34, 63, 64, 65, 96, 100, 128]

# `randint(a, b)` —— 取自 detective.py 的真实区间
PYRANDOM_RANDINT_RANGES = [
    (2, 8),
    (2, 9),
    (1, 8),
    (2, 5),
    (1, 5),
    (3, 6),
    (1, 4),
    (0, 0),
    (0, 1),
    (5, 5),
]

# `choice(seq)` —— 长度取自 detective.py 的真实序列
PYRANDOM_CHOICE_SEQS = [
    ["step", "alternate", "growing_step"],
    ["a"],
    ["a", "b"],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
]

# 每个原语在每个种子下取几个值
PYRANDOM_VALUES_PER_CASE = 8

# 交错调用序列：每次调用消耗的状态字数不同（randint 可能拒绝采样、
# 大 k 的 getrandbits 要多个字、random() 恒两个），**顺序错一位就全错**。
PYRANDOM_MIXED_SPECS = [
    ("mixed_detective_shapes", 2024, [
        ("randint", 2, 8),
        ("randint", 2, 9),
        ("choice", ["step", "alternate", "growing_step"]),
        ("randint", 1, 8),
        ("randint", 2, 5),
        ("randint", 1, 5),
        ("randint", 3, 6),
        ("randint", 1, 4),
        ("randint", 2, 9),
        ("randint", 2, 9),
    ]),
    ("mixed_with_big_words", 7, [
        ("getrandbits", 32),
        ("getrandbits", 64),
        ("randint", 1, 100),
        ("getrandbits", 1),
        ("getrandbits", 33),
        ("randint", 0, 2),
        ("getrandbits", 128),
        ("randint", 7, 7),
    ]),
    ("mixed_with_floats", 99, [
        ("random",),
        ("randint", 1, 6),
        ("random",),
        ("choice", ["a", "b", "c"]),
        ("random",),
        ("getrandbits", 32),
    ]),
    ("mixed_rejection_pressure", 1, [
        ("randint", 0, 0),  # n=1：每次都要靠拒绝采样把那唯一的值挤出来
        ("randint", 0, 0),
        ("randint", 0, 0),
        ("randint", 0, 2),  # n=3：k=2，r=3 时拒绝
        ("randint", 0, 2),
        ("randint", 0, 6),  # n=7：k=3，r=7 时拒绝
    ]),
]


def _pyrandom_state(rng):
    """`getstate()` 的 625 个整数：624 个状态字 + index。"""
    return list(rng.getstate()[1])


# ⚠️ 大整数一律用**十进制字符串**编码，不用 JSON number
# ----------------------------------------------------
# `JSON.parse` 会把超过 2^53 的整数静默截断成最近的 double：`2**64` 读回来是
# 18446744073709552000，`10**30` 更离谱。Python 侧写出去是精确的，
# JS 侧读进来不是 —— 那是**读 fixture 这一步**就引入的偏差，
# 而且会伪装成"实现有 bug"。所以 seed、getrandbits 的值都走 str(int)，
# 两侧各自解析成 BigInt 再比。
def _big(value) -> str:
    return str(int(value))


class _CountingRandom:
    """只为数 `_randbelow` 到底调了几次 `getrandbits`（拒绝采样的证据）。

    做法是给实例**装一个同名属性**盖住 C 方法：
      * `_randbelow` 里那条分支看到 `type(getrandbits) is Method` 为假，
        但 `type(self.random) is BuiltinMethod` 为真 → 仍然走
        `_randbelow_with_getrandbits`，也就是真实路径；
      * 于是计数是真的，而消耗的状态也一样（转发给同一个 rng）。
    **不能**改成继承 `random.Random` 再覆盖 `getrandbits`：那样
    `type(getrandbits) is Method` 为真，会走到另一个分支去。
    """

    def __init__(self, seed):
        import random

        self._rng = random.Random(seed)
        self.calls = 0
        original = self._rng.getrandbits

        def counting_getrandbits(k):
            self.calls += 1
            return original(k)

        self._rng.getrandbits = counting_getrandbits

    def randbelow(self, n):
        return self._rng._randbelow(n)


def dump_pyrandom() -> str:
    """MT19937 的三层对拍：种子状态 / 单原语 / 交错序列。"""
    import random

    seeds = []
    for seed in PYRANDOM_SEEDS:
        seeds.append({"seed": _big(seed), "state": _pyrandom_state(random.Random(seed))})

    raw_words = []
    for seed in [0, 5, 12345, -(2**40)]:
        rng = random.Random(seed)
        words = [rng.getrandbits(32) for _ in range(40)]
        raw_words.append({"seed": _big(seed), "words": words, "state": _pyrandom_state(rng)})

    getrandbits_cases = []
    for seed in [5, 2024]:
        for k in PYRANDOM_GETRANDBITS_K:
            rng = random.Random(seed)
            getrandbits_cases.append(
                {
                    "seed": _big(seed),
                    "k": k,
                    "values": [_big(rng.getrandbits(k)) for _ in range(PYRANDOM_VALUES_PER_CASE)],
                }
            )

    randbelow_cases = []
    for seed in [5, 2024]:
        for n in PYRANDOM_RANDBELOW_N:
            counting = _CountingRandom(seed)
            values = [counting.randbelow(n) for _ in range(PYRANDOM_VALUES_PER_CASE)]
            # 拒绝采样的**证据**：n 不是 2 的幂时，getrandbits 的调用次数
            # 会**多于**值的个数 —— 差额就是被拒绝后重取的次数
            randbelow_cases.append(
                {
                    "seed": _big(seed),
                    "n": n,
                    "values": values,
                    "getrandbits_calls": counting.calls,
                    "bit_length": n.bit_length(),
                }
            )

    randint_cases = []
    for seed in [5, 2024]:
        for low, high in PYRANDOM_RANDINT_RANGES:
            rng = random.Random(seed)
            randint_cases.append(
                {
                    "seed": _big(seed),
                    "low": low,
                    "high": high,
                    "values": [rng.randint(low, high) for _ in range(PYRANDOM_VALUES_PER_CASE)],
                }
            )

    choice_cases = []
    for seed in [5, 2024]:
        for seq in PYRANDOM_CHOICE_SEQS:
            rng = random.Random(seed)
            choice_cases.append(
                {
                    "seed": _big(seed),
                    "seq": seq,
                    "values": [rng.choice(seq) for _ in range(PYRANDOM_VALUES_PER_CASE)],
                }
            )

    float_cases = []
    for seed in [0, 5, 2024, -(2**40)]:
        rng = random.Random(seed)
        float_cases.append({"seed": _big(seed), "values": [rng.random() for _ in range(10)]})

    mixed_cases = []
    for case_id, seed, ops in PYRANDOM_MIXED_SPECS:
        rng = random.Random(seed)
        results = []
        for op in ops:
            if op[0] == "randint":
                results.append(
                    {"op": "randint", "low": op[1], "high": op[2], "value": rng.randint(op[1], op[2])}
                )
            elif op[0] == "choice":
                results.append(
                    {"op": "choice", "seq": list(op[1]), "value": rng.choice(op[1])}
                )
            elif op[0] == "getrandbits":
                results.append({"op": "getrandbits", "k": op[1], "value": _big(rng.getrandbits(op[1]))})
            else:
                results.append({"op": "random", "value": rng.random()})
        mixed_cases.append(
            {"id": case_id, "seed": _big(seed), "results": results, "state": _pyrandom_state(rng)}
        )

    return _write(
        "pyrandom_parity.json",
        {
            "seed_state": seeds,
            "raw_words": raw_words,
            "getrandbits": getrandbits_cases,
            "randbelow": randbelow_cases,
            "randint": randint_cases,
            "choice": choice_cases,
            "random_float": float_cases,
            "mixed": mixed_cases,
        },
    )


# ── engine: state_machine ──────────────────────────────────
#
# 等级（level）与升级（upgrade）必须分开验：等级是派生值（未采样不卡档），
# 升级是严格门（缺任何证据都不行）。最反直觉的一条在 derive_level：
# **六个信号全 null 但 sample_count ≥ 6** 的信号会派生出 automatic ——
# 因为"未采样不参与判定"，五档阈值全被跳过。这不是 bug（真实世界里
# sample_count ≥ 6 而 mastery 全 null 的形态到不了），而是"等级"与"升级"
# 分离设计的直接后果：等级可以虚高，升级门另算，孩子不会被推走。
# fixture 把它钉住，防止有人"顺手修掉"这个看起来像 bug 的行为。
#
# reasons 是**逐字契约**：Planner 直接展示给家长端，对拍时顺序差一条就是红。

# (id, note, signals 描述) —— 用 _sm_signals_desc 的键
SM_DERIVE_LEVEL_CASES = [
    {
        "id": "no_samples_short_circuit",
        "note": "sample_count=0：连阈值都不看，直接给第一档",
        "signals": {},
    },
    {
        "id": "below_min_samples",
        "note": "sample_count=5 < min_samples_for_level(6)：同样短路",
        "signals": {"sample_count": 5, "mastery": 0.99, "accuracy": 0.99},
    },
    {
        "id": "all_unsampled_reaches_automatic",
        "note": "六信号全 null 但 sample_count=6：未采样不卡档 → 一路派生到 automatic"
        "（等级与升级分离的活证据：等级虚高但升级门另算）",
        "signals": {"sample_count": 6},
    },
    {
        "id": "at_understanding_thresholds",
        "note": "mastery=0.35 / accuracy=0.6 恰好等于 understanding 阈值：EPS 容差内算达标",
        "signals": {"sample_count": 6, "mastery": 0.35, "accuracy": 0.6},
    },
    {
        "id": "eps_covers_near_threshold",
        "note": "mastery 比 0.35 低 4e-10（< EPS=1e-9）：仍然算达标 → understanding",
        "signals": {"sample_count": 6, "mastery": 0.3499999996, "accuracy": 0.6},
    },
    {
        "id": "eps_is_not_infinite",
        "note": "mastery 比 0.35 低 2e-9（> EPS）：不达标 → 停在 encountering",
        "signals": {"sample_count": 6, "mastery": 0.349999998, "accuracy": 0.6},
    },
    {
        "id": "all_signals_high",
        "note": "五信号全高：automatic",
        "signals": {
            "sample_count": 6,
            "mastery": 0.9,
            "accuracy": 0.95,
            "independence": 0.9,
            "transfer": 0.9,
            "fluency": 0.9,
        },
    },
    {
        "id": "stops_at_proficient",
        "note": "fluency=0.79 < 0.8：前面全满足、最后一档不满足 —— 真实配置下可观测的 break",
        "signals": {
            "sample_count": 6,
            "mastery": 0.9,
            "accuracy": 0.95,
            "independence": 0.9,
            "transfer": 0.9,
            "fluency": 0.79,
        },
    },
    {
        "id": "stops_at_can_do",
        "note": "transfer=0.69 < 0.7：proficient 不满足 → can_do",
        "signals": {"sample_count": 6, "mastery": 0.9, "accuracy": 0.95, "transfer": 0.69},
    },
    {
        "id": "mastery_unsampled_accuracy_carries",
        "note": "mastery 未采样（skip）、accuracy=0.7 过 understanding 但不过 can_do(0.8)",
        "signals": {"sample_count": 6, "accuracy": 0.7},
    },
    {
        "id": "confidence_never_gates",
        "note": "confidence 有值但不在任何阈值表里：不影响等级",
        "signals": {"sample_count": 6, "mastery": 0.9, "accuracy": 0.95, "confidence": 0.1},
    },
]

# (id, note, competency, patterns 描述: {pattern_key: signals 描述})
# ⚠️ patterns 的键是**完整的 pattern_key**（"能力::pattern"），与 upgrade 段一致
SM_COUNT_PATTERNS_CASES = [
    {
        "id": "no_patterns_touched",
        "note": "一个 pattern 都没碰过 → 0",
        "competency": "sd_add_10",
        "patterns": {},
    },
    {
        "id": "zero_samples_not_counted",
        "note": "sample_count=0 的 pattern 不算（没证据）",
        "competency": "sd_add_10",
        "patterns": {
            "sd_add_10::combine": {"sample_count": 0, "accuracy": 0.9},
            "sd_add_10::direct_compute": {"sample_count": 3, "accuracy": 0.9},
        },
    },
    {
        "id": "null_accuracy_not_counted",
        "note": "accuracy 未采样 → 不算（不是'按 0 分算'）",
        "competency": "sd_add_10",
        "patterns": {
            "sd_add_10::combine": {"sample_count": 3, "accuracy": None},
            "sd_add_10::direct_compute": {"sample_count": 3, "accuracy": 0.9},
        },
    },
    {
        "id": "min_accuracy_boundary",
        "note": "accuracy=0.5 恰好达标（min_accuracy 默认 0.5）、0.49 不达标 → 1",
        "competency": "sd_add_10",
        "patterns": {
            "sd_add_10::combine": {"sample_count": 3, "accuracy": 0.5},
            "sd_add_10::direct_compute": {"sample_count": 3, "accuracy": 0.49},
        },
    },
    {
        "id": "both_count",
        "note": "两个都 ≥ 0.5 → 2（升级门 min_patterns=2 的下限）",
        "competency": "sd_add_10",
        "patterns": {
            "sd_add_10::combine": {"sample_count": 3, "accuracy": 0.6},
            "sd_add_10::direct_compute": {"sample_count": 3, "accuracy": 0.7},
        },
    },
    {
        "id": "many_patterns",
        "note": "make_ten 有 7 个 pattern，其中 3 个成功 → 3（超出 min_patterns 的形态）",
        "competency": "make_ten",
        "patterns": {
            "make_ten::increase": {"sample_count": 2, "accuracy": 0.9},
            "make_ten::total": {"sample_count": 2, "accuracy": 0.2},
            "make_ten::direct_compute": {"sample_count": 2, "accuracy": 0.5},
            "make_ten::missing_part": {"sample_count": 0, "accuracy": 1.0},
            "make_ten::reverse": {"sample_count": 2, "accuracy": 0.8},
        },
    },
]


def _sm_signals_desc(**overrides):
    """同 `_signals_desc` —— 单独再定义一个是为了让 state_machine 段自包含好读。"""
    return _signals_desc(**overrides)


def _sm_state_from(desc):
    """state_machine 用的声明式状态描述 → ChildLearningState。

    这里的 signals 描述允许**只写关心的字段**（`{"sample_count": 3}`），
    缺的由 `_signals_desc` 按 engine 段的同一套约定补齐 —— 所以
    `last_touched_seq` / `recent_attempts` 之外的描述都不必写全 11 个键。
    """
    from backend.engine.types import Attempt, ChildLearningState, MisconceptionState, Telemetry

    state = ChildLearningState(child_id="child_sm")
    for code, signals in desc.get("competencies", {}).items():
        state.competencies[code] = _engine_signals_from(_signals_desc(**signals))
    for key, signals in desc.get("patterns", {}).items():
        state.patterns[key] = _engine_signals_from(_signals_desc(**signals))
    for misc in desc.get("misconceptions", []):
        created = MisconceptionState(code=misc["code"])
        created.hit_count = misc.get("hit_count", 0)
        created.last_seq = misc.get("last_seq")
        created.resolved = misc.get("resolved", False)
        created.remediation_competency = misc.get("remediation_competency")
        state.misconceptions[created.code] = created
    for row in desc.get("recent_attempts", []):
        state.recent_attempts.append(
            Attempt(
                attempt_id="att_{}".format(row.get("seq", 0)),
                child_id="child_sm",
                item_id="item",
                competency_id=row.get("competency", "make_ten"),
                pattern_id="direct_compute",
                correct=row["correct"],
                telemetry=Telemetry(response_time_ms=5000, active_time_ms=1000),
                seq=row.get("seq", 0),
                hints_used=row.get("hints_used", 0),
            )
        )
    for code, seq in desc.get("last_touched_seq", {}).items():
        state.last_touched_seq[code] = seq
    return state


def _plain_decision(decision):
    return {
        "action": decision.action,
        "competency_id": decision.competency_id,
        "target_competency_id": decision.target_competency_id,
        "reasons": list(decision.reasons),
    }


def _sm_full_signals(**overrides):
    """恰好满足 upgrade_requires 全部阈值 + 样本数要求的 signals（v0 配置）。"""
    desc = {
        "sample_count": 8,
        "mastery": 0.9,
        "accuracy": 0.95,
        "independence": 0.9,
        "transfer": 0.9,
        "fluency": 0.9,
    }
    desc.update(overrides)
    return _sm_signals_desc(**desc)


# (id, note, competency, state 描述)
SM_UPGRADE_CASES = [
    {
        "id": "no_record",
        "note": "能力没有 Signals → hold「还没有任何作答记录」（其它条件都不看）",
        "competency": "sd_add_10",
        "state": {},
    },
    {
        "id": "probe_only",
        "note": "只有探测题：blocks_upgrade + 样本不足两条 reasons 都出现（顺序固定）",
        "competency": "sd_add_10",
        "state": {
            "competencies": {"sd_add_10": _sm_signals_desc(sample_count=6, assessment_samples=6)},
        },
    },
    {
        "id": "practice_short",
        "note": "正式练习样本 5 < 6",
        "competency": "sd_add_10",
        "state": {
            "competencies": {
                "sd_add_10": _sm_full_signals(
                    sample_count=5, mastery=None, accuracy=None,
                    independence=None, transfer=None, fluency=None,
                ),
            },
        },
    },
    {
        "id": "signal_below_and_missing",
        "note": "accuracy 不达标 + mastery 未采样：两种文案同现（先 accuracy 后 mastery）",
        "competency": "sd_add_10",
        "state": {
            "competencies": {
                "sd_add_10": _sm_full_signals(accuracy=0.8, mastery=None),
            },
        },
    },
    {
        "id": "eps_in_upgrade_gate",
        "note": "independence=0.8499999996（比 0.85 低 4e-10）：EPS 在升级门同样生效，"
        "加上其余全部条件满足 → upgrade",
        "competency": "sd_add_10",
        "state": {
            "competencies": {
                "sd_add_10": _sm_full_signals(independence=0.8499999996),
            },
            "patterns": {
                "sd_add_10::combine": {"sample_count": 3, "accuracy": 0.6},
                "sd_add_10::direct_compute": {"sample_count": 3, "accuracy": 0.6},
            },
        },
    },
    {
        "id": "prerequisite_not_mastered",
        "note": "make_ten 的前置 sd_add_10 未达标 → 「前置能力未达标：sd_add_10」",
        "competency": "make_ten",
        "state": {
            "competencies": {"make_ten": _sm_full_signals()},
            "patterns": {
                "make_ten::increase": {"sample_count": 3, "accuracy": 0.9},
                "make_ten::total": {"sample_count": 3, "accuracy": 0.9},
            },
        },
    },
    {
        "id": "pattern_count_short",
        "note": "只成功 1 个 pattern（min_patterns=2）→ 「成功过的 pattern 数不足：1 < 2」",
        "competency": "sd_add_10",
        "state": {
            "competencies": {"sd_add_10": _sm_full_signals()},
            "patterns": {
                "sd_add_10::combine": {"sample_count": 3, "accuracy": 0.9},
                "sd_add_10::direct_compute": {"sample_count": 3, "accuracy": 0.2},
            },
        },
    },
    {
        "id": "all_conditions_met",
        "note": "全部条件满足 → upgrade（无前置的能力，prerequisites 分支空转）",
        "competency": "sd_add_10",
        "state": {
            "competencies": {"sd_add_10": _sm_full_signals()},
            "patterns": {
                "sd_add_10::combine": {"sample_count": 3, "accuracy": 0.6},
                "sd_add_10::direct_compute": {"sample_count": 3, "accuracy": 0.6},
            },
        },
    },
    {
        "id": "reasons_ordering",
        "note": "同时踩中多条：探测题 → 样本不足 → accuracy → mastery 的顺序就是 reasons 顺序",
        "competency": "sd_add_10",
        "state": {
            "competencies": {
                "sd_add_10": _sm_signals_desc(sample_count=7, assessment_samples=7, accuracy=0.5),
            },
        },
    },
]


def _sm_touched(*pairs):
    return {code: seq for code, seq in pairs}


# (id, note, state 描述) —— 期望值由 Python 算出后写入
SM_NEXT_COMPETENCY_CASES = [
    {
        "id": "empty_state_uses_graph_entry",
        "note": "无任何历史 → 图的入口（next_unmastered）",
        "state": {},
    },
    {
        "id": "recent_landing_first",
        "note": "最近落脚且未掌握的能力优先（make_ten 在拓扑序里靠后，但最近碰过）",
        "state": {
            "competencies": {"make_ten": _sm_signals_desc(sample_count=2, mastery=0.2)},
            "last_touched_seq": _sm_touched(("make_ten", 5)),
        },
    },
    {
        "id": "larger_seq_wins",
        "note": "两个都未掌握：seq 大的优先（carry_add@9 > make_ten@5）",
        "state": {
            "competencies": {
                "make_ten": _sm_signals_desc(sample_count=2, mastery=0.2),
                "carry_add": _sm_signals_desc(sample_count=2, mastery=0.2),
            },
            "last_touched_seq": _sm_touched(("make_ten", 5), ("carry_add", 9)),
        },
    },
    {
        "id": "same_seq_tie_breaks_on_code",
        "note": "seq 相同：按 code 升序",
        "state": {
            "competencies": {
                "carry_add": _sm_signals_desc(sample_count=2, mastery=0.2),
                "borrow_sub": _sm_signals_desc(sample_count=2, mastery=0.2),
            },
            "last_touched_seq": _sm_touched(("carry_add", 7), ("borrow_sub", 7)),
        },
    },
    {
        "id": "touched_but_missing_signals_skipped",
        "note": "last_touched_seq 里有、competencies 里没有的 code 被跳过（老数据防护）",
        "state": {
            "competencies": {"make_ten": _sm_signals_desc(sample_count=2, mastery=0.2)},
            "last_touched_seq": _sm_touched(("place_value", 9), ("make_ten", 5)),
        },
    },
    {
        "id": "mastered_landing_falls_through",
        "note": "最近落脚的已**真正掌握**（五信号 + 两个 pattern 证据都齐）→ 跳过它，"
        "落到图里第一个未掌握的能力",
        "state": {
            "competencies": {"sd_add_10": _sm_full_signals()},
            "patterns": {
                "sd_add_10::combine": {"sample_count": 3, "accuracy": 0.6},
                "sd_add_10::direct_compute": {"sample_count": 3, "accuracy": 0.6},
            },
            "last_touched_seq": _sm_touched(("sd_add_10", 3)),
        },
    },
]

# (id, note, current, state 描述)
SM_FALLBACK_CASES = [
    {
        "id": "no_recent_attempts",
        "note": "没有近期作答 → hold",
        "current": "carry_add",
        "state": {"competencies": {"carry_add": _sm_full_signals()}},
    },
    {
        "id": "consecutive_wrong_three",
        "note": "连错 3 次 → fallback；目标是 mastery 最低的前置（weakest_prerequisite）",
        "current": "carry_add",
        "state": {
            "recent_attempts": [
                {"correct": False, "seq": 1},
                {"correct": False, "seq": 2},
                {"correct": False, "seq": 3},
            ],
        },
    },
    {
        "id": "consecutive_wrong_two",
        "note": "只连错 2 次（< 3）：不触发 → hold「未触发回退条件」",
        "current": "carry_add",
        "state": {
            "recent_attempts": [
                {"correct": False, "seq": 2},
                {"correct": False, "seq": 3},
                {"correct": True, "seq": 4},
                {"correct": False, "seq": 5},
            ],
        },
    },
    {
        "id": "hint_spike",
        "note": "提示突然增加 0 → 2（delta 2 ≥ 2）：触发",
        "current": "carry_add",
        "state": {
            "recent_attempts": [
                {"correct": True, "hints_used": 0, "seq": 1},
                {"correct": False, "hints_used": 2, "seq": 2},
            ],
        },
    },
    {
        "id": "hint_spike_below_delta",
        "note": "提示增加 0 → 1（delta 1 < 2）：不触发",
        "current": "carry_add",
        "state": {
            "recent_attempts": [
                {"correct": True, "hints_used": 0, "seq": 1},
                {"correct": False, "hints_used": 1, "seq": 2},
            ],
        },
    },
    {
        "id": "misconception_points_to_prereq",
        "note": "未解决错误认知指向 carry_add 的**前置之一** td_add_nocarry（不是最弱前置会选的"
        " make_ten）→ 目标直接用指名的能力，target 本身就区分了「指名」与「最弱」两条路；"
        "连错同时触发时两条 reasons 都在、顺序固定",
        "current": "carry_add",
        "state": {
            "recent_attempts": [
                {"correct": False, "seq": 1},
                {"correct": False, "seq": 2},
                {"correct": False, "seq": 3},
            ],
            "misconceptions": [
                {
                    "code": "misc_td_add",
                    "last_seq": 3,
                    "remediation_competency": "td_add_nocarry",
                },
            ],
        },
    },
    {
        "id": "misconception_resolved_ignored",
        "note": "已解决的错误认知不触发 → 走最弱前置（target 是 make_ten，与指名路区分）",
        "current": "carry_add",
        "state": {
            "recent_attempts": [
                {"correct": False, "seq": 1},
                {"correct": False, "seq": 2},
                {"correct": False, "seq": 3},
            ],
            "misconceptions": [
                {
                    "code": "misc_td_add",
                    "last_seq": 3,
                    "resolved": True,
                    "remediation_competency": "td_add_nocarry",
                },
            ],
        },
    },
    {
        "id": "misconception_too_old",
        "note": "last_seq < 最后一条 seq - 1（=2）→ 太老，不触发 → 走最弱前置",
        "current": "carry_add",
        "state": {
            "recent_attempts": [
                {"correct": False, "seq": 1},
                {"correct": False, "seq": 2},
                {"correct": False, "seq": 3},
            ],
            "misconceptions": [
                {
                    "code": "misc_td_add",
                    "last_seq": 1,
                    "remediation_competency": "td_add_nocarry",
                },
            ],
        },
    },
    {
        "id": "misconception_points_outside_prereq",
        "note": "指向 carry_add 前置闭包之外（sd_sub_10）→ 不触发 → 走最弱前置",
        "current": "carry_add",
        "state": {
            "recent_attempts": [
                {"correct": False, "seq": 1},
                {"correct": False, "seq": 2},
                {"correct": False, "seq": 3},
            ],
            "misconceptions": [
                {"code": "misc_other", "last_seq": 3, "remediation_competency": "sd_sub_10"},
            ],
        },
    },
    {
        "id": "no_prerequisite_to_fall_back",
        "note": "sd_add_10 没有前置：触发条件成立也只能 hold（不能 fallback 到 null）",
        "current": "sd_add_10",
        "state": {
            "recent_attempts": [
                {"correct": False, "seq": 1},
                {"correct": False, "seq": 2},
                {"correct": False, "seq": 3},
            ],
        },
    },
    {
        "id": "multiple_reasons_first_two",
        "note": "连错 + 提示突增同时触发：两条 reasons 都在、misconception 没有时直接最弱前置",
        "current": "carry_add",
        "state": {
            "recent_attempts": [
                {"correct": False, "hints_used": 0, "seq": 1},
                {"correct": False, "hints_used": 3, "seq": 2},
                {"correct": False, "hints_used": 3, "seq": 3},
            ],
        },
    },
]


def dump_state_machine() -> str:
    """状态机的三层对拍：等级派生 / 升级门 / 回退判定。"""
    from backend.content.loader import load_bundle
    from backend.engine.config import load_config
    from backend.engine.graph import CompetencyGraph
    from backend.engine.state_machine import (
        count_successful_patterns,
        derive_level,
        fallback_decision,
        next_competency,
        upgrade_decision,
    )

    cfg = load_config(0)
    graph = CompetencyGraph(load_bundle())

    derive_cases = [
        {
            "id": spec["id"],
            "note": spec["note"],
            "signals": _sm_signals_desc(**spec["signals"]),
            "expect": derive_level(_engine_signals_from(_sm_signals_desc(**spec["signals"])), cfg),
        }
        for spec in SM_DERIVE_LEVEL_CASES
    ]

    count_cases = []
    for spec in SM_COUNT_PATTERNS_CASES:
        state = _sm_state_from({"patterns": spec["patterns"]})
        count_cases.append(
            {
                "id": spec["id"],
                "note": spec["note"],
                "competency": spec["competency"],
                "patterns": spec["patterns"],
                "expect": count_successful_patterns(state, spec["competency"], graph, cfg),
            }
        )

    def upgrade_case(spec):
        return {
            "id": spec["id"],
            "note": spec["note"],
            "competency": spec["competency"],
            "state": spec["state"],
            "expect": _plain_decision(
                upgrade_decision(_sm_state_from(spec["state"]), spec["competency"], graph, cfg)
            ),
        }

    def next_case(spec):
        return {
            "id": spec["id"],
            "note": spec["note"],
            "state": spec["state"],
            "expect": next_competency(_sm_state_from(spec["state"]), graph, cfg),
        }

    def fallback_case(spec):
        return {
            "id": spec["id"],
            "note": spec["note"],
            "current": spec["current"],
            "state": spec["state"],
            "expect": _plain_decision(
                fallback_decision(_sm_state_from(spec["state"]), spec["current"], graph, cfg)
            ),
        }

    return _write(
        "state_machine_parity.json",
        {
            "config_version": cfg.version,
            "min_samples_for_level": cfg.min_samples_for_level,
            "min_practice_samples": cfg.min_practice_samples,
            "derive_level": derive_cases,
            "count_patterns": count_cases,
            "upgrade": [upgrade_case(spec) for spec in SM_UPGRADE_CASES],
            "next_competency": [next_case(spec) for spec in SM_NEXT_COMPETENCY_CASES],
            "fallback": [fallback_case(spec) for spec in SM_FALLBACK_CASES],
            "level_order": list(cfg.level_order),
        },
    )


# ── learner（apply_attempt / apply_attempts）───────────────
#
# 在线更新与 Replay 共用的推进器。这里的黄金语料要钉的不是"某个信号怎么算"
# （那是 engine 段 update_signals 的事），而是**状态组装**：
#   - 六类账本各自记对（competencies / patterns / misconceptions /
#     attempts_seen+assessment_attempts / first_scaffold / last_touched_seq）
#   - 错误认知"新建 vs 累积"两条路：hit_count 递增、last_seq 覆盖、
#     remediation_competency 从 **bundle 定义**里取 —— 用真实内容里的
#     counting_dependency（remediation=make_ten）钉，item 是 dump 时
#     注入 bundle 的定制题（两侧注入同构）
#   - recent_attempts 的窗口截断：变体配置 window=3，5 条留 3 条
#     （真实配置 window=20，铺 20+ 条才能观测到 —— 不划算）
#   - apply_attempts 的 seq 排序：乱序传入 [3,1,2]，EWMA 对顺序敏感，
#     不排序的话 mastery 会不同 —— 最终快照自己就是证人

LEARNER_ITEM_DESCS = [
    {
        "code": "learner_diag_item",
        "answer": 13,
        # 触发 counting_dependency —— 内容定义里它的 remediation=make_ten
        "error_rules": [{"code": "counting_dependency", "match": {"answer_off_by": 1}}],
    },
]


def _learner_attempt_desc(seq, attempt_id, **overrides):
    desc = dict(ENGINE_ATTEMPT_DEFAULTS)
    desc["id"] = attempt_id
    desc["seq"] = seq
    desc["response_ms"] = 6000  # thinking 5000 → 正常波段
    desc.update(overrides)
    return desc


LEARNER_SEQUENCES = [
    {
        "id": "cold_start_first_attempt",
        "note": "空状态首答：六类账本各记一笔，EWMA 取初值",
        "config": "v0",
        "initial": {},
        "attempts": [_learner_attempt_desc(1, "a1")],
    },
    {
        "id": "ewma_continues_from_prefilled",
        "note": "已有 signals 继续答：EWMA 接着算，不是重置",
        "config": "v0",
        "initial": {
            "competencies": {
                "make_ten": {
                    "mastery": 0.5,
                    "accuracy": 0.8,
                    "sample_count": 4,
                    "assessment_samples": 1,
                }
            }
        },
        "attempts": [
            _learner_attempt_desc(1, "a1"),
            _learner_attempt_desc(2, "a2", correct=False),
        ],
    },
    {
        "id": "pattern_layers_separate",
        "note": "同能力不同 pattern 各自记账；能力层汇总所有 pattern 的作答",
        "config": "v0",
        "initial": {},
        "attempts": [
            _learner_attempt_desc(1, "a1"),
            _learner_attempt_desc(2, "a2", pattern="number_friends", interaction="choice"),
            _learner_attempt_desc(3, "a3", correct=False),
        ],
    },
    {
        "id": "misconception_created_then_accumulated",
        "note": "item 规则触发：第一次新建（hit=1），第二次累积（hit=2、last_seq 覆盖）",
        "config": "v0",
        "initial": {},
        "attempts": [
            _learner_attempt_desc(1, "a1", correct=False, submitted=12,
                                  item_code="learner_diag_item"),
            _learner_attempt_desc(2, "a2", correct=False, submitted=12,
                                  item_code="learner_diag_item"),
            _learner_attempt_desc(3, "a3", correct=True),  # 答对不清除错误认知
        ],
    },
    {
        "id": "misconception_from_attempt_codes",
        "note": "attempt 显式标注的 code 也建账；remediation 同样取自 bundle 定义",
        "config": "v0",
        "initial": {},
        "attempts": [
            _learner_attempt_desc(1, "a1", correct=False,
                                  misconception_codes=["place_value_confusion"]),
        ],
    },
    {
        "id": "assessment_counts_and_weights",
        "note": "probe 计入 assessment_attempts 且权重打折（D5），正式题全额",
        "config": "v0",
        "initial": {},
        "attempts": [
            _learner_attempt_desc(1, "a1", is_assessment=True),
            _learner_attempt_desc(2, "a2"),
            _learner_attempt_desc(3, "a3", is_assessment=True, correct=False),
        ],
    },
    {
        "id": "window_truncates",
        "note": "变体 window=3：5 条作答后 recent_attempts 只留最后 3 条",
        "config": "window3",
        "initial": {},
        "attempts": [_learner_attempt_desc(i, "a{}".format(i)) for i in range(1, 6)],
    },
    {
        "id": "out_of_order_apply",
        "note": "apply_attempts 按 seq 排序后推进（正确/错误/正确的序列）",
        "config": "v0",
        "initial": {},
        "attempts": [
            _learner_attempt_desc(3, "a3"),
            _learner_attempt_desc(1, "a1"),
            _learner_attempt_desc(2, "a2", correct=False),
        ],
    },
]


def _learner_item_from(desc):
    from backend.content.loader import Item

    return Item(
        code=desc["code"],
        competency_id="make_ten",
        pattern_id="direct_compute",
        difficulty=3,
        scaffold_level="direct",
        interaction_type="number_pad",
        estimated_seconds=6,
        problem={},
        answer=desc["answer"],
        error_rules=desc["error_rules"],
    )


def _learner_attempt_from(desc):
    from backend.engine.types import Attempt, Telemetry

    return Attempt(
        attempt_id=desc["id"],
        child_id="child_learner",
        item_id=desc.get("item_code") or "none",
        competency_id=desc["competency"],
        pattern_id=desc["pattern"],
        correct=desc["correct"],
        telemetry=Telemetry(response_time_ms=desc["response_ms"],
                            active_time_ms=desc["active_ms"],
                            idle_time_ms=desc["idle_ms"]),
        seq=desc["seq"],
        hints_used=desc["hints"],
        scaffold_level=desc["scaffold"],
        interaction_type=desc["interaction"],
        is_assessment=desc["is_assessment"],
        is_transfer_probe=desc["is_transfer_probe"],
        submitted_answer=desc.get("submitted"),
        misconception_codes=list(desc.get("misconception_codes", [])),
    )


def _learner_state_from(desc, recent_attempts_by_id):
    """声明式初态 → ChildLearningState（与 _sm_state_from 同风格，多四个账本）。"""
    from backend.engine.types import ChildLearningState, MisconceptionState

    state = ChildLearningState(child_id="child_learner")
    for code, signals in desc.get("competencies", {}).items():
        state.competencies[code] = _engine_signals_from(_signals_desc(**signals))
    for key, signals in desc.get("patterns", {}).items():
        state.patterns[key] = _engine_signals_from(_signals_desc(**signals))
    for misc in desc.get("misconceptions", []):
        created = MisconceptionState(code=misc["code"])
        created.hit_count = misc.get("hit_count", 0)
        created.last_seq = misc.get("last_seq")
        created.resolved = misc.get("resolved", False)
        created.remediation_competency = misc.get("remediation_competency")
        state.misconceptions[created.code] = created
    state.attempts_seen = desc.get("attempts_seen", 0)
    state.assessment_attempts = desc.get("assessment_attempts", 0)
    for aid in desc.get("recent_attempt_ids", []):
        state.recent_attempts.append(recent_attempts_by_id[aid])
    for code, scaffold in desc.get("first_scaffold", {}).items():
        state.first_scaffold[code] = scaffold
    for code, seq in desc.get("last_touched_seq", {}).items():
        state.last_touched_seq[code] = seq
    return state


def _learner_state_snapshot(state):
    """每步推进后的完整状态快照（键都排过序，两侧同构）。"""
    return {
        "attempts_seen": state.attempts_seen,
        "assessment_attempts": state.assessment_attempts,
        "competencies": {
            code: signals.to_dict()
            for code, signals in sorted(state.competencies.items())
        },
        "patterns": {
            key: signals.to_dict()
            for key, signals in sorted(state.patterns.items())
        },
        "misconceptions": {
            code: {
                "hit_count": m.hit_count,
                "last_seq": m.last_seq,
                "resolved": m.resolved,
                "remediation_competency": m.remediation_competency,
            }
            for code, m in sorted(state.misconceptions.items())
        },
        "recent_attempt_ids": [a.attempt_id for a in state.recent_attempts],
        "first_scaffold": dict(sorted(state.first_scaffold.items())),
        "last_touched_seq": dict(sorted(state.last_touched_seq.items())),
    }


def dump_learner() -> str:
    """learner 的画像对拍：逐 attempt 推进，每步 dump 完整状态。"""
    import copy

    from backend.content.loader import load_bundle
    from backend.engine.config import AlgorithmConfig, load_config
    from backend.engine.learner import apply_attempt, apply_attempts

    cfg = load_config(0)
    bundle = load_bundle()
    for desc in LEARNER_ITEM_DESCS:
        bundle.items[desc["code"]] = _learner_item_from(desc)

    # 窗口截断要的变体配置：deepcopy 避免污染共享的 load_config 缓存
    window_cfg = AlgorithmConfig(copy.deepcopy(cfg.raw))
    window_cfg.raw.setdefault("history", {})["recent_attempt_window"] = 3
    configs = {"v0": cfg, "window3": window_cfg}

    # 初态 recent_attempt_ids 引用的 attempt（目前没有 case 用到 ——
    # 保留通道是为了让"初态带历史"的形态有地方写，别在造数据时各走各路）
    recent_by_id = {desc["id"]: _learner_attempt_from(desc) for desc in []}

    sequences = []
    for spec in LEARNER_SEQUENCES:
        use_cfg = configs[spec["config"]]
        state = _learner_state_from(spec.get("initial", {}), recent_by_id)
        steps = []
        attempts = [_learner_attempt_from(desc) for desc in spec["attempts"]]
        if spec["id"] == "out_of_order_apply":
            # 乱序整批 → apply_attempts 内部按 seq 排序
            state = apply_attempts(state, attempts, bundle, use_cfg)
            steps.append(_learner_state_snapshot(state))
        else:
            for attempt in attempts:
                state = apply_attempt(state, attempt, bundle, use_cfg)
                steps.append(_learner_state_snapshot(state))
        sequences.append(
            {
                "id": spec["id"],
                "note": spec["note"],
                "config": spec["config"],
                "initial": spec.get("initial", {}),
                "attempts": spec["attempts"],
                "steps": steps,
            }
        )

    return _write(
        "learner_parity.json",
        {
            "config_version": cfg.version,
            "recent_attempt_window": cfg.recent_attempt_window,
            "items": LEARNER_ITEM_DESCS,
            "sequences": sequences,
        },
    )


# ── replay ─────────────────────────────────────────────────
#
# replay 的黄金语料钉三件事：
#   1. snapshots 逐步快照（等级爬升、scaffold 推荐信号、upgrade decision 的
#      逐字 reasons）—— signals 是 round(., 4) 之后的展示值；
#   2. final_* 系列（next_competency 的落脚点优先、final_mastered 的门）；
#   3. **replay 与在线推进一致**：同一批 attempt，apply_attempts（在线路径）
#      与 replay（重放路径）的最终状态 states_equal 必须为 True ——
#      "共用同一段代码"这条约束的正面断言。.states_equal 的结果（布尔）
#      进 fixture，fingerprint 字符串本身不进（pyjson 不做跨语言逐字对拍）。

REPLAY_SEQUENCES = [
    {
        "id": "progression_ten_attempts",
        "note": "同能力 10 题：正确/提示/错误交错，看等级爬升与 decision 变化",
        "child_id": "child_replay",
        "initial": {},
        "attempts": [
            _learner_attempt_desc(1, "a1"),
            _learner_attempt_desc(2, "a2"),
            _learner_attempt_desc(3, "a3"),
            _learner_attempt_desc(4, "a4", hints=2),
            _learner_attempt_desc(5, "a5", correct=False),
            _learner_attempt_desc(6, "a6"),
            _learner_attempt_desc(7, "a7"),
            _learner_attempt_desc(8, "a8", correct=False),
            _learner_attempt_desc(9, "a9"),
            _learner_attempt_desc(10, "a10"),
        ],
    },
    {
        "id": "multi_competency_landing",
        "note": "跨能力作答：落脚点（last_touched_seq）决定 final_competency",
        "child_id": "child_replay",
        "initial": {},
        "attempts": [
            _learner_attempt_desc(1, "a1", competency="sd_add_10", pattern="combine"),
            _learner_attempt_desc(2, "a2", competency="sd_add_10", pattern="combine"),
            _learner_attempt_desc(3, "a3", competency="sd_add_10", pattern="direct_compute"),
            _learner_attempt_desc(4, "a4", competency="sd_add_10", pattern="direct_compute"),
            _learner_attempt_desc(5, "a5", competency="sd_add_10", pattern="direct_compute"),
            _learner_attempt_desc(6, "a6", competency="carry_add", pattern="carry_exchange",
                                  interaction="carry_exchange"),
            _learner_attempt_desc(7, "a7", competency="carry_add", pattern="carry_exchange",
                                  interaction="carry_exchange"),
            _learner_attempt_desc(8, "a8", competency="carry_add", pattern="carry_exchange",
                                  interaction="carry_exchange"),
        ],
    },
    {
        "id": "with_initial_state",
        "note": "带初态重放：replay 必须 copy() 初态，不动入参",
        "child_id": "child_replay",
        "initial": {
            "competencies": {
                "make_ten": {
                    "mastery": 0.5,
                    "accuracy": 0.8,
                    "sample_count": 4,
                    "assessment_samples": 1,
                }
            },
            "attempts_seen": 4,
            "first_scaffold": {"make_ten": "blocks"},
        },
        "attempts": [
            _learner_attempt_desc(10, "a10"),
            _learner_attempt_desc(11, "a11", correct=False),
        ],
    },
]


def dump_replay() -> str:
    from backend.content.loader import load_bundle
    from backend.engine.config import load_config
    from backend.engine.graph import CompetencyGraph
    from backend.engine.learner import apply_attempts, new_state
    from backend.engine.replay import replay, states_equal

    cfg = load_config(0)
    bundle = load_bundle()
    for desc in LEARNER_ITEM_DESCS:
        bundle.items[desc["code"]] = _learner_item_from(desc)
    graph = CompetencyGraph(bundle)

    def plain_decision(d):
        if d is None:
            return None
        return {
            "action": d.action,
            "competency_id": d.competency_id,
            "target_competency_id": d.target_competency_id,
            "reasons": list(d.reasons),
        }

    def snap(s):
        return {
            "seq": s.seq,
            "attempt_id": s.attempt_id,
            "competency_id": s.competency_id,
            "correct": s.correct,
            "level": s.level,
            "level_label": s.level_label,
            "scaffold_recommended": s.scaffold_recommended,
            "signals": s.signals,
            "decision": plain_decision(s.decision),
        }

    cases = []
    for spec in REPLAY_SEQUENCES:
        attempts = [_learner_attempt_from(d) for d in spec["attempts"]]
        initial = (
            _learner_state_from(spec["initial"], {})
            if spec.get("initial")
            else None
        )
        result = replay(spec["child_id"], attempts, bundle, cfg, graph, initial)
        cases.append(
            {
                "id": spec["id"],
                "note": spec["note"],
                "child_id": spec["child_id"],
                "initial": spec.get("initial", {}),
                "attempts": spec["attempts"],
                "snapshots": [snap(s) for s in result.snapshots],
                "to_dict": result.to_dict(),
                "final_decision": plain_decision(result.final_decision),
            }
        )

    # states_equal：replay 与在线推进的一致性（本模块最重的一条断言）
    equal_cases = []
    for spec in REPLAY_SEQUENCES:
        if spec.get("initial"):
            continue  # 一致性只在"同一起点"下有意义；带初态的用初态副本即可，此处从简
        attempts = [_learner_attempt_from(d) for d in spec["attempts"]]
        online = apply_attempts(new_state(spec["child_id"]), attempts, bundle, cfg)
        rep = replay(spec["child_id"], attempts, bundle, cfg, graph)
        equal_cases.append(
            {
                "id": "replay_matches_online__" + spec["id"],
                "note": "apply_attempts（在线）与 replay（重放）的最终状态必须一致",
                "expect": states_equal(online, rep.final_state),
            }
        )
    # 不相等形态：初态差一点就要能分辨出来（否则 states_equal 恒真是废的）
    state_a = _learner_state_from(
        {"competencies": {"make_ten": {"mastery": 0.5}}}, {}
    )
    state_b = _learner_state_from(
        {"competencies": {"make_ten": {"mastery": 0.9}}}, {}
    )
    equal_cases.append(
        {
            "id": "differs_by_mastery",
            "note": "mastery 不同的两个状态必须判不等",
            "expect": states_equal(state_a, state_b),
        }
    )

    return _write(
        "replay_parity.json",
        {
            "config_version": cfg.version,
            "items": LEARNER_ITEM_DESCS,
            "cases": cases,
            "states_equal": equal_cases,
        },
    )


# ── selector / intent / planner ────────────────────────────
#
# 这三段是「决策链」的对拍：Child State → Intent → Plan → Slot → Item。
#
# selector 用**全定制小 bundle**：题量少到每条分支都可钉（pattern 契约②步、
# 难度阶梯、避重、staleness、prefer_untried_pattern、scaffold 放宽）。
# 真实内容 1373 道题跑一遍，每条分支的输入都是"恰好撞上"，不可控；
# 定制 bundle 的每一道题都是为某条分支摆的，TS 侧照同一份描述构造同构池。
#
# intent / planner 用**真实 bundle + 声明式 state**：这两层的输入是能力状态，
# 输出要经过真实图谱（topo、prerequisites）、真实故事与真实槽位才有代表性。
# planner 另注入 fx_ 前缀的 slot/story（order_index=0 接管 make_ten 的故事段），
# 用来钉"节拍挂不到 slot""候选池为空""复习槽位写死别的 pattern"这些 note 文案。
#
# notes 是**逐字对拍**的重灾区：Python str(None)="None"、str(list)="['a', 'b']"
# 的格式化习惯都活在 note 里，TS 侧照抄字符串模板时最容易在这里走样。

SELECTOR_COMPETENCIES = [
    {"code": "c_a", "name": "能力甲", "stage": 1},
    {"code": "c_b", "name": "能力乙", "stage": 1},
]

SELECTOR_PATTERNS = [
    {"code": "p1", "name": "结构一", "cognitive_type": "procedure", "primary_competency": "c_a"},
    {"code": "p2", "name": "结构二", "cognitive_type": "procedure", "primary_competency": "c_a"},
    {"code": "p3", "name": "结构三", "cognitive_type": "procedure", "primary_competency": "c_b"},
]

# 7 道题各伺候一条分支：b1/b2/d1/d2/d3 是 p1 的难度×脚手架矩阵，
# p2_d2 是"pattern 契约②步"的唯一弹药，b3_cb 挂在 c_b 上验证池按能力过滤。
SELECTOR_ITEM_DESCS = [
    {"code": "fx_i_b1", "competency": "c_a", "pattern": "p1", "scaffold": "blocks", "difficulty": 1},
    {"code": "fx_i_b2", "competency": "c_a", "pattern": "p1", "scaffold": "blocks", "difficulty": 2},
    {"code": "fx_i_d1", "competency": "c_a", "pattern": "p1", "scaffold": "direct", "difficulty": 1},
    {"code": "fx_i_d2", "competency": "c_a", "pattern": "p1", "scaffold": "direct", "difficulty": 2},
    {"code": "fx_i_d3", "competency": "c_a", "pattern": "p1", "scaffold": "direct", "difficulty": 3},
    {"code": "fx_i_p2_d2", "competency": "c_a", "pattern": "p2", "scaffold": "direct", "difficulty": 2},
    {"code": "fx_i_b3_cb", "competency": "c_b", "pattern": "p3", "scaffold": "blocks", "difficulty": 3},
]

SELECTOR_SLOT_DESCS = [
    {"code": "fx_slot_main", "competency": "c_a", "min": 1, "max": 4},
    {"code": "fx_slot_p2", "competency": "c_a", "min": 1, "max": 4, "pattern": "p2"},
    # c_a 没有 p3 的题 —— 钉"放宽 pattern"分支
    {"code": "fx_slot_p3", "competency": "c_a", "min": 1, "max": 4, "pattern": "p3"},
    {"code": "fx_slot_tight", "competency": "c_a", "min": 1, "max": 1},
    # 区间里只有 d3：空状态（scaffold=blocks）在 blocks 档无题 → 放宽到 direct
    {"code": "fx_slot_d3", "competency": "c_a", "min": 3, "max": 3},
    {"code": "fx_slot_direct", "competency": "c_a", "min": 1, "max": 4, "scaffold": "direct"},
    {"code": "fx_slot_avoid0", "competency": "c_a", "min": 1, "max": 4, "policy": {"avoid_recent": 0}},
    {"code": "fx_slot_avoid1", "competency": "c_a", "min": 1, "max": 4, "policy": {"avoid_recent": 1}},
    {"code": "fx_slot_untried", "competency": "c_a", "min": 1, "max": 4, "policy": {"prefer_untried_pattern": True}},
    {"code": "fx_slot_b", "competency": "c_b", "min": 1, "max": 4},
]

# recent_attempts 行的缺省值（两侧构造 Attempt 必须同参）
SELECTOR_ATTEMPT_DEFAULTS = {
    "competency": "c_a",
    "pattern": "p1",
    "correct": True,
    "hints": 0,
    "response_ms": 6000,
    "active_ms": 1000,
    "idle_ms": 0,
    "scaffold": "direct",
    "interaction": "number_pad",
    "is_assessment": False,
    "is_transfer_probe": False,
}

SELECTOR_CASES = [
    {
        "id": "cold_blocks",
        "note": "空状态：scaffold=blocks，desired=区间下界 → 最简单的 blocks 题",
        "slot": "fx_slot_main",
        "initial": {},
    },
    {
        "id": "high_mastery_direct",
        "note": "mastery 0.95 → scaffold=direct，desired 顶到高难度",
        "slot": "fx_slot_main",
        "initial": {"competencies": {"c_a": {"mastery": 0.95, "sample_count": 10}}},
    },
    {
        "id": "mid_mastery_d2",
        "note": "mastery 0.5 → 中间难度",
        "slot": "fx_slot_main",
        "initial": {"competencies": {"c_a": {"mastery": 0.5, "sample_count": 6}}},
    },
    {
        "id": "avoid_recent_skips_fresh",
        "note": "刚做过 d3/b2，阶梯 [2,3] 内 fresh=[d2] → 避重跳过刚做的",
        "slot": "fx_slot_main",
        "initial": {
            "competencies": {"c_a": {"mastery": 0.95, "sample_count": 10}},
            "recent_attempts": [
                {"item": "fx_i_d3", "seq": 1},
                {"item": "fx_i_b2", "seq": 2},
            ],
        },
    },
    {
        "id": "staleness_repeats_within_ladder",
        "note": "阶梯 [3,4] 内只有 d3 且刚做过 → 宁重复、不降级（staleness 兜底）",
        "slot": "fx_slot_main",
        "initial": {
            "competencies": {"c_a": {"mastery": 0.95, "sample_count": 10}},
            "recent_attempts": [{"item": "fx_i_d3", "seq": 1}],
        },
    },
    {
        "id": "staleness_when_pool_all_seen",
        "note": "整池都做过（池 2 题、窗口 8）→ 按 staleness 挑最久没做的",
        "slot": "fx_slot_tight",
        "initial": {
            "recent_attempts": [
                {"item": "fx_i_d1", "seq": 1},
                {"item": "fx_i_b1", "seq": 2},
            ],
        },
    },
    {
        "id": "pattern_contract_beats_ladder",
        "note": "pattern 契约②步：p2 只有难度 2 的题，阶梯 floor=3 也得用它",
        "slot": "fx_slot_p2",
        "initial": {
            "recent_attempts": [
                {"item": "fx_i_d3", "seq": 1, "competency": "c_a"},
            ],
        },
    },
    {
        "id": "pattern_relax_when_empty",
        "note": "c_a 没有 p3 题 → 放宽 pattern（仍是同一能力）",
        "slot": "fx_slot_p3",
        "initial": {},
    },
    {
        "id": "scaffold_relax_nearest",
        "note": "空状态 blocks 档在 [3,3] 无题 → scaffold_order 放宽到 direct",
        "slot": "fx_slot_d3",
        "initial": {},
    },
    {
        "id": "prefer_untried_picks_p2",
        "note": "policy 声明 + p1 试过 → 迁移探针换到 p2",
        "slot": "fx_slot_untried",
        "initial": {
            "patterns": {"c_a::p1": {"mastery": 0.4, "sample_count": 3}},
        },
    },
    {
        "id": "untried_exhausted_returns_none_pattern",
        "note": "p1/p2 都试过 → pick_pattern 返回 None（没有结构可换）",
        "slot": "fx_slot_untried",
        "initial": {
            "patterns": {
                "c_a::p1": {"mastery": 0.4, "sample_count": 3},
                "c_a::p2": {"mastery": 0.4, "sample_count": 3},
            },
        },
    },
    {
        "id": "explicit_scaffold",
        "note": "槽位写死 direct → 不看熟练度",
        "slot": "fx_slot_direct",
        "initial": {},
    },
    {
        "id": "avoid_zero_may_repeat",
        "note": "avoid_recent=0 显式关闭避重 → 刚做过的题也在 fresh 里",
        "slot": "fx_slot_avoid0",
        "initial": {
            "competencies": {"c_a": {"mastery": 0.95, "sample_count": 10}},
            "recent_attempts": [{"item": "fx_i_d3", "seq": 1}],
        },
    },
    {
        "id": "avoid_one_clamped_to_min",
        "note": "声明 1 被下限夹到 8 → d3 仍在避重窗口里（fresh=[d2]）；若没夹取会选 d3",
        "slot": "fx_slot_avoid1",
        "initial": {
            "competencies": {"c_a": {"mastery": 0.95, "sample_count": 10}},
            "recent_attempts": [
                {"item": "fx_i_d3", "seq": 1},
                {"item": "fx_i_b2", "seq": 2},
            ],
        },
    },
    {
        "id": "select_items_excludes_within_group",
        "note": "同槽连取 3 道：取的过程中排除已选",
        "slot": "fx_slot_main",
        "count": 3,
        "initial": {},
    },
    {
        "id": "exclude_codes_across_slots",
        "note": "跨槽位排除表：d3/b2 已排给别的段 → 从候选里消失",
        "slot": "fx_slot_main",
        "count": 2,
        "exclude_codes": ["fx_i_d3", "fx_i_b2"],
        "initial": {"competencies": {"c_a": {"mastery": 0.95, "sample_count": 10}}},
    },
    {
        "id": "pool_filters_by_competency",
        "note": "c_b 的槽只看 c_b 的题（fx_i_b3_cb）",
        "slot": "fx_slot_b",
        "initial": {},
    },
]

SELECTOR_PROBES = [
    # 函数级 probe：把私有函数的返回值逐个钉住，端到端 case 分不清"哪一步分叉"时用它定位。
    {"id": "recent_codes_w2", "note": "窗口 2 只取最后两条", "kind": "recent_codes", "window": 2},
    {"id": "recent_codes_w0", "note": "窗口 0 → 空表", "kind": "recent_codes", "window": 0},
    {"id": "staleness_hit", "note": "d1 在历史 [d3, d1] 里最后一次出现在下标 1", "kind": "staleness", "item": "fx_i_d1"},
    {"id": "staleness_miss", "note": "b1 不在历史里 → -1", "kind": "staleness", "item": "fx_i_b1"},
    {"id": "avoid_default", "note": "默认声明 3，被下限 8 抬到 8", "kind": "avoid_recent", "slot": "fx_slot_main"},
    {"id": "avoid_zero_explicit", "note": "显式 0 → 0（不受下限约束）", "kind": "avoid_recent", "slot": "fx_slot_avoid0"},
    {"id": "avoid_one_clamped", "note": "声明 1 → 下限 8", "kind": "avoid_recent", "slot": "fx_slot_avoid1"},
    {"id": "last_difficulty_hit", "note": "最近一条 c_a 作答是 d3 → 难度 3", "kind": "last_difficulty"},
    {"id": "last_difficulty_unknown_item", "note": "作答指向不存在的题 → 跳过继续回溯", "kind": "last_difficulty", "prefix_unknown": True},
    {"id": "last_difficulty_none", "note": "没做过 → None", "kind": "last_difficulty", "empty": True},
    {"id": "step_no_last", "note": "无历史 → 阶梯就是槽位区间", "kind": "difficulty_step", "last": None, "slot": "fx_slot_main"},
    {"id": "step_from_3", "note": "last=3，步长 1 → [3,4]", "kind": "difficulty_step", "last": 3, "slot": "fx_slot_main"},
    {"id": "step_clamped", "note": "last=4 超过区间上界 → floor 夹到 1", "kind": "difficulty_step", "last": 4, "slot": "fx_slot_tight"},
    {"id": "zone_in", "note": "阶梯内 → 0", "kind": "zone", "difficulty": 2, "floor": 1, "ceil": 3},
    {"id": "zone_below", "note": "比 floor 简单 → 1", "kind": "zone", "difficulty": 0, "floor": 1, "ceil": 3},
    {"id": "zone_above", "note": "跳级 → 2", "kind": "zone", "difficulty": 4, "floor": 1, "ceil": 3},
    {"id": "target_difficulty_null", "note": "无 mastery → unknown_position", "kind": "target_difficulty", "mastery": None},
    {"id": "target_difficulty_low", "note": "mastery 0.25（低于 floor 0.5）→ 区间下界", "kind": "target_difficulty", "mastery": 0.25},
    {"id": "target_difficulty_mid", "note": "mastery 0.75 → 区间内线性位置", "kind": "target_difficulty", "mastery": 0.75},
    {"id": "target_difficulty_high", "note": "mastery 1.0 → 区间上界", "kind": "target_difficulty", "mastery": 1.0},
    {"id": "scaffold_order_blocks", "note": "blocks 优先，其余按距离", "kind": "scaffold_order", "preferred": "blocks"},
    {"id": "scaffold_order_unknown", "note": "auto 不在档位表 → 原序", "kind": "scaffold_order", "preferred": "auto"},
    {"id": "tried_patterns", "note": "只数 c_a 名下的 pattern", "kind": "tried_patterns"},
    {"id": "pick_pattern_unconstrained", "note": "槽位无 pattern、无 policy → None", "kind": "pick_pattern", "slot": "fx_slot_main"},
    {"id": "pick_pattern_slot_fixed", "note": "槽位写死 p2 → 原样返回", "kind": "pick_pattern", "slot": "fx_slot_p2"},
    {"id": "pick_pattern_untried", "note": "p1 试过 → 换 p2", "kind": "pick_pattern", "slot": "fx_slot_untried", "with_untried_state": True},
]


def _selector_bundle():
    """定制小 bundle —— 与 TS 侧 buildSelectorBundle 同构，实体清单见上方描述。"""
    from backend.content.loader import AUTO_SCAFFOLD, ChallengeSlot, Competency, ContentBundle, Item, Pattern

    bundle = ContentBundle()
    for row in SELECTOR_COMPETENCIES:
        bundle.competencies[row["code"]] = Competency(
            code=row["code"], name=row["name"], stage=row["stage"]
        )
    for row in SELECTOR_PATTERNS:
        bundle.patterns[row["code"]] = Pattern(
            code=row["code"],
            name=row["name"],
            cognitive_type=row["cognitive_type"],
            primary_competency=row["primary_competency"],
        )
    for row in SELECTOR_ITEM_DESCS:
        bundle.items[row["code"]] = Item(
            code=row["code"],
            competency_id=row["competency"],
            pattern_id=row["pattern"],
            difficulty=row["difficulty"],
            scaffold_level=row["scaffold"],
            interaction_type="number_pad",
            estimated_seconds=6,
            problem={"prompt": "{} 占位题面".format(row["code"])},
            answer=None,
        )
    for row in SELECTOR_SLOT_DESCS:
        bundle.slots[row["code"]] = ChallengeSlot(
            code=row["code"],
            competency_id=row["competency"],
            difficulty_min=row["min"],
            difficulty_max=row["max"],
            pattern_id=row.get("pattern"),
            scaffold_level=row.get("scaffold", AUTO_SCAFFOLD),
            selection_policy=dict(row.get("policy", {})),
        )
    return bundle


def _sel_state_from(desc):
    """声明式状态 → ChildLearningState（recent_attempts 支持指定 item）。"""
    from backend.engine.types import Attempt, ChildLearningState, Telemetry

    state = ChildLearningState(child_id="child_sel")
    for code, signals in desc.get("competencies", {}).items():
        state.competencies[code] = _engine_signals_from(_signals_desc(**signals))
    for key, signals in desc.get("patterns", {}).items():
        state.patterns[key] = _engine_signals_from(_signals_desc(**signals))
    for row in desc.get("recent_attempts", []):
        params = dict(SELECTOR_ATTEMPT_DEFAULTS)
        params.update(row)
        state.recent_attempts.append(
            Attempt(
                attempt_id="att_{}".format(params.get("seq", 0)),
                child_id="child_sel",
                item_id=params["item"],
                competency_id=params["competency"],
                pattern_id=params["pattern"],
                correct=params["correct"],
                telemetry=Telemetry(
                    response_time_ms=params["response_ms"],
                    active_time_ms=params["active_ms"],
                    idle_time_ms=params["idle_ms"],
                ),
                seq=params.get("seq", 0),
                hints_used=params["hints"],
                scaffold_level=params["scaffold"],
                interaction_type=params["interaction"],
                is_assessment=params["is_assessment"],
                is_transfer_probe=params["is_transfer_probe"],
            )
        )
    for code, seq in desc.get("last_touched_seq", {}).items():
        state.last_touched_seq[code] = seq
    return state


def dump_selector() -> str:
    """选题器的分支对拍：端到端 select_item/select_items + 函数级 probe。"""
    from backend.engine.config import load_config
    from backend.engine.graph import CompetencyGraph
    from backend.engine.selector import (
        _avoid_recent_window,
        _difficulty_step,
        _last_difficulty,
        _pick_pattern,
        _recent_codes,
        _scaffold_order,
        _staleness,
        _target_difficulty,
        _tried_patterns,
        _zone,
        select_item,
        select_items,
    )

    cfg = load_config(0)
    bundle = _selector_bundle()
    graph = CompetencyGraph(bundle)

    cases = []
    for spec in SELECTOR_CASES:
        state = _sel_state_from(spec.get("initial", {}))
        slot = bundle.slots[spec["slot"]]
        count = spec.get("count", 1)
        exclude = spec.get("exclude_codes")
        if count == 1:
            picked_item = select_item(slot, state, bundle, cfg, exclude_codes=exclude)
            picked = [picked_item.code] if picked_item is not None else None
        else:
            picked = [i.code for i in select_items(slot, state, bundle, cfg, count, exclude_codes=exclude)]
        cases.append(
            {
                "id": spec["id"],
                "note": spec["note"],
                "slot": spec["slot"],
                "initial": spec.get("initial", {}),
                "count": count,
                "exclude_codes": list(exclude or []),
                "picked": picked,
            }
        )

    # probe 共享一个"有历史、半熟"的状态
    probe_state = _sel_state_from(
        {
            "competencies": {"c_a": {"mastery": 0.5, "sample_count": 6}},
            "patterns": {"c_a::p1": {"mastery": 0.4, "sample_count": 3}},
            "recent_attempts": [
                {"item": "fx_i_d3", "seq": 1},
                {"item": "fx_i_d1", "seq": 2},
            ],
        }
    )
    empty_state = _sel_state_from({})
    probe_history = [a.item_id for a in probe_state.recent_attempts]
    probes = []
    for spec in SELECTOR_PROBES:
        kind = spec["kind"]
        if kind == "recent_codes":
            result = _recent_codes(probe_state, spec["window"])
        elif kind == "staleness":
            result = _staleness(bundle.items[spec["item"]], probe_history)
        elif kind == "avoid_recent":
            result = _avoid_recent_window(bundle.slots[spec["slot"]], cfg)
        elif kind == "last_difficulty":
            if spec.get("empty"):
                st = empty_state
            elif spec.get("prefix_unknown"):
                st = _sel_state_from(
                    {"recent_attempts": [
                        {"item": "ghost_item", "seq": 1, "competency": "c_a"},
                        {"item": "fx_i_d3", "seq": 2},
                    ]}
                )
            else:
                st = probe_state
            result = _last_difficulty(st, bundle, "c_a")
        elif kind == "difficulty_step":
            result = list(_difficulty_step(bundle.slots[spec["slot"]], spec["last"], cfg))
        elif kind == "zone":
            result = _zone(spec["difficulty"], spec["floor"], spec["ceil"])
        elif kind == "target_difficulty":
            st = empty_state
            if spec["mastery"] is not None:
                st = _sel_state_from(
                    {"competencies": {"c_a": {"mastery": spec["mastery"], "sample_count": 6}}}
                )
            result = _target_difficulty(bundle.slots["fx_slot_main"], st, cfg)
        elif kind == "scaffold_order":
            result = _scaffold_order(spec["preferred"])
        elif kind == "tried_patterns":
            result = sorted(_tried_patterns(probe_state, "c_a"))
        elif kind == "pick_pattern":
            st = probe_state if spec.get("with_untried_state") else probe_state
            result = _pick_pattern(bundle.slots[spec["slot"]], st, bundle, "direct")
        else:
            raise SystemExit("未知 probe：{}".format(kind))
        probes.append({"id": spec["id"], "note": spec["note"], "result": result})

    return _write(
        "selector_parity.json",
        {
            "config_version": cfg.version,
            "competencies": SELECTOR_COMPETENCIES,
            "patterns": SELECTOR_PATTERNS,
            "items": SELECTOR_ITEM_DESCS,
            "slots": SELECTOR_SLOT_DESCS,
            "cases": cases,
            "probes": probes,
        },
    )


# ── intent ─────────────────────────────────────────────────
# derive_intents 的每一支 warmup / repair / probe_transfer / strengthen_fluency /
# teach 都要有一条 state 恰好踩中。descibe 的编号文案（"1. [warmup] ..."）也是
# 对拍对象 —— 它是给家长看的，文案走样就是产品 bug。

INTENT_CASES = [
    {
        "id": "cold_start",
        "note": "空状态 → 只有 teach（topo 首个能力 place_value）",
        "initial": {},
    },
    {
        "id": "warmup_recall",
        "note": "sd_add_10 已会未自动化（mastery 0.8、样本 10 ≤ 12）→ warmup",
        "initial": {
            "competencies": {
                "sd_add_10": {"mastery": 0.8, "accuracy": 0.85, "sample_count": 10},
                "make_ten": {"mastery": 0.4, "accuracy": 0.6, "sample_count": 5},
            },
        },
    },
    {
        "id": "warmup_excluded_automated",
        "note": "样本 13 > 12 → 视为已自动化，warmup 不选它",
        "initial": {
            "competencies": {
                "sd_add_10": {"mastery": 0.8, "accuracy": 0.85, "sample_count": 13},
                "make_ten": {"mastery": 0.4, "accuracy": 0.6, "sample_count": 5},
            },
        },
    },
    {
        "id": "probe_transfer_when_ready",
        "note": "mastery 0.65 达 probe 线（0.6）但未到升级线（0.75）+ reverse 没试过 + transfer 无证据 → probe_transfer 与 teach 并存",
        "initial": {
            "competencies": {
                "make_ten": {
                    "mastery": 0.65, "accuracy": 0.9, "fluency": 0.9,
                    "independence": 0.9, "transfer": 0.9, "sample_count": 12,
                },
            },
            "patterns": {
                "make_ten::direct_compute": {"mastery": 0.9, "sample_count": 6},
                "make_ten::decompose": {"mastery": 0.9, "sample_count": 6},
                "make_ten::number_friends": {"mastery": 0.9, "sample_count": 6},
                "make_ten::increase": {"mastery": 0.9, "sample_count": 6},
                "make_ten::total": {"mastery": 0.9, "sample_count": 6},
                "make_ten::missing_part": {"mastery": 0.9, "sample_count": 6},
            },
            "last_touched_seq": {"make_ten": 12},
        },
    },
    {
        "id": "strengthen_fluency",
        "note": "mastery 0.7 会做，fluency 0.2 太慢（< 0.6×1.0）→ strengthen_fluency 与 teach 并存",
        "initial": {
            "competencies": {
                "make_ten": {
                    "mastery": 0.7, "accuracy": 0.9, "fluency": 0.2,
                    "independence": 0.9, "sample_count": 10,
                },
            },
            "last_touched_seq": {"make_ten": 10},
        },
    },
    {
        "id": "repair_after_consecutive_wrong",
        "note": "make_ten 连错 3 次 → 回退到最弱前置 sd_add_10（repair 优先于 teach）",
        "initial": {
            "competencies": {
                "sd_add_10": {"mastery": 0.5, "sample_count": 8},
                "make_ten": {"mastery": 0.4, "accuracy": 0.3, "sample_count": 9},
            },
            "recent_attempts": [
                {"item": "m1", "competency": "make_ten", "seq": 1, "correct": False},
                {"item": "m2", "competency": "make_ten", "seq": 2, "correct": False},
                {"item": "m3", "competency": "make_ten", "seq": 3, "correct": False},
            ],
            "last_touched_seq": {"make_ten": 3},
        },
    },
    {
        "id": "mixed_full",
        "note": "warmup + strengthen_fluency + teach 同场：排序按 (priority, kind)",
        "initial": {
            "competencies": {
                "sd_add_10": {"mastery": 0.75, "accuracy": 0.8, "sample_count": 9},
                "make_ten": {
                    "mastery": 0.7, "accuracy": 0.9, "fluency": 0.2,
                    "independence": 0.9, "sample_count": 10,
                },
            },
            "last_touched_seq": {"make_ten": 10, "sd_add_10": 9},
        },
    },
]


def _intent_state_from(desc):
    """intent/planner 共用的状态构造器（recent_attempts 指向虚拟 item）。"""
    from backend.engine.types import Attempt, ChildLearningState, MisconceptionState, Telemetry

    state = ChildLearningState(child_id="child_intent")
    for code, signals in desc.get("competencies", {}).items():
        state.competencies[code] = _engine_signals_from(_signals_desc(**signals))
    for key, signals in desc.get("patterns", {}).items():
        state.patterns[key] = _engine_signals_from(_signals_desc(**signals))
    for misc in desc.get("misconceptions", []):
        created = MisconceptionState(code=misc["code"])
        created.hit_count = misc.get("hit_count", 0)
        created.last_seq = misc.get("last_seq")
        created.resolved = misc.get("resolved", False)
        created.remediation_competency = misc.get("remediation_competency")
        state.misconceptions[created.code] = created
    for row in desc.get("recent_attempts", []):
        state.recent_attempts.append(
            Attempt(
                attempt_id="att_{}".format(row.get("seq", 0)),
                child_id="child_intent",
                item_id=row.get("item", "ghost_item"),
                competency_id=row.get("competency", "make_ten"),
                pattern_id=row.get("pattern", "direct_compute"),
                correct=row.get("correct", True),
                telemetry=Telemetry(response_time_ms=6000, active_time_ms=1000),
                seq=row.get("seq", 0),
                hints_used=row.get("hints", 0),
            )
        )
    state.attempts_seen = desc.get("attempts_seen", 0)
    state.assessment_attempts = desc.get("assessment_attempts", 0)
    for code, scaffold in desc.get("first_scaffold", {}).items():
        state.first_scaffold[code] = scaffold
    for code, seq in desc.get("last_touched_seq", {}).items():
        state.last_touched_seq[code] = seq
    return state


def _intent_to_dict(intent):
    return {
        "kind": intent.kind,
        "competency_id": intent.competency_id,
        "reason": intent.reason,
        "pattern_id": intent.pattern_id,
        "scaffold_level": intent.scaffold_level,
        "target_seconds": intent.target_seconds,
        "priority": intent.priority,
    }


def dump_intent() -> str:
    """意图层的分支对拍：derive_intents 全量 + describe_intents 文案。"""
    from backend.content.loader import load_bundle
    from backend.engine.config import load_config
    from backend.engine.graph import CompetencyGraph
    from backend.engine.intent import derive_intents, describe_intents

    cfg = load_config(0)
    bundle = load_bundle()
    graph = CompetencyGraph(bundle)

    cases = []
    for spec in INTENT_CASES:
        state = _intent_state_from(spec["initial"])
        intents = derive_intents(state, graph, bundle, cfg)
        cases.append(
            {
                "id": spec["id"],
                "note": spec["note"],
                "initial": spec["initial"],
                "intents": [_intent_to_dict(i) for i in intents],
                "described": describe_intents(intents),
            }
        )

    return _write(
        "intent_parity.json",
        {"config_version": cfg.version, "cases": cases},
    )


# ── planner ────────────────────────────────────────────────
# build_daily_plan 的对拍吃三样输入：声明式 state、due_reviews 描述、
# case 级内容变异（hide_slots / drop_stories）。注入的 fx_story（order_index=0）
# 接管 make_ten 的故事段：一个能落题的节拍、一个候选池为空的节拍、
# 一个挂不上 slot 的节拍 —— 三种命运各有文案。

PLANNER_ITEM_DESCS = [
    {"code": "fx_pl_i1", "competency": "make_ten", "pattern": "decompose", "scaffold": "direct", "difficulty": 2},
    {"code": "fx_pl_i2", "competency": "make_ten", "pattern": "number_friends", "scaffold": "direct", "difficulty": 2},
]

PLANNER_SLOT_DESCS = [
    {"code": "fx_story_slot_a", "competency": "make_ten", "min": 1, "max": 3, "purpose": "story"},
    # 难度 5-5：make_ten 在这个区间没有题 → 候选池为空
    {"code": "fx_story_slot_b", "competency": "make_ten", "min": 5, "max": 5, "purpose": "story"},
    # purpose=warmup 的槽位写死 number_friends —— 复习意图（reverse）拿到它时
    # 会命中"槽位写死了别的 pattern → 复习无法落题"
    {"code": "fx_warmup_fixed", "competency": "make_ten", "min": 1, "max": 4, "purpose": "warmup", "pattern": "number_friends"},
]

PLANNER_STORY_DESC = {
    "code": "fx_story",
    "title": "对拍小站",
    "universe": "fx",
    "summary": "对拍专用的故事",
    "order_index": 0,
    "duration_min": 4,
    "target_competencies": ["make_ten"],
    "beats": [
        {"code": "fx_story__b1", "sequence": 1, "type": "narration", "narration": "开场白", "character": "小狐狸"},
        {"code": "fx_story__b2", "sequence": 2, "type": "challenge", "slot": "fx_story_slot_a"},
        {"code": "fx_story__b3", "sequence": 3, "type": "challenge", "slot": "fx_story_slot_b"},
        {"code": "fx_story__b4", "sequence": 4, "type": "challenge", "slot": "fx_story_slot_missing"},
        {"code": "fx_story__b5", "sequence": 5, "type": "reward"},
    ],
}

PLANNER_REVIEW_DESCS = [
    {"key": "rv1", "competency": "make_ten", "pattern": "decompose", "interval_index": 0,
     "overdue_days": 2, "due_day": 6, "last_correct_day": 4, "consecutive_correct": 1},
    {"key": "rv2", "competency": "make_ten", "pattern": "number_friends", "interval_index": 1,
     "overdue_days": 1, "due_day": 7, "last_correct_day": 6, "consecutive_correct": 2},
    {"key": "rv3", "competency": "make_ten", "pattern": "reverse", "interval_index": 2,
     "overdue_days": 0, "due_day": 8, "last_correct_day": 8, "consecutive_correct": 3},
]

PLANNER_CASES = [
    {
        "id": "cold_start",
        "note": "空状态：target=place_value，故事段用真实故事 station_04",
        "initial": {},
    },
    {
        "id": "mid_progress_with_story",
        "note": "make_ten 进行中：story 段走 fx_story（三拍三种命运），warmup 召回 sd_add_10",
        "initial": {
            "competencies": {
                "sd_add_10": {"mastery": 0.8, "accuracy": 0.85, "sample_count": 10},
                "make_ten": {"mastery": 0.55, "accuracy": 0.7, "fluency": 0.5, "sample_count": 9},
            },
            "patterns": {
                "make_ten::decompose": {"mastery": 0.6, "sample_count": 4},
                "make_ten::direct_compute": {"mastery": 0.5, "sample_count": 3},
            },
            "attempts_seen": 14,
            "first_scaffold": {"make_ten": "blocks"},
            "last_touched_seq": {"make_ten": 14, "sd_add_10": 10},
        },
    },
    {
        "id": "budget_clamp_low",
        "note": "请求 2 分钟 → 夹到下限 10",
        "budget_minutes": 2,
        "initial": {},
    },
    {
        "id": "budget_clamp_high",
        "note": "请求 99 分钟 → 夹到上限 15",
        "budget_minutes": 99,
        "initial": {},
    },
    {
        "id": "reviews_share_warmup",
        "note": "2 项到期复习 ≤ warmup_item_count → 复习占满热身容量，常规热身被顶掉",
        "due_reviews": ["rv1", "rv2"],
        "initial": {
            "competencies": {
                "sd_add_10": {"mastery": 0.8, "accuracy": 0.85, "sample_count": 10},
                "make_ten": {"mastery": 0.55, "accuracy": 0.7, "sample_count": 9},
            },
            "first_scaffold": {"make_ten": "blocks"},
        },
    },
    {
        "id": "reviews_overflow",
        "note": "3 项复习 > 容量 2 → 常规热身整段消失，多出的复习也不新开段落",
        "due_reviews": ["rv1", "rv2", "rv3"],
        "initial": {
            "competencies": {
                "sd_add_10": {"mastery": 0.8, "accuracy": 0.85, "sample_count": 10},
                "make_ten": {"mastery": 0.55, "accuracy": 0.7, "sample_count": 9},
            },
            "first_scaffold": {"make_ten": "blocks"},
        },
    },
    {
        "id": "review_pattern_blocked_by_slot",
        "note": "隐藏 free 槽后 reverse 复习只落到写死 number_friends 的槽 → 复习无法落题",
        "due_reviews": ["rv3"],
        "hide_slots": ["core_make_ten_practice"],
        "initial": {
            "competencies": {"make_ten": {"mastery": 0.55, "accuracy": 0.7, "sample_count": 9}},
            "first_scaffold": {"make_ten": "blocks"},
        },
    },
    {
        "id": "no_story_at_all",
        "note": "整个内容库没有故事 → NOTE_NO_STORY_AT_ALL，比例重分配",
        "drop_stories": True,
        "initial": {
            "competencies": {"make_ten": {"mastery": 0.55, "accuracy": 0.7, "sample_count": 9}},
            "first_scaffold": {"make_ten": "blocks"},
        },
    },
    {
        "id": "no_story_for_target",
        "note": "删掉 fx_story 后 place_value 等别人的故事帮不了 make_ten → NOTE_NO_STORY_FOR_TARGET",
        "drop_stories": ["fx_story"],
        "initial": {
            "competencies": {"make_ten": {"mastery": 0.55, "accuracy": 0.7, "sample_count": 9}},
            "first_scaffold": {"make_ten": "blocks"},
        },
    },
    {
        "id": "discovery_first_scaffold_progress",
        "note": "first_scaffold=blocks 且现在 direct → 今日发现用进阶文案",
        "initial": {
            "competencies": {
                "make_ten": {"mastery": 0.95, "accuracy": 0.95, "sample_count": 12},
            },
            "first_scaffold": {"make_ten": "blocks"},
            "last_touched_seq": {"make_ten": 12},
        },
    },
    {
        "id": "discovery_accuracy_high",
        "note": "accuracy ≥ 0.8 → 越来越顺文案",
        "initial": {
            "competencies": {
                "make_ten": {"mastery": 0.6, "accuracy": 0.85, "sample_count": 9},
            },
            "last_touched_seq": {"make_ten": 9},
        },
    },
    {
        "id": "discovery_default",
        "note": "都不满足 → 不止一种算法文案",
        "initial": {
            "competencies": {
                "make_ten": {"mastery": 0.6, "accuracy": 0.5, "sample_count": 9},
            },
            "last_touched_seq": {"make_ten": 9},
        },
    },
]


def _planner_bundle(case):
    """真实 bundle + fx 注入 + case 级变异。每 case 重建，互不污染。"""
    from backend.content.loader import AUTO_SCAFFOLD, ChallengeSlot, Item, Story, StoryBeat, load_bundle

    bundle = load_bundle()
    for row in PLANNER_ITEM_DESCS:
        bundle.items[row["code"]] = Item(
            code=row["code"],
            competency_id=row["competency"],
            pattern_id=row["pattern"],
            difficulty=row["difficulty"],
            scaffold_level=row["scaffold"],
            interaction_type="number_pad",
            estimated_seconds=6,
            problem={"prompt": "{} 占位题面".format(row["code"])},
            answer=None,
        )
    for row in PLANNER_SLOT_DESCS:
        bundle.slots[row["code"]] = ChallengeSlot(
            code=row["code"],
            competency_id=row["competency"],
            difficulty_min=row["min"],
            difficulty_max=row["max"],
            purpose=row["purpose"],
            pattern_id=row.get("pattern"),
            scaffold_level=AUTO_SCAFFOLD,
        )
    story = Story(
        code=PLANNER_STORY_DESC["code"],
        title=PLANNER_STORY_DESC["title"],
        universe=PLANNER_STORY_DESC["universe"],
        summary=PLANNER_STORY_DESC["summary"],
        order_index=PLANNER_STORY_DESC["order_index"],
        duration_min=PLANNER_STORY_DESC["duration_min"],
        target_competencies=list(PLANNER_STORY_DESC["target_competencies"]),
    )
    for row in PLANNER_STORY_DESC["beats"]:
        story.beats.append(
            StoryBeat(
                code=row["code"],
                story_code=story.code,
                sequence=row["sequence"],
                beat_type=row["type"],
                narration=row.get("narration", ""),
                character=row.get("character", ""),
                slot_code=row.get("slot"),
            )
        )
    bundle.stories[story.code] = story

    for code in case.get("hide_slots", []):
        bundle.slots.pop(code, None)
    if case.get("drop_stories") is True:
        bundle.stories.clear()
    else:
        for code in case.get("drop_stories", []):
            bundle.stories.pop(code, None)
    return bundle


def _plan_to_dict(plan):
    return {
        "child_id": plan.child_id,
        "budget_minutes": plan.budget_minutes,
        "segments": [
            {
                "type": seg.type,
                "budget_s": seg.budget_s,
                "intents": [_intent_to_dict(i) for i in seg.intents],
                "items": [i.code for i in seg.items],
                "slot_code": seg.slot_code,
                "scaffold_level": seg.scaffold_level,
                "note": seg.note,
                "story_code": seg.story_code,
                "beats": [
                    {
                        "beat_code": b.beat_code,
                        "slot_code": b.slot_code,
                        "item_code": b.item_code,
                    }
                    for b in seg.beats
                ],
            }
            for seg in plan.segments
        ],
        "intents": [_intent_to_dict(i) for i in plan.intents],
        "discovery": plan.discovery,
        "notes": list(plan.notes),
    }


def dump_planner() -> str:
    """每日计划对拍：build_daily_plan 的完整 DailyPlan + render_plan 文本。"""
    from backend.content.loader import load_bundle
    from backend.engine.config import load_config
    from backend.engine.graph import CompetencyGraph
    from backend.engine.planner import build_daily_plan, render_plan
    from backend.engine.scheduler import ReviewItem

    cfg = load_config(0)
    review_items = {
        row["key"]: ReviewItem(
            pattern_key="{}::{}".format(row["competency"], row["pattern"]),
            competency_id=row["competency"],
            pattern_id=row["pattern"],
            due_day=row["due_day"],
            interval_index=row["interval_index"],
            last_correct_day=row["last_correct_day"],
            consecutive_correct=row["consecutive_correct"],
            overdue_days=row["overdue_days"],
        )
        for row in PLANNER_REVIEW_DESCS
    }

    cases = []
    for spec in PLANNER_CASES:
        bundle = _planner_bundle(spec)
        graph = CompetencyGraph(bundle)
        state = _intent_state_from(spec.get("initial", {}))
        due = [review_items[key] for key in spec.get("due_reviews", [])]
        plan = build_daily_plan(
            state,
            graph,
            bundle,
            cfg,
            budget_minutes=spec.get("budget_minutes"),
            due_reviews=due or None,
        )
        cases.append(
            {
                "id": spec["id"],
                "note": spec["note"],
                "initial": spec.get("initial", {}),
                "budget_minutes": spec.get("budget_minutes"),
                "due_reviews": list(spec.get("due_reviews", [])),
                "hide_slots": list(spec.get("hide_slots", [])),
                "drop_stories": spec.get("drop_stories", False),
                "plan": _plan_to_dict(plan),
                "render": render_plan(plan, graph, cfg),
            }
        )

    return _write(
        "planner_parity.json",
        {
            "config_version": cfg.version,
            "items": PLANNER_ITEM_DESCS,
            "slots": PLANNER_SLOT_DESCS,
            "story": PLANNER_STORY_DESC,
            "reviews": PLANNER_REVIEW_DESCS,
            "cases": cases,
        },
    )


# ── detective ──────────────────────────────────────────────
#
# 侦探模式是纯函数 + MT19937 种子：同一 puzzle_id 两侧必须重建出同一道题。
# 对拍三层：
#   1. 生成的谜题逐字（to_dict 全量 + solve/weak_clues + answer）；
#   2. judge 的输入变体（" 7 " / "07" / "3.5" / None —— Python int(str) 的
#      接受域就是判分的接受域）；
#   3. **穷举扫描**：0..1999 × {auto, 3 kind} 全部种子生成成功且 validate()==[]，
#      记录每个种子的顺延 offset —— 两侧的顺延序列必须逐项一致
#      （validate/is_trivial 的任何分叉都会在这里现形）。

DETECTIVE_SEEDS = list(range(1, 61)) + [0, 99, 999, 4096, 9999]
DETECTIVE_FIXED_KIND_SEEDS = [1, 7, 42, 100, 777, 2026]
DETECTIVE_SCAN_RANGE = 2000


def _detective_case(pid, kind, reveal_count=None):
    from backend.engine.detective import generate_puzzle

    # reveal_count 变体覆盖夹取两端：None=默认 2；1=下限；99=上界
    # （夹到 clues.length - 1 —— "谜题必须留悬念"的边界，变异测试靠它杀人）
    kwargs = {} if reveal_count is None else {"reveal_count": reveal_count}
    puzzle = generate_puzzle(pid, kind=kind, **kwargs)
    return {
        "puzzle_id": pid,
        "kind": kind,
        # None = 引擎默认 2；同 id 不同 reveal 的 case 靠它区分
        "reveal_count": reveal_count,
        "to_dict": puzzle.to_dict(),
        "answer": puzzle.answer,
        "solve": puzzle.solve(),
        "validate": puzzle.validate(),
        "weak_clues": puzzle.weak_clues(),
    }


def dump_detective() -> str:
    from backend.engine.detective import (
        ALL_KINDS,
        generate_puzzle,
        judge,
        make_puzzle_id,
        parse_puzzle_id,
        reveal_after_attempt,
    )

    cases = []
    for seed in DETECTIVE_SEEDS:
        pid = make_puzzle_id(seed)
        cases.append(_detective_case(pid, None))
    for kind in ALL_KINDS:
        for seed in DETECTIVE_FIXED_KIND_SEEDS:
            cases.append(_detective_case(make_puzzle_id(seed), kind))
    # reveal_count 的两端夹取（变异测试发现默认 case 全落在夹取死区里）：
    # 1 = 下限；5 = 超过典型线索数 - 1 → 上界夹取生效（谜题必须留一档悬念）。
    # 注：balance 在大 reveal_count 下 is_trivial 恒真，40 个种子全被顺延掉
    # （RuntimeError）—— 夹取上界正是防这种"全部揭示"的保险丝，别用它试。
    for reveal_count in (1, 5):
        cases.append(
            _detective_case(make_puzzle_id(3), None, reveal_count=reveal_count)
        )
        cases.append(
            _detective_case(make_puzzle_id(100), "find_pattern", reveal_count=reveal_count)
        )

    # judge 的输入变体围绕"真实答案"构造（answer 本身就是 case 数据）。
    # "9" 与 "{ans}9" 是给变异测试的：judge 的接受域是 [0-9]，缺了含 9 的
    # 输入时，把字符类缩成 [0-8] 的变异不会被任何 fixture 杀死。
    probe = generate_puzzle(make_puzzle_id(42))
    ans = probe.answer
    judge_inputs = [str(ans), " {} ".format(ans), "0{}".format(ans), "+{}".format(ans),
                    "{}.0".format(ans), "abc", None, True, 3.5, -1, "",
                    "9", "{}9".format(ans)]
    judge_cases = [{"input": v, "expect": judge(probe, v)} for v in judge_inputs]

    # 连错三次的揭示序列（多谜题取样，覆盖不同 kind）
    reveal_cases = []
    for pid, kind in [(make_puzzle_id(3), None), (make_puzzle_id(42), None),
                      (make_puzzle_id(7), None),
                      (make_puzzle_id(100), "balance")]:
        puzzle = generate_puzzle(pid, kind=kind)
        wrong = []
        for _ in range(3):
            wrong.extend(reveal_after_attempt(puzzle, correct=False))
        right = reveal_after_attempt(puzzle, correct=True)
        reveal_cases.append(
            {"puzzle_id": pid, "kind": kind,
             "wrong_reveals": wrong, "right_reveals": right,
             "clues_remaining": puzzle.clues_remaining}
        )

    parse_cases = [
        {"puzzle_id": "det_0042", "expect": parse_puzzle_id("det_0042")},
        {"puzzle_id": "det_0", "expect": parse_puzzle_id("det_0")},
        {"puzzle_id": "", "expect": parse_puzzle_id("")},
        {"puzzle_id": "det_", "expect": parse_puzzle_id("det_")},
        {"puzzle_id": "det_x", "expect": parse_puzzle_id("det_x")},
        {"puzzle_id": "det_12x", "expect": parse_puzzle_id("det_12x")},
        {"puzzle_id": "other_0042", "expect": parse_puzzle_id("other_0042")},
        {"puzzle_id": "det_123456", "expect": parse_puzzle_id("det_123456")},
    ]

    # 穷举扫描：validate/is_trivial 的分叉会体现在顺延 offset 上
    scan_kinds = [None] + list(ALL_KINDS)
    scan = []
    for kind in scan_kinds:
        offsets = []
        for seed in range(DETECTIVE_SCAN_RANGE):
            base = make_puzzle_id(seed)
            probe_puzzle = generate_puzzle(base, kind=kind)
            # 顺延 offset 从 puzzle_id 无法直接读出（generate 返回后已被揭示），
            # 这里用"重建时 validate 首个自洽种子的序号"重放同一搜索：
            from backend.engine.detective import GENERATORS
            import random as _random
            offset = 0
            for offset in range(40):
                s = seed + offset
                rng = _random.Random(s * 7919 + 13)
                chosen = kind or ALL_KINDS[s % len(ALL_KINDS)]
                p = GENERATORS[chosen](rng, make_puzzle_id(s))
                if not p.validate():
                    reveal = max(1, min(2, len(p.clues) - 1))
                    if not p.is_trivial(reveal):
                        break
            else:
                offset = -1
            offsets.append(offset)
        scan.append({"kind": kind, "offsets": offsets})

    return _write(
        "detective_parity.json",
        {
            "seeds": DETECTIVE_SEEDS,
            "fixed_kind_seeds": DETECTIVE_FIXED_KIND_SEEDS,
            "scan_range": DETECTIVE_SCAN_RANGE,
            "cases": cases,
            "judge_cases": judge_cases,
            "reveal_cases": reveal_cases,
            "parse_cases": parse_cases,
            "scan": scan,
        },
    )


# ── lint ───────────────────────────────────────────────────
#
# 为什么是「变异 + 对拍」而不是「拿真实内容跑一遍对拍」
# ----------------------------------------------------
# 实测：1373 道题在 validate_content 下**一条都不报**，在 lint_bundle 下
# 只报 9 条规则里的 1 条（全部来自 `_lint_slot_ceiling`）。
# 也就是说只跑真实内容的话，另外那些规则的两侧都返回 [] —— 全绿，但零信息量：
# TS 侧把它们逐个换成 `return []` 也不会有人发现。
#
# 变异的作用就是**把每条规则在真实内容上逼出来**。变异用共享的声明式 ops
# （tests/oracle/fixtures/lint_mutations.json）表达：两侧各自从 content/ 加载，
# 再施加同一组 ops，然后比较 {trace, problems, warnings}。
#
# trace 是「这组 ops 到底改了什么实体」的产物，两侧必须逐字一致 ——
# 它是防「变异解释器本身分叉」的：只比 problems/warnings 的话，一个恰好不改变
# 输出的解释器差异（比如删掉了另一组产生同样告警的题）会悄悄溜过去。

LINT_SPEC = os.path.join(FIXTURE_DIR, "lint_mutations.json")

# 每条 lint 规则的文案特征（与 tests/unit/lint.test.ts 的 RULE_MARKERS 同源）。
# 用来做「9 条规则每条都被某条变异触发过」的自证。
LINT_RULE_MARKERS = [
    ("_lint_coverage", ("缺少脚手架级别",)),
    ("_lint_time_estimates", ("的预估耗时与难度反向", "estimated_seconds 不合理")),
    ("_lint_duplicates", ("题面完全相同但答案不同：",)),
    ("_lint_hint_depth", ("孩子卡住时没有台阶",)),
    ("_lint_slot_pools", ("候选池只有",)),
    ("_lint_story_shape", ("分钟，",)),
    ("_lint_steps", ("steps_style=conclude",)),
    ("_lint_prompt_self_contained", ("没有 prompt", "里一个数字都没有")),
    (
        "_lint_slot_ceiling",
        (
            "声明的上限难度",
            "但该 pattern 在难度区间内没有题",
            "层在区间内只有别的 pattern 的题",
        ),
    ),
]

# op 的筛选键 -> Item 上的真实字段名（两侧必须一致）
LINT_FILTER_FIELDS = {
    "competency": "competency_id",
    "scaffold_level": "scaffold_level",
    "pattern": "pattern_id",
}


def _lint_rule_of(warning: str):
    """警告属于哪条规则；不属于任何一条就返回 None（那本身就是个问题）。"""
    for rule, markers in LINT_RULE_MARKERS:
        if any(marker in warning for marker in markers):
            return rule
    return None


def _lint_filters(op) -> str:
    """筛选条件的确定化文本 —— 进 trace，两侧必须一样。"""
    return json.dumps(
        {key: op[key] for key in LINT_FILTER_FIELDS if key in op},
        ensure_ascii=False,
        sort_keys=True,
    )


def _apply_lint_ops(bundle, ops) -> list:
    """施加一组声明式变异，返回 trace。"""
    trace = []

    def matches(item, op) -> bool:
        for key, field in LINT_FILTER_FIELDS.items():
            if key in op and getattr(item, field) != op[key]:
                return False
        return True

    for op in ops:
        kind = op["op"]
        if kind in ("set_item", "set_slot"):
            target = (bundle.items if kind == "set_item" else bundle.slots)[op["code"]]
            field = op["field"]
            # 只允许改**已存在**的字段：spec 里打错一个字段名就在这里炸，
            # 而不是悄悄多出一个谁也读不到的键 —— 那会让两侧"改的东西不一样"
            # 却都跑得通。
            if not hasattr(target, field):
                raise SystemExit("变异指令的字段不存在：{} {}".format(op["code"], field))
            setattr(target, field, op["value"])
            trace.append("{} {} {}".format(kind, op["code"], field))
        elif kind == "delete_item":
            del bundle.items[op["code"]]
            trace.append("delete_item {}".format(op["code"]))
        elif kind in ("delete_items_where", "set_items_where"):
            if not any(key in op for key in LINT_FILTER_FIELDS):
                raise SystemExit("{} 至少要给一个筛选条件：{}".format(kind, op))
            codes = sorted(
                code for code, item in bundle.items.items() if matches(item, op)
            )
            if not codes:
                raise SystemExit("{} 一道题都没选中：{}".format(kind, op))
            for code in codes:
                if kind == "delete_items_where":
                    del bundle.items[code]
                else:
                    setattr(bundle.items[code], op["field"], op["value"])
            trace.append(
                "{} {} {} -> {}".format(
                    kind,
                    _lint_filters(op),
                    op.get("field", ""),
                    ",".join(codes),
                )
            )
        else:
            raise SystemExit("未知的变异指令：{}".format(kind))
    return trace


# ── simulate ───────────────────────────────────────────────
def _sim_attempt_dict(a) -> dict:
    """Attempt 的对拍投影 —— 只保留引擎真正消费的字段。"""
    return {
        "attempt_id": a.attempt_id,
        "child_id": a.child_id,
        "item_id": a.item_id,
        "competency_id": a.competency_id,
        "pattern_id": a.pattern_id,
        "correct": a.correct,
        "telemetry": a.telemetry.to_dict(),
        "seq": a.seq,
        "hints_used": a.hints_used,
        "hint_level_max": a.hint_level_max,
        "scaffold_level": a.scaffold_level,
        "interaction_type": a.interaction_type,
        "is_transfer_probe": a.is_transfer_probe,
        "submitted_answer": a.submitted_answer,
    }


def _sim_run_dict(run, graph, cfg) -> dict:
    """ChildRun 的对拍投影：days/attempts/schedule/events + 全部派生结果。

    fallback_episodes / final_focus 是 ChildRun 的派生方法，Python 算好存进来，
    TS 侧用自己实现的方法算出同样的东西再对比 —— 派生逻辑本身也要对拍。
    """
    return {
        "key": run.key,
        "name": run.name,
        "description": run.description,
        "entry_focus": run.entry_focus,
        "days": [
            {
                "day": d.day,
                "focus": d.focus,
                "due_count": d.due_count,
                "planned_reviews": d.planned_reviews,
                "review_attempts": d.review_attempts,
                "probe_planned": d.probe_planned,
                "probe_attempts": d.probe_attempts,
                "notes": list(d.notes),
                "attempt_ids": [a.attempt_id for a in d.attempts],
            }
            for d in run.days
        ],
        "attempts": [_sim_attempt_dict(a) for a in run.all_attempts()],
        "review_attempt_ids": sorted(run.review_attempt_ids),
        "schedule": run.schedule,
        "events": run.events,
        "fallback_episodes": run.fallback_episodes(),
        "final_focus": run.final_focus(graph, cfg),
        "final_state": _learner_state_snapshot(run.final_state),
    }


def dump_simulate() -> str:
    """8 个画像 × 30 天逐 attempt 全量对拍（P3 体检的回归基准）。

    覆盖三块：
      1. run 本体 —— 每天 DayRecord、每个 attempt、schedule 终态、日终事件
         （focus_switch/upgrade/fallback）、final_state 快照；
      2. 派生结果 —— fallback_episodes 合并、final_focus、体检 findings 全文；
      3. render_report 全文 —— 报告文案逐字对拍。
    作答建模本身是画像规则（确定性、无外部依赖），它的随机性全部来自
    random.Random(profile.seed)，同一 seed 两次跑逐字段一致 —— 所以这里
    不需要"响应抽样"的对拍，跑一遍把结果全部固化即可。
    """
    from dataclasses import asdict

    from backend.content.loader import load_bundle
    from backend.engine.config import load_config
    from backend.engine.graph import CompetencyGraph
    from tools.simulate import (
        PROFILES,
        SIM_DAYS,
        render_report,
        run_cold_start,
        run_health_checks,
        run_profile,
        run_simulation,
        with_practice_slots,
    )

    bundle = load_bundle()
    cfg = load_config(0)
    graph = CompetencyGraph(bundle)

    sim_bundle, added_slots = with_practice_slots(bundle, cfg)
    runs = run_simulation(PROFILES, sim_bundle, cfg, graph, SIM_DAYS)
    cold = run_cold_start(sim_bundle, cfg, graph, SIM_DAYS)
    findings = run_health_checks(runs + [cold], sim_bundle, graph, cfg)

    return _write(
        "simulate_parity.json",
        {
            "days": SIM_DAYS,
            "added_slots": added_slots,
            # 画像声明本身也要对拍 —— TS 的 makeProfiles() 必须与 Python
            # PROFILES 的 key/seed/entry 逐字段一致，否则整个模拟都在对拍别的孩子
            "profiles": [
                {
                    "key": p.key,
                    "name": p.name,
                    "description": p.description,
                    "seed": p.seed,
                    "entry": asdict(p.entry),
                }
                for p in PROFILES
            ],
            "runs": [_sim_run_dict(r, graph, cfg) for r in runs],
            "cold_start": _sim_run_dict(cold, graph, cfg),
            "findings": [asdict(f) for f in findings],
            "report": render_report(runs, findings, sim_bundle, cfg, graph, added_slots, cold),
        },
    )


def dump_lint() -> str:
    """validate / lint / stats 的变异对拍 fixture（真实内容 + 声明式变异）。"""
    from backend.content.compiler import (
        compute_stats,
        lint_bundle,
        render_stats,
        validate_bundle,
    )
    from backend.content.loader import load_bundle

    with open(LINT_SPEC, encoding="utf-8") as fh:
        spec = json.load(fh)

    cases = []
    for mutation in spec["mutations"]:
        bundle = load_bundle()
        if bundle.load_problems:
            raise SystemExit(
                "内容存在加载期问题，变异对拍不可信：\n  "
                + "\n  ".join(bundle.load_problems)
            )
        trace = _apply_lint_ops(bundle, mutation["ops"])
        stats = compute_stats(bundle)
        cases.append(
            {
                "id": mutation["id"],
                "note": mutation["note"],
                "targets": list(mutation.get("targets", [])),
                "trace": trace,
                "problems": validate_bundle(bundle),
                "warnings": lint_bundle(bundle),
                "stats": stats,
                "stats_report": render_stats(stats),
            }
        )

    by_id = {case["id"]: case for case in cases}

    # ── 自证 1：每条规则的文案都真的出现在某条变异的输出里 ──
    # 没有这一条，某条规则的两侧都返回 []，"对拍"对它就是空转。
    hit = {}
    for case in cases:
        for warning in case["warnings"]:
            rule = _lint_rule_of(warning)
            if rule is not None:
                hit.setdefault(rule, case["id"])
            else:
                raise SystemExit(
                    "变异 {} 报出一条不属于任何已知规则的警告（文案改了？）：\n  {}".format(
                        case["id"], warning
                    )
                )
    missing = [rule for rule, _ in LINT_RULE_MARKERS if rule not in hit]
    if missing:
        raise SystemExit(
            "这些 lint 规则没有被任何变异触发，对拍对它们是空转：\n  " + "\n  ".join(missing)
        )

    # ── 自证 2：每条变异真的触发了它声明的规则 ──
    # targets 写错（比如以为会触发覆盖缺口、实际没有）会让 fixture 变成
    # "两边都返回同一串无关告警"，比的是别的东西。
    for case in cases:
        fired = {_lint_rule_of(warning) for warning in case["warnings"]}
        for rule in case["targets"]:
            if rule not in fired:
                raise SystemExit(
                    "变异 {} 声称触发 {}，但它一条都没报。".format(case["id"], rule)
                )

    # ── 自证 3：负向对照的输出必须与 baseline 逐字相同 ──
    baseline = by_id["baseline"]
    for case in cases:
        if case["id"] == "baseline":
            continue
        if not case.get("expect_baseline"):
            continue
        for field in ("problems", "warnings", "stats", "stats_report"):
            if case[field] != baseline[field]:
                raise SystemExit(
                    "变异 {} 标了 expect_baseline（预期不改变任何输出），"
                    "但它改变了 {}。".format(case["id"], field)
                )

    # ── 自证 4：标了 expect_problems 的必须真的报错 ──
    for case in cases:
        if case.get("expect_problems") and not case["problems"]:
            raise SystemExit(
                "变异 {} 标了 expect_problems，但 validate 一条错误都没报。".format(case["id"])
            )

    # ── 自证 5：stats 的内部一致性 ──
    # 这些恒等式是 compute_stats 的"账要么平要么不平"：某个字段挂错了源
    # （比如 standalone_slots 复用了 story_slots）时账立刻不平。
    # 加这一条是因为 compute_stats 有 14 个字段、彼此形状相似，而"两侧都写错
    # 同一个字段"对拍是抓不到的 —— 只有恒等式能抓。
    for case in cases:
        stats = case["stats"]
        where = "变异 {}".format(case["id"])

        def eq(left, right, what):
            if left != right:
                raise SystemExit("{} 的 stats 账不平：{}（{} != {}）".format(where, what, left, right))

        eq(stats["story_slots"] + stats["standalone_slots"], stats["slots"], "故事槽+独立槽")
        eq(sum(stats["items_by_pattern"].values()), stats["items"], "按结构统计的题数")
        style = stats["items_by_steps_style"]
        eq(style["guide"] + style["conclude"], stats["items"], "按示范路径写法统计的题数")
        eq(sum(row["items"] for row in stats["coverage"].values()), stats["items"], "按能力统计的题数")
        eq(
            sum(
                sum(row["by_scaffold"].values())
                for row in stats["coverage"].values()
            ),
            stats["items"],
            "按脚手架档统计的题数",
        )
        eq(len(stats["coverage"]), stats["competencies"], "覆盖表的能力数")
        eq(len(stats["slots_detail"]), stats["slots"], "候选池报表的槽位数")
        # 报表：总览 2 行 + 空行 + 覆盖表（表头+分隔线+能力数）+ 空行 + "按认知结构分布"
        #       + 结构数 + 空行 + 示范路径写法 + 空行 + "槽位候选池宽度" + 槽位数
        lines = case["stats_report"].splitlines()
        eq(
            len(lines),
            2 + 1 + (2 + stats["competencies"]) + 1 + 1 + len(stats["items_by_pattern"])
            + 1 + 1 + 1 + 1 + stats["slots"],
            "报表行数",
        )

    payload = {
        "content_version": _content_version(),
        "rules_covered": sorted(hit),
        "cases": cases,
    }
    return _write("lint_parity.json", payload)


def _content_version() -> str:
    """与 build/content_dump.json 里那份保持一致（对拍双方必须看同一版内容）。"""
    dump_path = os.path.join(ROOT, "build", "content_dump.json")
    if not os.path.isfile(dump_path):
        raise SystemExit("找不到 build/content_dump.json，先跑 make content-dump。")
    with open(dump_path, encoding="utf-8") as fh:
        return json.load(fh)["content_version"]


DUMPERS = {
    "content": dump_content,
    "cognitive": dump_cognitive,
    "config": dump_config,
    "detective": dump_detective,
    "engine": dump_engine,
    "graph": dump_graph,
    "intent": dump_intent,
    "learner": dump_learner,
    "lint": dump_lint,
    "planner": dump_planner,
    "py": dump_py,
    "pyrandom": dump_pyrandom,
    "replay": dump_replay,
    "selector": dump_selector,
    "simulate": dump_simulate,
    "state_machine": dump_state_machine,
}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="dump_fixtures",
        description="把 Python 行为 dump 成对拍 fixture（只读脚本）",
    )
    parser.add_argument(
        "targets",
        nargs="*",
        default=["all"],
        choices=sorted(DUMPERS) + ["all"],
        help="要 dump 的 fixture（默认 all）",
    )
    args = parser.parse_args(argv)

    targets = sorted(DUMPERS) if "all" in args.targets else args.targets
    for name in targets:
        path = DUMPERS[name]()
        size = os.path.getsize(path)
        print("  {:<24} {:>8} B   {}".format(name, size, os.path.relpath(path, ROOT)))

    print("\n⚠️ fixture 必须提交进仓库 —— Python 删除后它是唯一的回归基准。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
