"""Item Selection：从一个 Challenge Slot 选出一道具体题目。

职责边界（ADR-0001）：
  Slot 说"练什么"（pattern / 难度区间 / 策略）
  本模块说"具体做哪一道"
  本模块**不允许**改变故事与 slot 的语义
"""
from __future__ import annotations

from typing import FrozenSet, Iterable, List, Optional, Tuple

from backend.content.loader import AUTO_SCAFFOLD, ChallengeSlot, ContentBundle, Item
from backend.engine.config import SCAFFOLD_LEVELS, AlgorithmConfig
from backend.engine.types import ChildLearningState, split_pattern_key


def effective_scaffold(
    slot: ChallengeSlot,
    state: ChildLearningState,
    cfg: AlgorithmConfig,
) -> str:
    """槽位可以显式指定脚手架，也可以交给熟练度决定（脚手架递退）。"""
    if slot.scaffold_level and slot.scaffold_level != AUTO_SCAFFOLD:
        return slot.scaffold_level
    signals = state.competencies.get(slot.competency_id)
    mastery = signals.mastery if signals else None
    return cfg.scaffold_for_mastery(mastery)


def _recent_codes(state: ChildLearningState, window: int) -> List[str]:
    if window <= 0:
        return []
    return [a.item_id for a in state.recent_attempts[-window:]]


def _staleness(item: Item, history: List[str]) -> int:
    """这道题在近期作答历史里最后一次出现的位置。

    越小 = 越久没做过；-1 = 窗口内没出现过。候选池全被最近做过时用它排序：
    池子比窗口小的时候（例如某难度档只有 6 道题、窗口却是 8），"避开最近做过的"
    会把整池都排除掉，此时若按难度重新排一遍，选出来的永远是同一道题 ——
    这正是"跨天重复同一道题"在池子小的能力上反而更严重的原因。
    """
    last = -1
    for index, code in enumerate(history):
        if code == item.code:
            last = index
    return last


def _avoid_recent_window(slot: ChallengeSlot, cfg: AlgorithmConfig) -> int:
    """避重窗口：槽位显式声明优先，没写才用配置缺省值。

    `avoid_recent: 0` 是显式关闭避重（内容作者的表达），不受下限约束；
    其余情况再套一层配置下限 —— 一天的计划整批生成、窗口只数"最近 N 次作答"，
    小于一天的窗口挡不住"昨天做过、今天又排第一"的题（Q6 的机制）。
    """
    policy = slot.selection_policy or {}
    declared = (
        int(policy.get("avoid_recent") or 0)
        if "avoid_recent" in policy
        else cfg.default_avoid_recent()
    )
    if declared <= 0:
        return 0
    return max(declared, cfg.min_avoid_recent())


def _last_difficulty(
    state: ChildLearningState,
    bundle: ContentBundle,
    competency_id: str,
) -> Optional[int]:
    """该能力上最近一次作答的难度。找不到（没做过 / 题已不在内容里）返回 None。

    只按能力过滤，不区分 slot：难度是**能力内标尺**，同一能力的题共用一把尺子。
    跨能力切换时不套用这个值（见 `_difficulty_step` 的说明）。
    """
    for attempt in reversed(state.recent_attempts):
        if attempt.competency_id != competency_id:
            continue
        item = bundle.items.get(attempt.item_id)
        if item is not None:
            return item.difficulty
    return None


def _difficulty_step(
    slot: ChallengeSlot,
    last: Optional[int],
    cfg: AlgorithmConfig,
) -> Tuple[int, int]:
    """本次选题允许的难度阶梯 `[floor, ceil]`。

    - floor：不回头做比"最近做过的难度"更简单的题。单次失误不回撤难度
      （回撤由 fallback 触发器判定），否则难度会在低难度题占多数的池子里反复被拽回去。
    - ceil：一次最多升 `selection.max_difficulty_step_up` 档，防止跳级
      （模拟体检 Q5 的判据就是"相邻两次难度上升 ≥ 2"）。
    - slot 的 difficulty_min / difficulty_max 仍是权威边界，阶梯只在其内部收窄。

    跨能力切换不套用上一次的难度：难度是能力内标尺，新能力的起点由该能力
    自己的熟练度目标决定（`_target_difficulty` + slot 区间），否则会把一个能力的
    难度标尺外推到另一个能力上。
    """
    if last is None:
        return slot.difficulty_min, slot.difficulty_max
    step = cfg.max_difficulty_step_up()
    floor = min(max(slot.difficulty_min, last), slot.difficulty_max)
    ceil = min(slot.difficulty_max, max(last + step, floor))
    return floor, ceil


def _zone(difficulty: int, floor: int, ceil: int) -> int:
    """难度相对阶梯的位置：0 = 阶梯内；1 = 更简单（回撤）；2 = 跳级。"""
    if difficulty > ceil:
        return 2
    if difficulty < floor:
        return 1
    return 0


def _target_difficulty(
    slot: ChallengeSlot,
    state: ChildLearningState,
    cfg: AlgorithmConfig,
) -> float:
    """本次选题的目标难度：由该能力上的熟练度映射到 slot 的难度区间内。

    区间本身（difficulty_min / difficulty_max）是 slot 的权威声明，
    这里只决定落在区间里的哪个位置。
    """
    signals = state.competencies.get(slot.competency_id)
    mastery = signals.mastery if signals else None
    return cfg.target_difficulty(mastery, slot.difficulty_min, slot.difficulty_max)


def _scaffold_order(preferred: str) -> List[str]:
    """优先精确匹配；匹配不到时按"离目标最近"的顺序放宽。"""
    if preferred not in SCAFFOLD_LEVELS:
        return list(SCAFFOLD_LEVELS)
    index = SCAFFOLD_LEVELS.index(preferred)
    return sorted(SCAFFOLD_LEVELS, key=lambda s: (abs(SCAFFOLD_LEVELS.index(s) - index), s))


def _tried_patterns(state: ChildLearningState, competency_id: str) -> set:
    """该能力下已经练过的问题结构（pattern 状态键含 competency）。"""
    return {
        split_pattern_key(key)[1]
        for key in state.patterns
        if split_pattern_key(key)[0] == competency_id
    }


def _pool(
    slot: ChallengeSlot,
    bundle: ContentBundle,
    scaffold: str,
    pattern_id: Optional[str],
) -> List[Item]:
    return [
        item
        for item in bundle.items.values()
        if item.competency_id == slot.competency_id
        and (pattern_id is None or item.pattern_id == pattern_id)
        and item.scaffold_level == scaffold
        and slot.difficulty_min <= item.difficulty <= slot.difficulty_max
    ]


def _pick_pattern(
    slot: ChallengeSlot,
    state: ChildLearningState,
    bundle: ContentBundle,
    scaffold: str,
) -> Optional[str]:
    """按 selection_policy 决定本次用哪个 pattern。None 表示不约束。"""
    if slot.pattern_id:
        return slot.pattern_id
    if not (slot.selection_policy or {}).get("prefer_untried_pattern"):
        return None

    tried = _tried_patterns(state, slot.competency_id)
    untried_in_pool = sorted(
        {i.pattern_id for i in _pool(slot, bundle, scaffold, None) if i.pattern_id not in tried}
    )
    if untried_in_pool:
        return untried_in_pool[0]

    # 该能力下的 pattern 全都做过了：换一个"当前不在候选池里"的结构，
    # 仍然满足"换一种问题结构"的迁移意图
    all_patterns = sorted(
        {i.pattern_id for i in bundle.items.values() if i.competency_id == slot.competency_id}
    )
    remaining = [p for p in all_patterns if p not in tried]
    if remaining:
        return remaining[0]
    return None


def _pick_from_pools(
    pools: List[List[Item]],
    step: Optional[Tuple[int, int]],
    desired: float,
    recent: FrozenSet[str],
    history: List[str],
) -> Optional[Item]:
    """从若干候选池里挑一道（pools 已按脚手架优先顺序排好）。

    挑选优先级：
      1. 难度在阶梯区间内（`step=None` 表示不设阶梯，全部视为区间内）；
      2. 区间内优先没在最近窗口里做过的题；整池都做过时挑**最久没做过**的那道
         —— 宁重复、不降级，但也不把刚做过的那道原样再给一遍；
      3. 离期望难度最近；并列时先取更简单的（保守），再按 code（确定性）。

    方法名带 `pools` 是因为调用方可能分成几批传进来（"pattern 正确的一批"、
    "放宽 pattern 的一批"），优先级由**调用顺序**表达，本函数在第一批里
    找到就走，不跨批比较。
    """
    fallback: Optional[List[Item]] = None
    for pool in pools:
        if not pool:
            continue
        if step is None:
            in_step = list(pool)
        else:
            floor, ceil = step
            in_step = [i for i in pool if _zone(i.difficulty, floor, ceil) == 0]
        if in_step:
            fresh = [i for i in in_step if i.code not in recent]
            if fresh:
                return sorted(
                    fresh,
                    key=lambda i: (abs(i.difficulty - desired), i.difficulty, i.code),
                )[0]
            return sorted(
                in_step,
                key=lambda i: (
                    _staleness(i, history),
                    abs(i.difficulty - desired),
                    i.difficulty,
                    i.code,
                ),
            )[0]
        if fallback is None:
            fallback = sorted(
                pool,
                key=lambda i: (
                    _zone(i.difficulty, floor, ceil) if step is not None else 0,
                    abs(i.difficulty - desired),
                    i.difficulty,
                    i.code,
                ),
            )
    return fallback[0] if fallback else None


def select_item(
    slot: ChallengeSlot,
    state: ChildLearningState,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    exclude_codes: Optional[Iterable[str]] = None,
) -> Optional[Item]:
    """filter → rank → select。

    **pattern 是契约，难度阶梯只是节奏。** 两者冲突时让阶梯让步：

      ① pattern 正确 + 难度在阶梯内 → 用它；
      ② pattern 正确但难度在阶梯外 → 仍然用它（`step=None` 再挑一遍）；
      ③ 只有"该 pattern 在整个难度区间里一道题都没有"时，才放宽 pattern。

    第 ② 步是必须的：迁移探针（`prefer_untried_pattern`）与复习固定结构
    要的就是"换回/换到这个结构"，一旦被阶梯挤掉、静默换成另一个熟悉的
    pattern，transfer 证据就永远攒不出来 —— 孩子的升级会被永久卡住，
    而模拟报告里只看得到"迁移测试落地率低"，看不到真正的原因。

    其余排序规则见 `_pick_from_pools` 的文档。返回 None 表示候选池为空 ——
    这属于内容缺陷，Content Compiler 应当拦下（见 loader.validate_content
    的"候选池为空"校验）。
    """
    scaffold = effective_scaffold(slot, state, cfg)
    avoid_recent = _avoid_recent_window(slot, cfg)
    target = _target_difficulty(slot, state, cfg)
    last = _last_difficulty(state, bundle, slot.competency_id)
    floor, ceil = _difficulty_step(slot, last, cfg)
    desired = min(max(target, floor), ceil)

    recent: FrozenSet[str] = frozenset(_recent_codes(state, avoid_recent))
    if exclude_codes:
        recent = recent | frozenset(exclude_codes)

    pattern_id = _pick_pattern(slot, state, bundle, scaffold)
    history = [a.item_id for a in state.recent_attempts]
    scaffolds = _scaffold_order(scaffold)

    if pattern_id is not None:
        bound = [_pool(slot, bundle, sc, pattern_id) for sc in scaffolds]
        picked = _pick_from_pools(bound, (floor, ceil), desired, recent, history)
        if picked is not None:
            return picked
        picked = _pick_from_pools(bound, None, desired, recent, history)
        if picked is not None:
            return picked

    # 放宽 pattern：结构对了才有内容，但仍然是同一个 competency（ADR-0001）
    return _pick_from_pools(
        [_pool(slot, bundle, sc, None) for sc in scaffolds],
        (floor, ceil),
        desired,
        recent,
        history,
    )


def select_items(
    slot: ChallengeSlot,
    state: ChildLearningState,
    bundle: ContentBundle,
    cfg: AlgorithmConfig,
    count: int,
    exclude_codes: Optional[Iterable[str]] = None,
) -> List[Item]:
    """为同一槽位连续取 count 道题，取的过程中排除已选项，避免同一组内重复。

    `exclude_codes` 是**跨槽位**的排除表（例如"今天已经排给别的段的题"）。
    不传它的话，调用方拿到重复题只能自己丢掉，而丢掉之后并没有重挑 ——
    表现就是"计划里这一段明明有意图却一道题都没有"。
    """
    chosen: List[Item] = []
    excluded: List[str] = list(exclude_codes or [])
    for _ in range(count):
        item = select_item(slot, state, bundle, cfg, exclude_codes=excluded)
        if item is None:
            break
        chosen.append(item)
        excluded.append(item.code)
    return chosen
