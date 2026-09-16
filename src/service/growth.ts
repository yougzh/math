/**
 * 世界 / 实验室 / 成长域 —— `backend/service/growth.py` 的 TypeScript 移植。
 *
 * **P2 阶段的定位**：契约里这些端点必须存在且形状正确，但它们的游戏规则
 * （材料掉落、建筑解锁、徽章、布局）属于 P5 成长体系。因此本模块只实现
 * "从学习事实中可推导"的部分，规则常量集中放在文件顶部，方便 P5 整体替换。
 *
 * 实验室（§7）不在本模块维护规则：解锁判定统一走 `src/lab` +
 * `config/lab/v0.yaml`（构建产物），这里只提供 `labPayload`（内含
 * 派生等级 level_of，ADR-0002，读时现算不落库）。
 *
 * 推导原则：游戏状态永远不是学习状态的权威（见 db/migrations 的注释）。
 * 这里的材料 / 建筑 / 徽章只读 inventory / unlock / attempt / proficiency_state。
 *
 * session 参数的对应物：Python 所有函数第一个参数都是 SQLAlchemy session，
 * 事务边界由路由层控制。TS 侧只读函数内部直接用全局 `getDb()`；唯一会
 * 写库的 `buildPayload` 接收路由层开好的事务（见 DbExecutor 的说明）。
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type { ContentBundle } from "@/src/content/types";
import { challengeBeats } from "@/src/content/types";
import { getDb, type DbExecutor, type DbTx } from "@/src/db/client";
import { attempt, inventory, unlock } from "@/src/db/schema";
import type { AlgorithmConfig } from "@/src/engine/config";
import type { CompetencyGraph } from "@/src/engine/graph";
import { deriveLevel, isMastered } from "@/src/engine/state-machine";
import type { ChildLearningState } from "@/src/engine/types";
import { listExperiments } from "@/src/lab/service";
import { pyRound } from "@/src/py/pyround";
import { sortedBy, sortedStrings } from "@/src/py/pysort";

// ── P5 待接管的常量（内容是资产，规则应可配置） ─────────────

export interface UniverseDef {
  code: string;
  name: string;
  emoji: string;
}

export interface BuildingDef {
  code: string;
  name: string;
  emoji: string;
  cost: Record<string, number>;
  unlocks: string[];
}

export interface BadgeDef {
  code: string;
  name: string;
  emoji: string;
  competency: string;
}

export const UNIVERSES: UniverseDef[] = [
  { code: "number_station", name: "数字车站", emoji: "🚂" },
  { code: "detective", name: "侦探社", emoji: "🦊" },
];

export const BUILDINGS: BuildingDef[] = [
  {
    code: "ticket_booth",
    name: "售票亭",
    emoji: "🎫",
    cost: { wood: 5, coin: 2 },
    unlocks: [],
  },
  {
    code: "platform",
    name: "站台",
    emoji: "🛤️",
    cost: { wood: 10, coin: 5 },
    unlocks: ["universe.detective"],
  },
];

export const BADGES: BadgeDef[] = [
  { code: "first_make_ten", name: "第一次凑十", emoji: "🎖️", competency: "make_ten" },
  { code: "first_carry", name: "第一次进位", emoji: "🚃", competency: "carry_add" },
];

export const MATERIAL_CODES = ["wood", "coin", "gem", "seed"];

export const COMPETENCY_EMOJI: Record<string, string> = {
  sd_add_10: "➕",
  sd_sub_10: "➖",
  sd_add_20: "🔢",
  sd_sub_20: "🔽",
  make_ten: "🔟",
  place_value: "🚃",
  td_add_nocarry: "🧮",
  td_sub_nocarry: "📉",
  carry_add: "🔁",
  borrow_sub: "🔄",
};

export const DEFAULT_UNIVERSE = "number_station";

// ── 基础读取 ───────────────────────────────────────────────

export async function materialsOf(
  childId: number,
  client?: DbExecutor,
): Promise<Record<string, number>> {
  const db = client ?? getDb();
  const out: Record<string, number> = {};
  for (const code of MATERIAL_CODES) {
    out[code] = 0;
  }
  const rows = await db.select().from(inventory).where(eq(inventory.childId, childId));
  for (const row of rows) {
    // Python：`out[row.item_code] = int(row.count or 0)` —— item_code 不在
    // MATERIAL_CODES 里也会加键（未来掉落物不因常量表滞后而丢失）
    out[row.itemCode] = Math.trunc(row.count ?? 0);
  }
  return out;
}

export async function unlockedCodes(childId: number, client?: DbExecutor): Promise<Set<string>> {
  const db = client ?? getDb();
  const rows = await db
    .select({ unlockCode: unlock.unlockCode })
    .from(unlock)
    .where(eq(unlock.childId, childId));
  return new Set(rows.map((row) => row.unlockCode));
}

export function competencyEmoji(code: string): string {
  return COMPETENCY_EMOJI[code] ?? "📘";
}

/** 契约 §7：实验列表。解锁规则整套由 `src/lab` 负责（配置构建产物）。 */
export function labPayload(state: ChildLearningState, cfg: AlgorithmConfig): Record<string, unknown> {
  const levelOf = (competencyCode: string): string => {
    const signals = state.competencies.get(competencyCode);
    if (signals === undefined) {
      return cfg.level_order[0]!;
    }
    return deriveLevel(signals, cfg);
  };
  return {
    experiments: listExperiments(levelOf, [...cfg.level_order]),
  };
}

// ── 故事完成度（用 attempt 的 slot_code 反推） ─────────────

export async function completedStoryCodes(childId: number, bundle: ContentBundle): Promise<string[]> {
  const db = getDb();
  const done: string[] = [];
  for (const story of bundle.stories.values()) {
    const slotCodes = challengeBeats(story)
      .map((beat) => beat.slot_code)
      .filter((code): code is string => Boolean(code));
    if (slotCodes.length === 0) {
      continue;
    }
    const rows = await db
      .selectDistinct({ slotCode: attempt.slotCode })
      .from(attempt)
      .where(and(eq(attempt.childId, childId), inArray(attempt.slotCode, slotCodes)));
    const hit = new Set<string>();
    for (const row of rows) {
      if (row.slotCode) {
        hit.add(row.slotCode);
      }
    }
    if (slotCodes.every((code) => hit.has(code))) {
      done.push(story.code);
    }
  }
  return done;
}

// ── GET /v1/world ──────────────────────────────────────────

export async function worldPayload(
  child: { id: number; name: string },
  state: ChildLearningState,
  cfg: AlgorithmConfig,
  bundle: ContentBundle,
  budgetMinutes: number,
): Promise<Record<string, unknown>> {
  const completed = new Set(await completedStoryCodes(child.id, bundle));
  const stories = sortedBy([...bundle.stories.values()], (s) => s.order_index, (s) => s.code);

  const universes: Record<string, unknown>[] = [];
  for (const universe of UNIVERSES) {
    const universeStories = stories.filter((s) => s.universe === universe.code);
    const total = universeStories.length;
    const doneCount = universeStories.filter((s) => completed.has(s.code)).length;
    const progress = total ? doneCount / total : 0.0;
    universes.push({
      code: universe.code,
      name: universe.name,
      emoji: universe.emoji,
      unlocked:
        universe.code === DEFAULT_UNIVERSE ||
        (await unlockedCodes(child.id)).has(`universe.${universe.code}`),
      // `round(progress, 4)` 是 Python 的 half-even，用 pyRound
      progress: pyRound(progress, 4),
      stories: universeStories.map((story) => ({
        code: story.code,
        title: story.title,
        completed: completed.has(story.code),
        unlocked: true,
      })),
    });
  }

  const todayStory = stories.find((s) => !completed.has(s.code)) ?? null;
  const today =
    todayStory !== null
      ? {
          headline: todayStory.title,
          subtitle: todayStory.summary || "去数字车站帮它一把",
          story_code: todayStory.code,
          universe_code: todayStory.universe,
          estimated_minutes: todayStory.duration_min || budgetMinutes,
          completed: false,
        }
      : {
          // 没有故事内容（P2 未接入）时的降级：形状不变，字段指向默认宇宙
          headline: "今天来练一练数字吧",
          subtitle: "去数字车站练一练",
          story_code: null,
          universe_code: DEFAULT_UNIVERSE,
          estimated_minutes: budgetMinutes,
          completed: false,
        };

  const codes = await unlockedCodes(child.id);
  return {
    child: { id: child.id, name: child.name },
    today,
    universes,
    lab_unlocked: true,
    detective_unlocked: codes.has("universe.detective"),
    growth_summary: {
      materials: await materialsOf(child.id),
      buildings: sortedStrings([...codes])
        .filter((code) => code.startsWith("building."))
        .map((code) => code.slice(code.indexOf(".") + 1)),
      newest_badge: await newestBadge(child.id, state),
    },
  };
}

// ── GET /v1/growth ─────────────────────────────────────────

export async function badgePayloads(
  childId: number,
  state: ChildLearningState,
): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const out: Record<string, unknown>[] = [];
  for (const badge of BADGES) {
    const signals = state.competencies.get(badge.competency);
    const earned = signals !== undefined && signals.sample_count > 0;
    let earnedAt: string | null = null;
    if (earned) {
      const rows = await db
        .select({ createdAt: attempt.createdAt })
        .from(attempt)
        .where(and(eq(attempt.childId, childId), eq(attempt.competencyCode, badge.competency)))
        .orderBy(asc(attempt.seq))
        .limit(1);
      // created_at 列 notNull，Python 的 `row[0] is not None` 检查在这里
      // 只剩"有没有行"一个分支
      if (rows.length > 0) {
        earnedAt = iso(rows[0]!.createdAt);
      }
    }
    out.push({
      code: badge.code,
      name: badge.name,
      emoji: badge.emoji,
      earned,
      earned_at: earnedAt,
    });
  }
  return out;
}

async function newestBadge(
  childId: number,
  state: ChildLearningState,
): Promise<Record<string, unknown> | null> {
  const earned = (await badgePayloads(childId, state)).filter((b) => b["earned"]);
  if (earned.length === 0) {
    return null;
  }
  const last = earned[earned.length - 1]!;
  return {
    code: last["code"],
    name: last["name"],
    emoji: last["emoji"],
  };
}

export async function growthPayload(
  child: { id: number; name: string },
  state: ChildLearningState,
  cfg: AlgorithmConfig,
  bundle: ContentBundle,
  graph: CompetencyGraph,
): Promise<Record<string, unknown>> {
  const order = graph.topologicalOrder();
  const positionIndex = new Map(order.map((code, index) => [code, index]));

  const nodes: Record<string, unknown>[] = [];
  for (const code of order) {
    const competency = bundle.competencies.get(code);
    if (competency === undefined) {
      continue;
    }
    const signals = state.competencies.get(code);
    const level = signals !== undefined ? deriveLevel(signals, cfg) : cfg.level_order[0]!;
    nodes.push({
      code,
      name: competency.name,
      level,
      level_label: cfg.levelLabel(level),
      mastered: isMastered(state, code, graph, cfg),
      emoji: competencyEmoji(code),
      unlocked: true,
      position: { x: positionIndex.get(code) ?? 0, y: competency.stage },
    });
  }

  const edges: Record<string, string>[] = [];
  for (const code of order) {
    for (const prereq of graph.prerequisites(code)) {
      edges.push({ from: prereq, to: code });
    }
  }

  const built = new Set(
    [...(await unlockedCodes(child.id))]
      .filter((code) => code.startsWith("building."))
      .map((code) => code.slice(code.indexOf(".") + 1)),
  );
  return {
    tree: { nodes, edges },
    materials: await materialsOf(child.id),
    buildings: BUILDINGS.map((row) => ({
      code: row.code,
      name: row.name,
      emoji: row.emoji,
      built: built.has(row.code),
      cost: row.cost,
    })),
    badges: await badgePayloads(child.id, state),
  };
}

/**
 * POST /v1/growth/build：材料足够则扣减并解锁。
 *
 * 只在路由层开好的事务里跑（Python 侧 `session.commit()` 也在路由层）。
 * 材料不足**不是错误**：返回 200 + `built: false` + 原因。
 */
export async function buildPayload(
  tx: DbTx,
  childId: number,
  building: BuildingDef,
): Promise<Record<string, unknown>> {
  const materials = await materialsOf(childId, tx);
  const cost = building.cost;
  const missing: Record<string, number> = {};
  for (const [code, need] of Object.entries(cost)) {
    if ((materials[code] ?? 0) < need) {
      missing[code] = need - (materials[code] ?? 0);
    }
  }
  if (Object.keys(missing).length > 0) {
    return {
      built: false,
      reason: "材料不足",
      materials,
      missing,
      unlocks: [],
    };
  }

  for (const [code, need] of Object.entries(cost)) {
    const rows = await tx
      .select()
      .from(inventory)
      .where(and(eq(inventory.childId, childId), eq(inventory.itemCode, code)));
    const current = rows.length > 0 ? (rows[0]!.count ?? 0) : 0;
    const next = current - need;
    // Python：查不到就 new 一行 count=0 再减 —— upsert 等价
    await tx
      .insert(inventory)
      .values({ childId, itemCode: code, count: next })
      .onConflictDoUpdate({
        target: [inventory.childId, inventory.itemCode],
        set: { count: next },
      });
  }

  const unlockCodesNow: string[] = [];
  for (const unlockCode of building.unlocks ?? []) {
    const exists = await tx
      .select({ unlockCode: unlock.unlockCode })
      .from(unlock)
      .where(and(eq(unlock.childId, childId), eq(unlock.unlockCode, unlockCode)))
      .limit(1);
    if (exists.length === 0) {
      await tx.insert(unlock).values({ childId, unlockCode });
    }
    // 已存在也计入返回列表 —— Python 的 append 在 if 外面，照抄
    unlockCodesNow.push(unlockCode);
  }
  // Python 这里不查重直接 add：重复建造同一建筑会撞主键 —— 两侧行为一致
  await tx.insert(unlock).values({ childId, unlockCode: `building.${building.code}` });
  return {
    built: true,
    materials: await materialsOf(childId, tx),
    unlocks: unlockCodesNow,
  };
}

/**
 * Python `_iso(value)`：aware datetime.isoformat()，naive 才补 "Z"。
 *
 * psycopg2 / node-pg 从 timestamptz 读出的值永远是 aware，所以只实现
 * aware 分支：时区后缀 +00:00（isoformat 对 UTC aware datetime 的输出；
 * psycopg2 的 tzinfo 跟随 session 时区，本地与 Neon 默认都是 UTC）。
 * 微秒：node-pg 只有毫秒精度 —— 毫秒为 0 时两侧 isoformat 都不带小数，
 * 非 0 时 Python 是 6 位、这里是毫秒×1000 补齐 6 位（api-contract 对拍
 * 的时间戳归一化在 #50 统一处理）。
 */
function iso(value: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const base =
    `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}` +
    `T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  const ms = value.getUTCMilliseconds();
  const fraction = ms === 0 ? "" : `.${pad(ms * 1000, 6)}`;
  return `${base}${fraction}+00:00`;
}
