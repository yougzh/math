/**
 * 模拟儿童长周期测试（P3）—— `tools/simulate.py` 的 TypeScript 移植。
 *
 * 7 个不同类型的虚拟孩子 × 30 天 × 每天 10~15 分钟，每一步都走**真实引擎**：
 *
 *     derive_intents → build_daily_plan(带 due_reviews) → select_items
 *     → 按画像规则作答 → apply_attempt → update_schedule
 *
 * 所有随机性都来自固定 seed 的 PyRandom（不用真随机），同一个 seed
 * 跑两次结果逐字段一致 —— 报告必须可复现，否则它只是段故事。
 *
 * 体检要回答的 5 个问题（DoD）：
 *   Q1 是否过早升级  Q2 是否长期卡在简单题  Q3 回退是否频繁
 *   Q4 复习是否过载  Q5 是否出现难度断层
 */
import { pathToFileURL } from "node:url";
import { loadBundle } from "@/src/content/loader";
import { validateContent } from "@/src/content/validate";
import type { ChallengeSlot, ContentBundle, Item } from "@/src/content/types";
import { AUTO_SCAFFOLD } from "@/src/content/types";
import { loadConfig } from "@/src/engine/config";
import type { AlgorithmConfig } from "@/src/engine/config";
import { CompetencyGraph } from "@/src/engine/graph";
import { applyAttempt, newState } from "@/src/engine/learner";
import { buildDailyPlan } from "@/src/engine/planner";
import {
  dueReviews,
  pendingReviews,
  updateSchedule,
  type ScheduleEntry,
} from "@/src/engine/scheduler";
import {
  countSuccessfulPatterns,
  deriveLevel,
  fallbackDecision,
  isMastered,
  levelLabel,
  nextCompetency,
  upgradeDecision,
} from "@/src/engine/state-machine";
import type { Attempt, ChildLearningState, SignalName } from "@/src/engine/types";
import { Attempt as AttemptClass, Signals, Telemetry, patternKey } from "@/src/engine/types";
import { samplesForAttempt } from "@/src/engine/proficiency";
import { PyRandom } from "@/src/py/pyrandom";
import { pyFormat, pyFormatPercent, pyFormatSigned } from "@/src/py/pyround";

export const SIM_DAYS = 30;
export const ANALYSIS_WINDOW_DAYS = 30; // 报告口径：30 天

// ── 体检判据（报告口径，不是算法阈值；算法阈值一律来自 v0.yaml） ──
export const JUMP_ALERT = 2; // 相邻两次作答难度上升 ≥ 2 → 难度断层
export const STUCK_EASY_DAYS = 10; // 30 天里超过 10 天只做难度 1 的题 → 卡在简单题
export const FALLBACK_ALERT = 10; // 30 天里回退超过 10 次 → 回退频繁
export const REPEAT_ALERT = 5; // 同一道题出现超过 5 次 → 过度重复

export const LINE = "═".repeat(78);
export const THIN = "─".repeat(78);

// ══════════════════════════════════════════════════════════
//  一部分：作答建模
// ══════════════════════════════════════════════════════════

export class Response {
  correct: boolean;
  hints_used: number;
  thinking_ms: number;
  submitted_answer: unknown;

  constructor(init: {
    correct: boolean;
    hints_used: number;
    thinking_ms: number;
    submitted_answer: unknown;
  }) {
    this.correct = init.correct;
    this.hints_used = init.hints_used;
    this.thinking_ms = init.thinking_ms;
    this.submitted_answer = init.submitted_answer;
  }
}

export class AttemptContext {
  day: number;
  item: Item;
  is_review: boolean;
  is_transfer_probe: boolean;
  /** None = 这个结构从没练过 */
  days_since_pattern: number | null;
  /** 当天第几次作答（从 0 开始） */
  attempt_index: number;

  constructor(init: {
    day: number;
    item: Item;
    is_review: boolean;
    is_transfer_probe: boolean;
    days_since_pattern: number | null;
    attempt_index: number;
  }) {
    this.day = init.day;
    this.item = init.item;
    this.is_review = init.is_review;
    this.is_transfer_probe = init.is_transfer_probe;
    this.days_since_pattern = init.days_since_pattern;
    this.attempt_index = init.attempt_index;
  }
}

function ratioThresholdMs(cfg: AlgorithmConfig, item: Item): number {
  return cfg.fluencyThresholdMs(item.pattern_id, item.interaction_type);
}

function thinkingMs(cfg: AlgorithmConfig, item: Item, ratio: number, rng: PyRandom): number {
  /** 思考时间 = 比值 × 该 (pattern, interaction_type) 的 fluency 阈值。
   *
   * 带 ±10% 抖动，让信号是有波动的真实采样，而不是一条直线。
   */
  const base = ratioThresholdMs(cfg, item);
  const jitter = 0.9 + 0.2 * rng.random();
  return Math.max(500, Math.trunc(base * ratio * jitter));
}

export function wrongAnswer(item: Item, rng: PyRandom, style: string): unknown {
  /** 构造一个"像孩子会犯的错"的答案，用来触发 diagnosis 的 error_rules。
   *
   * style:
   *   carry_missed —— 个位相加满十但不进位（答案差 10），命中 carry_missed / place_value_confusion
   *   off_by_one   —— 差 1，命中 counting_dependency
   *   off_by_ten   —— 差整十，命中 place_value_confusion
   *   mixed        —— 按 seed 在上面三种里挑
   */
  const answer = item.answer;
  if (typeof answer !== "number" || !Number.isInteger(answer)) {
    return answer;
  }
  if (style === "carry_missed") {
    return answer - 10;
  }
  if (style === "off_by_one") {
    return rng.random() < 0.5 ? answer - 1 : answer + 1;
  }
  if (style === "off_by_ten") {
    return answer + 10;
  }
  const roll = rng.random();
  if (roll < 0.5) {
    return rng.random() < 0.5 ? answer - 1 : answer + 1;
  }
  if (roll < 0.85) {
    return answer + 10;
  }
  return answer - 10;
}

function makeResponse(
  cfg: AlgorithmConfig,
  ctx: AttemptContext,
  rng: PyRandom,
  correct: boolean,
  hints = 0,
  ratio = 1.0,
  style = "mixed",
): Response {
  return new Response({
    correct,
    hints_used: hints,
    thinking_ms: thinkingMs(cfg, ctx.item, ratio, rng),
    submitted_answer: correct ? ctx.item.answer : wrongAnswer(ctx.item, rng, style),
  });
}

// ══════════════════════════════════════════════════════════
//  二部分：画像
// ══════════════════════════════════════════════════════════

export class Entry {
  focus: string;
  focus_mastery: number;
  focus_accuracy: number;
  focus_independence: number;
  focus_fluency: number;
  focus_samples: number;
  mastered_prereqs: string[];
  weak: Record<string, number>;
  tried_patterns: number;

  constructor(init: {
    focus: string;
    focus_mastery?: number;
    focus_accuracy?: number;
    focus_independence?: number;
    focus_fluency?: number;
    focus_samples?: number;
    mastered_prereqs?: string[];
    weak?: Record<string, number>;
    tried_patterns?: number;
  }) {
    this.focus = init.focus;
    this.focus_mastery = init.focus_mastery ?? 0.55;
    this.focus_accuracy = init.focus_accuracy ?? 0.62;
    this.focus_independence = init.focus_independence ?? 0.9;
    this.focus_fluency = init.focus_fluency ?? 0.8;
    this.focus_samples = init.focus_samples ?? 8;
    this.mastered_prereqs = init.mastered_prereqs ?? [];
    this.weak = init.weak ?? {};
    this.tried_patterns = init.tried_patterns ?? 2;
  }
}

export abstract class ChildProfile {
  key = "base";
  name = "基础画像";
  description = "";
  seed = 20260915;
  entry: Entry = new Entry({ focus: "make_ten" });

  abstract respond(ctx: AttemptContext, rng: PyRandom, cfg: AlgorithmConfig): Response;
}

class SlowStarter extends ChildProfile {
  override key = "slow_starter";
  override name = "慢热型";
  override description = "前 10 天正确率 0.35，之后逐步升到 0.75；思考偏慢、几乎不用提示";
  override seed = 1101;
  override entry = new Entry({
    focus: "sd_add_10",
    focus_mastery: 0.34,
    focus_accuracy: 0.4,
    focus_independence: 0.9,
    focus_fluency: 0.7,
    focus_samples: 5,
    tried_patterns: 1,
  });

  static RAMP_DAYS = 10;
  static LOW = 0.35;
  static HIGH = 0.75;

  accuracyAt(day: number): number {
    if (day <= SlowStarter.RAMP_DAYS) {
      return SlowStarter.LOW;
    }
    const span = Math.max(1, ANALYSIS_WINDOW_DAYS - SlowStarter.RAMP_DAYS);
    const progress = Math.min(1.0, (day - SlowStarter.RAMP_DAYS) / span);
    return SlowStarter.LOW + (SlowStarter.HIGH - SlowStarter.LOW) * progress;
  }

  override respond(ctx: AttemptContext, rng: PyRandom, cfg: AlgorithmConfig): Response {
    const p = this.accuracyAt(ctx.day) - 0.06 * (ctx.item.difficulty - 1);
    const correct = rng.random() < p;
    const hints = !correct && rng.random() < 0.15 ? 1 : 0;
    return makeResponse(cfg, ctx, rng, correct, hints, 1.2);
  }
}

class HintDependent extends ChildProfile {
  override key = "hint_dependent";
  override name = "提示依赖型";
  override description = "不用提示正确率 0.45；一提示就到 0.85，提示用得很凶";
  override seed = 2202;
  override entry = new Entry({
    focus: "make_ten",
    focus_mastery: 0.5,
    focus_accuracy: 0.55,
    mastered_prereqs: ["sd_add_10"],
  });
  static SOLO_ACCURACY = 0.45;
  static HINTED_ACCURACY = 0.85;
  static HINT_SEEKING = 0.9; // 做不出来就求助的概率

  override respond(ctx: AttemptContext, rng: PyRandom, cfg: AlgorithmConfig): Response {
    const p = HintDependent.SOLO_ACCURACY - 0.05 * (ctx.item.difficulty - 1);
    if (rng.random() < p) {
      return makeResponse(cfg, ctx, rng, true, 0, 1.4);
    }
    if (rng.random() < HintDependent.HINT_SEEKING) {
      const hints = rng.random() < 0.75 ? 1 : 2;
      const correct = rng.random() < HintDependent.HINTED_ACCURACY;
      return makeResponse(cfg, ctx, rng, correct, hints, 1.6);
    }
    return makeResponse(cfg, ctx, rng, false, 0, 1.5);
  }
}

class FluentButSloppy extends ChildProfile {
  override key = "fluent_but_sloppy";
  override name = "会但很慢型";
  override description = "正确率 0.92，但思考时间是阈值 2 倍以上；不提示、不放弃";
  override seed = 3303;
  override entry = new Entry({
    focus: "make_ten",
    focus_mastery: 0.6,
    focus_accuracy: 0.85,
    focus_fluency: 0.5,
    mastered_prereqs: ["sd_add_10"],
  });
  static BASE_ACCURACY = 0.92;
  static THINKING_RATIO = 2.2; // ratio 2.0~2.5 → fluency 采样落在 0.5 档

  override respond(ctx: AttemptContext, rng: PyRandom, cfg: AlgorithmConfig): Response {
    const p = FluentButSloppy.BASE_ACCURACY - 0.02 * (ctx.item.difficulty - 1);
    const correct = rng.random() < p;
    return makeResponse(cfg, ctx, rng, correct, 0, FluentButSloppy.THINKING_RATIO);
  }
}

class FastButFragile extends ChildProfile {
  override key = "fast_but_fragile";
  override name = "快但脆型";
  override description = "常规题正确率 0.9 且很快；一换问题结构（迁移测试）掉到 0.3";
  override seed = 4404;
  override entry = new Entry({
    focus: "make_ten",
    focus_mastery: 0.6,
    focus_accuracy: 0.9,
    focus_fluency: 0.9,
    focus_independence: 0.95,
    mastered_prereqs: ["sd_add_10"],
  });
  static NORMAL_ACCURACY = 0.9;
  static TRANSFER_ACCURACY = 0.3;

  override respond(ctx: AttemptContext, rng: PyRandom, cfg: AlgorithmConfig): Response {
    if (ctx.is_transfer_probe) {
      const correct = rng.random() < FastButFragile.TRANSFER_ACCURACY;
      return makeResponse(cfg, ctx, rng, correct, 0, 1.1);
    }
    const p = FastButFragile.NORMAL_ACCURACY - 0.02 * (ctx.item.difficulty - 1);
    const correct = rng.random() < p;
    return makeResponse(cfg, ctx, rng, correct, 0, 0.6);
  }
}

class Plateau extends ChildProfile {
  override key = "plateau";
  override name = "平台型";
  override description = "正确率卡在 0.70 上下永远上不去；系统会怎么对待他";
  override seed = 5505;
  override entry = new Entry({
    focus: "make_ten",
    focus_mastery: 0.68,
    focus_accuracy: 0.72,
    focus_fluency: 0.85,
    mastered_prereqs: ["sd_add_10"],
  });
  static BASE_ACCURACY = 0.7;

  override respond(ctx: AttemptContext, rng: PyRandom, cfg: AlgorithmConfig): Response {
    const p = Plateau.BASE_ACCURACY - 0.03 * (ctx.item.difficulty - 1);
    const correct = rng.random() < p;
    const hints = !correct && rng.random() < 0.2 ? 1 : 0;
    return makeResponse(cfg, ctx, rng, correct, hints, 1.3);
  }
}

class Forgetful extends ChildProfile {
  override key = "forgetful";
  override name = "健忘型";
  override description = "当天练过就做得对（0.9），隔一天就忘（0.3）—— 复习调度的试金石";
  override seed = 6606;
  override entry = new Entry({
    focus: "make_ten",
    focus_mastery: 0.62,
    focus_accuracy: 0.8,
    mastered_prereqs: ["sd_add_10"],
  });
  static SAME_DAY_ACCURACY = 0.9;
  static NEXT_DAY_ACCURACY = 0.3;
  static LONG_GAP_ACCURACY = 0.25;

  override respond(ctx: AttemptContext, rng: PyRandom, cfg: AlgorithmConfig): Response {
    const gap = ctx.days_since_pattern;
    let p: number;
    if (gap === null || gap === 0) {
      p = Forgetful.SAME_DAY_ACCURACY;
    } else if (gap === 1) {
      p = Forgetful.NEXT_DAY_ACCURACY;
    } else {
      p = Forgetful.LONG_GAP_ACCURACY;
    }
    p -= 0.03 * (ctx.item.difficulty - 1);
    const correct = rng.random() < p;
    const hints = !correct && rng.random() < 0.2 ? 1 : 0;
    return makeResponse(cfg, ctx, rng, correct, hints, 1.3);
  }
}

class CarryPhobic extends ChildProfile {
  override key = "carry_phobic";
  override name = "进位恐惧型";
  override description = "除进位加法外都能过关；进位题正确率 0.25，错误一律是「忘记进 1」";
  override seed = 7707;
  override entry = new Entry({
    focus: "carry_add",
    focus_mastery: 0.62,
    focus_accuracy: 0.78,
    focus_independence: 0.9,
    focus_fluency: 0.85,
    mastered_prereqs: ["sd_add_10", "make_ten", "td_add_nocarry"],
    weak: { place_value: 0.55 },
  });
  static BASE_ACCURACY = 0.95;
  static CARRY_ACCURACY = 0.25;

  override respond(ctx: AttemptContext, rng: PyRandom, cfg: AlgorithmConfig): Response {
    if (ctx.item.competency_id === "carry_add") {
      const correct = rng.random() < CarryPhobic.CARRY_ACCURACY;
      // 漏进位：13 + 8 答成 11，同时命中 carry_missed 与 place_value_confusion
      return makeResponse(cfg, ctx, rng, correct, 0, 1.2, "carry_missed");
    }
    const p = CarryPhobic.BASE_ACCURACY - 0.02 * (ctx.item.difficulty - 1);
    const correct = rng.random() < p;
    return makeResponse(cfg, ctx, rng, correct, 0, 0.8);
  }
}

export function makeProfiles(): ChildProfile[] {
  return [
    new SlowStarter(),
    new HintDependent(),
    new FluentButSloppy(),
    new FastButFragile(),
    new Plateau(),
    new Forgetful(),
    new CarryPhobic(),
  ];
}

// ══════════════════════════════════════════════════════════
//  三部分：入学起点
// ══════════════════════════════════════════════════════════

function masteredSignals(samples = 12): Signals {
  const signals = new Signals({
    mastery: 0.92,
    accuracy: 0.96,
    independence: 0.95,
    transfer: 0.95,
    fluency: 0.9,
    confidence: 0.95,
    sample_count: samples,
    probe_status: "stable",
  });
  for (const name of ["mastery", "accuracy", "independence", "transfer", "fluency", "confidence"] as SignalName[]) {
    signals.signal_sample_counts.set(name, samples);
  }
  return signals;
}

function seedMasteredCompetency(
  state: ChildLearningState,
  code: string,
  graph: CompetencyGraph,
  seq: number,
): number {
  state.competencies.set(code, masteredSignals());
  for (const pattern of graph.patternsFor(code)) {
    state.patterns.set(
      patternKey(code, pattern.code),
      new Signals({ mastery: 0.9, accuracy: 1.0, sample_count: 3 }),
    );
  }
  state.last_touched_seq.set(code, seq);
  return seq + 1;
}

export function buildEntryState(
  child_id: string,
  entry: Entry,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): ChildLearningState {
  /** 按画像的入学起点构造初始状态（不落库，只存在于模拟进程内）。 */
  const state = newState(child_id);
  let seq = 1;
  for (const code of entry.mastered_prereqs) {
    seq = seedMasteredCompetency(state, code, graph, seq);
  }

  // 明确"没掌握"的能力：只给低信号，不写 last_touched（不抢焦点）
  for (const [code, mastery] of Object.entries(entry.weak)) {
    state.competencies.set(
      code,
      new Signals({
        mastery,
        accuracy: mastery,
        independence: 0.9,
        fluency: 0.6,
        sample_count: 4,
        probe_status: "stable",
      }),
    );
  }

  const focus = entry.focus;
  const focus_signals = new Signals({
    mastery: entry.focus_mastery,
    accuracy: entry.focus_accuracy,
    independence: entry.focus_independence,
    fluency: entry.focus_fluency,
    confidence: 0.7,
    sample_count: entry.focus_samples,
    probe_status: "stable",
  });
  for (const name of ["mastery", "accuracy", "independence", "fluency"] as SignalName[]) {
    focus_signals.signal_sample_counts.set(name, entry.focus_samples);
  }
  state.competencies.set(focus, focus_signals);

  const focusPatterns = graph.patternsFor(focus).slice(0, Math.max(0, entry.tried_patterns));
  for (const pattern of focusPatterns) {
    state.patterns.set(
      patternKey(focus, pattern.code),
      new Signals({ mastery: 0.85, accuracy: 1.0, sample_count: 2 }),
    );
  }
  state.last_touched_seq.set(focus, seq);
  state.attempts_seen = seq;

  const landed = nextCompetency(state, graph, cfg);
  if (landed !== focus) {
    throw new Error(`入学起点构造失败：期望焦点 ${focus}，实际 ${landed}`);
  }
  return state;
}

// ══════════════════════════════════════════════════════════
//  四部分：模拟用补槽
// ══════════════════════════════════════════════════════════

export function withPracticeSlots(
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
): [ContentBundle, string[]] {
  /** 为"有题目、但没有可用训练槽"的能力补一个**模拟用**训练槽。
   *
   * ⚠️ 这不是内容：只存在于模拟进程内，不写回 content/**。
   * 理由：当前内容里 10 个能力中只有 make_ten / sd_add_10 有非 story 槽位，
   * 而 planner 的 story 段还没有意图映射，其余能力在真实引擎里"无题可出"。
   * 补槽让引擎的全部路径（教学 / 迁移 / 复习 / 回退）都能被跑到；
   * "内容缺口"本身在报告里单独列出，不因为补槽而消失。
   */
  const practice_purposes = new Set(["practice", "teach", "review"]);
  const covered = new Set(
    [...bundle.slots.values()]
      .filter((slot) => practice_purposes.has(slot.purpose))
      .map((slot) => slot.competency_id),
  );
  const by_competency = new Map<string, Item[]>();
  for (const item of bundle.items.values()) {
    const list = by_competency.get(item.competency_id);
    if (list === undefined) {
      by_competency.set(item.competency_id, [item]);
    } else {
      list.push(item);
    }
  }

  const added: string[] = [];
  const slots = new Map(bundle.slots);
  for (const competency_id of [...by_competency.keys()].sort()) {
    if (covered.has(competency_id)) {
      continue;
    }
    const items = by_competency.get(competency_id)!;
    const difficulties = items.map((i) => i.difficulty);
    const seconds = items.map((i) => i.estimated_seconds).sort((a, b) => a - b);
    const code = `zzsim_${competency_id}_practice`;
    const slot: ChallengeSlot = {
      code,
      competency_id,
      difficulty_min: Math.min(...difficulties),
      difficulty_max: Math.max(...difficulties),
      purpose: "practice",
      pattern_id: null,
      scaffold_level: AUTO_SCAFFOLD,
      estimated_seconds: seconds[Math.floor(seconds.length / 2)]!,
      story_beat_id: null,
      selection_policy: { avoid_recent: 3 },
      review_policy: {},
    };
    slots.set(code, slot);
    added.push(code);
  }

  const cloned: ContentBundle = {
    competencies: new Map(bundle.competencies),
    patterns: new Map(bundle.patterns),
    items: new Map(bundle.items),
    misconceptions: new Map(bundle.misconceptions),
    slots,
    stories: new Map(bundle.stories),
    load_problems: bundle.load_problems,
  };
  return [cloned, added];
}

// ══════════════════════════════════════════════════════════
//  五部分：模拟循环
// ══════════════════════════════════════════════════════════

export class DayRecord {
  day: number;
  focus: string | null;
  /** 当日到期复习项（未做每日上限截断） */
  due_count: number;
  /** 实际排进计划的复习项 */
  planned_reviews: number;
  review_attempts: number;
  /** 计划里的迁移测试意图数 */
  probe_planned: number;
  /** 真正落到题上的迁移测试数 */
  probe_attempts: number;
  notes: string[];
  attempts: Attempt[];

  constructor(init: {
    day: number;
    focus: string | null;
    due_count: number;
    planned_reviews: number;
    review_attempts: number;
    probe_planned: number;
    probe_attempts: number;
    notes: string[];
  }) {
    this.day = init.day;
    this.focus = init.focus;
    this.due_count = init.due_count;
    this.planned_reviews = init.planned_reviews;
    this.review_attempts = init.review_attempts;
    this.probe_planned = init.probe_planned;
    this.probe_attempts = init.probe_attempts;
    this.notes = init.notes;
    this.attempts = [];
  }
}

export interface SimEvent {
  day: number;
  type: "focus_switch" | "upgrade" | "fallback";
  [key: string]: unknown;
}

export class ChildRun {
  key: string;
  name: string;
  description: string;
  entry_focus: string;
  days: DayRecord[] = [];
  attempts: Attempt[] = [];
  review_attempt_ids: Set<string> = new Set();
  schedule: Map<string, ScheduleEntry> = new Map();
  final_state: ChildLearningState | null = null;
  events: SimEvent[] = [];

  constructor(init: { key: string; name: string; description: string; entry_focus: string }) {
    this.key = init.key;
    this.name = init.name;
    this.description = init.description;
    this.entry_focus = init.entry_focus;
  }

  all_attempts(): Attempt[] {
    return [...this.attempts].sort((a, b) => a.seq - b.seq);
  }

  review_attempts(): Attempt[] {
    return this.all_attempts().filter((a) => this.review_attempt_ids.has(a.attempt_id));
  }

  probe_attempts(): Attempt[] {
    return this.all_attempts().filter((a) => a.is_transfer_probe);
  }

  upgrades(): SimEvent[] {
    return this.events.filter((e) => e.type === "upgrade");
  }

  /** 把连续几天、同一目标的回退合并成一次"回退事件"。 */
  fallback_episodes(): Array<Record<string, unknown>> {
    const episodes: Array<Record<string, unknown>> = [];
    for (const event of this.events) {
      if (event.type !== "fallback") {
        continue;
      }
      if (episodes.length > 0) {
        const last = episodes[episodes.length - 1]!;
        if (
          last["target"] === event["target"] &&
          (event["day"] as number) - (last["last_day"] as number) <= 1
        ) {
          last["last_day"] = event["day"];
          last["days"] = (last["days"] as number) + 1;
          continue;
        }
      }
      episodes.push({
        target: event["target"],
        first_day: event["day"],
        last_day: event["day"],
        days: 1,
        reasons: event["reasons"],
      });
    }
    return episodes;
  }

  final_focus(graph: CompetencyGraph, cfg: AlgorithmConfig): string | null {
    if (this.final_state === null) {
      return null;
    }
    return nextCompetency(this.final_state, graph, cfg);
  }
}

function attemptFromResponse(
  seq: number,
  child_id: string,
  item: Item,
  response: Response,
  ctx: AttemptContext,
): Attempt {
  const active = Math.min(2000, Math.max(600, Math.trunc(response.thinking_ms / 4)));
  return new AttemptClass({
    attempt_id: `sim_${child_id}_${String(seq).padStart(4, "0")}`,
    child_id,
    item_id: item.code,
    competency_id: item.competency_id,
    pattern_id: item.pattern_id,
    correct: response.correct,
    telemetry: new Telemetry({
      response_time_ms: response.thinking_ms + active,
      active_time_ms: active,
    }),
    seq,
    hints_used: response.hints_used,
    hint_level_max: response.hints_used,
    scaffold_level: item.scaffold_level,
    interaction_type: item.interaction_type,
    is_transfer_probe: ctx.is_transfer_probe,
    submitted_answer: response.submitted_answer,
  });
}

function switchEvidence(
  state: ChildLearningState,
  competency_id: string | null,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): Record<string, unknown> {
  /** 切换焦点时的证据快照 —— 体检要拿它对照升级门槛。 */
  if (competency_id === null) {
    return {};
  }
  const signals = state.competencies.get(competency_id);
  if (signals === undefined) {
    return { sample_count: 0, successful_patterns: 0 };
  }
  return {
    mastery: signals.mastery,
    accuracy: signals.accuracy,
    independence: signals.independence,
    transfer: signals.transfer,
    fluency: signals.fluency,
    practice_samples: signals.practiceSamples,
    successful_patterns: countSuccessfulPatterns(state, competency_id, graph, cfg),
  };
}

export function runProfile(
  profile: ChildProfile,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  graph: CompetencyGraph,
  days = SIM_DAYS,
): ChildRun {
  /** 跑一个画像的 30 天。全程走真实引擎，只把"孩子怎么作答"换成画像规则。 */
  const state = buildEntryState(profile.key, profile.entry, graph, cfg);
  let schedule: Map<string, ScheduleEntry> = new Map();
  const rng = new PyRandom(profile.seed);
  const run = new ChildRun({
    key: profile.key,
    name: profile.name,
    description: profile.description,
    entry_focus: profile.entry.focus,
  });

  let seq = 0;
  let prev_focus: string | null = null;
  const last_pattern_day: Record<string, number> = {};
  // 入学起点里"已经掌握"的能力不算本次模拟的升级事件
  const upgraded = new Set(
    [...state.competencies.keys()].filter((code) => isMastered(state, code, graph, cfg)),
  );

  for (let day = 1; day <= days; day += 1) {
    const focus = nextCompetency(state, graph, cfg);
    if (prev_focus !== null && focus !== prev_focus) {
      run.events.push({
        day,
        type: "focus_switch",
        from: prev_focus,
        to: focus,
        evidence: switchEvidence(state, prev_focus, graph, cfg),
      });
    }
    prev_focus = focus;

    const pending = pendingReviews(schedule, day, state, cfg);
    const planned = dueReviews(schedule, day, state, cfg);
    const plan = buildDailyPlan(state, graph, bundle, cfg, undefined, planned);

    const record = new DayRecord({
      day,
      focus,
      due_count: pending.length,
      planned_reviews: planned.length,
      review_attempts: 0,
      probe_planned: plan.intents.filter((i) => i.kind === "probe_transfer").length,
      probe_attempts: 0,
      notes: [...plan.notes],
    });

    for (const segment of plan.segments) {
      if (segment.type === "discovery") {
        continue;
      }
      for (const item of segment.items) {
        seq += 1;
        const is_review = segment.intents.some(
          (i) =>
            i.kind === "review" &&
            i.competency_id === item.competency_id &&
            i.pattern_id === item.pattern_id,
        );
        const is_probe = segment.intents.some(
          (i) => i.kind === "probe_transfer" && i.competency_id === item.competency_id,
        );
        const key = patternKey(item.competency_id, item.pattern_id);
        const ctx = new AttemptContext({
          day,
          item,
          is_review,
          is_transfer_probe: is_probe,
          days_since_pattern:
            key in last_pattern_day ? day - last_pattern_day[key]! : null,
          attempt_index: record.attempts.length,
        });
        const response = profile.respond(ctx, rng, cfg);
        const attempt = attemptFromResponse(seq, profile.key, item, response, ctx);
        const next = applyAttempt(state, attempt, bundle, cfg);
        state.competencies = next.competencies;
        state.patterns = next.patterns;
        state.misconceptions = next.misconceptions;
        state.attempts_seen = next.attempts_seen;
        state.assessment_attempts = next.assessment_attempts;
        state.recent_attempts = next.recent_attempts;
        state.first_scaffold = next.first_scaffold;
        state.last_touched_seq = next.last_touched_seq;
        schedule = updateSchedule(schedule, attempt, day, cfg);
        last_pattern_day[key] = day;
        record.attempts.push(attempt);
        run.attempts.push(attempt);
        if (is_review) {
          record.review_attempts += 1;
          run.review_attempt_ids.add(attempt.attempt_id);
        }
        if (is_probe) {
          record.probe_attempts += 1;
        }
      }
    }

    // 日终事件：升级 / 回退
    for (const code of [...new Set([...state.competencies.keys(), ...state.last_touched_seq.keys()])].sort()) {
      if (upgraded.has(code)) {
        continue;
      }
      if (isMastered(state, code, graph, cfg)) {
        upgraded.add(code);
        run.events.push({ day, type: "upgrade", competency: code });
      }
    }

    if (focus !== null) {
      const decision = fallbackDecision(state, focus, graph, cfg);
      if (decision.action === "fallback") {
        run.events.push({
          day,
          type: "fallback",
          competency: focus,
          target: decision.target_competency_id,
          reasons: [...decision.reasons],
        });
      }
    }

    run.days.push(record);
  }

  run.schedule = schedule;
  run.final_state = state;
  return run;
}

export function runSimulation(
  profiles: ChildProfile[],
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  graph: CompetencyGraph,
  days = SIM_DAYS,
): ChildRun[] {
  return profiles.map((p) => runProfile(p, bundle, cfg, graph, days));
}

export function runColdStart(
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  graph: CompetencyGraph,
  days = SIM_DAYS,
): ChildRun {
  /** 冷启动路径：不加任何入学起点，看看新孩子第一天会遇到什么。
   *
   * 这是最重要的对照 —— 它暴露的是"系统面对一个全新孩子"的真实行为。
   */
  const profile = new SlowStarter();
  profile.key = "cold_start";
  profile.name = "冷启动新孩子";
  let state = newState(profile.key);
  let schedule: Map<string, ScheduleEntry> = new Map();
  const run = new ChildRun({
    key: profile.key,
    name: profile.name,
    description: "不做任何入学起点设置的真正新孩子",
    entry_focus: "（无）",
  });
  const rng = new PyRandom(9001);
  let seq = 0;
  for (let day = 1; day <= days; day += 1) {
    const focus = nextCompetency(state, graph, cfg);
    const pending = pendingReviews(schedule, day, state, cfg);
    const plan = buildDailyPlan(
      state,
      graph,
      bundle,
      cfg,
      undefined,
      dueReviews(schedule, day, state, cfg),
    );
    const record = new DayRecord({
      day,
      focus,
      due_count: pending.length,
      planned_reviews: 0,
      review_attempts: 0,
      probe_planned: plan.intents.filter((i) => i.kind === "probe_transfer").length,
      probe_attempts: 0,
      notes: [...plan.notes],
    });
    for (const segment of plan.segments) {
      if (segment.type === "discovery") {
        continue;
      }
      for (const item of segment.items) {
        seq += 1;
        const ctx = new AttemptContext({
          day,
          item,
          is_review: false,
          is_transfer_probe: false,
          days_since_pattern: null,
          attempt_index: record.attempts.length,
        });
        const response = profile.respond(ctx, rng, cfg);
        const attempt = attemptFromResponse(seq, profile.key, item, response, ctx);
        const next = applyAttempt(state, attempt, bundle, cfg);
        state = next;
        schedule = updateSchedule(schedule, attempt, day, cfg);
        record.attempts.push(attempt);
        run.attempts.push(attempt);
      }
    }
    run.days.push(record);
  }
  run.schedule = schedule;
  run.final_state = state;
  return run;
}

// ══════════════════════════════════════════════════════════
//  六部分：体检（纯函数，可单独测试）
// ══════════════════════════════════════════════════════════

export class Finding {
  question: string;
  title: string;
  detected: boolean;
  /** ok | warn | alert */
  severity: string;
  lines: string[];

  constructor(init: {
    question: string;
    title: string;
    detected: boolean;
    severity: string;
    lines?: string[];
  }) {
    this.question = init.question;
    this.title = init.title;
    this.detected = init.detected;
    this.severity = init.severity;
    this.lines = init.lines ?? [];
  }

  toDict(): Record<string, unknown> {
    return {
      question: this.question,
      title: this.title,
      detected: this.detected,
      severity: this.severity,
      lines: [...this.lines],
    };
  }
}

function evidenceGaps(evidence: Record<string, unknown>, cfg: AlgorithmConfig): string[] {
  /** 对照 upgrade_requires，列出证据里没达标的项。 */
  const requires = cfg.upgradeRequires();
  const gaps: string[] = [];
  for (const name of ["accuracy", "mastery", "independence", "transfer", "fluency"]) {
    if (!(name in requires)) {
      continue;
    }
    const value = evidence[name];
    const threshold = Number(requires[name]);
    if (value === null || value === undefined) {
      gaps.push(`${name} 无证据`);
    } else if ((value as number) < threshold) {
      gaps.push(`${name}=${pyFormat(value as number, 2)} < ${pyFormat(threshold, 2)}`);
    }
  }
  const practice = evidence["practice_samples"];
  if (practice !== null && practice !== undefined && (practice as number) < cfg.min_practice_samples) {
    gaps.push(`练习样本 ${practice} < ${cfg.min_practice_samples}`);
  }
  const rule = cfg.newPatternSuccessRule();
  const need = Math.trunc(Number(rule["min_patterns"] ?? 2));
  const got = evidence["successful_patterns"];
  if (got !== null && got !== undefined && (got as number) < need) {
    gaps.push(`成功 pattern ${got} < ${need}`);
  }
  return gaps;
}

export function checkEarlyUpgrade(
  runs: ChildRun[],
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): Finding {
  /** Q1：焦点被推到更靠后的能力上时，上一个能力真的达标了吗？
   *
   * "向前推进"用能力图的拓扑序判定：`to` 排在 `from` 之后才算推进。
   * 往前置方向移动（回退 / 遗忘后重练）不算过早升级 —— 那是系统在往回拉。
   */
  const position = new Map(
    graph.topologicalOrder().map((code, i) => [code, i] as const),
  );
  const lines: string[] = [];
  let total_forward = 0;
  for (const run of runs) {
    const switches = run.events.filter((e) => e.type === "focus_switch");
    const forward = switches.filter(
      (e) =>
        (position.get(e["to"] as string) ?? -1) > (position.get(e["from"] as string) ?? -1),
    );
    total_forward += forward.length;
    const bad = forward
      .map((e) => [e, evidenceGaps((e["evidence"] ?? {}) as Record<string, unknown>, cfg)] as const)
      .filter(([, gaps]) => gaps.length > 0);
    if (bad.length === 0) {
      continue;
    }
    lines.push(
      `${run.name}（${run.key}）：焦点切换 ${switches.length} 次（向前推进 ${forward.length} 次），` +
        `其中 ${bad.length} 次在未达标时就推进`,
    );
    for (const [event, gaps] of bad.slice(0, 5)) {
      lines.push(
        `    第 ${event["day"]} 天：${event["from"]} → ${event["to"]}｜证据缺口：${gaps.join("；")}`,
      );
    }
  }
  if (lines.length > 0) {
    return new Finding({
      question: "Q1",
      title: "过早升级（焦点在未达标时被推向更靠后的能力）",
      detected: true,
      severity: "alert",
      lines,
    });
  }
  const total_upgrades = runs.reduce((sum, run) => sum + run.upgrades().length, 0);
  const tail =
    total_upgrades > 0
      ? `同期共完成 ${total_upgrades} 次能力升级 —— 都是在前置达标后才升的。`
      : "但代价在下面：没有任何一个孩子真的完成了升级。";
  return new Finding({
    question: "Q1",
    title: "过早升级（焦点在未达标时被推向更靠后的能力）",
    detected: false,
    severity: "ok",
    lines: [
      `${runs.length} 个孩子 30 天里共出现 ${total_forward} 次「向前推进」，没有一次发生在证据不足时（0 次过早升级）。`,
      tail,
    ],
  });
}

export function checkUpgradeBlockers(
  runs: ChildRun[],
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): Finding {
  /** Q1 的补充：如果没人升级，卡在哪一条证据上？（给数字，不给感觉） */
  const lines: string[] = [];
  for (const run of runs) {
    const focus = run.final_focus(graph, cfg);
    if (focus === null) {
      lines.push(`${run.name}（${run.key}）：已经把所有能力都拿下了`);
      continue;
    }
    const decision = upgradeDecision(run.final_state!, focus, graph, cfg);
    const status = decision.action === "upgrade" ? "✅ 可推进" : "⏸ 暂不推进";
    const reasons = decision.reasons.length > 0 ? decision.reasons.join("；") : "无";
    lines.push(`${run.name}（${run.key}）：最终焦点 ${focus} → ${status}｜${reasons}`);
  }
  return new Finding({
    question: "Q1b",
    title: "还没升级的孩子卡在哪一条证据上（upgrade_decision 原话）",
    detected: false,
    severity: "ok",
    lines,
  });
}

export function checkUnupgradableCompetencies(
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): Finding {
  /** 静态检查：有些能力**结构上**永远无法升级。
   *
   * upgrade_requires.require_new_pattern_success 要求"至少 2 个不同 pattern 成功过"，
   * 但能力图里有能力只挂了 1 个 pattern —— 那个能力的孩子永远凑不齐这一条。
   * 这是模拟跑出来的最严重的结构性问题：一个能力卡死，它下游的所有能力一起陪葬。
   */
  const rule = cfg.newPatternSuccessRule();
  const need = Math.trunc(Number(rule["min_patterns"] ?? 2));
  const blocked: Array<[string, string[]]> = [];
  for (const code of graph.topologicalOrder()) {
    const patterns = graph.patternsFor(code);
    if (patterns.length < need) {
      blocked.push([code, patterns.map((p) => p.code)]);
    }
  }
  const lines: string[] = [];
  for (const [code, patterns] of blocked) {
    const closure = graph
      .topologicalOrder()
      .filter((other) => graph.prerequisites(other, true).includes(code));
    lines.push(
      `${code}：只挂了 ${patterns.length} 个 pattern（${patterns.length > 0 ? patterns.join("、") : "无"}），而升级需要 ${need} 个 → 该能力永远无法升级`,
    );
    if (closure.length > 0) {
      lines.push(`    受牵连的下游能力 ${closure.length} 个（含传递前置）：${closure.join("、")}`);
    }
  }
  return new Finding({
    question: "Q7",
    title: "结构性缺陷：只有 1 个 pattern 的能力永远无法升级",
    detected: blocked.length > 0,
    severity: blocked.length > 0 ? "alert" : "ok",
    lines:
      lines.length > 0
        ? lines
        : [`所有能力都挂了 ≥ ${need} 个 pattern，不存在结构性卡死。`],
  });
}

export function signalDrift(
  run: ChildRun,
  focus_code: string | null,
  cfg: AlgorithmConfig,
): Array<Record<string, unknown>> {
  /** 最终信号（EWMA）与 30 天样本均值的偏差。
   *
   * EWMA alpha 只有 0.25，有效记忆约十几次作答 —— 长期形成的习惯
   * 会被"最近几次恰好表现好"抹平。这个偏差就是证据。
   */
  const totals = new Map<string, number[]>();
  for (const attempt of run.all_attempts()) {
    // samplesForAttempt 返回的是 Map —— Object.entries(Map) 恒为空数组，
    // 这是对拍（simulate_parity）抓出来的 bug：报告的信号漂移段会永远
    // 显示"没有任何信号出现 ≥ 0.05 的偏差"。
    for (const [name, sample] of samplesForAttempt(attempt, cfg)) {
      if (sample === null || name === "confidence") {
        continue;
      }
      const list = totals.get(name);
      if (list === undefined) {
        totals.set(name, [sample]);
      } else {
        list.push(sample);
      }
    }
  }

  const out: Array<Record<string, unknown>> = [];
  if (focus_code === null || run.final_state === null) {
    return out;
  }
  const signals = run.final_state.competencies.get(focus_code);
  if (signals === undefined) {
    return out;
  }
  for (const [name, values] of [...totals.entries()].sort()) {
    const final = signals.value(name as SignalName);
    if (final === null || values.length === 0) {
      continue;
    }
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    out.push({
      signal: name,
      final,
      mean,
      drift: final - mean,
      samples: values.length,
    });
  }
  return out;
}

export function renderSignalDrift(
  runs: ChildRun[],
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): string[] {
  /** 只打印偏差 ≥ 0.05 的项 —— 偏差小的是噪声，偏差大的是"信号在骗人"。 */
  const lines = [
    `口径：最终值 = 状态里的 EWMA（alpha=${cfg.ewma_alpha}）；样本均值 = 30 天每次作答的采样均值`,
    padRow([
      { text: "画像", width: 20, align: "left" },
      { text: "信号", width: 12, align: "left" },
      { text: "最终值", width: 8, align: "right" },
      { text: "样本均值", width: 10, align: "right" },
      { text: "偏差", width: 8, align: "right" },
      { text: "采样数", width: 8, align: "right" },
    ]),
    THIN,
  ];
  let flagged = 0;
  for (const run of runs) {
    const focus = run.final_focus(graph, cfg);
    const rows = signalDrift(run, focus, cfg);
    for (const row of rows) {
      if (Math.abs(row["drift"] as number) < 0.05) {
        continue;
      }
      flagged += 1;
      lines.push(
        padRow([
          { text: `${run.name}（${run.key}）`, width: 20, align: "left" },
          { text: row["signal"] as string, width: 12, align: "left" },
          { text: pyFormat(row["final"] as number, 3), width: 8, align: "right" },
          { text: pyFormat(row["mean"] as number, 3), width: 10, align: "right" },
          { text: pyFormatSigned(row["drift"] as number, 3), width: 8, align: "right" },
          { text: String(row["samples"]), width: 8, align: "right" },
        ]),
      );
    }
  }
  if (flagged === 0) {
    lines.push("（没有任何信号出现 ≥ 0.05 的偏差）");
  }
  return lines;
}

/** Python "{:<w}" / "{:>w}" —— 宽度按字符数（中文算 1），与 str.format 同构 */
function padRow(cells: Array<{ text: string; width: number; align: "left" | "right" }>): string {
  return cells
    .map(({ text, width, align }) => {
      if (text.length >= width) return text;
      const pad = " ".repeat(width - text.length);
      return align === "left" ? text + pad : pad + text;
    })
    .join(" ");
}

export function checkStuckOnEasy(
  runs: ChildRun[],
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
): Finding {
  /** Q2：30 天里超过 10 天只做难度 1 的题？ */
  const lines: string[] = [];
  for (const run of runs) {
    const easy_days: number[] = [];
    for (const record of run.days) {
      if (record.attempts.length === 0) {
        continue;
      }
      const difficulties = record.attempts
        .filter((a) => bundle.items.has(a.item_id))
        .map((a) => bundle.items.get(a.item_id)!.difficulty);
      if (difficulties.length > 0 && Math.max(...difficulties) <= 1) {
        easy_days.push(record.day);
      }
    }
    if (easy_days.length > STUCK_EASY_DAYS) {
      lines.push(
        `${run.name}（${run.key}）：${run.days.length} 天里有 ${easy_days.length} 天全部是难度 1 的题（首日 ${easy_days[0]!}，末日 ${easy_days[easy_days.length - 1]!}）`,
      );
      const focuses = [...new Set(run.days.map((r) => r.focus).filter((f): f is string => f !== null))].sort();
      lines.push(`    卡住时的焦点能力：${focuses.length > 0 ? focuses.join("、") : "（无）"}`);
    }
  }
  return new Finding({
    question: "Q2",
    title: `长期卡在简单题（> ${STUCK_EASY_DAYS} 天只做难度 1）`,
    detected: lines.length > 0,
    severity: lines.length > 0 ? "warn" : "ok",
    lines:
      lines.length > 0
        ? lines
        : [`没有孩子在 30 天里超过 ${STUCK_EASY_DAYS} 天只做难度 1 的题。`],
  });
}

export function checkFrequentFallback(runs: ChildRun[], cfg: AlgorithmConfig): Finding {
  /** Q3：30 天里回退超过 10 次？ */
  const lines: string[] = [];
  let over = false;
  for (const run of runs) {
    const episodes = run.fallback_episodes();
    const raw_days = run.events.filter((e) => e.type === "fallback");
    if (episodes.length > FALLBACK_ALERT) {
      over = true;
      lines.push(
        `${run.name}（${run.key}）：回退事件 ${episodes.length} 起（原始命中 ${raw_days.length} 天），超过 ${FALLBACK_ALERT} 次`,
      );
      for (const episode of episodes.slice(0, 5)) {
        const reasons = episode["reasons"] as string[];
        lines.push(
          `    第 ${episode["first_day"]}~${episode["last_day"]} 天 → 回退到 ${episode["target"]}（${reasons.length > 0 ? reasons[0]! : ""}）`,
        );
      }
    } else if (episodes.length > 0) {
      lines.push(
        `${run.name}（${run.key}）：回退 ${episodes.length} 起（原始命中 ${raw_days.length} 天），未超阈值`,
      );
    }
  }
  if (lines.length === 0) {
    return new Finding({
      question: "Q3",
      title: `回退频繁（> ${FALLBACK_ALERT} 次）`,
      detected: false,
      severity: "ok",
      lines: ["没有任何孩子触发回退。"],
    });
  }
  return new Finding({
    question: "Q3",
    title: `回退频繁（> ${FALLBACK_ALERT} 次）`,
    detected: over,
    severity: over ? "warn" : "ok",
    lines,
  });
}

export function checkReviewOverload(runs: ChildRun[], cfg: AlgorithmConfig): Finding {
  /** Q4：复习洪峰控制有没有守住？
   *
   * 两个层次分开看，不能混为一谈：
   *   - 待复习积压（due_count > 上限）：说明当天到期的结构比能复习的多，
   *     按设计**顺延到次日**（release_pressure 只截断不丢项）—— 这是预警，不是故障
   *   - 计划排入（planned_reviews > 上限）：说明上限没守住，是机制故障（应当恒为 0）
   */
  const max_per_day = Math.trunc(Number(cfg.get(["review", "max_per_day"])));
  const lines: string[] = [];
  let overloaded = false;
  let breached = 0;
  for (const run of runs) {
    const over = run.days.filter((r) => r.due_count > max_per_day);
    const planned_breach = run.days.filter((r) => r.planned_reviews > max_per_day);
    breached += planned_breach.length;
    const peak = Math.max(0, ...run.days.map((r) => r.due_count));
    const peak_planned = Math.max(0, ...run.days.map((r) => r.planned_reviews));
    if (over.length > 0) {
      overloaded = true;
      lines.push(
        `${run.name}（${run.key}）：${over.length} 天待复习超过上限（上限 ${max_per_day}），峰值待复习 ${peak} 项，` +
          `首日超限第 ${over[0]!.day} 天，末日待复习 ${run.days.length > 0 ? run.days[run.days.length - 1]!.due_count : 0} 项`,
      );
      lines.push(
        `    当日实际排入复习最多 ${peak_planned} 项（超出部分按设计顺延到次日，不丢项）`,
      );
    } else {
      lines.push(`${run.name}（${run.key}）：无超限，峰值待复习 ${peak} 项`);
    }
  }
  lines.push(`所有孩子的当日排入复习数都不超过上限（机制失守 ${breached} 次）`);
  return new Finding({
    question: "Q4",
    title: `复习过载（待复习积压 > review.max_per_day=${max_per_day}）`,
    detected: overloaded || breached > 0,
    severity: breached > 0 ? "alert" : overloaded ? "warn" : "ok",
    lines,
  });
}

function difficultyJumps(
  run: ChildRun,
  bundle: ContentBundle,
): Array<{ from: Attempt; to: Attempt; delta: number; same_competency: boolean }> {
  const jumps: Array<{ from: Attempt; to: Attempt; delta: number; same_competency: boolean }> = [];
  let previous: Attempt | null = null;
  for (const attempt of run.all_attempts()) {
    if (previous !== null) {
      const prev_item = bundle.items.get(previous.item_id);
      const item = bundle.items.get(attempt.item_id);
      if (prev_item !== undefined && item !== undefined) {
        const delta = item.difficulty - prev_item.difficulty;
        if (delta >= JUMP_ALERT) {
          jumps.push({
            from: previous,
            to: attempt,
            delta,
            same_competency: previous.competency_id === attempt.competency_id,
          });
        }
      }
    }
    previous = attempt;
  }
  return jumps;
}

function dayOf(run: ChildRun, attempt: Attempt): number {
  for (const record of run.days) {
    for (const a of record.attempts) {
      if (a.seq === attempt.seq) {
        return record.day;
      }
    }
  }
  return -1;
}

export function checkDifficultyJump(
  runs: ChildRun[],
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
): Finding {
  /** Q5：出现"难度 1 直接跳到难度 4"这种没有过渡的情况了吗？ */
  const lines: string[] = [];
  let detected = false;
  for (const run of runs) {
    const jumps = difficultyJumps(run, bundle);
    if (jumps.length === 0) {
      continue;
    }
    detected = true;
    const same = jumps.filter((j) => j.same_competency);
    const cross = jumps.filter((j) => !j.same_competency);
    lines.push(
      `${run.name}（${run.key}）：难度跳变 ${jumps.length} 次（同能力内 ${same.length} 次，换能力 ${cross.length} 次），最大跨度 +${Math.max(...jumps.map((j) => j.delta))}`,
    );
    for (const jump of jumps.slice(0, 3)) {
      lines.push(
        `    第 ${dayOf(run, jump.to)} 天（attempt #${jump.to.seq}）：${jump.from.item_id} 难度 ${bundle.items.get(jump.from.item_id)!.difficulty} → ${jump.to.item_id} 难度 ${bundle.items.get(jump.to.item_id)!.difficulty}（${jump.same_competency ? "同能力内" : "跨能力"}）`,
      );
    }
  }
  return new Finding({
    question: "Q5",
    title: `难度断层（相邻两次难度上升 ≥ ${JUMP_ALERT}）`,
    detected,
    severity: detected ? "warn" : "ok",
    lines: lines.length > 0 ? lines : ["没有出现难度跨级上升。"],
  });
}

export function checkRepetition(
  runs: ChildRun[],
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
): Finding {
  /** 附加体检：同一道题被反复出的次数（平台型画像最容易撞上）。 */
  const lines: string[] = [];
  let detected = false;
  for (const run of runs) {
    const counter = new Map<string, number>();
    for (const a of run.all_attempts()) {
      counter.set(a.item_id, (counter.get(a.item_id) ?? 0) + 1);
    }
    if (counter.size === 0) {
      continue;
    }
    // Counter.most_common(1)：并列时 Python 按插入序取第一个，Map 同构
    let item_id = "";
    let count = 0;
    for (const [code, n] of counter) {
      if (n > count) {
        item_id = code;
        count = n;
      }
    }
    if (count > REPEAT_ALERT) {
      detected = true;
      lines.push(
        `${run.name}（${run.key}）：${item_id} 被做了 ${count} 次（> ${REPEAT_ALERT}），共 ${counter.size} 道不同的题`,
      );
    } else {
      lines.push(
        `${run.name}（${run.key}）：最高重复 ${count} 次（${item_id}），累计 ${counter.size} 道不同的题`,
      );
    }
  }
  return new Finding({
    question: "Q6",
    title: `同一道题重复次数（> ${REPEAT_ALERT}）`,
    detected,
    severity: detected ? "warn" : "ok",
    lines,
  });
}

export function runHealthChecks(
  runs: ChildRun[],
  bundle: ContentBundle,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): Finding[] {
  return [
    checkEarlyUpgrade(runs, graph, cfg),
    checkUpgradeBlockers(runs, graph, cfg),
    checkUnupgradableCompetencies(graph, cfg),
    checkStuckOnEasy(runs, bundle, cfg),
    checkFrequentFallback(runs, cfg),
    checkReviewOverload(runs, cfg),
    checkDifficultyJump(runs, bundle, cfg),
    checkRepetition(runs, bundle, cfg),
  ];
}

// ══════════════════════════════════════════════════════════
//  七部分：报告
// ══════════════════════════════════════════════════════════

function fmt(value: number | null, digits = 2): string {
  return value === null ? "—" : pyFormat(value, digits);
}

function profileTable(
  runs: ChildRun[],
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): string[] {
  const lines = [
    padRow([
      { text: "画像", width: 20, align: "left" },
      { text: "作答", width: 6, align: "right" },
      { text: "升级", width: 6, align: "right" },
      { text: "复习题", width: 8, align: "right" },
      { text: "复习正确率", width: 10, align: "right" },
      { text: "最终焦点", width: 16, align: "right" },
      { text: "最终等级", width: 0, align: "left" },
    ]),
    THIN,
  ];
  for (const run of runs) {
    const reviews = run.review_attempts();
    const review_correct =
      reviews.length > 0
        ? reviews.filter((a) => a.correct).length / reviews.length
        : null;
    const focus = run.final_focus(graph, cfg);
    const signals =
      run.final_state && focus
        ? run.final_state.competencies.get(focus)
        : undefined;
    const level = signals ? levelLabel(deriveLevel(signals, cfg), cfg) : "—";
    lines.push(
      padRow([
        { text: `${run.name}（${run.key}）`, width: 20, align: "left" },
        { text: String(run.all_attempts().length), width: 6, align: "right" },
        { text: String(run.upgrades().length), width: 6, align: "right" },
        { text: String(reviews.length), width: 8, align: "right" },
        { text: review_correct !== null ? fmt(review_correct) : "—", width: 10, align: "right" },
        { text: focus ?? "—", width: 16, align: "right" },
        { text: level, width: 0, align: "left" },
      ]),
    );
  }
  return lines;
}

function reviewSection(runs: ChildRun[], cfg: AlgorithmConfig): string[] {
  const max_per_day = Math.trunc(Number(cfg.get(["review", "max_per_day"])));
  const lines = [
    `每日上限 review.max_per_day=${max_per_day}，间隔档位 ${pyListInts(cfg.review_intervals_days)}`,
    "「到期项次」= 每天待复习结构数之和；「排入」= 按上限截断后进计划的复习项次；" +
      "「落空」= 因「该结构在当前脚手架下没有题」而没能落进计划（宁可跳过也不换结构）；「作答」= 实际落到的复习题",
    padRow([
      { text: "画像", width: 20, align: "left" },
      { text: "到期项次", width: 8, align: "right" },
      { text: "排入", width: 6, align: "right" },
      { text: "落空", width: 6, align: "right" },
      { text: "作答", width: 6, align: "right" },
      { text: "复习正确率", width: 10, align: "right" },
      { text: "间隔档位分布", width: 0, align: "left" },
    ]),
    THIN,
  ];
  for (const run of runs) {
    const due = run.days.reduce((s, r) => s + r.due_count, 0);
    const planned = run.days.reduce((s, r) => s + r.planned_reviews, 0);
    const missed = run.days.reduce(
      (s, r) => s + r.notes.filter((note) => note.includes("复习无法落题")).length,
      0,
    );
    const reviews = run.review_attempts();
    const correct = reviews.filter((a) => a.correct).length;
    const histogram = new Map<number, number>();
    for (const entry of run.schedule.values()) {
      const index = Math.trunc(Number(entry.interval_index ?? 0));
      histogram.set(index, (histogram.get(index) ?? 0) + 1);
    }
    const dist =
      [...histogram.keys()]
        .sort((a, b) => a - b)
        .map((i) => `第${i + 1}档×${histogram.get(i)}`)
        .join(" ") || "（空调度）";
    lines.push(
      padRow([
        { text: `${run.name}（${run.key}）`, width: 20, align: "left" },
        { text: String(due), width: 8, align: "right" },
        { text: String(planned), width: 6, align: "right" },
        { text: String(missed), width: 6, align: "right" },
        { text: String(reviews.length), width: 6, align: "right" },
        { text: reviews.length > 0 ? fmt(correct / reviews.length) : "—", width: 10, align: "right" },
        { text: dist, width: 0, align: "left" },
      ]),
    );
  }
  return lines;
}

function pyListInts(values: readonly number[]): string {
  return `[${values.join(", ")}]`;
}

function probeSection(runs: ChildRun[], cfg: AlgorithmConfig): string[] {
  const lines = [
    padRow([
      { text: "画像", width: 20, align: "left" },
      { text: "计划天数", width: 10, align: "right" },
      { text: "落地次数", width: 10, align: "right" },
      { text: "落地率", width: 10, align: "right" },
      { text: "说明", width: 0, align: "left" },
    ]),
    THIN,
  ];
  for (const run of runs) {
    const planned_days = run.days.filter((r) => r.probe_planned > 0).length;
    const landed = run.probe_attempts().length;
    const rate = planned_days > 0 ? pyFormatPercent(landed / planned_days) : "—";
    let note: string;
    if (planned_days > 0 && landed === 0) {
      note = "迁移测试一次都没落到题上";
    } else if (planned_days > 0 && landed > 0) {
      const first = run.days.find((r) => r.probe_attempts > 0)!.day;
      note = `首次迁移测试在第 ${first} 天`;
    } else {
      note = "从未安排迁移测试";
    }
    lines.push(
      padRow([
        { text: `${run.name}（${run.key}）`, width: 20, align: "left" },
        { text: String(planned_days), width: 10, align: "right" },
        { text: String(landed), width: 10, align: "right" },
        { text: rate, width: 10, align: "right" },
        { text: note, width: 0, align: "left" },
      ]),
    );
  }
  return lines;
}

export function renderReport(
  runs: ChildRun[],
  findings: Finding[],
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  graph: CompetencyGraph,
  added_slots: string[],
  cold_start: ChildRun | null,
): string {
  const lines: string[] = [];
  lines.push(LINE);
  lines.push(`数学世界 · P3 模拟儿童长周期体检报告（${runs.length} 个画像 × ${SIM_DAYS} 天）`);
  lines.push(LINE);
  lines.push(
    `算法配置 v${cfg.version} ｜ 内容：${bundle.items.size} item / ${bundle.competencies.size} competency / ${bundle.slots.size} slot ｜ 固定种子，可复现`,
  );
  lines.push(
    "每天执行引擎计划产出的全部题目（warmup/core/story/thinking 段），" +
      "每步走 apply_attempt + update_schedule",
  );
  lines.push("");

  lines.push("【一】孩子档案");
  lines.push(...profileTable(runs, graph, cfg));
  lines.push("");

  lines.push("【二】五个体检问题（DoD）");
  for (const finding of findings) {
    const mark = { alert: "❌", warn: "⚠️", ok: "✅" }[finding.severity]!;
    lines.push("");
    lines.push(`${mark} ${finding.question}：${finding.title}`);
    for (const line of finding.lines) {
      lines.push("    " + line);
    }
  }
  lines.push("");

  lines.push("【三】信号漂移（EWMA 只记得最近十几次作答）");
  lines.push(...renderSignalDrift(runs, graph, cfg));
  lines.push("");

  lines.push("【四】迁移测试落地情况");
  lines.push(...probeSection(runs, cfg));
  lines.push("");
  lines.push("【五】复习调度实测");
  lines.push(...reviewSection(runs, cfg));
  lines.push("");

  lines.push("【六】模拟设定说明");
  lines.push(
    `    模拟补槽 ${added_slots.length} 个（仅存在于模拟进程，不写回 content/**）：${added_slots.length > 0 ? added_slots.join("、") : "无"}`,
  );
  lines.push(
    "    每个画像的入学起点（focus / 已掌握前置 / 未掌握能力）都写在 tools/simulate.py 的 entry 字段里",
  );
  if (cold_start !== null) {
    lines.push("");
    lines.push("【七】冷启动对照（真正的新孩子，没有任何入学起点）");
    const cold_focus = cold_start.final_focus(graph, cfg);
    lines.push(
      `    最终焦点：${cold_focus}｜30 天作答 ${cold_start.attempts.length} 次｜第 1 天计划产出题目数：${cold_start.days.length > 0 ? cold_start.days[0]!.attempts.length : 0}`,
    );
    if (cold_start.days.length > 0 && cold_start.days[0]!.notes.length > 0) {
      lines.push(`    第 1 天计划备注：${cold_start.days[0]!.notes[0]!}`);
    }
    const done_items = [...new Set(cold_start.attempts.map((a) => a.item_id))].sort();
    const comps = [...new Set(cold_start.attempts.map((a) => a.competency_id))].sort();
    lines.push(
      `    30 天共做过 ${done_items.length} 道不同的题（全部属于 ${comps.length > 0 ? comps.join("、") : "（无）"}）`,
    );
  }
  lines.push(LINE);
  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════
//  八部分：入口
// ══════════════════════════════════════════════════════════

export function main(argv: readonly string[] = []): number {
  let days = SIM_DAYS;
  const daysIndex = argv.indexOf("--days");
  if (daysIndex >= 0) {
    days = Number.parseInt(argv[daysIndex + 1]!, 10);
  }

  const bundle = loadBundle();
  const cfg = loadConfig(0);
  const graph = new CompetencyGraph(bundle);

  const problems = validateContent(bundle, null);
  const graph_problems = graph.validate();

  const [sim_bundle, added_slots] = withPracticeSlots(bundle, cfg);

  const runs = runSimulation(makeProfiles(), sim_bundle, cfg, graph, days);
  const cold = runColdStart(sim_bundle, cfg, graph, days);
  const findings = runHealthChecks([...runs, cold], sim_bundle, graph, cfg);

  console.log(renderReport(runs, findings, sim_bundle, cfg, graph, added_slots, cold));
  console.log("");
  console.log(
    `内容校验：${problems.length} 条问题 ｜ 能力图校验：${graph_problems.length} 条问题`,
  );
  for (const problem of problems.slice(0, 5)) {
    console.log("  ·", problem);
  }
  return 0;
}

// Python: if __name__ == "__main__": raise SystemExit(main())
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
