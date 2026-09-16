/**
 * 每日计划规划器 —— `backend/engine/planner.py` 的 TypeScript 移植。
 *
 * 时间预算是硬约束，题量不是（§20）。
 *
 *     warmup   2min  召回旧知识（已会但未自动化）
 *     core     4min  围绕当前目标能力的核心训练
 *     story    4min  故事训练：把聚焦能力放进故事里练
 *     thinking 3min  思维挑战 / 迁移测试
 *     discovery 1min 今日发现
 *
 * Planner 的输入是 Learning Intent，输出是 DailyPlan（其中含 slot 与选中题目）。
 *
 * 故事段的选法（ADR-0001）：
 *   故事段消费的是 `purpose=story` 的槽位 —— 这些槽位挂在故事的挑战节拍上，
 *   但**具体做哪一道题仍然由本模块在运行时决定**。故事作者写的是
 *   "这里需要算一算"，不是"这里做 mt_add_3_4"。
 *   一个节拍出一道题（`select_item` 而不是 `select_items`）：节拍的顺序就是故事的
 *   顺序，在同一个节拍上连出两道题，那不是故事，是刷题。
 */

import {
  challengeBeats,
  type ChallengeSlot,
  type ContentBundle,
  type Item,
  type Story,
} from "@/src/content/types";
import { SCAFFOLD_LEVELS } from "@/src/engine/config";
import type { AlgorithmConfig } from "@/src/engine/config";
import type { CompetencyGraph } from "@/src/engine/graph";
import { deriveIntents } from "@/src/engine/intent";
import type { ReviewItem } from "@/src/engine/scheduler";
import { effectiveScaffold, selectItem, selectItems } from "@/src/engine/selector";
import { nextCompetency } from "@/src/engine/state-machine";
import type { ChildLearningState, LearningIntent } from "@/src/engine/types";
import { LearningIntent as LearningIntentClass } from "@/src/engine/types";
import { pyRound } from "@/src/py/pyround";
import { pyGet } from "@/src/py/pyvalue";

export const SCAFFOLD_LABELS: Record<string, string> = {
  blocks: "用积木摆",
  decompose: "先拆一拆",
  direct: "直接算",
};

// 意图 → 计划段落
export const INTENT_SEGMENT: Record<string, string> = {
  warmup: "warmup",
  review: "warmup", // 复习占用热身段：热身的职责本来就是"召回旧知识"
  repair: "core",
  teach: "core",
  strengthen_fluency: "core",
  story: "story",
  probe_transfer: "thinking",
};

// 复习意图的优先级：在常规热身之前，但不抢回退（repair）的位置
export const PRIORITY_REVIEW = 5;

// 句子常量：故事段缺内容时，note 要能说清"是内容还没写"还是"这个能力还没故事"
export const NOTE_NO_STORY_AT_ALL = "故事段暂缺内容，其时间预算已按比例并入其他段落";
export const NOTE_NO_STORY_FOR_TARGET =
  "故事段暂缺内容：{} 还没有故事，其时间预算已按比例并入其他段落";

// 段落 → 优先匹配的 slot purpose
export const SEGMENT_PURPOSES: Record<string, string[]> = {
  warmup: ["warmup", "review", "practice"],
  core: ["practice", "teach", "review"],
  story: ["story"],
  thinking: ["challenge", "practice"],
};

/**
 * Python `str(None)` 是 "None" 不是 "null" —— note 文案进 fixture，必须逐字一致。
 */
function pyStr(v: string | null | undefined): string {
  return v === null || v === undefined ? "None" : v;
}

/** 故事段里"哪个节拍配了哪道题"。
 *
 * 故事播放器要逐 beat 出题，所以这个映射必须显式给出 ——
 * 靠 `items` 的下标隐式对齐，会在某个节拍落不到题时整体错位。
 */
export class StoryBeatAssignment {
  beat_code: string;
  slot_code: string;
  item_code: string;

  constructor(init: { beat_code: string; slot_code: string; item_code: string }) {
    this.beat_code = init.beat_code;
    this.slot_code = init.slot_code;
    this.item_code = init.item_code;
  }

  toDict(): Record<string, unknown> {
    return { beat_code: this.beat_code, slot_code: this.slot_code, item_code: this.item_code };
  }
}

export class PlanSegment {
  type: string;
  budget_s: number;
  intents: LearningIntent[];
  items: Item[];
  slot_code: string | null;
  scaffold_level: string | null;
  note: string;
  story_code: string | null;
  beats: StoryBeatAssignment[];

  constructor(init: { type: string; budget_s: number }) {
    this.type = init.type;
    this.budget_s = init.budget_s;
    this.intents = [];
    this.items = [];
    this.slot_code = null;
    this.scaffold_level = null;
    this.note = "";
    this.story_code = null;
    this.beats = [];
  }

  toDict(): Record<string, unknown> {
    return {
      type: this.type,
      budget_s: this.budget_s,
      intents: this.intents.map((i) => intentToDict(i)),
      items: this.items.map((i) => i.code),
      slot_code: this.slot_code,
      scaffold_level: this.scaffold_level,
      note: this.note,
      story_code: this.story_code,
      beats: this.beats.map((b) => b.toDict()),
    };
  }
}

export class DailyPlan {
  child_id: string;
  budget_minutes: number;
  segments: PlanSegment[];
  intents: LearningIntent[];
  discovery: string;
  notes: string[];

  constructor(init: {
    child_id: string;
    budget_minutes: number;
    segments: PlanSegment[];
    intents: LearningIntent[];
    discovery: string;
    notes?: string[];
  }) {
    this.child_id = init.child_id;
    this.budget_minutes = init.budget_minutes;
    this.segments = init.segments;
    this.intents = init.intents;
    this.discovery = init.discovery;
    this.notes = init.notes ?? [];
  }

  toDict(): Record<string, unknown> {
    return {
      child_id: this.child_id,
      budget_minutes: this.budget_minutes,
      segments: this.segments.map((s) => s.toDict()),
      intents: this.intents.map((i) => intentToDict(i)),
      discovery: this.discovery,
      notes: [...this.notes],
    };
  }
}

/** LearningIntent 的字典投影（与 Python 侧 dataclasses.asdict 同构） */
export function intentToDict(intent: LearningIntent): Record<string, unknown> {
  return {
    kind: intent.kind,
    competency_id: intent.competency_id,
    reason: intent.reason,
    pattern_id: intent.pattern_id,
    scaffold_level: intent.scaffold_level,
    target_seconds: intent.target_seconds,
    priority: intent.priority,
  };
}

function findSlot(
  bundle: ContentBundle,
  competency_id: string,
  purposes: string[],
  pattern_id?: string | null,
): ChallengeSlot | null {
  let candidates = [...bundle.slots.values()].filter(
    (slot) => slot.competency_id === competency_id && purposes.includes(slot.purpose),
  );
  if (pattern_id) {
    const exact = candidates.filter((s) => s.pattern_id === pattern_id);
    if (exact.length > 0) {
      candidates = exact;
    } else {
      // 槽位允许自由 pattern 时也能承接指定 pattern 的意图
      const free = candidates.filter((s) => s.pattern_id === null);
      if (free.length > 0) {
        candidates = free;
      }
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  // Python: sorted(candidates, key=lambda s: (purposes.index(s.purpose), s.code))[0]
  let best = candidates[0]!;
  let bestKey: [number, string] = [purposes.indexOf(best.purpose), best.code];
  for (const s of candidates) {
    const key: [number, string] = [purposes.indexOf(s.purpose), s.code];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = s;
      bestKey = key;
    }
  }
  return best;
}

function reviewIntents(
  due_reviews: readonly ReviewItem[] | null,
  cfg: AlgorithmConfig,
): LearningIntent[] {
  /** 把到期复习项翻译成学习意图（仍然是"练什么"，不是"做哪道题"）。
   *
   * 顺序即优先级：调用方（scheduler.due_reviews）已按"逾期天数降序"排好，
   * 这里原样保留 —— 最该复习的排最前。
   */
  const intents: LearningIntent[] = [];
  for (const row of due_reviews ?? []) {
    intents.push(
      new LearningIntentClass({
        kind: "review",
        competency_id: row.competency_id,
        pattern_id: row.pattern_id,
        reason: `到期复习：${row.pattern_id}，第 ${row.interval_index + 1} 档间隔，逾期 ${row.overdue_days} 天`,
        priority: PRIORITY_REVIEW,
        target_seconds:
          Math.trunc(Number(pyGet(cfg.intentConfig(), "warmup_item_count", 2))) * 10,
      }),
    );
  }
  return intents;
}

function scaffoldDistance(level: string, preferred: string | null | undefined): number {
  const levels = SCAFFOLD_LEVELS as readonly string[];
  if (!preferred || !levels.includes(preferred)) {
    return 0;
  }
  return Math.abs(levels.indexOf(level) - levels.indexOf(preferred));
}

function reviewSlot(
  slot: ChallengeSlot,
  bundle: ContentBundle,
  pattern_id: string | null | undefined,
  preferred_scaffold?: string | null,
): ChallengeSlot | null {
  /** 复习必须打准问题结构。
   *
   * pattern 是复习的对象，不能"随便换一道"—— 换了结构就不是在复习那件事了。
   * 槽位允许自由 pattern 时，把它收窄到本次要复习的 pattern；槽位写死了别的
   * pattern、或这个结构在难度区间内压根没有题目时，宁可跳过（交回 Planner 记 note），
   * 也不静默地复习成别的内容。
   *
   * 脚手架则相反：内容里同一个结构只在某些呈现方式下存在（例如只有"先拆一拆"
   * 版本的 missing_part），熟练度对应的那一档没有这个结构的题时，退到离它最近的
   * 可用档 —— 换呈现方式不算换结构，做不上才是真的把复习丢了。
   */
  if (!pattern_id) {
    return slot;
  }
  if (slot.pattern_id !== null && slot.pattern_id !== pattern_id) {
    return null;
  }
  const pool = [...bundle.items.values()].filter(
    (item) =>
      item.competency_id === slot.competency_id &&
      item.pattern_id === pattern_id &&
      slot.difficulty_min <= item.difficulty &&
      item.difficulty <= slot.difficulty_max,
  );
  if (pool.length === 0) {
    return null;
  }
  // Python: sorted({item.scaffold_level for item in pool})
  const scaffolds: string[] = [...new Set(pool.map((item) => item.scaffold_level))].sort();
  let preferred = preferred_scaffold ?? null;
  if (!preferred || !scaffolds.includes(preferred)) {
    // Python: min(scaffolds, key=lambda s: (_scaffold_distance(s, preferred), s))
    let minS = scaffolds[0]!;
    let minKey: [number, string] | null = null;
    for (const s of scaffolds) {
      const key: [number, string] = [scaffoldDistance(s, preferred), s];
      if (minKey === null || key[0] < minKey[0] || (key[0] === minKey[0] && key[1] < minKey[1])) {
        minS = s;
        minKey = key;
      }
    }
    preferred = minS;
  }
  // Python: replace(slot, pattern_id=pattern_id, scaffold_level=preferred)
  // preferred 此时必是 pool 中出现的档位之一（安全断言）
  return { ...slot, pattern_id, scaffold_level: preferred as ChallengeSlot["scaffold_level"] };
}

function warmupIntentsWithReviews(
  review_intents: readonly LearningIntent[],
  warmup_intents: readonly LearningIntent[],
  capacity: number,
): LearningIntent[] {
  /** 复习优先占用热身段容量，剩余容量才安排常规热身。
   *
   * 复习**不新开段落**：热身本来就是这个作用，多开一段会挤掉核心训练的时间预算。
   */
  if (review_intents.length >= capacity) {
    return [...review_intents];
  }
  const kept = warmup_intents.slice(0, capacity - review_intents.length); + 1;
  return [...review_intents, ...kept];
}

function storyForTarget(bundle: ContentBundle, target: string | null): Story | null {
  /** 为聚焦能力挑一个故事。
   *
   * 同一个能力可能有多站故事，按 order_index 取最靠前的一站 ——
   * "从第一站开始"是内容作者的顺序，Planner 不重新发明排序。
   * 没有任何挑战节拍的故事不接（故事必须包含数学训练）。
   */
  if (!target) {
    return null;
  }
  const candidates = [...bundle.stories.values()].filter(
    (story) => story.target_competencies.includes(target) && challengeBeats(story).length > 0,
  );
  if (candidates.length === 0) {
    return null;
  }
  // Python: sorted(candidates, key=lambda s: (s.order_index, s.code))[0]
  let best = candidates[0]!;
  let bestKey: [number, string] = [best.order_index, best.code];
  for (const s of candidates) {
    const key: [number, string] = [s.order_index, s.code];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = s;
      bestKey = key;
    }
  }
  return best;
}

function storyIntent(
  story: Story,
  target: string,
  graph: CompetencyGraph,
): LearningIntent {
  /** 故事段也有意图 —— 它练的还是聚焦能力，只是换了个说法。
   *
   * 故事不是"另一门课"，它是同一个学习意图的另一种交付方式：
   * core 段是"练 make_ten"，story 段是"在车站的故事里练 make_ten"。
   * 所以这里刻意复用能力的名字，而不是新造一个教学概念。
   */
  const competency = graph.competencies.get(target);
  const name = competency ? competency.name : target;
  return new LearningIntentClass({
    kind: "story",
    competency_id: target,
    reason: `故事训练《${story.title}》：把${name}放进故事里练`,
    target_seconds: story.duration_min * 60,
  });
}

function fillStorySegment(
  segment: PlanSegment,
  story: Story,
  state: ChildLearningState,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  used_item_codes: string[],
  notes: string[],
): void {
  /** 一个挑战节拍出一道题，按节拍顺序排。
   *
   * 节拍挂不到 slot、或槽位候选池为空时，**只跳过这一个节拍并记 note** ——
   * 不中断整个故事段。一个节拍没题是内容缺陷（Content Compiler 会拦），
   * 不该让孩子今天连故事都看不到。
   */
  segment.story_code = story.code;
  for (const beat of challengeBeats(story)) {
    const slot = bundle.slots.get(beat.slot_code ?? "");
    if (slot === undefined) {
      notes.push(`故事 ${story.code} 的挑战节拍 ${beat.code} 没有可用的 slot`);
      continue;
    }
    const picked = selectItem(slot, state, bundle, cfg, used_item_codes);
    if (picked === null) {
      notes.push(`故事 ${story.code} 节拍 ${beat.code} 的 slot ${slot.code} 候选池为空`);
      continue;
    }
    used_item_codes.push(picked.code);
    segment.items.push(picked);
    segment.beats.push(
      new StoryBeatAssignment({
        beat_code: beat.code,
        slot_code: slot.code,
        item_code: picked.code,
      }),
    );
  }
}

function discoveryText(
  state: ChildLearningState,
  target: string | null,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): string {
  /** 今日发现 —— 核心是"和过去的自己比"，不是"今天做了多少题"。 */
  if (target === null) {
    return "今天你发现了：你已经把这一阶段的能力都拿下啦。";
  }

  const competency = graph.competencies.get(target);
  const name = competency ? competency.name : target;
  const signals = state.competencies.get(target);
  const first = state.first_scaffold.get(target) ?? null;
  const current = cfg.scaffoldForMastery(signals ? signals.mastery : null);

  // Python: if first and first != current and current == "direct"（truthy 检查）
  if (first && first !== current && current === "direct") {
    return `今天你发现了：${name}，第一次还要${SCAFFOLD_LABELS[first] ?? first}，现在可以${SCAFFOLD_LABELS[current] ?? current}了。`;
  }
  if (signals && signals.accuracy !== null && signals.accuracy >= 0.8) {
    return `今天你发现了：${name} 越来越顺了。`;
  }
  return `今天你发现了：${name} 不止一种算法，找到自己最快的那一种。`;
}

export function buildDailyPlan(
  state: ChildLearningState,
  graph: CompetencyGraph,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  budget_minutes?: number | null,
  due_reviews?: readonly ReviewItem[] | null,
): DailyPlan {
  /** 构建今日计划。
   *
   * `due_reviews`：scheduler.due_reviews() 的输出。传 None / 空列表时，
   * 计划行为与没有复习调度时**完全一致**（复习是叠加项，不是改造项）。
   * 有到期复习项时，它们优先占用热身段的容量。
   */
  const plan_cfg = cfg.dailyPlan();
  let budget = budget_minutes ?? Math.trunc(Number(pyGet(plan_cfg, "budget_minutes", 12)));
  budget = Math.max(
    Math.trunc(Number(pyGet(plan_cfg, "min_budget_minutes", 10))),
    Math.min(Math.trunc(Number(pyGet(plan_cfg, "max_budget_minutes", 15))), budget),
  );

  const notes: string[] = [];
  let intents = deriveIntents(state, graph, bundle, cfg);
  const target = nextCompetency(state, graph, cfg);
  const reviews = reviewIntents(due_reviews ?? null, cfg);
  if (reviews.length > 0) {
    // Python: "、".join(i.competency_id + "::" + str(i.pattern_id) ...)
    const joined = reviews.map((i) => `${i.competency_id}::${pyStr(i.pattern_id)}`).join("、");
    notes.push(`今日复习 ${reviews.length} 项（间隔复习调度，优先占用热身段）：${joined}`);
  }

  // 只保留"有内容可承接"的段落，时间按剩余段落比例重新分配
  const ratio_by_type = new Map<string, number>();
  for (const row of pyGet(plan_cfg, "segments", []) as Record<string, unknown>[]) {
    ratio_by_type.set(String(row["type"]), Number(row["ratio"]));
  }

  // 故事段是"聚焦能力的故事"，所以能不能开，取决于**这个能力**有没有故事，
  // 而不是内容库里有没有任何故事 —— 别人的故事帮不了今天的目标。
  const story = storyForTarget(bundle, target);
  if (story !== null) {
    intents = [...intents, storyIntent(story, target!, graph)];
  }

  const active_types = [...ratio_by_type.keys()].filter(
    (t) => t !== "story" || story !== null,
  );
  if (story === null) {
    notes.push(
      bundle.stories.size > 0
        ? NOTE_NO_STORY_FOR_TARGET.replace("{}", pyStr(target))
        : NOTE_NO_STORY_AT_ALL,
    );
  }
  let total_ratio = 0;
  for (const t of active_types) {
    total_ratio += ratio_by_type.get(t)!;
  }

  const segments: PlanSegment[] = [];
  const used_item_codes: string[] = [];

  for (const segment_type of active_types) {
    // Python: int(round(budget_minutes * 60 * ratio / total_ratio))
    const budget_s = Math.trunc(
      pyRound((budget * 60 * ratio_by_type.get(segment_type)!) / total_ratio),
    );
    const segment = new PlanSegment({ type: segment_type, budget_s });

    if (segment_type === "discovery") {
      segments.push(segment);
      continue;
    }

    if (segment_type === "story") {
      segment.intents = intents.filter((i) => INTENT_SEGMENT[i.kind] === "story");
      fillStorySegment(segment, story!, state, bundle, cfg, used_item_codes, notes);
      if (segment.items.length === 0) {
        segment.note = "故事段无法落题（内容缺失）";
      }
      segments.push(segment);
      continue;
    }

    let segment_intents = intents.filter((i) => INTENT_SEGMENT[i.kind] === segment_type);
    if (segment_type === "warmup" && reviews.length > 0) {
      segment_intents = warmupIntentsWithReviews(
        reviews,
        segment_intents,
        Math.trunc(Number(pyGet(cfg.intentConfig(), "warmup_item_count", 2))),
      );
    }
    segment.intents = segment_intents;

    let count: number;
    if (segment_type === "warmup") {
      count = Math.trunc(Number(pyGet(cfg.intentConfig(), "warmup_item_count", 2)));
    } else if (segment_type === "thinking") {
      count = Math.trunc(Number(pyGet(cfg.intentConfig(), "thinking_item_count", 1)));
    } else {
      count = Math.trunc(Number(pyGet(cfg.intentConfig(), "core_item_count", 3)));
    }

    // 同一段里有多个意图时，按意图数分配题量，避免后一个意图抢不到题
    const per_intent = Math.max(1, Math.floor(count / Math.max(1, segment_intents.length)));

    for (const intent of segment_intents) {
      let slot = findSlot(
        bundle,
        intent.competency_id,
        SEGMENT_PURPOSES[segment_type]!,
        intent.pattern_id,
      );
      if (slot === null) {
        // Python 格式化 list 得到 "['warmup', 'review', 'practice']" 形式 —— 逐字复刻
        const purposes = SEGMENT_PURPOSES[segment_type]!
          .map((p) => `'${p}'`)
          .join(", ");
        notes.push(
          `内容缺失：${intent.competency_id} 没有 purpose=[${purposes}] 的 slot，意图 [${intent.kind}] 无法落地`,
        );
        continue;
      }
      if (intent.kind === "review") {
        slot = reviewSlot(
          slot,
          bundle,
          intent.pattern_id,
          effectiveScaffold(slot, state, cfg),
        );
        if (slot === null) {
          notes.push(
            `复习无法落题：${intent.competency_id} 的 ${pyStr(intent.pattern_id)} 结构在可用槽位里没有候选题`,
          );
          continue;
        }
      }
      segment.slot_code = slot.code;
      segment.scaffold_level = effectiveScaffold(slot, state, cfg);
      // 把今天已经排给其他段的题传下去：不传的话，选择器挑出重复题
      // 只能在这里被丢掉，而丢掉之后并没有重挑 —— 表现就是"这段明明
      // 有意图却一道题都没有"（迁移测试落地率低的机制之一）。
      let picked = selectItems(slot, state, bundle, cfg, per_intent, used_item_codes);
      if (intent.kind === "review" && intent.pattern_id) {
        // 选择题在"该 pattern 在这个脚手架下没题"时会放宽 pattern 换一道。
        // 常规练习可以接受这种放宽，复习不行 —— 换了结构就不是在复习那件事。
        // 所以这里对选出的题做校验：不是被复习的结构，宁可不做。
        const kept = picked.filter((i) => i.pattern_id === intent.pattern_id);
        if (kept.length !== picked.length) {
          notes.push(
            `复习无法落题：${intent.competency_id} 的 ${intent.pattern_id} 结构在当前脚手架下没有候选题（不换结构）`,
          );
        }
        picked = kept;
      }
      for (const item of picked) {
        if (used_item_codes.includes(item.code)) {
          continue;
        }
        used_item_codes.push(item.code);
        segment.items.push(item);
      }
    }

    if (segment_type !== "discovery" && segment.items.length === 0) {
      if (segment_intents.length === 0) {
        segment.note = "本段今日无意图";
      } else {
        segment.note = "本段意图无法落题（内容缺失）";
      }
    }

    segments.push(segment);
  }

  if (!segments.some((seg) => seg.items.length > 0)) {
    notes.push("今日无可用题目：请检查内容与 slot 配置");
  }

  return new DailyPlan({
    child_id: state.child_id,
    budget_minutes: budget,
    segments: segments,
    intents: [...intents, ...reviews],
    discovery: discoveryText(state, target, graph, cfg),
    notes: notes,
  });
}

/** Python "{:<9}" 左对齐 / "{:>3}" 右对齐 */
function padEndWidth(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
function padStartWidth(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

export function renderPlan(
  plan: DailyPlan,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): string {
  /** 把计划渲染成人能读的文本 —— 用来验证"Planner 决定的是意图，不是题目"。 */
  const lines = [`📋 今日计划（${plan.budget_minutes} 分钟，时间硬约束）`];
  for (const seg of plan.segments) {
    const header = `  [${padEndWidth(seg.type, 9)}] ${padStartWidth(String(seg.budget_s), 3)}s`;
    const detail: string[] = [];
    if (seg.story_code) {
      detail.push(`故事=${seg.story_code}`);
    }
    for (const intent of seg.intents) {
      detail.push(`${intent.kind}:${intent.competency_id}`);
    }
    if (seg.scaffold_level) {
      detail.push(`脚手架=${seg.scaffold_level}`);
    }
    if (seg.items.length > 0) {
      detail.push(
        "题目=" +
          seg.items
            .map((i) => {
              // Python: i.problem.get("prompt", "") —— 值为 None 时 format 输出 "None"
              const prompt = pyGet(i.problem, "prompt", "");
              return `${i.code}（${prompt === null ? "None" : String(prompt)}）`;
            })
            .join(", "),
      );
    } else if (seg.note) {
      detail.push(seg.note);
    }
    lines.push(header + (detail.length > 0 ? "  " + detail.join(" | ") : ""));
  }
  lines.push(`  💡 ${plan.discovery}`);
  for (const note of plan.notes) {
    lines.push(`  ⚠️ ${note}`);
  }
  return lines.join("\n");
}
