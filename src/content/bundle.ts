/**
 * 运行时内容入口 —— 从构建期产物还原 `ContentBundle`。
 *
 * ⚠️ `import "server-only"`：content.json 有 1.2MB。这里的任何东西一旦被
 * client component 引到，整个内容库会跟 1,373 道题的 **answer 字段** 一起
 * 打进浏览器包。这不只是体积问题，answer 是绝不能下发前端的（见 docs/api-contract.md）。
 * server-only 让这类误引在构建期就报错，而不是等到有人翻 DevTools。
 *
 * 产物由 `npm run build:content`（scripts/build-content.ts）生成，
 * 形状见 src/content/dump.ts。**运行时绝不读 YAML**。
 */
import "server-only";

import rawContent from "../generated/content.json";
import rawIndex from "../generated/content.index.json";

import {
  type ChallengeSlot,
  type Competency,
  type ContentBundle,
  type ContentDump,
  type ContentIndex,
  type Item,
  type Misconception,
  type Pattern,
  type Story,
  type StoryBeat,
} from "./types";

/**
 * 按 `load_order` 重建 Map —— 这一步是刻意的，不是绕远路。
 *
 * content.json 里的数组按 code 排序（= Python `cmd_dump` 的输出），
 * 而 Python **运行时**的 dict 迭代顺序是"文件路径排序 → 文件内行序"。
 * 直接 `new Map(rows.map(r => [r.code, r]))` 得到的是字典序，
 * 与 Python 不是同一个顺序 —— 一旦某处代码依赖"取第一个匹配"，就会静默错。
 *
 * 所以这里按 load_order 插入。代价 O(n)，换来"顺序问题不存在"。
 */
function reorder<T extends { code: string }>(
  rows: readonly T[],
  codes: readonly string[],
  kind: string,
): Map<string, T> {
  const remaining = new Map<string, T>();
  for (const row of rows) {
    if (remaining.has(row.code)) {
      // 构建脚本已把 code 重复当致命错误拦掉，能走到这里说明产物被人手改过
      // 或者两个产物文件不是同一次构建的产物。宁可炸，不要静默丢一条。
      throw new Error(`content.json 的 ${kind} 存在重复 code：${row.code}`);
    }
    remaining.set(row.code, row);
  }

  const out = new Map<string, T>();
  for (const code of codes) {
    const row = remaining.get(code);
    if (row === undefined) {
      throw new Error(`content.index.json 的 load_order.${kind} 指向不存在的 code：${code}`);
    }
    out.set(code, row);
    remaining.delete(code);
  }
  if (remaining.size > 0) {
    const sample = [...remaining.keys()].slice(0, 5).join("、");
    throw new Error(
      `content.index.json 的 load_order.${kind} 漏了 ${remaining.size} 个 code（如 ${sample}）` +
        ` —— content.json 与 content.index.json 不是同一次构建的产物，请重跑 npm run build:content`,
    );
  }
  return out;
}

/**
 * 故事节拍。
 *
 * 这里补回 dump 丢掉的 `story_code`（= 所属故事的 code，从 code 的
 * "{story_code}__{local}" 约定反推，与 loader.py:376 一致）。
 *
 * ⚠️ 已知差异（已确认无害，S1-3 会把它记进"有意差异"清单）：
 *   loader 的 `story.beats` 是**声明顺序**，dump 里是 `ordered_beats()` 的
 *   **sequence 顺序**。TS 运行时拿到的是后者。
 *   影响面：Python 里直接迭代 `story.beats` 的只有 link_slots_to_beats
 *   （走 dict，与顺序无关）和 _validate_stories（只影响报错文案顺序）；
 *   所有要"按顺序"的地方都调 ordered_beats()/challenge_beats()，而那两个
 *   在已排好序的数组上再排一次是幂等的。
 *   另外 validate_content 禁止 sequence 重复，所以两种顺序在合法内容上一致。
 */
function rehydrateStory(story: ContentDump["stories"][number]): Story {
  return {
    code: story.code,
    title: story.title,
    universe: story.universe,
    summary: story.summary,
    order_index: story.order_index,
    duration_min: story.duration_min,
    target_competencies: story.target_competencies,
    beats: story.beats.map(
      (beat): StoryBeat => ({
        code: beat.code,
        story_code: story.code,
        sequence: beat.sequence,
        beat_type: beat.beat_type,
        narration: beat.narration,
        character: beat.character,
        slot_code: beat.slot_code,
      }),
    ),
  };
}

function buildBundle(): ContentBundle {
  // JSON 模块的类型推断只会给出 string/number 这类宽类型，与内容模型的
  // 字面量联合（ScaffoldLevel / SlotPurpose / ...）对不上。
  // 真正的把关不在这里，而在于：**产物是构建期按内容模型写出来的**，
  // 加上 S1-3 的逐字段对拍。这里断言只是为了让类型系统放行。
  const dump = rawContent as unknown as ContentDump;
  const index = rawIndex as unknown as ContentIndex;
  const order = index.load_order;

  const competencies = reorder<Competency>(
    dump.competencies.map(
      (c): Competency => ({
        code: c.code,
        name: c.name,
        description: c.description,
        prerequisites: c.prerequisites,
        stage: c.stage,
        // terms 不在 dump 里（competency 表也没这列）—— 从索引文件回填，
        // 否则 AI 教练的"不超纲"护栏会静默失效。见 dump.ts 的 ContentIndex 注释。
        terms: index.competency_terms[c.code] ?? [],
      }),
    ),
    order.competencies,
    "competency",
  );

  const patterns = reorder<Pattern>(
    dump.patterns.map(
      (p): Pattern => ({
        code: p.code,
        name: p.name,
        cognitive_type: p.cognitive_type,
        primary_competency: p.primary_competency,
        applicable_competencies: p.applicable_competencies,
        description: p.description,
      }),
    ),
    order.patterns,
    "pattern",
  );

  const misconceptions = reorder<Misconception>(
    dump.misconceptions,
    order.misconceptions,
    "misconception",
  );

  const items = reorder<Item>(
    dump.items.map(
      (i): Item => ({
        code: i.code,
        competency_id: i.competency,
        pattern_id: i.pattern,
        difficulty: i.difficulty,
        scaffold_level: i.scaffold_level,
        interaction_type: i.interaction_type,
        estimated_seconds: i.estimated_seconds,
        problem: i.problem,
        answer: i.answer,
        steps: i.steps,
        hint_chain: i.hint_chain,
        error_rules: i.error_rules,
        steps_style: i.steps_style,
      }),
    ),
    order.items,
    "item",
  );

  const slots = reorder<ChallengeSlot>(
    dump.slots.map(
      (s): ChallengeSlot => ({
        code: s.code,
        competency_id: s.competency,
        difficulty_min: s.difficulty_min,
        difficulty_max: s.difficulty_max,
        purpose: s.purpose,
        pattern_id: s.pattern,
        scaffold_level: s.scaffold_level,
        estimated_seconds: s.estimated_seconds,
        story_beat_id: s.story_beat_id,
        selection_policy: s.selection_policy,
        review_policy: s.review_policy,
      }),
    ),
    order.slots,
    "slot",
  );

  const stories = reorder<Story>(
    dump.stories.map(rehydrateStory),
    order.stories,
    "story",
  );

  return {
    competencies,
    patterns,
    items,
    misconceptions,
    slots,
    stories,
    // 构建期已经保证没有加载期问题了（有问题直接构建失败）。
    // 保留空数组是为了让两个入口返回同一个类型。
    load_problems: [],
  };
}

let cached: ContentBundle | null = null;

/**
 * 运行时内容包（进程内缓存）。
 *
 * serverless 下每个实例冷启动建一次，之后复用 —— 1373 道题的 Map 重建
 * 是毫秒级，但没必要每个请求都做一遍。
 */
export function contentBundle(): ContentBundle {
  cached ??= buildBundle();
  return cached;
}

export type { ContentBundle };
