/**
 * `toContentDump` / `buildContentIndex` 的**合成数据**单测。
 *
 * 为什么在 content-parity 之外还要这一层
 * --------------------------------------
 * content-parity 比的是"当前内容下的产物"，它只能证明**当前内容走过的分支**是对的。
 * 实测就抓到过一个盲区：competency 的排序键是 `(stage, code)`，而现有 10 个能力
 * 全是 stage 1 —— 把排序键改成 `(code)` 对拍依然全绿。等 stage 2 内容进来才会炸，
 * 而那时候已经没人记得这个键存在过。
 *
 * 所以这里用手搭的 bundle 去戳**对拍数据覆盖不到的语义**：
 *   - 多 stage 的排序
 *   - applicable_competencies 的 set 并集 + 去重 + 排序
 *   - beats 按 sequence 排（而不是声明顺序），且相等时稳定
 *   - 哪些字段是"原样保留顺序"（target_competencies）—— 排序它会改变语义
 *
 * 这些用例是"照抄 cmd_dump 的语义"的说明书，改动前先读这里。
 */
import { describe, expect, it } from "vitest";

import { buildContentIndex, toContentDump } from "@/src/content/dump";
import { sortedBy, sortedStrings } from "@/src/py/pysort";
import type {
  ChallengeSlot,
  Competency,
  ContentBundle,
  Item,
  Misconception,
  Pattern,
  Story,
} from "@/src/content/types";

// ── 手搭 fixture 的小工具 ─────────────────────────────────

function competency(code: string, stage: number, overrides: Partial<Competency> = {}): Competency {
  return {
    code,
    name: code,
    description: "",
    prerequisites: [],
    stage,
    terms: [],
    ...overrides,
  };
}

function pattern(code: string, overrides: Partial<Pattern> = {}): Pattern {
  return {
    code,
    name: code,
    cognitive_type: "compute",
    primary_competency: "comp",
    applicable_competencies: [],
    description: "",
    ...overrides,
  };
}

function item(code: string, overrides: Partial<Item> = {}): Item {
  return {
    code,
    competency_id: "comp",
    pattern_id: "pat",
    difficulty: 1,
    scaffold_level: "direct",
    interaction_type: "number_pad",
    estimated_seconds: 15,
    problem: {},
    answer: 1,
    steps: [],
    hint_chain: ["想一想"],
    error_rules: [],
    steps_style: "guide",
    ...overrides,
  };
}

function slot(code: string, overrides: Partial<ChallengeSlot> = {}): ChallengeSlot {
  return {
    code,
    competency_id: "comp",
    difficulty_min: 1,
    difficulty_max: 5,
    purpose: "practice",
    pattern_id: null,
    scaffold_level: "auto",
    estimated_seconds: 20,
    story_beat_id: null,
    selection_policy: {},
    review_policy: {},
    ...overrides,
  };
}

function bundle(parts: Partial<ContentBundle> = {}): ContentBundle {
  return {
    competencies: new Map(),
    patterns: new Map(),
    items: new Map(),
    misconceptions: new Map(),
    slots: new Map(),
    stories: new Map(),
    load_problems: [],
    ...parts,
  };
}

/** 用插入顺序建 Map —— 刻意不排序，好让"是否按 code 排"这件事可断言 */
function mapOf<T extends { code: string }>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) out.set(row.code, row);
  return out;
}

// ── 排序原语 ──────────────────────────────────────────────

describe("sortedStrings / sortedBy：Python sorted 的等价语义", () => {
  it("sortedStrings 是升序的字典序，不改原数组", () => {
    const input = ["b", "a", "c"];
    expect(sortedStrings(input)).toEqual(["a", "b", "c"]);
    expect(input).toEqual(["b", "a", "c"]);
  });

  it("sortedBy 按传入的键依次比较（等价 Python 元组比较）", () => {
    const rows = [
      { stage: 2, code: "a" },
      { stage: 1, code: "z" },
      { stage: 1, code: "a" },
    ];
    expect(sortedBy(rows, (r) => r.stage, (r) => r.code)).toEqual([
      { stage: 1, code: "a" },
      { stage: 1, code: "z" },
      { stage: 2, code: "a" },
    ]);
  });

  it("键全部相等时保持原顺序（稳定排序，与 Python 一致）", () => {
    const rows = [
      { seq: 1, tag: "先" },
      { seq: 1, tag: "后" },
    ];
    expect(sortedBy(rows, (r) => r.seq).map((r) => r.tag)).toEqual(["先", "后"]);
  });
});

// ── competencies ─────────────────────────────────────────

describe("toContentDump：competencies", () => {
  it("排序键是 (stage, code)：stage 优先于 code", () => {
    // 单看 code 应排 aaa, zzz；stage 优先后 zzz(stage 1) 必须在前
    const dump = toContentDump(
      bundle({ competencies: mapOf([competency("aaa", 2), competency("zzz", 1)]) }),
      "v-test",
    );
    expect(dump.competencies.map((c) => c.code)).toEqual(["zzz", "aaa"]);
  });

  it("导出字段里没有 terms（terms 走 content.index.json，不在 dump 形状里）", () => {
    const dump = toContentDump(
      bundle({ competencies: mapOf([competency("comp", 1, { terms: ["凑十"] })]) }),
      "v-test",
    );
    expect(Object.keys(dump.competencies[0]!)).toEqual([
      "code",
      "name",
      "description",
      "stage",
      "prerequisites",
    ]);
    expect(dump.competencies[0]).not.toHaveProperty("terms");
  });

  it("prerequisites 原样保留顺序（不是排序后输出）", () => {
    const dump = toContentDump(
      bundle({
        competencies: mapOf([competency("comp", 1, { prerequisites: ["zebra", "apple"] })]),
      }),
      "v-test",
    );
    expect(dump.competencies[0]!.prerequisites).toEqual(["zebra", "apple"]);
  });
});

// ── patterns ─────────────────────────────────────────────

describe("toContentDump：patterns 的 applicable_competencies", () => {
  it("results = sorted(set(applicable) ∪ {primary})：primary 一定在，且不重复", () => {
    const dump = toContentDump(
      bundle({
        patterns: mapOf([
          pattern("pat", {
            primary_competency: "b_primary",
            applicable_competencies: ["c_extra", "a_extra"],
          }),
        ]),
      }),
      "v-test",
    );
    expect(dump.patterns[0]!.applicable_competencies).toEqual(["a_extra", "b_primary", "c_extra"]);
  });

  it("primary 已在 applicable 里时不产生重复项", () => {
    const dump = toContentDump(
      bundle({
        patterns: mapOf([
          pattern("pat", {
            primary_competency: "same",
            applicable_competencies: ["same", "same"],
          }),
        ]),
      }),
      "v-test",
    );
    expect(dump.patterns[0]!.applicable_competencies).toEqual(["same"]);
  });

  it("applicable 为空时结果仍含 primary", () => {
    const dump = toContentDump(
      bundle({ patterns: mapOf([pattern("pat", { primary_competency: "only" })]) }),
      "v-test",
    );
    expect(dump.patterns[0]!.applicable_competencies).toEqual(["only"]);
  });

  it("按 code 排序", () => {
    const dump = toContentDump(
      bundle({ patterns: mapOf([pattern("zzz"), pattern("aaa")]) }),
      "v-test",
    );
    expect(dump.patterns.map((p) => p.code)).toEqual(["aaa", "zzz"]);
  });
});

// ── items ────────────────────────────────────────────────

describe("toContentDump：items", () => {
  it("字段改名：competency_id → competency，pattern_id → pattern", () => {
    const dump = toContentDump(
      bundle({
        items: mapOf([item("i1", { competency_id: "c1", pattern_id: "p1" })]),
      }),
      "v-test",
    );
    const row = dump.items[0]!;
    expect(row.competency).toBe("c1");
    expect(row.pattern).toBe("p1");
    expect(row).not.toHaveProperty("competency_id");
    expect(row).not.toHaveProperty("pattern_id");
  });

  it("按 code 排序，且 answer / error_rules / steps 原样带出", () => {
    const rules = [{ code: "miss", match: { answer_equals: 44 } }];
    const dump = toContentDump(
      bundle({
        items: mapOf([
          item("zzz", { answer: 7 }),
          item("aaa", { answer: 3, error_rules: rules }),
        ]),
      }),
      "v-test",
    );
    expect(dump.items.map((i) => i.code)).toEqual(["aaa", "zzz"]);
    expect(dump.items[0]!.answer).toBe(3);
    expect(dump.items[0]!.error_rules).toEqual(rules);
    expect(dump.items[1]!.answer).toBe(7);
  });
});

// ── misconceptions ───────────────────────────────────────

describe("toContentDump：misconceptions", () => {
  it("remediation_competency 的 null 原样保留（不是 undefined 也不是省略）", () => {
    const misc: Misconception = {
      code: "m1",
      name: "m1",
      description: "",
      severity: 2,
      remediation_competency: null,
    };
    const dump = toContentDump(bundle({ misconceptions: mapOf([misc]) }), "v-test");
    expect(dump.misconceptions[0]!.remediation_competency).toBeNull();
    expect(Object.keys(dump.misconceptions[0]!)).toContain("remediation_competency");
  });
});

// ── stories ──────────────────────────────────────────────

describe("toContentDump：stories", () => {
  function story(code: string, beats: Story["beats"]): Story {
    return {
      code,
      title: code,
      universe: "u",
      summary: "",
      order_index: 0,
      duration_min: 8,
      target_competencies: [],
      beats,
    };
  }

  function beat(code: string, sequence: number, slotCode: string | null = null) {
    return {
      code,
      story_code: "s",
      sequence,
      beat_type: "narration" as const,
      narration: "……",
      character: "",
      slot_code: slotCode,
    };
  }

  it("beats 按 sequence 排，而不是声明顺序", () => {
    const dump = toContentDump(
      bundle({
        stories: mapOf([story("s", [beat("s__c", 3), beat("s__a", 1), beat("s__b", 2)])]),
      }),
      "v-test",
    );
    expect(dump.stories[0]!.beats.map((b) => b.code)).toEqual(["s__a", "s__b", "s__c"]);
  });

  it("sequence 相等时保持声明顺序（稳定排序）", () => {
    const dump = toContentDump(
      bundle({
        stories: mapOf([story("s", [beat("s__先", 1), beat("s__后", 1)])]),
      }),
      "v-test",
    );
    expect(dump.stories[0]!.beats.map((b) => b.code)).toEqual(["s__先", "s__后"]);
  });

  it("slot_code 的 null 与字符串都原样带出（挑战节拍的桥梁）", () => {
    const dump = toContentDump(
      bundle({
        stories: mapOf([story("s", [beat("s__a", 1, "slot_1"), beat("s__b", 2, null)])]),
      }),
      "v-test",
    );
    expect(dump.stories[0]!.beats.map((b) => b.slot_code)).toEqual(["slot_1", null]);
  });

  it("visual / reward 恒为 {}（内容层没有这两个字段，来自 DB 列）", () => {
    const dump = toContentDump(bundle({ stories: mapOf([story("s", [beat("s__a", 1)])]) }), "v-test");
    expect(dump.stories[0]!.beats[0]!.visual).toEqual({});
    expect(dump.stories[0]!.beats[0]!.reward).toEqual({});
  });

  it("target_competencies 原样保留顺序（排序它会改变「故事优先练什么」的语义）", () => {
    const s = story("s", [beat("s__a", 1)]);
    s.target_competencies = ["zebra", "apple"];
    const dump = toContentDump(bundle({ stories: mapOf([s]) }), "v-test");
    expect(dump.stories[0]!.target_competencies).toEqual(["zebra", "apple"]);
  });

  it("beat 输出里没有 story_code（归属由所在 story 表达）", () => {
    const dump = toContentDump(bundle({ stories: mapOf([story("s", [beat("s__a", 1)])]) }), "v-test");
    expect(Object.keys(dump.stories[0]!.beats[0]!)).toEqual([
      "code",
      "sequence",
      "beat_type",
      "narration",
      "character",
      "slot_code",
      "visual",
      "reward",
    ]);
  });
});

// ── slots ────────────────────────────────────────────────

describe("toContentDump：slots", () => {
  it("字段改名：competency_id → competency；pattern_id / story_beat_id 的 null 保留", () => {
    const dump = toContentDump(
      bundle({
        slots: mapOf([
          slot("sl", { competency_id: "c1", pattern_id: null, story_beat_id: null }),
        ]),
      }),
      "v-test",
    );
    const row = dump.slots[0]!;
    expect(row.competency).toBe("c1");
    expect(row.pattern).toBeNull();
    expect(row.story_beat_id).toBeNull();
    expect(row).not.toHaveProperty("competency_id");
    expect(row).not.toHaveProperty("pattern_id");
  });

  it("两个 policy 字典按值带出（引用共享与 cmd_dump 一致，产物随即被序列化）", () => {
    const policy = { avoid_recent: 3 };
    const dump = toContentDump(
      bundle({ slots: mapOf([slot("sl", { selection_policy: policy })]) }),
      "v-test",
    );
    expect(dump.slots[0]!.selection_policy).toEqual({ avoid_recent: 3 });
    expect(dump.slots[0]!.review_policy).toEqual({});
  });
});

// ── 整体 ─────────────────────────────────────────────────

describe("toContentDump：整体", () => {
  it("counts 数的是 Map 大小；content_version 原样带出", () => {
    const dump = toContentDump(
      bundle({
        competencies: mapOf([competency("c", 1)]),
        patterns: mapOf([pattern("p")]),
        items: mapOf([item("i1"), item("i2")]),
        slots: mapOf([slot("s")]),
      }),
      "v9.9.9",
    );
    expect(dump.content_version).toBe("v9.9.9");
    expect(dump.counts).toEqual({
      competencies: 1,
      patterns: 1,
      items: 2,
      misconceptions: 0,
      slots: 1,
      stories: 0,
    });
  });
});

// ── buildContentIndex ────────────────────────────────────

const FINGERPRINT = "test-fingerprint";

describe("buildContentIndex", () => {
  it("load_order 是 Map 的插入顺序，不是 code 排序", () => {
    const index = buildContentIndex(
      bundle({ items: mapOf([item("zzz"), item("aaa"), item("mmm")]) }),
      FINGERPRINT,
    );
    expect(index.load_order.items).toEqual(["zzz", "aaa", "mmm"]);
  });

  it("source_fingerprint 原样带出（产物过期检测的唯一依据）", () => {
    const index = buildContentIndex(bundle(), FINGERPRINT);
    expect(index.source_fingerprint).toBe(FINGERPRINT);
  });

  it("competency_terms 覆盖全部能力，空 terms 也留键（否则运行时区分不了「没有」和「没写」）", () => {
    const index = buildContentIndex(
      bundle({
        competencies: mapOf([
          competency("with", 1, { terms: ["凑十"] }),
          competency("without", 1),
        ]),
      }),
      FINGERPRINT,
    );
    expect(index.competency_terms).toEqual({ with: ["凑十"], without: [] });
    expect(Object.keys(index.competency_terms).sort()).toEqual(["with", "without"]);
  });

  it("terms 是拷贝出来的数组，之后改 bundle 不会串改索引", () => {
    const comp = competency("c", 1, { terms: ["凑十"] });
    const index = buildContentIndex(bundle({ competencies: mapOf([comp]) }), FINGERPRINT);
    comp.terms.push("补满十");
    expect(index.competency_terms["c"]).toEqual(["凑十"]);
  });
});
