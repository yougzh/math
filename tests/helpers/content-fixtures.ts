/**
 * 内容层的合成 fixture 构造工具。
 *
 * 为什么需要它：真实 `content/**`（1373 道题）在 `validateContent` 下**一条问题
 * 都不报**，在 `lintBundle` 下只报 9 条规则里的 1 条。也就是说"拿真实内容跑一遍"
 * 对剩下那些规则的约束力是**零** —— TS 侧把整个函数换成 `return []`，
 * 对拍照样全绿。规则类的移植只能靠**为触发分支而构造的合成数据**。
 *
 * 使用纪律：先从 `cleanBundle()` / `lintCleanBundle()` 这条零输出的基线出发，
 * **只改一处**，再断言"刚好报出这一条"。否则"这里报了两条"到底是移植错了、
 * 还是构造本身就有别的问题，分不清。
 *
 * 这些构造函数刻意给的是**最小合法值**（hint_chain 只有一条、problem 里有 a/b
 * 没 prompt），因为 validate 与 lint 关心的东西不同：
 * `cleanBundle()` 是 validate 的基线，`lintCleanBundle()` 是 lint 的基线，
 * 后者要在前者之上把 lint 的 9 条规则全部喂饱。两个基线并存是刻意的 ——
 * 合成一个"两边都干净"的基线会让每个用例都背上无关的约束。
 */
import { AUTO_SCAFFOLD } from "@/src/content/types";
import type {
  ChallengeSlot,
  Competency,
  ContentBundle,
  Item,
  Misconception,
  Pattern,
  Story,
  StoryBeat,
} from "@/src/content/types";

export function mkCompetency(code: string, overrides: Partial<Competency> = {}): Competency {
  return {
    code,
    name: code,
    description: "",
    prerequisites: [],
    stage: 1,
    terms: [],
    ...overrides,
  };
}

export function mkPattern(code: string, primary: string, overrides: Partial<Pattern> = {}): Pattern {
  return {
    code,
    name: code,
    cognitive_type: "compute",
    primary_competency: primary,
    applicable_competencies: [],
    description: "",
    ...overrides,
  };
}

export function mkItem(
  code: string,
  competencyId: string,
  patternId: string,
  overrides: Partial<Item> = {},
): Item {
  return {
    code,
    competency_id: competencyId,
    pattern_id: patternId,
    difficulty: 1,
    scaffold_level: "direct",
    interaction_type: "number_pad",
    estimated_seconds: 15,
    problem: { a: 3, b: 4 },
    answer: 7,
    steps: [],
    hint_chain: ["数一数"],
    error_rules: [],
    steps_style: "guide",
    ...overrides,
  };
}

export function mkSlot(
  code: string,
  competencyId: string,
  overrides: Partial<ChallengeSlot> = {},
): ChallengeSlot {
  return {
    code,
    competency_id: competencyId,
    difficulty_min: 1,
    difficulty_max: 5,
    purpose: "practice",
    pattern_id: null,
    scaffold_level: AUTO_SCAFFOLD,
    estimated_seconds: 20,
    story_beat_id: null,
    selection_policy: {},
    review_policy: {},
    ...overrides,
  };
}

export function mkBeat(code: string, overrides: Partial<StoryBeat> = {}): StoryBeat {
  return {
    code,
    story_code: code.split("__")[0]!,
    sequence: 1,
    beat_type: "challenge",
    narration: "算一算",
    character: "",
    slot_code: null,
    ...overrides,
  };
}

export function mkStory(code: string, overrides: Partial<Story> = {}): Story {
  return {
    code,
    title: code,
    universe: "test",
    summary: "",
    order_index: 0,
    duration_min: 8,
    target_competencies: [],
    beats: [],
    ...overrides,
  };
}

export function mkMisconception(code: string): Misconception {
  return { code, name: code, description: "", severity: 1, remediation_competency: null };
}

export function mkBundle(parts: {
  competencies?: readonly Competency[];
  patterns?: readonly Pattern[];
  items?: readonly Item[];
  misconceptions?: readonly Misconception[];
  slots?: readonly ChallengeSlot[];
  stories?: readonly Story[];
  load_problems?: readonly string[];
}): ContentBundle {
  return {
    competencies: new Map((parts.competencies ?? []).map((c) => [c.code, c])),
    patterns: new Map((parts.patterns ?? []).map((p) => [p.code, p])),
    items: new Map((parts.items ?? []).map((i) => [i.code, i])),
    misconceptions: new Map((parts.misconceptions ?? []).map((m) => [m.code, m])),
    slots: new Map((parts.slots ?? []).map((s) => [s.code, s])),
    stories: new Map((parts.stories ?? []).map((s) => [s.code, s])),
    load_problems: [...(parts.load_problems ?? [])],
  };
}

/**
 * 完全干净的最小 bundle：base → child 两个能力，各有 1 个 pattern、1 道题、1 条误区。
 *
 * 没有 slot / story —— 需要它们的用例自己往这份基线上加，加的时候才看得清
 * 到底哪一条报错是新加的部件带来的。
 */
export function cleanBundle(): ContentBundle {
  return mkBundle({
    competencies: [mkCompetency("base"), mkCompetency("child", { prerequisites: ["base"] })],
    patterns: [mkPattern("base_p", "base"), mkPattern("child_p", "child")],
    items: [mkItem("base_i", "base", "base_p"), mkItem("child_i", "child", "child_p")],
    misconceptions: [mkMisconception("misc_a")],
  });
}

/** 在基线上加一个完整故事：1 个挑战节拍（挂着 slot）+ 1 个奖励节拍 */
export function withStory(bundle: ContentBundle): ContentBundle {
  bundle.stories.set(
    "s",
    mkStory("s", {
      target_competencies: ["child"],
      beats: [
        mkBeat("s__b1", { sequence: 1, beat_type: "challenge", slot_code: "s_slot" }),
        mkBeat("s__b2", { sequence: 2, beat_type: "reward", narration: "太棒了" }),
      ],
    }),
  );
  bundle.slots.set(
    "s_slot",
    mkSlot("s_slot", "child", { pattern_id: "child_p", story_beat_id: "s__b1" }),
  );
  return bundle;
}
