/**
 * 学习状态与作答提交 —— `backend/service/learning.py` 的 TypeScript 移植。
 *
 * 两条硬性规则（照抄 Python 模块头）：
 *
 * 1. **在线更新与 Replay 共用同一段代码**（ADR-0002 / replay 可信的前提）。
 *    做法：把 DB 里的历史 attempt 读出来 → 构造成引擎的 `Attempt` → 调
 *    `applyAttempts` → 把结果写回状态表。本模块**不重新实现**任何信号计算。
 *
 *    为什么是"全量重放"而不是"读状态增量更新"：`ChildLearningState` 里有
 *    `first_scaffold` / `last_touched_seq` / `recent_attempts` 这些窗口字段，
 *    增量更新需要在库里另存它们（SQL 里没有）。全量重放让在线路径与
 *    `engine.replay.replay()` 逐字段等价，代价是每次提交 O(历史条数) ——
 *    儿童学习场景每天几十条，可接受。
 *
 * 2. **attempt 是唯一事实入口**（ADR-0004）。attempt 行 + learning_event +
 *    reward_log + 四张状态表 + 会话计数，全部在同一个事务里提交。
 *
 * 并发与幂等（三层防护，#50 并发压测验证）：
 *   a. `pg_advisory_xact_lock(child_id)` —— 同一孩子的提交在数据库级串行化
 *      （跨实例有效），MAX(seq) 读取不会竞态；
 *   b. seq 用原子表达式 `COALESCE((SELECT MAX(seq) ...), 0) + 1` 写入，
 *      加上 `attempt_child_seq_uniq` 唯一索引兜底；
 *   c. 23505（唯一冲突）重试 3 次（20/50/120ms 退避）：重开事务后先走幂等
 *      查询 —— 并发同 client_attempt_id 的第二个请求返回首次结果。
 *
 * 幂等：`client_attempt_id` 写进 `attempt.uuid`（UNIQUE）。重复提交直接返回
 * 首次结果，不再推进状态。
 */
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { Item, ContentBundle } from "@/src/content/types";
import type { AlgorithmConfig } from "@/src/engine/config";
import { diagnose } from "@/src/engine/diagnosis";
import { applyAttempts, newState } from "@/src/engine/learner";
import { newSchedule, updateSchedule } from "@/src/engine/scheduler";
import { selectItem } from "@/src/engine/selector";
import { deriveLevel } from "@/src/engine/state-machine";
import {
  Attempt,
  Signals,
  splitPatternKey,
  Telemetry,
  type ChildLearningState,
} from "@/src/engine/types";
import { getDb, type DbExecutor, type DbTx } from "@/src/db/client";
import {
  attempt,
  child,
  inventory,
  learningEvent,
  learningSession,
  misconceptionState,
  patternState,
  proficiencyState,
  reviewSchedule,
  rewardLog,
  storyBeat,
} from "@/src/db/schema";
import { pyRound } from "@/src/py/pyround";
import { sortedStrings } from "@/src/py/pysort";
import * as errors from "@/src/service/errors";
import { itemPayload } from "@/src/service/content";

/** 每次有效提交的基础奖励（占位规则，P5 成长体系接管）。契约 §4 示例：答错也有参与奖励。 */
const REWARD_WOOD = 1;
const REWARD_COINS = 1;

/** 23505 唯一冲突的重试退避（毫秒）：重开整个事务，第二次进来会命中幂等查询 */
const SUBMIT_RETRY_DELAYS_MS = [20, 50, 120];

/**
 * POST /v1/attempts 的领域输入。
 *
 * Python 是 dataclass（带默认值）；请求体到这里的校验在路由层（#49）做，
 * 这里的字段类型就是"校验后的形状"。
 */
export interface AttemptSubmission {
  client_attempt_id: string;
  child_id: number;
  item_code: string;
  answer: unknown;
  telemetry: Telemetry;
  session_id?: number | null;
  slot_code?: string | null;
  client_correct?: boolean | null;
  hints_used?: number;
  hint_level_max?: number;
  method_used?: string | null;
  is_transfer_probe?: boolean;
  is_assessment?: boolean;
}

/** coach 的最小接口（真实实现在 src/coach，#48 移植；LLM 改写是异步的 —— Python 侧是阻塞 HTTP，语义对应） */
export interface CoachMessageLike {
  toDict(): Record<string, unknown>;
}

export interface CoachLike {
  feedback(
    item: Item,
    correct: boolean,
    hintsUsed: number,
    opts: { misconceptionCodes: string[]; seed: number },
  ): Promise<CoachMessageLike>;
}

/** attempt_response 接收的行形状（整行 select 或 insert returning 都满足） */
export type AttemptRow = typeof attempt.$inferSelect;

// ── DB → 引擎对象 ──────────────────────────────────────────

function asInt(value: unknown): number | null {
  if (typeof value === "boolean") {
    return null;
  }
  if (typeof value === "number") {
    // Python：int 直接返回；float 走 int(str(v))，"2.0"/"2.5" 都解析失败。
    // JS 的 number 不区分 2 与 2.0 —— JSONB 里整数答案是 "36" 这种字面量，
    // 内容资产里没有 x.0 形态的答案，按"整数值 number = Python int"处理。
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) {
      return null;
    }
    return Number.parseInt(text, 10);
  }
  return null;
}

/** 服务端独立判定 —— 判定永远以后端为准（ADR-0004 双轨判定）。 */
export function judgeAnswer(item: Item, answer: unknown): boolean {
  const expected = item.answer;
  if (typeof expected === "number" && Number.isInteger(expected)) {
    const got = asInt(answer);
    return got !== null && got === expected;
  }
  if (expected === null || expected === undefined) {
    return false;
  }
  return String(answer).trim() === String(expected).trim();
}

/** Python `_iso` / `iso_utc`：aware datetime.isoformat()，naive 才补 Z（详见 growth.ts） */
export function isoUtc(value: Date | null): string | null {
  if (value === null) {
    return null;
  }
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const base =
    `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}` +
    `T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  const ms = value.getUTCMilliseconds();
  const fraction = ms === 0 ? "" : `.${pad(ms * 1000, 6)}`;
  return `${base}${fraction}+00:00`;
}

export function attemptFromRow(row: AttemptRow, bundle: ContentBundle): Attempt {
  /**
   * `scaffold_level` / `interaction_type` 是 fluency 阈值与"今日发现"的输入，
   * attempt 表已有这两列（0001 修订）：提交时随行写入，replay **优先读列**。
   *
   * 读取顺序：列 → submitted_json 快照 → item 表 → 缺省值。为什么要兜底：
   * attempt 是历史事实（ADR-0004），**必须不随 item 内容漂移** —— item 后来
   * 被修改或下架时，历史 replay 仍要按"作答那一刻"的脚手架与交互类型计算。
   * 列是权威；快照只服务于补列之前的旧行；item 表是最后手段（会漂移）。
   */
  const blob = (row.submittedJson ?? {}) as Record<string, unknown>;
  const item = bundle.items.get(row.itemCode);
  const scaffold =
    row.scaffoldLevel ||
    (blob["scaffold_level"] as string | undefined) ||
    item?.scaffold_level ||
    "direct";
  const interaction =
    row.interactionType ||
    (blob["interaction_type"] as string | undefined) ||
    item?.interaction_type ||
    "number_pad";
  return new Attempt({
    attempt_id: String(row.id),
    child_id: String(row.childId),
    item_id: row.itemCode,
    competency_id: row.competencyCode,
    pattern_id: row.patternCode,
    correct: Boolean(row.correct),
    telemetry: new Telemetry({
      response_time_ms: row.responseTimeMs,
      active_time_ms: row.activeTimeMs,
      idle_time_ms: row.idleTimeMs,
    }),
    seq: row.seq,
    hints_used: row.hintsUsed ?? 0,
    hint_level_max: row.hintLevelMax ?? 0,
    method_used: row.methodUsed,
    scaffold_level: scaffold,
    interaction_type: interaction,
    is_assessment: Boolean(row.isAssessment),
    is_transfer_probe: Boolean(row.isTransferProbe),
    misconception_codes: [...(row.misconceptionCodesJson ?? [])],
    submitted_answer: blob["answer"],
    created_at: row.createdAt !== null ? isoUtc(row.createdAt) : null,
  });
}

export async function loadAttempts(db: DbExecutor, childId: number): Promise<AttemptRow[]> {
  return db.select().from(attempt).where(eq(attempt.childId, childId)).orderBy(asc(attempt.seq));
}

/** 从持久化的历史 attempt 完整重建学习状态（= Replay）。`uptoSeq` 重建"某次作答那一刻"的状态。 */
export async function loadState(
  db: DbExecutor,
  childId: number,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  uptoSeq?: number | null,
): Promise<ChildLearningState> {
  const rows = await loadAttempts(db, childId);
  const filtered =
    uptoSeq !== undefined && uptoSeq !== null ? rows.filter((row) => row.seq <= uptoSeq) : rows;
  const attempts = filtered.map((row) => attemptFromRow(row, bundle));
  return applyAttempts(newState(String(childId)), attempts, bundle, cfg);
}

// ── 状态写回 ───────────────────────────────────────────────

/** NUMERIC(5,4)：写库前统一到 4 位小数，避免 PG / SQLite 精度表现不一致。 */
function quantize(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return pyRound(value, 4);
}

/**
 * 把重放得到的状态写回四张状态表（proficiency / pattern / misconception / review）。
 *
 * 注意：**不写 level**（ADR-0002）。等级每次读的时候由 derive_level 现算。
 */
export async function persistState(
  db: DbExecutor,
  childId: number,
  state: ChildLearningState,
  cfg: AlgorithmConfig,
  now: Date,
): Promise<void> {
  const existingProf = await db
    .select()
    .from(proficiencyState)
    .where(eq(proficiencyState.childId, childId));
  const profByKey = new Map(existingProf.map((row) => [row.competencyCode, row] as const));
  for (const [code, signals] of state.competencies) {
    const values = applySignalsValues(signals, cfg, now);
    // Python `hasattr(row, "assessment_samples")`：只有 proficiency 表有这两列
    const profValues = {
      ...values,
      assessmentSamples: signals.assessment_samples,
      probeStatus: signals.probe_status,
    };
    if (profByKey.has(code)) {
      await db
        .update(proficiencyState)
        .set(profValues)
        .where(and(eq(proficiencyState.childId, childId), eq(proficiencyState.competencyCode, code)));
    } else {
      await db
        .insert(proficiencyState)
        .values({ childId, competencyCode: code, ...profValues });
    }
  }

  const existingPatterns = await db
    .select()
    .from(patternState)
    .where(eq(patternState.childId, childId));
  const patternByKey = new Map<string, (typeof existingPatterns)[number]>(
    existingPatterns.map((row) => [`${row.competencyCode}::${row.patternCode}`, row] as const),
  );
  for (const [key, signals] of state.patterns) {
    const [competencyCode, patternCode] = splitPatternKey(key);
    const values = applySignalsValues(signals, cfg, now);
    if (patternByKey.has(key)) {
      await db
        .update(patternState)
        .set(values)
        .where(
          and(
            eq(patternState.childId, childId),
            eq(patternState.competencyCode, competencyCode),
            eq(patternState.patternCode, patternCode),
          ),
        );
    } else {
      await db
        .insert(patternState)
        .values({ childId, competencyCode, patternCode, ...values });
    }
  }

  const existingMisc = await db
    .select()
    .from(misconceptionState)
    .where(eq(misconceptionState.childId, childId));
  const miscByKey = new Map(existingMisc.map((row) => [row.misconceptionCode, row] as const));
  for (const [code, misc] of state.misconceptions) {
    const row = miscByKey.get(code);
    if (row !== undefined) {
      await db
        .update(misconceptionState)
        .set({
          hitCount: misc.hit_count,
          lastAttemptSeq: misc.last_seq,
          resolved: misc.resolved,
          // Python：remediation 只在有值时更新（None 不覆盖已有值）
          ...(misc.remediation_competency !== null ? { remediationCompetency: misc.remediation_competency } : {}),
        })
        .where(
          and(
            eq(misconceptionState.childId, childId),
            eq(misconceptionState.misconceptionCode, code),
          ),
        );
    } else {
      await db.insert(misconceptionState).values({
        childId,
        misconceptionCode: code,
        hitCount: misc.hit_count,
        lastAttemptSeq: misc.last_seq,
        resolved: misc.resolved,
        ...(misc.remediation_competency !== null ? { remediationCompetency: misc.remediation_competency } : {}),
      });
    }
  }
  // "本轮命中的误区才刷新 last_seen_at"——Python 用两轮循环实现，但第一轮
  // 已把已存在行的 last_attempt_seq 覆写成 misc.last_seq，第二轮的相等判断
  // 因此恒真。净效果：**已存在的**误区行每次提交都刷新 last_seen_at，新建行
  // 不在 existing 字典里、不刷新（last_seen_at 保持 NULL）。照抄这个净效果。
  for (const code of state.misconceptions.keys()) {
    if (miscByKey.has(code)) {
      await db
        .update(misconceptionState)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(misconceptionState.childId, childId),
            eq(misconceptionState.misconceptionCode, code),
          ),
        );
    }
  }
}

/** Python `_apply_signals` 的字段投影。proficiency / pattern 两表共用（后者无 assessment 列）。 */
function applySignalsValues(signals: Signals, cfg: AlgorithmConfig, now: Date) {
  return {
    mastery: quantize(signals.mastery),
    accuracy: quantize(signals.accuracy),
    fluency: quantize(signals.fluency),
    independence: quantize(signals.independence),
    transfer: quantize(signals.transfer),
    confidence: quantize(signals.confidence),
    signalSampleCounts: Object.fromEntries(signals.signal_sample_counts),
    sampleCount: signals.sample_count,
    algorithmVersion: cfg.version,
    updatedAt: now,
  };
}

/**
 * 复习调度：调用引擎调度器 update_schedule（P3 起真实现）。
 *
 * 调度器是纯函数，粒度是 pattern_key（"{competency}::{pattern}"）。
 * 两处与现实的对齐方式：
 *
 * - **day（"今天是第几天"）**：DB 没有天序概念。这里用"该孩子第几个学习日"——
 *   学习日 := 该孩子有作答记录的 UTC 自然日，按时间先后编号（1 起）。
 * - **存储形状**：review_schedule 表没有 consecutive_correct / last_correct_day /
 *   due_day 列，增量读回会有损。与四张状态表同一哲学 —— **从 attempt 全量重放**。
 *   due_at 是日历近似（当前时刻 + 间隔天数），只供 ops 按时间查询；
 *   调度的权威是重放结果。
 *
 * probe（is_assessment）不推进复习调度。事务边界不变：由 submitAttempt 在
 * attempt 提交的同一事务里调用。
 */
export async function updateReviewSchedule(
  db: DbExecutor,
  childId: number,
  history: Attempt[],
  cfg: AlgorithmConfig,
  now: Date,
): Promise<void> {
  const intervals = [...cfg.review_intervals_days];
  if (intervals.length === 0 || history.length === 0) {
    return;
  }

  // 学习日 := 有作答记录的 UTC 自然日，按时间先后编号（1 起）
  const dayOfDate = new Map<string, number>();
  const days: (number | null)[] = [];
  for (const entry of history) {
    if (entry.created_at === null) {
      days.push(null);
      continue;
    }
    const date = new Date(entry.created_at);
    if (Number.isNaN(date.getTime())) {
      days.push(null);
      continue;
    }
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    if (!dayOfDate.has(key)) {
      dayOfDate.set(key, dayOfDate.size + 1);
    }
    days.push(dayOfDate.get(key)!);
  }

  let schedule = newSchedule();
  for (let index = 0; index < history.length; index++) {
    const day = days[index]!;
    const entry = history[index]!;
    if (day === null || entry.is_assessment) {
      continue;
    }
    schedule = updateSchedule(schedule, entry, day, cfg);
  }

  const existing = await db
    .select()
    .from(reviewSchedule)
    .where(and(eq(reviewSchedule.childId, childId), eq(reviewSchedule.targetType, "pattern")));
  const existingByKey = new Map(existing.map((row) => [row.targetCode, row] as const));
  for (const key of sortedStrings([...schedule.keys()])) {
    const entry = schedule.get(key)!;
    const stage = Math.max(0, Math.min(Math.trunc(entry.interval_index), intervals.length - 1));
    const intervalDays = Math.trunc(intervals[stage]!);
    const values = {
      stageIndex: stage,
      intervalDays,
      // 日历近似：当前时刻 + 间隔天数（调度的权威是重放结果，孩子跳过几天时以学习日为准）
      dueAt: new Date(now.getTime() + intervalDays * 86_400_000),
    };
    if (existingByKey.has(key)) {
      await db
        .update(reviewSchedule)
        .set(values)
        .where(
          and(
            eq(reviewSchedule.childId, childId),
            eq(reviewSchedule.targetType, "pattern"),
            eq(reviewSchedule.targetCode, key),
          ),
        );
    } else {
      await db
        .insert(reviewSchedule)
        .values({ childId, targetType: "pattern", targetCode: key, ...values });
    }
  }
}

// ── 奖励（占位规则，P5 接管） ──────────────────────────────

export function buildReward(): Record<string, unknown> {
  return {
    materials: [{ code: "wood", count: REWARD_WOOD }],
    coins: REWARD_COINS,
    unlocks: [],
  };
}

export async function recordReward(
  db: DbExecutor,
  childId: number,
  attemptId: number,
  reward: Record<string, unknown>,
): Promise<void> {
  await db.insert(rewardLog).values({
    childId,
    attemptId,
    rewardJson: reward as typeof rewardLog.$inferInsert["rewardJson"],
  });
  const materials = (reward["materials"] ?? []) as Record<string, unknown>[];
  for (const material of materials) {
    const code = material["code"];
    const count = Math.trunc(Number(material["count"] ?? 0));
    if (!code || count <= 0) {
      continue;
    }
    await addToInventory(db, childId, String(code), count);
  }
  const coins = Math.trunc(Number(reward["coins"] ?? 0));
  if (coins > 0) {
    await addToInventory(db, childId, "coin", coins);
  }
}

/** Python `row.count = (row.count or 0) + n` 的等价 upsert（调用方在 advisory lock 下运行） */
async function addToInventory(
  db: DbExecutor,
  childId: number,
  itemCode: string,
  delta: number,
): Promise<void> {
  const rows = await db
    .select()
    .from(inventory)
    .where(and(eq(inventory.childId, childId), eq(inventory.itemCode, itemCode)));
  const current = rows.length > 0 ? (rows[0]!.count ?? 0) : 0;
  const next = current + delta;
  await db
    .insert(inventory)
    .values({ childId, itemCode, count: next })
    .onConflictDoUpdate({
      target: [inventory.childId, inventory.itemCode],
      set: { count: next },
    });
}

export async function recordLearningEvent(
  db: DbExecutor,
  childId: number,
  sessionId: number | null,
  attemptId: number | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(learningEvent).values({
    childId,
    sessionId,
    attemptId,
    eventType: "answer_submitted",
    payloadJson: payload,
  });
}

// ── 响应组装 ───────────────────────────────────────────────

export function progressPayload(
  state: ChildLearningState,
  competencyCode: string,
  cfg: AlgorithmConfig,
): Record<string, unknown> {
  const signals = state.competencies.get(competencyCode) ?? new Signals();
  const level = deriveLevel(signals, cfg);
  return {
    competency: competencyCode,
    level,
    level_label: cfg.levelLabel(level),
    scaffold_level: cfg.scaffoldForMastery(signals.mastery),
    signals: {
      mastery: quantize(signals.mastery),
      accuracy: quantize(signals.accuracy),
      fluency: quantize(signals.fluency),
      independence: quantize(signals.independence),
      transfer: quantize(signals.transfer),
    },
    sample_count: signals.sample_count,
  };
}

export async function nextPayload(
  db: DbExecutor,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  state: ChildLearningState,
  slotCode: string | null | undefined,
): Promise<Record<string, unknown>> {
  /** 提交后的"下一步"提示：同一个槽位里选下一道题。 */
  const result: Record<string, unknown> = { kind: "next_item", beat_index: null, item: null };
  if (!slotCode) {
    return result;
  }
  const slot = bundle.slots.get(slotCode);
  if (slot === undefined) {
    return result;
  }
  const item = selectItem(slot, state, bundle, cfg);
  if (item !== null) {
    result["item"] = itemPayload(item);
  }
  if (slot.story_beat_id) {
    const rows = await db
      .select({ sequence: storyBeat.sequence })
      .from(storyBeat)
      .where(eq(storyBeat.code, slot.story_beat_id));
    if (rows.length > 0) {
      result["beat_index"] = rows[0]!.sequence;
    }
  }
  return result;
}

async function feedbackPayload(
  coach: CoachLike,
  item: Item,
  row: AttemptRow,
): Promise<Record<string, unknown>> {
  const message = await coach.feedback(item, Boolean(row.correct), Math.trunc(row.hintsUsed ?? 0), {
    misconceptionCodes: [...(row.misconceptionCodesJson ?? [])],
    seed: Math.trunc(row.seq ?? 0),
  });
  return message.toDict();
}

async function rewardFromDb(db: DbExecutor, attemptId: number): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(rewardLog)
    .where(eq(rewardLog.attemptId, attemptId))
    .orderBy(desc(rewardLog.id))
    .limit(1);
  if (rows.length === 0) {
    return { materials: [], coins: 0, unlocks: [] };
  }
  const reward = { ...((rows[0]!.rewardJson ?? {}) as Record<string, unknown>) };
  // setdefault 语义：缺键才补默认
  if (!("materials" in reward)) reward["materials"] = [];
  if (!("coins" in reward)) reward["coins"] = 0;
  if (!("unlocks" in reward)) reward["unlocks"] = [];
  return reward;
}

/**
 * 把一次已落库的 attempt 渲染成契约 §4 的响应。
 *
 * 重复提交时用"截止到该 attempt 的重放状态"计算 progress / next，
 * 因此与非重复路径逐字等价。
 *
 * `state` 直传优化（Python 没有这个参数）：submitAttempt 的事务里已经为
 * 状态推进全量重放过一遍，直接把那份结果传进来可以省掉第二次重放 ——
 * 语义等价的前提是 row.seq 是该孩子当前最大 seq（advisory lock 串行下成立）。
 * 幂等命中路径不传，函数自己 loadState(upto_seq)。
 */
export async function attemptResponse(
  db: DbExecutor,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  coach: CoachLike,
  row: AttemptRow,
  duplicate: boolean,
  state?: ChildLearningState,
): Promise<Record<string, unknown>> {
  const resolvedState =
    state ?? (await loadState(db, row.childId, bundle, cfg, row.seq));
  const item = bundle.items.get(row.itemCode);
  const feedback =
    item !== undefined
      ? await feedbackPayload(coach, item, row)
      : { tone: "encourage", text: "我们继续。", character: "小助手" };
  return {
    attempt_id: row.id,
    seq: row.seq,
    duplicate,
    correct: Boolean(row.correct),
    judgement_mismatch: Boolean(row.judgementMismatch),
    misconceptions: [...(row.misconceptionCodesJson ?? [])],
    feedback,
    reward: await rewardFromDb(db, row.id),
    progress: progressPayload(resolvedState, row.competencyCode, cfg),
    next: await nextPayload(db, bundle, cfg, resolvedState, row.slotCode),
  };
}

// ── 提交（唯一事实入口） ───────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown })["code"] === "23505"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /v1/attempts 的全部业务，单事务。任何一步失败 → 整体回滚。
 *
 * 事务边界与 Python 不同的一点：Python 把响应组装放在 commit 之后，这里放在
 * 事务回调内 —— 事务内读自己的写，数据可见性更强，行为（读到的内容）相同。
 */
export async function submitAttempt(
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  coach: CoachLike,
  submission: AttemptSubmission,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let tryIndex = 0; tryIndex <= SUBMIT_RETRY_DELAYS_MS.length; tryIndex++) {
    try {
      return await getDb().transaction(async (tx) => {
        return runSubmission(tx, bundle, cfg, coach, submission);
      });
    } catch (err) {
      if (isUniqueViolation(err) && tryIndex < SUBMIT_RETRY_DELAYS_MS.length) {
        lastError = err;
        await sleep(SUBMIT_RETRY_DELAYS_MS[tryIndex]!);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function runSubmission(
  tx: DbTx,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  coach: CoachLike,
  submission: AttemptSubmission,
): Promise<Record<string, unknown>> {
  // 三层防护之一：同一孩子的提交在数据库级串行化（跨实例有效）
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${submission.child_id})`);

  const childRows = await tx
    .select({ id: child.id })
    .from(child)
    .where(eq(child.id, submission.child_id))
    .limit(1);
  if (childRows.length === 0) {
    throw errors.childMissing(submission.child_id);
  }

  // 幂等：同一 (child, client_attempt_id) 只写一次。
  // 放在 item 校验之前 —— 即使内容后来变了，重放也必须能拿到首次结果。
  const existingRows = await tx
    .select()
    .from(attempt)
    .where(and(eq(attempt.childId, submission.child_id), eq(attempt.uuid, submission.client_attempt_id)))
    .limit(1);
  if (existingRows.length > 0) {
    const existing = existingRows[0]!;
    const state = await loadState(tx, existing.childId, bundle, cfg, existing.seq);
    return attemptResponse(tx, bundle, cfg, coach, existing, true, state);
  }

  const item = bundle.items.get(submission.item_code);
  if (item === undefined) {
    throw errors.itemMissing(submission.item_code);
  }

  if (submission.session_id !== null && submission.session_id !== undefined) {
    const sessionRows = await tx
      .select({ id: learningSession.id })
      .from(learningSession)
      .where(eq(learningSession.id, submission.session_id))
      .limit(1);
    if (sessionRows.length === 0) {
      throw errors.sessionMissing(submission.session_id);
    }
  }

  const now = new Date();
  const correct = judgeAnswer(item, submission.answer);
  const mismatch =
    submission.client_correct !== null &&
    submission.client_correct !== undefined &&
    Boolean(submission.client_correct) !== correct;

  // 误区诊断：写库前先算出来（attempt 行需要快照）
  const probe = new Attempt({
    attempt_id: "pending",
    child_id: String(submission.child_id),
    item_id: item.code,
    competency_id: item.competency_id,
    pattern_id: item.pattern_id,
    correct,
    telemetry: submission.telemetry,
    hints_used: submission.hints_used ?? 0,
    hint_level_max: submission.hint_level_max ?? 0,
    method_used: submission.method_used ?? null,
    scaffold_level: item.scaffold_level,
    interaction_type: item.interaction_type,
    is_assessment: submission.is_assessment ?? false,
    is_transfer_probe: submission.is_transfer_probe ?? false,
    submitted_answer: submission.answer,
  });
  const misconceptionCodes = diagnose(probe, item, cfg);

  // 三层防护之二：seq 原子表达式（配合唯一索引 + 23505 重试兜底）
  const insertedRows = await tx
    .insert(attempt)
    .values({
      uuid: submission.client_attempt_id,
      sessionId: submission.session_id ?? null,
      childId: submission.child_id,
      itemCode: item.code,
      competencyCode: item.competency_id,
      patternCode: item.pattern_id,
      slotCode: submission.slot_code ?? null,
      scaffoldLevel: item.scaffold_level,
      interactionType: item.interaction_type,
      seq: sql`COALESCE((SELECT MAX(seq) FROM attempt WHERE child_id = ${submission.child_id}), 0) + 1` as unknown as number,
      submittedJson: {
        answer: submission.answer,
        client_correct: submission.client_correct ?? null,
      },
      correct,
      judgementMismatch: mismatch,
      responseTimeMs: submission.telemetry.response_time_ms,
      activeTimeMs: submission.telemetry.active_time_ms,
      idleTimeMs: submission.telemetry.idle_time_ms,
      hintsUsed: submission.hints_used ?? 0,
      hintLevelMax: submission.hint_level_max ?? 0,
      methodUsed: submission.method_used ?? null,
      isAssessment: submission.is_assessment ?? false,
      isTransferProbe: submission.is_transfer_probe ?? false,
      misconceptionCodesJson: misconceptionCodes,
      createdAt: now,
    })
    .returning();

  await recordLearningEvent(tx, submission.child_id, submission.session_id ?? null, insertedRows[0]!.id, {
    item_code: item.code,
    answer: submission.answer,
    correct,
    judgement_mismatch: mismatch,
    misconception_codes: misconceptionCodes,
    telemetry: submission.telemetry.toDict(),
  });

  const reward = buildReward();
  await recordReward(tx, submission.child_id, insertedRows[0]!.id, reward);

  if (submission.session_id !== null && submission.session_id !== undefined) {
    const sessionRows = await tx
      .select()
      .from(learningSession)
      .where(eq(learningSession.id, submission.session_id))
      .limit(1);
    if (sessionRows.length > 0) {
      const row = sessionRows[0]!;
      await tx
        .update(learningSession)
        .set({ itemCount: (row.itemCount ?? 0) + 1 })
        .where(eq(learningSession.id, row.id));
    }
  }

  // 状态推进：读全部历史 attempt → 复算 → 写回（与 replay 同一段代码）
  const historyRows = await loadAttempts(tx, submission.child_id);
  const history = historyRows.map((row) => attemptFromRow(row, bundle));
  const updatedState = applyAttempts(
    newState(String(submission.child_id)),
    history,
    bundle,
    cfg,
  );
  await persistState(tx, submission.child_id, updatedState, cfg, now);

  // review_schedule：ADR-0004 的事务清单成员。从全部 attempt 重放真调度器
  await updateReviewSchedule(tx, submission.child_id, history, cfg, now);

  return attemptResponse(tx, bundle, cfg, coach, insertedRows[0]!, false, updatedState);
}

export function newClientAttemptId(): string {
  return randomUUID();
}
