/**
 * 家长报告（契约 §10）—— `backend/service/report.py` 的 TypeScript 移植。
 *
 * 所有数字都来自孩子真实的 attempt / session / 状态表；文案规则集中在
 * headline / advice，P6 接入 LLM 时替换这两处即可。
 *
 * 免责声明是硬性要求：数据仅供家庭参考，不作为学业评价。
 *
 * 时区语义（照抄 Python 的混合语义，见函数内注释）：
 *   - `date.today()` 是**本地**日期；
 *   - attempt.created_at 是 timestamptz（aware），`.date()` 取 **UTC** 日期；
 *   - naive 的 `datetime.combine(start_day, 0:00)` 传进 SQL 后按会话时区
 *     （本地与 Neon 都是 UTC）解释 —— TS 侧用 `Date.UTC(...)` 表达同一时刻。
 */
import { and, asc, eq, gte } from "drizzle-orm";

import type { ContentBundle } from "@/src/content/types";
import type { DbExecutor } from "@/src/db/client";
import { attempt, learningSession } from "@/src/db/schema";
import type { AlgorithmConfig } from "@/src/engine/config";
import type { CompetencyGraph } from "@/src/engine/graph";
import { replay } from "@/src/engine/replay";
import { deriveLevel } from "@/src/engine/state-machine";
import type { ChildLearningState } from "@/src/engine/types";
import { pyRound } from "@/src/py/pyround";
import { sortedStrings } from "@/src/py/pysort";
import { completedStoryCodes } from "@/src/service/growth";
import { attemptFromRow } from "@/src/service/learning";

export const DISCLAIMER = "数据来自孩子在应用内的真实作答，仅供家庭参考，不作为学业评价。";

const LEVEL_ORDER = ["encountering", "understanding", "can_do", "proficient", "automatic"];

function levelIndex(level: string): number {
  const at = LEVEL_ORDER.indexOf(level);
  return at < 0 ? 0 : at;
}

interface WeakPoint {
  type: string;
  competency: string;
  text: string;
}

/** weak point 判定用的粗阈值 —— 全部取自配置，不写字面量（ADR-0002）。 */
function weakThresholds(cfg: AlgorithmConfig): Record<string, number> {
  const raw = cfg.get(["report", "weak_thresholds"]) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = Number(value);
  }
  return out;
}

function weakPoints(
  state: ChildLearningState,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
): WeakPoint[] {
  const thresholds = weakThresholds(cfg);
  const rows: WeakPoint[] = [];
  for (const code of sortedStrings([...state.competencies.keys()])) {
    const signals = state.competencies.get(code)!;
    const definition = bundle.competencies.get(code);
    const name = definition !== undefined ? definition.name : code;
    const accuracy = signals.accuracy;
    const fluency = signals.fluency;
    const independence = signals.independence;
    const transfer = signals.transfer;

    if (independence !== null && independence < thresholds["independence"]!) {
      rows.push({
        type: "independence",
        competency: code,
        text: `${name} 还需要提示才能做下去；下次先让他自己试一分钟，再给提示。`,
      });
    } else if (
      accuracy !== null &&
      accuracy >= thresholds["fluency_accuracy_floor"]! &&
      (fluency === null || fluency < thresholds["fluency"]!)
    ) {
      rows.push({
        type: "fluency",
        competency: code,
        text: `${name} 能独立做对，但每次要多想几秒；建议继续用「先凑十」的方法，不要退回逐个数。`,
      });
    } else if (accuracy !== null && accuracy < thresholds["accuracy"]!) {
      rows.push({
        type: "accuracy",
        competency: code,
        text: `${name} 的正确率还不稳定；建议降一级脚手架，用积木或拆分摆一摆再算。`,
      });
    } else if (transfer !== null && transfer < thresholds["transfer"]!) {
      rows.push({
        type: "transfer",
        competency: code,
        text: `${name} 在同一题型上很熟，但换个问法还不太行；这周换一种问法再练。`,
      });
    }
  }
  return rows.slice(0, 3);
}

function headline(weakPoints: WeakPoint[], bundle: ContentBundle): string {
  if (weakPoints.length === 0) {
    return "本周学习状态平稳，继续保持每天 10～15 分钟。";
  }
  const first = weakPoints[0]!;
  const definition = bundle.competencies.get(first.competency);
  const name = definition !== undefined ? definition.name : first.competency;
  if (first.type === "fluency") {
    return `本周不是「不会${name}」，而是「已经理解，但流畅度不足」。`;
  }
  if (first.type === "independence") {
    return `本周${name}的独立完成度还不够，多给一点自己尝试的时间。`;
  }
  if (first.type === "transfer") {
    return `本周${name}已经练熟，但换个问法就会卡住，需要更多变式。`;
  }
  return `本周${name}的正确率还不稳定，先把脚手架加回来。`;
}

function advice(weakPoints: WeakPoint[], bundle: ContentBundle): string[] {
  const out = ["每天 10～15 分钟即可，不要延长。"];
  if (weakPoints.length > 0) {
    const first = weakPoints[0]!;
    const definition = bundle.competencies.get(first.competency);
    const name = definition !== undefined ? definition.name : first.competency;
    if (first.type === "fluency") {
      out.push(`本周重点是「快一点」，可以玩「限时${name}」，但不要催。`);
    } else if (first.type === "independence") {
      out.push("孩子卡住时先等一分钟，让他自己找方法，再给提示。");
    } else if (first.type === "transfer") {
      out.push(`把「${name}」换成生活中的问法问一问，练变式。`);
    } else {
      out.push(`先把「${name}」的积木 / 拆分玩法拿出来，重新走一遍过程。`);
    }
  } else {
    out.push("可以让孩子当小老师，把今天学的方法讲一遍。");
  }
  return out;
}

// ── 日期工具（本地 today + UTC attempt 日期的混合语义） ────

interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

function isoDay(day: CalendarDay): string {
  return (
    `${String(day.y).padStart(4, "0")}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`
  );
}

function shiftDays(base: CalendarDay, delta: number): CalendarDay {
  const shifted = new Date(Date.UTC(base.y, base.m - 1, base.d) + delta * 86_400_000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

/** attempt.createdAt（timestamptz → aware datetime）`.date()` 的对应物：UTC 日期 */
function utcDayOf(date: Date): CalendarDay {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

async function engagement(
  db: DbExecutor,
  childId: number,
  start: Date,
  bundle: ContentBundle,
): Promise<Record<string, unknown>> {
  const sessions = await db
    .select()
    .from(learningSession)
    .where(and(eq(learningSession.childId, childId), gte(learningSession.startedAt, start)));
  let totalMinutes = 0.0;
  for (const row of sessions) {
    if (row.durationMs) {
      totalMinutes += row.durationMs / 60000.0;
    }
  }
  const count = sessions.length;

  // next_day_return_rate：有作答的日子里，"第二天也来"的比例
  const attemptRows = await db
    .select({ createdAt: attempt.createdAt })
    .from(attempt)
    .where(and(eq(attempt.childId, childId), gte(attempt.createdAt, start)));
  const dayKeys = new Set<string>();
  for (const row of attemptRows) {
    if (row.createdAt !== null) {
      dayKeys.add(isoDay(utcDayOf(row.createdAt)));
    }
  }
  // Python `date.today()`：本地日期
  const now = new Date();
  const today = isoDay({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
  const baseDays: string[] = [];
  for (const day of dayKeys) {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    if (isoDay(shiftDays({ y: y!, m: m!, d: d! }, 1)) <= today) {
      baseDays.push(day);
    }
  }
  let returns = 0;
  for (const day of baseDays) {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    if (dayKeys.has(isoDay(shiftDays({ y: y!, m: m!, d: d! }, 1)))) {
      returns += 1;
    }
  }
  const returnRate = baseDays.length > 0 ? returns / baseDays.length : 0.0;

  const totalStories = bundle.stories.size;
  const doneStories = (await completedStoryCodes(childId, bundle)).length;
  return {
    sessions: count,
    total_minutes: pyRound(totalMinutes, 1),
    avg_minutes_per_session: count ? pyRound(totalMinutes / count, 1) : 0.0,
    next_day_return_rate: pyRound(returnRate, 4),
    story_completion_rate: totalStories ? pyRound(doneStories / totalStories, 4) : 0.0,
  };
}

async function progressEvents(
  childId: string,
  db: DbExecutor,
  bundle: ContentBundle,
  cfg: AlgorithmConfig,
  graph: CompetencyGraph,
  start: Date,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select()
    .from(attempt)
    .where(eq(attempt.childId, Number(childId)))
    .orderBy(asc(attempt.seq));
  if (rows.length === 0) {
    return [];
  }
  const attempts = rows.map((row) => attemptFromRow(row, bundle));
  const result = replay(childId, attempts, bundle, cfg, graph);
  const events: Record<string, unknown>[] = [];
  const previousLevel = new Map<string, string>();
  for (const snapshot of result.snapshots) {
    const previous = previousLevel.get(snapshot.competency_id);
    previousLevel.set(snapshot.competency_id, snapshot.level);
    if (previous === undefined || levelIndex(snapshot.level) <= levelIndex(previous)) {
      continue;
    }
    const row = rows.find((r) => r.seq === snapshot.seq) ?? null;
    if (row === null || row.createdAt === null) {
      continue;
    }
    // Python 原文是 `row.created_at < start`：aware（DB 读出）与 naive（start）
    // 的 datetime 比较在该侧会抛 TypeError —— 按意图移植成时刻比较。
    if (row.createdAt.getTime() < start.getTime()) {
      continue;
    }
    const definition = bundle.competencies.get(snapshot.competency_id);
    const name = definition !== undefined ? definition.name : snapshot.competency_id;
    events.push({
      date: isoDay(utcDayOf(row.createdAt)),
      level: snapshot.level,
      note: `${name} 达到「${snapshot.level_label}」`,
    });
  }
  // Python events[-8:]：长度不足 8 时全取
  return events.slice(-8);
}

export async function reportPayload(
  db: DbExecutor,
  childRow: { id: number; name: string },
  state: ChildLearningState,
  cfg: AlgorithmConfig,
  bundle: ContentBundle,
  graph: CompetencyGraph,
  days: number,
): Promise<Record<string, unknown>> {
  const now = new Date();
  const today: CalendarDay = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  const startDay = shiftDays(today, -(Math.max(1, days) - 1));
  // Python `datetime.combine(start_day, 0:00)`（naive，SQL 里按 UTC 解释）
  const start = new Date(Date.UTC(startDay.y, startDay.m - 1, startDay.d));

  const competencies: Record<string, unknown>[] = [];
  for (const code of graph.topologicalOrder()) {
    const signals = state.competencies.get(code);
    if (signals === undefined || signals.sample_count === 0) {
      continue;
    }
    const definition = bundle.competencies.get(code);
    const name = definition !== undefined ? definition.name : code;
    const level = deriveLevel(signals, cfg);
    competencies.push({
      code,
      name,
      level,
      level_label: cfg.levelLabel(level),
      // Python `round(float(signals.mastery or 0.0), 4)`
      score: pyRound(signals.mastery ?? 0, 4),
      signals: {
        mastery: signals.mastery,
        accuracy: signals.accuracy,
        fluency: signals.fluency,
        independence: signals.independence,
        transfer: signals.transfer,
      },
    });
  }

  const misconceptions: Record<string, unknown>[] = [];
  for (const code of sortedStrings([...state.misconceptions.keys()])) {
    const misc = state.misconceptions.get(code)!;
    const definition = bundle.misconceptions.get(code);
    misconceptions.push({
      code,
      name: definition !== undefined ? definition.name : code,
      hit_count: misc.hit_count,
      text: `近一周出现 ${misc.hit_count} 次。`,
    });
  }

  const points = weakPoints(state, bundle, cfg);
  return {
    child: { id: childRow.id, name: childRow.name },
    range: { days: Math.max(1, days), from: isoDay(startDay), to: isoDay(today) },
    headline: headline(points, bundle),
    competencies,
    weak_points: points,
    misconceptions,
    progress: await progressEvents(String(childRow.id), db, bundle, cfg, graph, start),
    engagement: await engagement(db, childRow.id, start, bundle),
    advice: advice(points, bundle),
    disclaimer: DISCLAIMER,
  };
}
