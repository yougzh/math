/**
 * Drizzle schema —— `db/migrations/0001_init.sql` 的 TypeScript 表达。
 *
 * 纪律：**这份 SQL 是部署事实**。schema.ts 必须与它逐表逐列一致，
 * `tests/contract/schema-parity.test.ts` 会双向比对，不一致即测试失败。
 *
 * 三个类型映射要点（照抄 SQL 语义，不要"改进"）：
 *   1. NUMERIC 用 `.$type<number>()` —— Python 侧是
 *      `Numeric(5, 4, asdecimal=False)`（见 backend/db/models.py:41），
 *      返回的是 float 而非 Decimal。要真做到这点，客户端必须把 NUMERIC 的
 *      type parser 换成 parseFloat（见 src/db/client.ts），否则 pg 默认返回 string。
 *   2. `gen_random_uuid()` 由 DB 默认值提供，不改成应用层生成。
 *   3. ADR-0002：proficiency_state / pattern_state **不得有 level 列**。
 *      等级永远是 derive_level(signals, algorithm_version) 的结果。
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** JSONB 列的载荷形状。精确类型随引擎移植（S2/S3）在 src/engine/types.ts 落定后再收紧。 */
type JsonObject = Record<string, unknown>;
/** item.problem_json：题面结构随 interaction_type 变化，暂用宽松类型 */
type ProblemSpec = JsonObject;
/** story_beat.visual_json */
type StoryVisual = JsonObject;
/** reward_log.reward_json / story_beat.reward_json */
type Reward = JsonObject;

// ───────────────────────────────────────────────────────────
// 类型别名：NUMERIC(5,4) / NUMERIC(4,3)
// ───────────────────────────────────────────────────────────

/** 4 位小数的百分比/评分（0~1）。读出来是 JS number（见文件头注释 1）。 */
const num_5_4 = (name: string) => numeric(name, { precision: 5, scale: 4 }).$type<number>();
/** 3 位小数（权重、ease）。 */
const num_4_3 = (name: string) => numeric(name, { precision: 4, scale: 3 }).$type<number>();

/** timestamptz：统一用 Date（UTC）读写，不落 naive 时间 */
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ═══════════════════════════════════════════════════════════
// 学习域：能力图谱与内容
// ═══════════════════════════════════════════════════════════

export const competency = pgTable("competency", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  stage: integer("stage").notNull().default(1),
  active: boolean("active").notNull().default(true),
});

export const competencyPrerequisite = pgTable(
  "competency_prerequisite",
  {
    competencyCode: text("competency_code")
      .notNull()
      .references(() => competency.code, { onDelete: "cascade" }),
    prerequisiteCode: text("prerequisite_code")
      .notNull()
      .references(() => competency.code, { onDelete: "cascade" }),
    weight: num_4_3("weight").notNull().default(1.0),
  },
  (t) => [
    primaryKey({ columns: [t.competencyCode, t.prerequisiteCode] }),
    check("competency_prerequisite_no_self_ref", sql`${t.competencyCode} <> ${t.prerequisiteCode}`),
  ],
);

export const problemPattern = pgTable(
  "problem_pattern",
  {
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    cognitiveType: text("cognitive_type").notNull(),
  },
  (t) => [
    check(
      "problem_pattern_cognitive_type_check",
      sql`${t.cognitiveType} IN ('compute', 'represent', 'strategy', 'apply', 'reverse')`,
    ),
  ],
);

/** pattern 可用于多个能力；decompose 用在 make_ten 和 td_add_nocarry 上不是同一个技能 */
export const patternCompetency = pgTable(
  "pattern_competency",
  {
    patternCode: text("pattern_code")
      .notNull()
      .references(() => problemPattern.code, { onDelete: "cascade" }),
    competencyCode: text("competency_code")
      .notNull()
      .references(() => competency.code, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.patternCode, t.competencyCode] })],
);

export const misconception = pgTable("misconception", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  severity: smallint("severity").notNull().default(1),
  remediationCompetency: text("remediation_competency").references(() => competency.code),
});

// ───────────────────────────────────────────────────────────
// 内容版本 / 算法配置（必须早于 item 声明：item 有指向 content_release 的 FK）
// ───────────────────────────────────────────────────────────

export const contentRelease = pgTable("content_release", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  version: text("version").notNull().unique(),
  checksum: text("checksum").notNull(),
  importedAt: timestamptz("imported_at").notNull().defaultNow(),
  statsJson: jsonb("stats_json").notNull().default({}),
});

/** 状态必须 pin 住自己是用哪个版本的算法算出来的（ADR-0002 可回放的前提） */
export const algorithmConfig = pgTable("algorithm_config", {
  version: integer("version").primaryKey(),
  payloadJson: jsonb("payload_json").notNull(),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const item = pgTable(
  "item",
  {
    code: text("code").primaryKey(),
    competencyCode: text("competency_code")
      .notNull()
      .references(() => competency.code),
    patternCode: text("pattern_code")
      .notNull()
      .references(() => problemPattern.code),
    difficulty: smallint("difficulty").notNull().default(1),
    scaffoldLevel: text("scaffold_level").notNull(),
    interactionType: text("interaction_type").notNull(),
    estimatedSeconds: integer("estimated_seconds").notNull().default(15),
    problemJson: jsonb("problem_json").$type<ProblemSpec>().notNull(),
    answerJson: jsonb("answer_json").notNull(),
    stepsJson: jsonb("steps_json").notNull().default([]),
    hintChainJson: jsonb("hint_chain_json").notNull().default([]),
    errorRulesJson: jsonb("error_rules_json").notNull().default([]),
    sourceTemplate: text("source_template"),
    reviewStatus: text("review_status").notNull().default("draft"),
    // SQL 里该约束名为 item_release_fk（由 ALTER TABLE 添加）。Drizzle 的
    // .references() 不支持内联命名，名字差异不影响列集合一致性。
    contentReleaseId: bigint("content_release_id", { mode: "number" }).references(
      () => contentRelease.id,
    ),
  },
  (t) => [
    check(
      "item_scaffold_level_check",
      sql`${t.scaffoldLevel} IN ('blocks', 'decompose', 'direct')`,
    ),
    check("item_estimated_seconds_check", sql`${t.estimatedSeconds} > 0`),
    check(
      "item_review_status_check",
      sql`${t.reviewStatus} IN ('draft', 'approved', 'retired')`,
    ),
    index("item_lookup_idx").on(
      t.competencyCode,
      t.patternCode,
      t.scaffoldLevel,
      t.difficulty,
    ),
  ],
);

// ═══════════════════════════════════════════════════════════
// 账号（MVP 极简：不做社交、不做复杂账号体系）
// ═══════════════════════════════════════════════════════════

export const child = pgTable("child", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  birthYear: integer("birth_year"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  active: boolean("active").notNull().default(true),
});

// ═══════════════════════════════════════════════════════════
// 事件域：学习事实
// ═══════════════════════════════════════════════════════════

export const learningSession = pgTable(
  "learning_session",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    childId: bigint("child_id", { mode: "number" })
      .notNull()
      .references(() => child.id, { onDelete: "cascade" }),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    endedAt: timestamptz("ended_at"),
    durationMs: integer("duration_ms"),
    plannedMinutes: integer("planned_minutes"),
    itemCount: integer("item_count").notNull().default(0),
    storyCount: integer("story_count").notNull().default(0),
    completion: num_4_3("completion"),
    quitReason: text("quit_reason"),
    device: text("device"),
  },
  (t) => [
    check("learning_session_duration_ms_check", sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`),
    index("learning_session_child_idx").on(t.childId, t.startedAt.desc()),
  ],
);

/** 学习系统唯一事实入口（ADR-0004） */
export const attempt = pgTable(
  "attempt",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().defaultRandom().unique(),
    sessionId: bigint("session_id", { mode: "number" }).references(() => learningSession.id, {
      onDelete: "set null",
    }),
    childId: bigint("child_id", { mode: "number" })
      .notNull()
      .references(() => child.id, { onDelete: "cascade" }),
    itemCode: text("item_code")
      .notNull()
      .references(() => item.code),
    competencyCode: text("competency_code")
      .notNull()
      .references(() => competency.code),
    patternCode: text("pattern_code")
      .notNull()
      .references(() => problemPattern.code),
    slotCode: text("slot_code"),
    // item 属性快照（P2 补列）：attempt 是历史事实，必须不随 item 内容漂移
    // （见 ADR-0004）。replay 优先读列，submitted_json 快照只兜底旧数据。
    scaffoldLevel: varchar("scaffold_level", { length: 16 }).notNull().default("direct"),
    interactionType: varchar("interaction_type", { length: 32 }).notNull().default("number_pad"),
    /** 单孩子内单调递增，replay 的排序键 */
    seq: bigint("seq", { mode: "number" }).notNull(),
    submittedJson: jsonb("submitted_json"),
    correct: boolean("correct").notNull(),
    /** 前端判定与服务端不一致 */
    judgementMismatch: boolean("judgement_mismatch").notNull().default(false),
    // 时间语义（ADR-0003）：thinking 由计算得出，不落库，避免两个真相
    responseTimeMs: integer("response_time_ms").notNull(),
    activeTimeMs: integer("active_time_ms").notNull(),
    idleTimeMs: integer("idle_time_ms").notNull().default(0),
    hintsUsed: smallint("hints_used").notNull().default(0),
    hintLevelMax: smallint("hint_level_max").notNull().default(0),
    /** counting / decompose / make_ten / mental / written / visual_blocks / number_line */
    methodUsed: text("method_used"),
    /** 冷启动 probe：权重打折且不参与升级判定 */
    isAssessment: boolean("is_assessment").notNull().default(false),
    /** 迁移测试：给 transfer 采样 */
    isTransferProbe: boolean("is_transfer_probe").notNull().default(false),
    misconceptionCodesJson: jsonb("misconception_codes_json").$type<string[]>().notNull().default([]),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("attempt_response_time_ms_check", sql`${t.responseTimeMs} >= 0`),
    check("attempt_active_time_ms_check", sql`${t.activeTimeMs} >= 0`),
    check("attempt_idle_time_ms_check", sql`${t.idleTimeMs} >= 0`),
    check("attempt_hints_used_check", sql`${t.hintsUsed} >= 0`),
    check(
      "attempt_time_budget_check",
      sql`${t.activeTimeMs} + ${t.idleTimeMs} <= ${t.responseTimeMs}`,
    ),
    uniqueIndex("attempt_child_seq_uniq").on(t.childId, t.seq),
    index("attempt_child_seq_idx").on(t.childId, t.seq),
    index("attempt_competency_idx").on(t.childId, t.competencyCode, t.seq),
  ],
);

/** append-only：算法演进与回放的原始素材 */
export const learningEvent = pgTable(
  "learning_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    childId: bigint("child_id", { mode: "number" })
      .notNull()
      .references(() => child.id, { onDelete: "cascade" }),
    sessionId: bigint("session_id", { mode: "number" }).references(() => learningSession.id, {
      onDelete: "set null",
    }),
    attemptId: bigint("attempt_id", { mode: "number" }).references(() => attempt.id, {
      onDelete: "cascade",
    }),
    /** answer_submitted / hint_revealed / session_started / ... */
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json").notNull().default({}),
    ts: timestamptz("ts").notNull().defaultNow(),
  },
  (t) => [index("learning_event_child_idx").on(t.childId, t.id)],
);

export const coachMessage = pgTable(
  "coach_message",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    attemptId: bigint("attempt_id", { mode: "number" }).references(() => attempt.id, {
      onDelete: "cascade",
    }),
    role: text("role").notNull(),
    source: text("source").notNull(),
    hintLevel: smallint("hint_level"),
    text: text("text").notNull(),
    validatorResultJson: jsonb("validator_result_json").notNull().default({}),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    latencyMs: integer("latency_ms"),
    ts: timestamptz("ts").notNull().defaultNow(),
  },
  (t) => [check("coach_message_source_check", sql`${t.source} IN ('rule', 'llm')`)],
);

// ═══════════════════════════════════════════════════════════
// 状态域：熟练度（派生值不落权威）
//
// 注意：这两张表没有 level 字段。等级永远是
// derive_level(signals, algorithm_version) 的结果（ADR-0002）。
// ═══════════════════════════════════════════════════════════

export const proficiencyState = pgTable(
  "proficiency_state",
  {
    childId: bigint("child_id", { mode: "number" })
      .notNull()
      .references(() => child.id, { onDelete: "cascade" }),
    competencyCode: text("competency_code")
      .notNull()
      .references(() => competency.code),
    mastery: num_5_4("mastery"),
    accuracy: num_5_4("accuracy"),
    fluency: num_5_4("fluency"),
    independence: num_5_4("independence"),
    transfer: num_5_4("transfer"),
    confidence: num_5_4("confidence"),
    signalSampleCounts: jsonb("signal_sample_counts").notNull().default({}),
    sampleCount: integer("sample_count").notNull().default(0),
    assessmentSamples: integer("assessment_samples").notNull().default(0),
    probeStatus: text("probe_status").notNull().default("unknown"),
    algorithmVersion: integer("algorithm_version")
      .notNull()
      .references(() => algorithmConfig.version),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("proficiency_state_mastery_check", sql`${t.mastery} IS NULL OR (${t.mastery} BETWEEN 0 AND 1)`),
    check("proficiency_state_accuracy_check", sql`${t.accuracy} IS NULL OR (${t.accuracy} BETWEEN 0 AND 1)`),
    check("proficiency_state_fluency_check", sql`${t.fluency} IS NULL OR (${t.fluency} BETWEEN 0 AND 1)`),
    check("proficiency_state_independence_check", sql`${t.independence} IS NULL OR (${t.independence} BETWEEN 0 AND 1)`),
    check("proficiency_state_transfer_check", sql`${t.transfer} IS NULL OR (${t.transfer} BETWEEN 0 AND 1)`),
    check("proficiency_state_confidence_check", sql`${t.confidence} IS NULL OR (${t.confidence} BETWEEN 0 AND 1)`),
    check(
      "proficiency_state_probe_status_check",
      sql`${t.probeStatus} IN ('unknown', 'probing', 'estimated', 'stable')`,
    ),
    primaryKey({ columns: [t.childId, t.competencyCode] }),
  ],
);

/** 键含 competency：迁移 = 同一 competency 换 pattern */
export const patternState = pgTable(
  "pattern_state",
  {
    childId: bigint("child_id", { mode: "number" })
      .notNull()
      .references(() => child.id, { onDelete: "cascade" }),
    competencyCode: text("competency_code")
      .notNull()
      .references(() => competency.code),
    patternCode: text("pattern_code")
      .notNull()
      .references(() => problemPattern.code),
    mastery: num_5_4("mastery"),
    accuracy: num_5_4("accuracy"),
    fluency: num_5_4("fluency"),
    independence: num_5_4("independence"),
    transfer: num_5_4("transfer"),
    confidence: num_5_4("confidence"),
    signalSampleCounts: jsonb("signal_sample_counts").notNull().default({}),
    sampleCount: integer("sample_count").notNull().default(0),
    algorithmVersion: integer("algorithm_version")
      .notNull()
      .references(() => algorithmConfig.version),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.childId, t.competencyCode, t.patternCode] })],
);

export const misconceptionState = pgTable(
  "misconception_state",
  {
    childId: bigint("child_id", { mode: "number" })
      .notNull()
      .references(() => child.id, { onDelete: "cascade" }),
    misconceptionCode: text("misconception_code")
      .notNull()
      .references(() => misconception.code),
    hitCount: integer("hit_count").notNull().default(0),
    lastAttemptSeq: bigint("last_attempt_seq", { mode: "number" }),
    lastSeenAt: timestamptz("last_seen_at"),
    resolved: boolean("resolved").notNull().default(false),
    remediationCompetency: text("remediation_competency").references(() => competency.code),
  },
  (t) => [primaryKey({ columns: [t.childId, t.misconceptionCode] })],
);

export const reviewSchedule = pgTable(
  "review_schedule",
  {
    childId: bigint("child_id", { mode: "number" })
      .notNull()
      .references(() => child.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetCode: text("target_code").notNull(),
    stageIndex: smallint("stage_index").notNull().default(0),
    intervalDays: integer("interval_days").notNull(),
    dueAt: timestamptz("due_at").notNull(),
    ease: num_4_3("ease").notNull().default(1.0),
  },
  (t) => [
    check("review_schedule_target_type_check", sql`${t.targetType} IN ('competency', 'pattern')`),
    primaryKey({ columns: [t.childId, t.targetType, t.targetCode] }),
    index("review_schedule_due_idx").on(t.childId, t.dueAt),
  ],
);

// ═══════════════════════════════════════════════════════════
// 故事域
// ═══════════════════════════════════════════════════════════

export const universe = pgTable("universe", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  theme: text("theme").notNull().default(""),
  unlockRuleJson: jsonb("unlock_rule_json").notNull().default({}),
  orderIndex: integer("order_index").notNull().default(0),
});

export const story = pgTable("story", {
  code: text("code").primaryKey(),
  universeCode: text("universe_code")
    .notNull()
    .references(() => universe.code),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  durationMin: smallint("duration_min"),
  targetCompetenciesJson: jsonb("target_competencies_json").$type<string[]>().notNull().default([]),
  orderIndex: integer("order_index").notNull().default(0),
});

/**
 * story_beat.code 约定为 "{story_code}__{local_code}"，因此它本身全局唯一，
 * 但每次读都必须能回到故事，故事 id 也必须能反查所有 beat。
 */
export const storyBeat = pgTable(
  "story_beat",
  {
    code: text("code").primaryKey(),
    storyCode: text("story_code")
      .notNull()
      .references(() => story.code, { onDelete: "cascade" }),
    sequence: smallint("sequence").notNull(),
    beatType: text("beat_type").notNull(),
    narration: text("narration"),
    character: text("character"),
    visualJson: jsonb("visual_json").$type<StoryVisual>().notNull().default({}),
    rewardJson: jsonb("reward_json").$type<Reward>().notNull().default({}),
  },
  (t) => [
    check("story_beat_beat_type_check", sql`${t.beatType} IN ('narration', 'challenge', 'reward')`),
    uniqueIndex("story_beat_story_seq_uniq").on(t.storyCode, t.sequence),
  ],
);

/**
 * 题目槽位：故事与题目之间的唯一桥梁（ADR-0001）
 *
 *   story_beat_code 为 NULL ⇒ 独立训练槽（核心训练 / 思维挑战段在用）。
 *   槽位机制不属于故事，故事只是它的一种使用场景。
 */
export const challengeSlot = pgTable(
  "challenge_slot",
  {
    code: text("code").primaryKey(),
    storyBeatCode: text("story_beat_code").references(() => storyBeat.code, {
      onDelete: "cascade",
    }),
    competencyCode: text("competency_code")
      .notNull()
      .references(() => competency.code),
    /** NULL ⇒ 由规划器按状态决定 */
    patternCode: text("pattern_code").references(() => problemPattern.code),
    difficultyMin: smallint("difficulty_min").notNull().default(1),
    difficultyMax: smallint("difficulty_max").notNull().default(5),
    scaffoldLevel: text("scaffold_level").notNull().default("auto"),
    purpose: text("purpose").notNull().default("practice"),
    estimatedSeconds: integer("estimated_seconds").notNull().default(20),
    selectionPolicyJson: jsonb("selection_policy_json").notNull().default({}),
    reviewPolicyJson: jsonb("review_policy_json").notNull().default({}),
  },
  (t) => [
    check(
      "challenge_slot_scaffold_level_check",
      sql`${t.scaffoldLevel} IN ('auto', 'blocks', 'decompose', 'direct')`,
    ),
    check(
      "challenge_slot_purpose_check",
      sql`${t.purpose} IN ('warmup', 'core', 'practice', 'story',
                           'thinking', 'challenge', 'review', 'probe')`,
    ),
    check("challenge_slot_difficulty_range_check", sql`${t.difficultyMin} <= ${t.difficultyMax}`),
    index("challenge_slot_beat_idx").on(t.storyBeatCode),
  ],
);

// ═══════════════════════════════════════════════════════════
// 游戏域
//
// 游戏状态与学习状态分离，两者通过 attempt 连接；
// 游戏状态永远不是学习状态的权威。
// ═══════════════════════════════════════════════════════════

export const inventory = pgTable(
  "inventory",
  {
    childId: bigint("child_id", { mode: "number" })
      .notNull()
      .references(() => child.id, { onDelete: "cascade" }),
    itemCode: text("item_code").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    check("inventory_count_check", sql`${t.count} >= 0`),
    primaryKey({ columns: [t.childId, t.itemCode] }),
  ],
);

export const unlock = pgTable(
  "unlock",
  {
    childId: bigint("child_id", { mode: "number" })
      .notNull()
      .references(() => child.id, { onDelete: "cascade" }),
    unlockCode: text("unlock_code").notNull(),
    unlockedAt: timestamptz("unlocked_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.childId, t.unlockCode] })],
);

export const rewardLog = pgTable("reward_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  childId: bigint("child_id", { mode: "number" })
    .notNull()
    .references(() => child.id, { onDelete: "cascade" }),
  attemptId: bigint("attempt_id", { mode: "number" }).references(() => attempt.id, {
    onDelete: "set null",
  }),
  rewardJson: jsonb("reward_json").$type<Reward>().notNull(),
  ts: timestamptz("ts").notNull().defaultNow(),
});

// ═══════════════════════════════════════════════════════════
// 迁移的落地形态（ADR-0004）
//
// 以下四张表必须由同一事务写入，不允许分步提交：
//
//   BEGIN;
//     INSERT INTO attempt ...;
//     INSERT INTO learning_event ...;
//     INSERT INTO reward_log ...;
//     UPDATE proficiency_state / pattern_state / misconception_state / review_schedule ...;
//   COMMIT;
// ═══════════════════════════════════════════════════════════
