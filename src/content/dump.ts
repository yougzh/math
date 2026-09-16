/**
 * 内容 dump —— `tools/content_cli/main.py::cmd_dump` 的 TypeScript 移植。
 *
 * 构建期专用（`scripts/build-content.ts` 调用）；运行时只读产物
 * `src/generated/content.json`，不 import 这个文件。
 *
 * ⚠️ 移植纪律：下面每个排序的**排序键**都逐字抄自 cmd_dump ——
 * 键的先后顺序、是否先 set 去重、升序还是降序，任何一处"顺手改好"
 * 都会让 S1-3 的逐字段对拍变红。对拍变红不代表对拍太严，代表产物真的变了。
 *
 * 为什么产物镜像 cmd_dump 而不是 loader 的插入顺序：
 *   cmd_dump 是"数据库导入的唯一输入格式"（P2 起 Python 侧也是它），
 *   TS 运行时要吃的是同一份事实。所以 content.json = dump 形状（按 code 排序），
 *   而 Python 运行时的**插入顺序**另存在 content.index.json 的 load_order 里
 *   —— 那份顺序在运行时无法重算，丢了就再也对不上了。
 */
import {
  orderedBeats,
  type ContentBundle,
  type ContentDump,
  type ContentIndex,
  type DumpBeat,
  type DumpCompetency,
  type DumpItem,
  type DumpMisconception,
  type DumpPattern,
  type DumpSlot,
  type DumpStory,
} from "./types";
import { sortedBy, sortedStrings } from "@/src/py/pysort";

/**
 * 内容 → cmd_dump 的 payload。
 *
 * `contentVersion` 对应 `cmd_dump --version`（默认 "v0.1.0"）：
 * 它会落进 content_release 表，是内容版本 pin 的锚点（ADR-0002 同源思路）。
 *
 * ⚠️ 这里对 `problem` / `answer` / `steps` / `error_rules` / `prerequisites` /
 * `selection_policy` 等**按引用带出，不拷贝** —— 这是刻意跟 cmd_dump 保持一致的
 * （Python 那边 `dict(row)` 也只是浅拷贝一层，内层对象照样共享）。
 * 安全性来自调用方：产物拿到后立刻 JSON.stringify 落盘，没有任何人再改它。
 * 想"顺手改成深拷贝"之前先想清楚：改了不会更对，只会离 Python 更远。
 */
export function toContentDump(bundle: ContentBundle, contentVersion: string): ContentDump {
  return {
    content_version: contentVersion,
    counts: {
      competencies: bundle.competencies.size,
      patterns: bundle.patterns.size,
      items: bundle.items.size,
      misconceptions: bundle.misconceptions.size,
      slots: bundle.slots.size,
      stories: bundle.stories.size,
    },

    // sorted(..., key=lambda c: (c.stage, c.code))
    competencies: sortedBy(
      bundle.competencies.values(),
      (c) => c.stage,
      (c) => c.code,
    ).map(
      (c): DumpCompetency => ({
        code: c.code,
        name: c.name,
        description: c.description,
        stage: c.stage,
        prerequisites: c.prerequisites,
      }),
    ),

    // sorted(..., key=lambda p: p.code)；applicable 先做 set 并集再排序
    patterns: sortedBy(bundle.patterns.values(), (p) => p.code).map(
      (p): DumpPattern => ({
        code: p.code,
        name: p.name,
        cognitive_type: p.cognitive_type,
        primary_competency: p.primary_competency,
        // Python: sorted(set(p.applicable_competencies) | {p.primary_competency})
        // 注意 primary 一定会出现在结果里，即使它没写进 applicable_competencies
        applicable_competencies: sortedStrings(
          new Set([...p.applicable_competencies, p.primary_competency]),
        ),
        description: p.description,
      }),
    ),

    misconceptions: sortedBy(bundle.misconceptions.values(), (m) => m.code).map(
      (m): DumpMisconception => ({
        code: m.code,
        name: m.name,
        description: m.description,
        severity: m.severity,
        remediation_competency: m.remediation_competency,
      }),
    ),

    // 注意：answer 只进数据库，永不下发前端（见 docs/api-contract.md）
    items: sortedBy(bundle.items.values(), (i) => i.code).map(
      (i): DumpItem => ({
        code: i.code,
        competency: i.competency_id,
        pattern: i.pattern_id,
        difficulty: i.difficulty,
        scaffold_level: i.scaffold_level,
        interaction_type: i.interaction_type,
        estimated_seconds: i.estimated_seconds,
        problem: i.problem,
        answer: i.answer,
        steps: i.steps,
        steps_style: i.steps_style,
        hint_chain: i.hint_chain,
        error_rules: i.error_rules,
      }),
    ),

    stories: sortedBy(bundle.stories.values(), (s) => s.code).map(
      (s): DumpStory => ({
        code: s.code,
        universe: s.universe,
        title: s.title,
        summary: s.summary,
        duration_min: s.duration_min,
        order_index: s.order_index,
        target_competencies: s.target_competencies,
        // s.ordered_beats() —— 按 sequence 排（稳定，sequence 相同时保留声明顺序）
        beats: orderedBeats(s).map(
          (b): DumpBeat => ({
            code: b.code,
            sequence: b.sequence,
            beat_type: b.beat_type,
            narration: b.narration,
            character: b.character,
            // 挑战节拍挂的槽位（slot 是声明方，这里只是快照回填）；
            // 故事播放器逐 beat 出题靠它映射，narration/reward 节拍为 null
            slot_code: b.slot_code,
            // visual / reward **不在内容层**：loader 的 StoryBeat 就没有这两个字段，
            // 它们来自 DB 的 story_beat.visual_json / reward_json，
            // 为空时由 service/content.py::_beat_visual 补默认插画。
            // 所以这里恒为 {}，与 cmd_dump 逐字一致。
            visual: {},
            reward: {},
          }),
        ),
      }),
    ),

    slots: sortedBy(bundle.slots.values(), (s) => s.code).map(
      (s): DumpSlot => ({
        code: s.code,
        story_beat_id: s.story_beat_id,
        competency: s.competency_id,
        pattern: s.pattern_id,
        difficulty_min: s.difficulty_min,
        difficulty_max: s.difficulty_max,
        purpose: s.purpose,
        scaffold_level: s.scaffold_level,
        estimated_seconds: s.estimated_seconds,
        selection_policy: s.selection_policy,
        review_policy: s.review_policy,
      }),
    ),
  };
}

/**
 * 运行时索引的构造 —— 为什么只放这些东西，见 types.ts 的 `ContentIndex`。
 */
export function buildContentIndex(bundle: ContentBundle, fingerprint: string): ContentIndex {
  const competencyTerms: Record<string, string[]> = {};
  for (const competency of bundle.competencies.values()) {
    // 拷贝一份：索引是"某一刻的快照"，不是 bundle 的实时视图。
    // 与 toContentDump 的引用共享不同 —— 那边是刻意的，为了逐字对齐 cmd_dump。
    competencyTerms[competency.code] = [...competency.terms];
  }
  return {
    source_fingerprint: fingerprint,
    load_order: {
      competencies: [...bundle.competencies.keys()],
      patterns: [...bundle.patterns.keys()],
      misconceptions: [...bundle.misconceptions.keys()],
      items: [...bundle.items.keys()],
      slots: [...bundle.slots.keys()],
      stories: [...bundle.stories.keys()],
    },
    competency_terms: competencyTerms,
  };
}
