/**
 * Item Selection —— `backend/engine/selector.py` 的 TypeScript 移植。
 *
 * 职责边界（ADR-0001）：
 *   Slot 说"练什么"（pattern / 难度区间 / 策略）
 *   本模块说"具体做哪一道"
 *   本模块**不允许**改变故事与 slot 的语义
 */

import { AUTO_SCAFFOLD } from "@/src/content/types";
import type { ChallengeSlot, ContentBundle, Item } from "@/src/content/types";
import { SCAFFOLD_LEVELS } from "@/src/engine/config";
import type { AlgorithmConfig } from "@/src/engine/config";
import type { ChildLearningState } from "@/src/engine/types";
import { splitPatternKey } from "@/src/engine/types";

export function effectiveScaffold(
  slot: ChallengeSlot,
  state: ChildLearningState,
  cfg: AlgorithmConfig,
): string {
  // 槽位可以显式指定脚手架，也可以交给熟练度决定（脚手架递退）
  if (slot.scaffold_level && slot.scaffold_level !== AUTO_SCAFFOLD) {
    return slot.scaffold_level;
  }
  const signals = state.competencies.get(slot.competency_id);
  const mastery = signals ? signals.mastery : null;
  return cfg.scaffoldForMastery(mastery);
}

function recentCodes(state: ChildLearningState, window: number): string[] {
  if (window <= 0) {
    return [];
  }
  return state.recent_attempts.slice(-window).map((a) => a.item_id);
}

/**
 * 这道题在近期作答历史里最后一次出现的位置。
 *
 * 越小 = 越久没做过；-1 = 窗口内没出现过。候选池全被最近做过时用它排序：
 * 池子比窗口小的时候（例如某难度档只有 6 道题、窗口却是 8），"避开最近做过的"
 * 会把整池都排除掉，此时若按难度重新排一遍，选出来的永远是同一道题 ——
 * 这正是"跨天重复同一道题"在池子小的能力上反而更严重的原因。
 */
function staleness(item: Item, history: readonly string[]): number {
  let last = -1;
  for (let index = 0; index < history.length; index += 1) {
    if (history[index] === item.code) {
      last = index;
    }
  }
  return last;
}

/**
 * 避重窗口：槽位显式声明优先，没写才用配置缺省值。
 *
 * `avoid_recent: 0` 是显式关闭避重（内容作者的表达），不受下限约束；
 * 其余情况再套一层配置下限 —— 一天的计划整批生成、窗口只数"最近 N 次作答"，
 * 小于一天的窗口挡不住"昨天做过、今天又排第一"的题（Q6 的机制）。
 */
function avoidRecentWindow(slot: ChallengeSlot, cfg: AlgorithmConfig): number {
  const policy = slot.selection_policy ?? {};
  const declared =
    "avoid_recent" in policy
      ? Math.trunc(Number((policy as Record<string, unknown>)["avoid_recent"] || 0))
      : cfg.defaultAvoidRecent();
  if (declared <= 0) {
    return 0;
  }
  return Math.max(declared, cfg.minAvoidRecent());
}

/**
 * 该能力上最近一次作答的难度。找不到（没做过 / 题已不在内容里）返回 null。
 *
 * 只按能力过滤，不区分 slot：难度是**能力内标尺**，同一能力的题共用一把尺子。
 * 跨能力切换时不套用这个值（见 `difficultyStep` 的说明）。
 */
function lastDifficulty(
  state: ChildLearningState,
  bundle: ContentBundle,
  competency_id: string,
): number | null {
  for (let i = state.recent_attempts.length - 1; i >= 0; i -= 1) {
    const attempt = state.recent_attempts[i]!;
    if (attempt.competency_id !== competency_id) {
      continue;
    }
    const item = bundle.items.get(attempt.item_id);
    if (item !== undefined) {
      return item.difficulty;
    }
  }
  return null;
}

/**
 * 本次选题允许的难度阶梯 `[floor, ceil]`。
 *
 * - floor：不回头做比"最近做过的难度"更简单的题。单次失误不回撤难度
 *   （回撤由 fallback 触发器判定），否则难度会在低难度题占多数的池子里反复被拽回去。
 * - ceil：一次最多升 `selection.max_difficulty_step_up` 档，防止跳级
 *   （模拟体检 Q5 的判据就是"相邻两次难度上升 ≥ 2"）。
 * - slot 的 difficulty_min / difficulty_max 仍是权威边界，阶梯只在其内部收窄。
 *
 * 跨能力切换不套用上一次的难度：难度是能力内标尺，新能力的起点由该能力
 * 自己的熟练度目标决定（`targetDifficulty` + slot 区间），否则会把一个能力的
 * 难度标尺外推到另一个能力上。
 */
function difficultyStep(
  slot: ChallengeSlot,
  last: number | null,
  cfg: AlgorithmConfig,
): [number, number] {
  if (last === null) {
    return [slot.difficulty_min, slot.difficulty_max];
  }
  const step = cfg.maxDifficultyStepUp();
  const floor = Math.min(Math.max(slot.difficulty_min, last), slot.difficulty_max);
  const ceil = Math.min(slot.difficulty_max, Math.max(last + step, floor));
  return [floor, ceil];
}

/** 难度相对阶梯的位置：0 = 阶梯内；1 = 更简单（回撤）；2 = 跳级。 */
function zone(difficulty: number, floor: number, ceil: number): number {
  if (difficulty > ceil) {
    return 2;
  }
  if (difficulty < floor) {
    return 1;
  }
  return 0;
}

/**
 * 本次选题的目标难度：由该能力上的熟练度映射到 slot 的难度区间内。
 *
 * 区间本身（difficulty_min / difficulty_max）是 slot 的权威声明，
 * 这里只决定落在区间里的哪个位置。
 */
function targetDifficulty(
  slot: ChallengeSlot,
  state: ChildLearningState,
  cfg: AlgorithmConfig,
): number {
  const signals = state.competencies.get(slot.competency_id);
  const mastery = signals ? signals.mastery : null;
  return cfg.targetDifficulty(mastery, slot.difficulty_min, slot.difficulty_max);
}

/** 优先精确匹配；匹配不到时按"离目标最近"的顺序放宽。 */
function scaffoldOrder(preferred: string): string[] {
  if (!SCAFFOLD_LEVELS.includes(preferred as (typeof SCAFFOLD_LEVELS)[number])) {
    return [...SCAFFOLD_LEVELS];
  }
  const index = SCAFFOLD_LEVELS.indexOf(preferred as (typeof SCAFFOLD_LEVELS)[number]);
  return [...SCAFFOLD_LEVELS].sort(
    (a, b) =>
      Math.abs(SCAFFOLD_LEVELS.indexOf(a) - index) -
        Math.abs(SCAFFOLD_LEVELS.indexOf(b) - index) || (a < b ? -1 : a > b ? 1 : 0),
  );
}

/** 该能力下已经练过的问题结构（pattern 状态键含 competency）。 */
function triedPatterns(state: ChildLearningState, competency_id: string): Set<string> {
  const out = new Set<string>();
  for (const key of state.patterns.keys()) {
    const [competency, pattern] = splitPatternKey(key);
    if (competency === competency_id) {
      out.add(pattern);
    }
  }
  return out;
}

function pool(
  slot: ChallengeSlot,
  bundle: ContentBundle,
  scaffold: string,
  pattern_id: string | null,
): Item[] {
  const out: Item[] = [];
  for (const item of bundle.items.values()) {
    if (
      item.competency_id === slot.competency_id &&
      (pattern_id === null || item.pattern_id === pattern_id) &&
      item.scaffold_level === scaffold &&
      slot.difficulty_min <= item.difficulty &&
      item.difficulty <= slot.difficulty_max
    ) {
      out.push(item);
    }
  }
  return out;
}

/** 按 selection_policy 决定本次用哪个 pattern。null 表示不约束。 */
function pickPattern(
  slot: ChallengeSlot,
  state: ChildLearningState,
  bundle: ContentBundle,
  scaffold: string,
): string | null {
  if (slot.pattern_id) {
    return slot.pattern_id;
  }
  if (!(slot.selection_policy ?? {})["prefer_untried_pattern"]) {
    return null;
  }

  const tried = triedPatterns(state, slot.competency_id);
  const untriedInPool = [
    ...new Set(pool(slot, bundle, scaffold, null).map((i) => i.pattern_id)),
  ].sort();
  if (untriedInPool.length > 0) {
    return untriedInPool[0]!;
  }

  // 该能力下的 pattern 全都做过了：换一个"当前不在候选池里"的结构，
  // 仍然满足"换一种问题结构"的迁移意图
  const allPatterns = [
    ...new Set(
      [...bundle.items.values()]
        .filter((i) => i.competency_id === slot.competency_id)
        .map((i) => i.pattern_id),
    ),
  ].sort();
  const remaining = allPatterns.filter((p) => !tried.has(p));
  if (remaining.length > 0) {
    return remaining[0]!;
  }
  return null;
}

/**
 * 从若干候选池里挑一道（pools 已按脚手架优先顺序排好）。
 *
 * 挑选优先级：
 *   1. 难度在阶梯区间内（`step=null` 表示不设阶梯，全部视为区间内）；
 *   2. 区间内优先没在最近窗口里做过的题；整池都做过时挑**最久没做过**的那道
 *      —— 宁重复、不降级，但也不把刚做过的那道原样再给一遍；
 *   3. 离期望难度最近；并列时先取更简单的（保守），再按 code（确定性）。
 *
 * 方法名带 `pools` 是因为调用方可能分成几批传进来（"pattern 正确的一批"、
 * "放宽 pattern 的一批"），优先级由**调用顺序**表达，本函数在第一批里
 * 找到就走，不跨批比较。
 */
function pickFromPools(
  pools: Item[][],
  step: readonly [number, number] | null,
  desired: number,
  recent: ReadonlySet<string>,
  history: readonly string[],
): Item | null {
  let fallback: Item[] | null = null;
  for (const poolItems of pools) {
    if (poolItems.length === 0) {
      continue;
    }
    let inStep: Item[];
    if (step === null) {
      inStep = [...poolItems];
    } else {
      const [floor, ceil] = step;
      inStep = poolItems.filter((i) => zone(i.difficulty, floor, ceil) === 0);
    }
    if (inStep.length > 0) {
      const fresh = inStep.filter((i) => !recent.has(i.code));
      if (fresh.length > 0) {
        return fresh.sort(
          (a, b) =>
            Math.abs(a.difficulty - desired) - Math.abs(b.difficulty - desired) ||
            a.difficulty - b.difficulty ||
            (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
        )[0]!;
      }
      return inStep.sort(
        (a, b) =>
          staleness(a, history) - staleness(b, history) ||
          Math.abs(a.difficulty - desired) - Math.abs(b.difficulty - desired) ||
          a.difficulty - b.difficulty ||
          (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
      )[0]!;
    }
    if (fallback === null) {
      const [floor, ceil] = step ?? [0, 0];
      fallback = [...poolItems].sort(
        (a, b) =>
          (step !== null ? zone(a.difficulty, floor, ceil) - zone(b.difficulty, floor, ceil) : 0) ||
          Math.abs(a.difficulty - desired) - Math.abs(b.difficulty - desired) ||
          a.difficulty - b.difficulty ||
          (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
      );
    }
  }
  return fallback !== null && fallback.length > 0 ? fallback[0]! : null;
}

/**
 * filter → rank → select。
 *
 * **pattern 是契约，难度阶梯只是节奏。** 两者冲突时让阶梯让步：
 *
 *   ① pattern 正确 + 难度在阶梯内 → 用它；
 *   ② pattern 正确但难度在阶梯外 → 仍然用它（`step=null` 再挑一遍）；
 *   ③ 只有"该 pattern 在整个难度区间里一道题都没有"时，才放宽 pattern。
 *
 * 第 ② 步是必须的：迁移探针（`prefer_untried_pattern`）与复习固定结构
 * 要的就是"换回/换到这个结构"，一旦被阶梯挤掉、静默换成另一个熟悉的
 * pattern，transfer 证据就永远攒不出来 —— 孩子的升级会被永久卡住，
 * 而模拟报告里只看得到"迁移测试落地率低"，看不到真正的原因。
 *
 * 其余排序规则见 `pickFromPools` 的文档。返回 null 表示候选池为空 ——
 * 这属于内容缺陷，Content Compiler 应当拦下（见 loader.validate_content
 * 的"候选池为空"校验）。
 */
export function selectItem(
  slot: ChallengeSlot,
  state: ChildLearningState,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  exclude_codes?: readonly string[] | null,
): Item | null {
  const scaffold = effectiveScaffold(slot, state, cfg);
  const avoidRecent = avoidRecentWindow(slot, cfg);
  const target = targetDifficulty(slot, state, cfg);
  const last = lastDifficulty(state, bundle, slot.competency_id);
  const [floor, ceil] = difficultyStep(slot, last, cfg);
  const desired = Math.min(Math.max(target, floor), ceil);

  let recent = new Set(recentCodes(state, avoidRecent));
  if (exclude_codes) {
    for (const code of exclude_codes) {
      recent.add(code);
    }
  }

  const pattern_id = pickPattern(slot, state, bundle, scaffold);
  const history = state.recent_attempts.map((a) => a.item_id);
  const scaffolds = scaffoldOrder(scaffold);

  if (pattern_id !== null) {
    const bound = scaffolds.map((sc) => pool(slot, bundle, sc, pattern_id));
    const picked = pickFromPools(bound, [floor, ceil], desired, recent, history);
    if (picked !== null) {
      return picked;
    }
    const relaxed = pickFromPools(bound, null, desired, recent, history);
    if (relaxed !== null) {
      return relaxed;
    }
  }

  // 放宽 pattern：结构对了才有内容，但仍然是同一个 competency（ADR-0001）
  return pickFromPools(
    scaffolds.map((sc) => pool(slot, bundle, sc, null)),
    [floor, ceil],
    desired,
    recent,
    history,
  );
}

/**
 * 为同一槽位连续取 count 道题，取的过程中排除已选项，避免同一组内重复。
 *
 * `exclude_codes` 是**跨槽位**的排除表（例如"今天已经排给别的段的题"）。
 * 不传它的话，调用方拿到重复题只能自己丢掉，而丢掉之后并没有重挑 ——
 * 表现就是"计划里这一段明明有意图却一道题都没有"。
 */
export function selectItems(
  slot: ChallengeSlot,
  state: ChildLearningState,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  count: number,
  exclude_codes?: readonly string[] | null,
): Item[] {
  const chosen: Item[] = [];
  const excluded: string[] = [...(exclude_codes ?? [])];
  for (let i = 0; i < count; i += 1) {
    const item = selectItem(slot, state, bundle, cfg, excluded);
    if (item === null) {
      break;
    }
    chosen.push(item);
    excluded.push(item.code);
  }
  return chosen;
}
