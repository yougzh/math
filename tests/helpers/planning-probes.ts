/**
 * selector / intent / planner 对拍的构造助手。
 *
 * 与 Python 侧 `scripts/oracle/dump_fixtures.py` 的
 * `_selector_bundle` / `_sel_state_from` / `_intent_state_from` /
 * `_planner_bundle` 逐字段同源 —— 两侧从同一份声明式描述构造同构输入，
 * 差异只允许出现在被测代码里。
 */
import type { ChallengeSlot, Competency, ContentBundle, Item, Pattern, Story, StoryBeat } from "@/src/content/types";
import { loadBundle } from "@/src/content/loader";
import { MisconceptionState } from "@/src/engine/types";
import type { Attempt, ChildLearningState } from "@/src/engine/types";
import { Attempt as AttemptClass, ChildLearningState as ChildLearningStateClass, Telemetry } from "@/src/engine/types";
import { ReviewItem } from "@/src/engine/scheduler";
import { fullSignalsDesc, signalsFromDesc } from "./engine-probes";
import type { EngineSignalsDesc } from "./engine-probes";

// ── selector：全定制小 bundle ───────────────────────────────

export interface SelectorCompetencyDesc {
  code: string;
  name: string;
  stage: number;
}

export interface SelectorPatternDesc {
  code: string;
  name: string;
  cognitive_type: string;
  primary_competency: string;
}

export interface SelectorItemDesc {
  code: string;
  competency: string;
  pattern: string;
  scaffold: string;
  difficulty: number;
}

export interface SelectorSlotDesc {
  code: string;
  competency: string;
  min: number;
  max: number;
  purpose?: string;
  pattern?: string | null;
  scaffold?: string;
  policy?: Record<string, unknown>;
}

export interface SelectorFixtureShape {
  config_version: number;
  competencies: SelectorCompetencyDesc[];
  patterns: SelectorPatternDesc[];
  items: SelectorItemDesc[];
  slots: SelectorSlotDesc[];
  cases: SelectorCaseShape[];
  probes: Array<{ id: string; note: string; result: unknown }>;
}

export interface SelectorCaseShape {
  id: string;
  note: string;
  slot: string;
  initial: SelectorStateDesc;
  count: number;
  exclude_codes: string[];
  picked: string[] | null;
}

/** 与 Python `_sel_state_from` 的 SELECTOR_ATTEMPT_DEFAULTS 同源 */
const SELECTOR_ATTEMPT_DEFAULTS = {
  competency: "c_a",
  pattern: "p1",
  correct: true,
  hints: 0,
  response_ms: 6000,
  active_ms: 1000,
  idle_ms: 0,
  scaffold: "direct",
  interaction: "number_pad",
  is_assessment: false,
  is_transfer_probe: false,
};

export interface SelectorAttemptRow {
  item: string;
  seq?: number;
  competency?: string;
  pattern?: string;
  correct?: boolean;
  hints?: number;
}

export interface SelectorStateDesc {
  competencies?: Record<string, Partial<EngineSignalsDesc>>;
  patterns?: Record<string, Partial<EngineSignalsDesc>>;
  recent_attempts?: SelectorAttemptRow[];
  last_touched_seq?: Record<string, number>;
}

export function selectorStateFromDesc(desc: SelectorStateDesc): ChildLearningState {
  const state = new ChildLearningStateClass({ child_id: "child_sel" });
  for (const [code, signals] of Object.entries(desc.competencies ?? {})) {
    state.competencies.set(code, signalsFromDesc(fullSignalsDesc(signals)));
  }
  for (const [key, signals] of Object.entries(desc.patterns ?? {})) {
    state.patterns.set(key, signalsFromDesc(fullSignalsDesc(signals)));
  }
  for (const row of desc.recent_attempts ?? []) {
    const p = { ...SELECTOR_ATTEMPT_DEFAULTS, ...row } as typeof SELECTOR_ATTEMPT_DEFAULTS & {
      item: string;
      seq?: number;
    };
    state.recent_attempts.push(
      new AttemptClass({
        attempt_id: `att_${p.seq ?? 0}`,
        child_id: "child_sel",
        item_id: p.item,
        competency_id: p.competency,
        pattern_id: p.pattern,
        correct: p.correct,
        telemetry: new Telemetry({
          response_time_ms: p.response_ms,
          active_time_ms: p.active_ms,
          idle_time_ms: p.idle_ms,
        }),
        seq: p.seq ?? 0,
        hints_used: p.hints,
        scaffold_level: p.scaffold,
        interaction_type: p.interaction,
        is_assessment: p.is_assessment,
        is_transfer_probe: p.is_transfer_probe,
      }),
    );
  }
  for (const [code, seq] of Object.entries(desc.last_touched_seq ?? {})) {
    state.last_touched_seq.set(code, seq);
  }
  return state;
}

/** 与 Python `_selector_bundle` 同构：声明式描述 → 定制小 bundle */
export function buildSelectorBundle(shape: SelectorFixtureShape): ContentBundle {
  const competencies = new Map(
    shape.competencies.map(
      (row): [string, Competency] => [
        row.code,
        { code: row.code, name: row.name, prerequisites: [], stage: row.stage, terms: [], description: "" },
      ],
    ),
  );
  const patterns = new Map(
    shape.patterns.map(
      (row): [string, Pattern] => [
        row.code,
        {
          code: row.code,
          name: row.name,
          cognitive_type: row.cognitive_type as Pattern["cognitive_type"],
          primary_competency: row.primary_competency,
          applicable_competencies: [],
          description: "",
        },
      ],
    ),
  );
  const items = new Map(
    shape.items.map(
      (row): [string, Item] => [
        row.code,
        {
          code: row.code,
          competency_id: row.competency,
          pattern_id: row.pattern,
          difficulty: row.difficulty,
          scaffold_level: row.scaffold as Item["scaffold_level"],
          interaction_type: "number_pad",
          estimated_seconds: 6,
          problem: { prompt: `${row.code} 占位题面` },
          answer: null,
          steps: [],
          hint_chain: [],
          error_rules: [],
          steps_style: "guide",
        },
      ],
    ),
  );
  const slots = new Map(
    shape.slots.map(
      (row): [string, ChallengeSlot] => [
        row.code,
        {
          code: row.code,
          competency_id: row.competency,
          difficulty_min: row.min,
          difficulty_max: row.max,
          purpose: (row.purpose ?? "practice") as ChallengeSlot["purpose"],
          pattern_id: row.pattern === undefined ? null : row.pattern,
          scaffold_level: (row.scaffold ?? "auto") as ChallengeSlot["scaffold_level"],
          estimated_seconds: 20,
          story_beat_id: null,
          selection_policy: { ...(row.policy ?? {}) },
          review_policy: {},
        },
      ],
    ),
  );
  return {
    competencies,
    patterns,
    items,
    misconceptions: new Map(),
    slots,
    stories: new Map(),
    load_problems: [],
  };
}

// ── intent / planner：真实 bundle + 声明式 state ────────────

export interface IntentAttemptRow {
  item?: string;
  competency?: string;
  pattern?: string;
  seq?: number;
  correct?: boolean;
  hints?: number;
}

export interface IntentStateDesc {
  competencies?: Record<string, Partial<EngineSignalsDesc>>;
  patterns?: Record<string, Partial<EngineSignalsDesc>>;
  misconceptions?: Array<{
    code: string;
    hit_count?: number;
    last_seq?: number | null;
    resolved?: boolean;
    remediation_competency?: string | null;
  }>;
  recent_attempts?: IntentAttemptRow[];
  attempts_seen?: number;
  assessment_attempts?: number;
  first_scaffold?: Record<string, string>;
  last_touched_seq?: Record<string, number>;
}

/** 与 Python `_intent_state_from` 同源（缺省：ghost_item / make_ten / direct_compute） */
export function intentStateFromDesc(desc: IntentStateDesc): ChildLearningState {
  const state = new ChildLearningStateClass({ child_id: "child_intent" });
  for (const [code, signals] of Object.entries(desc.competencies ?? {})) {
    state.competencies.set(code, signalsFromDesc(fullSignalsDesc(signals)));
  }
  for (const [key, signals] of Object.entries(desc.patterns ?? {})) {
    state.patterns.set(key, signalsFromDesc(fullSignalsDesc(signals)));
  }
  for (const misc of desc.misconceptions ?? []) {
    state.misconceptions.set(
      misc.code,
      new MisconceptionState({
        code: misc.code,
        hit_count: misc.hit_count ?? 0,
        last_seq: misc.last_seq === undefined ? null : misc.last_seq,
        resolved: misc.resolved ?? false,
        remediation_competency:
          misc.remediation_competency === undefined ? null : misc.remediation_competency,
      }),
    );
  }
  for (const row of desc.recent_attempts ?? []) {
    state.recent_attempts.push(
      new AttemptClass({
        attempt_id: `att_${row.seq ?? 0}`,
        child_id: "child_intent",
        item_id: row.item ?? "ghost_item",
        competency_id: row.competency ?? "make_ten",
        pattern_id: row.pattern ?? "direct_compute",
        correct: row.correct ?? true,
        telemetry: new Telemetry({ response_time_ms: 6000, active_time_ms: 1000 }),
        seq: row.seq ?? 0,
        hints_used: row.hints ?? 0,
      }),
    );
  }
  state.attempts_seen = desc.attempts_seen ?? 0;
  state.assessment_attempts = desc.assessment_attempts ?? 0;
  for (const [code, scaffold] of Object.entries(desc.first_scaffold ?? {})) {
    state.first_scaffold.set(code, scaffold);
  }
  for (const [code, seq] of Object.entries(desc.last_touched_seq ?? {})) {
    state.last_touched_seq.set(code, seq);
  }
  return state;
}

// ── planner：真实 bundle + fx 注入 + case 级变异 ────────────

export interface PlannerItemDesc {
  code: string;
  competency: string;
  pattern: string;
  scaffold: string;
  difficulty: number;
}

export interface PlannerSlotDesc {
  code: string;
  competency: string;
  min: number;
  max: number;
  purpose: string;
  pattern?: string | null;
}

export interface PlannerStoryDesc {
  code: string;
  title: string;
  universe: string;
  summary: string;
  order_index: number;
  duration_min: number;
  target_competencies: string[];
  beats: Array<{
    code: string;
    sequence: number;
    type: string;
    slot?: string;
    narration?: string;
    character?: string;
  }>;
}

export interface PlannerCaseDesc {
  id: string;
  note: string;
  initial: IntentStateDesc;
  budget_minutes?: number | null;
  due_reviews?: string[];
  hide_slots?: string[];
  drop_stories?: boolean | string[];
}

/** 与 Python `_planner_bundle` 同构：每 case 重建，变异互不污染 */
export function buildPlannerBundle(
  items: PlannerItemDesc[],
  slots: PlannerSlotDesc[],
  storyDesc: PlannerStoryDesc,
  spec: PlannerCaseDesc,
): ContentBundle {
  const bundle = loadBundle();
  for (const row of items) {
    bundle.items.set(row.code, {
      code: row.code,
      competency_id: row.competency,
      pattern_id: row.pattern,
      difficulty: row.difficulty,
      scaffold_level: row.scaffold as Item["scaffold_level"],
      interaction_type: "number_pad",
      estimated_seconds: 6,
      problem: { prompt: `${row.code} 占位题面` },
      answer: null,
      steps: [],
      hint_chain: [],
      error_rules: [],
      steps_style: "guide",
    });
  }
  for (const row of slots) {
    bundle.slots.set(row.code, {
      code: row.code,
      competency_id: row.competency,
      difficulty_min: row.min,
      difficulty_max: row.max,
      purpose: row.purpose as ChallengeSlot["purpose"],
      pattern_id: row.pattern === undefined ? null : row.pattern,
      scaffold_level: "auto",
      estimated_seconds: 20,
      story_beat_id: null,
      selection_policy: {},
      review_policy: {},
    });
  }
  const beats: StoryBeat[] = storyDesc.beats.map((row) => ({
    code: row.code,
    story_code: storyDesc.code,
    sequence: row.sequence,
    beat_type: row.type as StoryBeat["beat_type"],
    narration: row.narration ?? "",
    character: row.character ?? "",
    slot_code: row.slot === undefined ? null : row.slot,
  }));
  const story: Story = {
    code: storyDesc.code,
    title: storyDesc.title,
    universe: storyDesc.universe,
    summary: storyDesc.summary,
    order_index: storyDesc.order_index,
    duration_min: storyDesc.duration_min,
    target_competencies: [...storyDesc.target_competencies],
    beats,
  };
  bundle.stories.set(story.code, story);

  for (const code of spec.hide_slots ?? []) {
    bundle.slots.delete(code);
  }
  if (spec.drop_stories === true) {
    bundle.stories.clear();
  } else if (Array.isArray(spec.drop_stories)) {
    for (const code of spec.drop_stories) {
      bundle.stories.delete(code);
    }
  }
  return bundle;
}

export interface PlannerReviewDesc {
  key: string;
  competency: string;
  pattern: string;
  interval_index: number;
  overdue_days: number;
  due_day: number;
  last_correct_day: number;
  consecutive_correct: number;
}

/** 与 Python `dump_planner` 的 ReviewItem 构造同源 */
export function reviewItemFromDesc(row: PlannerReviewDesc): ReviewItem {
  return new ReviewItem({
    pattern_key: `${row.competency}::${row.pattern}`,
    competency_id: row.competency,
    pattern_id: row.pattern,
    due_day: row.due_day,
    interval_index: row.interval_index,
    last_correct_day: row.last_correct_day,
    consecutive_correct: row.consecutive_correct,
    overdue_days: row.overdue_days,
  });
}
