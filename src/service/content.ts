/**
 * 内容读取服务 —— `backend/service/content.py` 的移植。
 *
 * 内容的部署形态是数据库（scripts/init-db.ts 把 build/content_dump.json
 * 导入 item / competency / pattern / misconception / challenge_slot / story
 * 等表），本模块负责把 DB 行重新组装成引擎认识的 ContentBundle。
 *
 * 回退规则：数据库里一条 item 都没有时（开发环境还没跑 init_db），回退到
 * 内存内容 loadBundle() —— API 不至于因为没初始化就不可用。
 * 一旦 DB 有内容，DB 就是唯一来源。
 *
 * 硬性不变量：**answer / steps 永不下发前端**（契约 §0/§3）。
 * 本模块是唯一的 item 载荷生产点，itemPayload() 里不出现这两个字段。
 */
import { asc, eq } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import {
  challengeSlot,
  competency,
  competencyPrerequisite,
  item as itemTable,
  misconception,
  patternCompetency,
  problemPattern,
  story as storyTable,
  storyBeat,
} from "@/src/db/schema";
import {
  loadBundle,
  loadCompetencies,
} from "@/src/content/loader";
import type {
  ChallengeSlot,
  CognitiveType,
  ContentBundle,
  Item,
  Pattern,
  StoryBeat,
} from "@/src/content/types";
import { effectiveScaffold, selectItem } from "@/src/engine/selector";
import type { AlgorithmConfig } from "@/src/engine/config";
import type { ChildLearningState } from "@/src/engine/types";

/** visual.kind 的默认值（契约 §6）。故事内容尚未提供 visual 字段时用它兜底。 */
const DEFAULT_VISUAL_KIND = "station";

// ── 载荷序列化（纯函数） ───────────────────────────────────

/** choice 题的选项数组。 */
export function choicesFor(item: Item): number[] | null {
  /** 内容模型没有 choices 字段（P1 缺口，见 P2 报告），这里从 error_rules 的
   * `answer_in` / `answer_equals` 反推"典型错法集合"，与正确答案合并成选项。 */
  if (item.interaction_type !== "choice") {
    return null;
  }
  const values = new Set<number>();
  if (typeof item.answer === "number" && Number.isFinite(item.answer)) {
    values.add(item.answer);
  }
  for (const rule of item.error_rules ?? []) {
    const match = (rule["match"] as Record<string, unknown> | undefined) ?? {};
    for (const value of ((match["answer_in"] as unknown[] | undefined) ?? []) as unknown[]) {
      if (typeof value === "number") {
        values.add(value);
      }
    }
    if (typeof match["answer_equals"] === "number") {
      values.add(match["answer_equals"] as number);
    }
  }
  if (values.size === 0) {
    return null;
  }
  return [...values].sort((a, b) => a - b);
}

/** 契约 §3 的 Item 载荷。**不含 answer，不含 steps。** */
export function itemPayload(item: Item): Record<string, unknown> {
  const problem: Record<string, unknown> = { ...(item.problem ?? {}) };
  const prompt = problem["prompt"];
  delete problem["prompt"];
  return {
    code: item.code,
    competency: item.competency_id,
    pattern: item.pattern_id,
    difficulty: item.difficulty,
    scaffold_level: item.scaffold_level,
    interaction_type: item.interaction_type,
    estimated_seconds: item.estimated_seconds,
    prompt,
    problem,
    answer_type: item.interaction_type === "choice" ? "choice" : "number",
    choices: choicesFor(item),
    hints_available: (item.hint_chain ?? []).length,
  };
}

// ── DB → ContentBundle ─────────────────────────────────────

async function bundleFromDb(): Promise<ContentBundle | null> {
  const db = getDb();
  const itemRows = await db.select().from(itemTable);
  if (itemRows.length === 0) {
    return null;
  }

  const prereqRows = await db.select().from(competencyPrerequisite);
  const prerequisites = new Map<string, string[]>();
  for (const row of prereqRows) {
    const list = prerequisites.get(row.competencyCode) ?? [];
    list.push(row.prerequisiteCode);
    prerequisites.set(row.competencyCode, list);
  }

  // terms 只用于 AI 教练的"不超纲"护栏，尚未入库（P1 缺口），从内存内容回填
  let memoryCompetencies: Map<string, { terms: string[] }>;
  try {
    memoryCompetencies = loadCompetencies();
  } catch {
    // 内容目录缺失时不影响主流程
    memoryCompetencies = new Map();
  }

  const competencies = new Map(
    (await db.select().from(competency)).map((row) => {
      const memory = memoryCompetencies.get(row.code);
      return [
        row.code,
        {
          code: row.code,
          name: row.name,
          description: row.description ?? "",
          prerequisites: [...(prerequisites.get(row.code) ?? [])].sort(),
          stage: row.stage,
          terms: memory ? [...memory.terms] : [],
        },
      ];
    }),
  );

  const patternRows = await db.select().from(patternCompetency);
  const related = new Map<string, string[]>();
  const primaryByPattern = new Map<string, string>();
  for (const row of patternRows) {
    const list = related.get(row.patternCode) ?? [];
    list.push(row.competencyCode);
    related.set(row.patternCode, list);
    if (row.isPrimary) {
      primaryByPattern.set(row.patternCode, row.competencyCode);
    }
  }

  const patterns = new Map(
    (await db.select().from(problemPattern)).map((row) => {
      const primary = primaryByPattern.get(row.code);
      return [
        row.code,
        {
          code: row.code,
          name: row.name,
          cognitive_type: row.cognitiveType as CognitiveType,
          primary_competency: primary as string,
          applicable_competencies: (related.get(row.code) ?? []).filter(
            (code) => code !== primary,
          ).sort(),
          description: row.description ?? "",
        },
      ];
    }),
  );

  const misconceptions = new Map(
    (await db.select().from(misconception)).map((row) => [
      row.code,
      {
        code: row.code,
        name: row.name,
        description: row.description ?? "",
        severity: row.severity,
        remediation_competency: row.remediationCompetency,
      },
    ]),
  );

  const items = new Map(
    itemRows.map((row) => [
      row.code,
      {
        code: row.code,
        competency_id: row.competencyCode,
        pattern_id: row.patternCode,
        difficulty: row.difficulty,
        scaffold_level: row.scaffoldLevel as Item["scaffold_level"],
        interaction_type: row.interactionType,
        estimated_seconds: row.estimatedSeconds,
        problem: (row.problemJson ?? {}) as Record<string, unknown>,
        answer: row.answerJson,
        steps: (row.stepsJson ?? []) as string[],
        hint_chain: (row.hintChainJson ?? []) as string[],
        error_rules: (row.errorRulesJson ?? []) as Item["error_rules"],
        // steps_style 未入库（Python 同），回填 dataclass 默认值 "guide"
        steps_style: "guide" as const,
      } satisfies Item,
    ]),
  );

  const slots = new Map(
    (await db.select().from(challengeSlot)).map((row) => [
      row.code,
      {
        code: row.code,
        competency_id: row.competencyCode,
        difficulty_min: row.difficultyMin,
        difficulty_max: row.difficultyMax,
        purpose: row.purpose as ChallengeSlot["purpose"],
        pattern_id: row.patternCode,
        scaffold_level: row.scaffoldLevel as ChallengeSlot["scaffold_level"],
        estimated_seconds: row.estimatedSeconds,
        story_beat_id: row.storyBeatCode,
        selection_policy: (row.selectionPolicyJson ?? {}) as Record<string, unknown>,
        review_policy: (row.reviewPolicyJson ?? {}) as Record<string, unknown>,
      } satisfies ChallengeSlot,
    ]),
  );

  const beatRows = await db
    .select()
    .from(storyBeat)
    .orderBy(asc(storyBeat.storyCode), asc(storyBeat.sequence));
  const slotByBeat = new Map(
    (await db.select().from(challengeSlot))
      .filter((row) => row.storyBeatCode !== null)
      .map((row) => [row.storyBeatCode as string, row.code]),
  );
  const beatsByStory = new Map<string, StoryBeat[]>();
  for (const row of beatRows) {
    const list = beatsByStory.get(row.storyCode) ?? [];
    list.push({
      code: row.code,
      story_code: row.storyCode,
      sequence: row.sequence,
      beat_type: row.beatType as StoryBeat["beat_type"],
      narration: row.narration ?? "",
      character: row.character ?? "",
      slot_code: slotByBeat.get(row.code) ?? null,
    });
    beatsByStory.set(row.storyCode, list);
  }
  const stories = new Map(
    (await db.select().from(storyTable)).map((row) => [
      row.code,
      {
        code: row.code,
        title: row.title,
        universe: row.universeCode,
        summary: row.summary ?? "",
        order_index: row.orderIndex,
        duration_min: row.durationMin ?? 8,
        target_competencies: (row.targetCompetenciesJson ?? []) as string[],
        beats: beatsByStory.get(row.code) ?? [],
      },
    ]),
  );

  return {
    competencies,
    patterns,
    items,
    misconceptions,
    slots,
    stories,
    load_problems: [],
  };
}

// ── 服务（模块级单例） ─────────────────────────────────────

let cachedBundle: ContentBundle | null = null;

/** 内容入口。DB 是权威来源；表为空时回退内存内容（开发环境）。 */
export async function bundle(): Promise<ContentBundle> {
  if (cachedBundle === null) {
    cachedBundle = await bundleFromDb();
    if (cachedBundle === null) {
      cachedBundle = loadBundle();
    }
  }
  return cachedBundle;
}

/** 内容重新导入后调用（测试与开发用）。 */
export function refreshContent(): void {
  cachedBundle = null;
}

function beatVisual(row: { visual_json: unknown } | undefined, character: string) {
  /** 契约 §6 的 visual。DB 有 visual_json 就用它，否则给默认插画描述。 */
  const visual = (row?.visual_json as Record<string, unknown> | null | undefined) ?? {};
  if (Object.keys(visual).length === 0) {
    return {
      kind: DEFAULT_VISUAL_KIND,
      mood: "calm",
      characters: character ? [character] : [],
    };
  }
  return visual;
}

/** 故事载荷（契约 §6）。故事不存在返回 null。 */
export async function storyPayload(
  storyCode: string,
  state: ChildLearningState,
  cfg: AlgorithmConfig,
): Promise<Record<string, unknown> | null> {
  const b = await bundle();
  const story = b.stories.get(storyCode);
  if (story === undefined) {
    return null;
  }

  // visual / reward 只存在于 story_beat 的 JSON 列（loader 的 StoryBeat
  // 不携带它们）。DB 有对应行就拿来装饰；内容走内存回退时给默认值。
  const db = getDb();
  const decorationRows = await db
    .select()
    .from(storyBeat)
    .where(eq(storyBeat.storyCode, storyCode));
  const decorations = new Map(decorationRows.map((row) => [row.code, row]));

  const payloadBeats: Array<Record<string, unknown>> = [];
  for (const beat of [...story.beats].sort((a, b2) => a.sequence - b2.sequence)) {
    const row = decorations.get(beat.code);
    let challenge: Record<string, unknown> | null = null;
    if (beat.slot_code) {
      const slot = b.slots.get(beat.slot_code);
      if (slot !== undefined) {
        const selected = selectItem(slot, state, b, cfg);
        challenge = {
          slot_code: beat.slot_code,
          purpose: slot.purpose,
          scaffold_level: effectiveScaffold(slot, state, cfg),
          item: selected !== null ? itemPayload(selected) : null,
        };
      }
    }
    // 契约 §6 的字段（index/type/narration/visual/reward/challenge）
    // + 前端直接可用的别名（code/sequence/text/character/slot_code）。
    // 两者同源：都从同一个 StoryBeat 生成。
    payloadBeats.push({
      index: beat.sequence,
      sequence: beat.sequence,
      code: beat.code,
      type: beat.beat_type,
      narration: beat.narration,
      text: beat.narration,
      character: beat.character,
      slot_code: beat.slot_code,
      visual: beatVisual(row as { visual_json: unknown } | undefined, beat.character),
      // Python：`dict(row.reward_json) if row.reward_json else None`
      // —— 空 dict 是 falsy，必须输出 null（JS 的 {} 是 truthy，要显式判空）
      reward:
        row !== undefined && row.rewardJson && Object.keys(row.rewardJson).length > 0
          ? { ...row.rewardJson }
          : null,
      challenge,
    });
  }

  return {
    code: story.code,
    universe: story.universe,
    title: story.title,
    summary: story.summary ?? "",
    duration_min: story.duration_min ?? 8,
    order_index: story.order_index,
    beats: payloadBeats,
  };
}
