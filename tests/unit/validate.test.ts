/**
 * `src/content/validate.ts` 的单测。
 *
 * 为什么必须有这个文件
 * -------------------
 * 实测：真实 content/**（1373 道题）在 `validateContent` 下**一条问题都不报**。
 * 也就是说"跑真实内容看有没有报错"这件事，对移植正确性的约束力是**零** ——
 * TS 侧哪怕把整个 validateContent 换成 `return []`，构建照样全绿、对拍照样全绿。
 *
 * 所以这里全部用**合成 bundle**：每条规则至少一条用例把它**触发**出来，
 * 再配上"改了另一处不能误报"的反向用例。基线（cleanBundle）本身有一条自证断言，
 * 后面每条测试都从它出发**只改一处** —— 否则"这里报了两条"到底是移植错了
 * 还是构造本身就有别的问题，分不清。
 *
 * 与 S1-2c 的分工：这里钉的是"TS 的行为符合我对 Python 的理解"；
 * S1-2c 的同源变异对拍钉的是"我的理解本身对不对"（Python 侧跑同一份声明式
 * 变异，逐条比对输出）。两者缺一不可 —— 只有这个文件的话，理解错了就一起错。
 */
import { describe, expect, it } from "vitest";

import { validateBundle } from "@/src/content/compiler";
import { loadBundle, readConfigSection } from "@/src/content/loader";
import { AUTO_SCAFFOLD } from "@/src/content/types";
import type {
  ChallengeSlot,
  Competency,
  ContentBundle,
  Item,
  Pattern,
  StoryBeat,
} from "@/src/content/types";
import { hintLeaksAnswer, minPatternsFromRaw, validateContent } from "@/src/content/validate";
import { AlgorithmConfig, minPatternsFromConfig } from "@/src/engine/config";
import {
  cleanBundle,
  mkBeat,
  mkBundle,
  mkCompetency,
  mkItem,
  mkMisconception,
  mkPattern,
  mkSlot,
  mkStory,
  withStory,
} from "../helpers/content-fixtures";

// ── 构造工具 ───────────────────────────────────────────────

/** 断言 problems 里刚好有这一条（用来钉"只报这一条、别的不许报"） */
function onlyProblem(problems: readonly string[]): string {
  expect(problems, `期望刚好 1 条问题，实际 ${problems.length} 条`).toHaveLength(1);
  return problems[0]!;
}

const MIN_PATTERNS = 1;

/**
 * 大多数用例只关心"某一条规则有没有触发"，所以把**升级可达性**检查关掉。
 *
 * 它是唯一一条会因为「别的部件缺失」而顺带报出来的规则：内容里少一道题，
 * 升级门的报错就会混进期望值里，让每个用例都被迫写一整串无关文案。
 * 它的正面/反面用例在下面有独立的一组。
 */
const SKIP_UPGRADE = null;

// ── 基线自证 ───────────────────────────────────────────────

describe("干净基线", () => {
  it("合成基线自身零问题（后面每条用例都从它出发只改一处）", () => {
    expect(validateContent(cleanBundle(), MIN_PATTERNS)).toEqual([]);
  });

  it("带完整故事的基线也零问题", () => {
    expect(validateContent(withStory(cleanBundle()), MIN_PATTERNS)).toEqual([]);
  });

  it("真实内容零问题（现状，不是移植正确性的证据 —— 证据在合成用例）", () => {
    const bundle = loadBundle();
    expect(validateContent(bundle, minPatternsFromRaw(readConfigSection("algorithm")))).toEqual([]);
  });

  it("load_problems 被原样带出，且排在最前", () => {
    const bundle = cleanBundle();
    bundle.load_problems.push("item code 重复：x（a.yaml），后出现的那条会覆盖前一条");
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toEqual(["item code 重复：x（a.yaml），后出现的那条会覆盖前一条"]);
  });
});

// ── competency ─────────────────────────────────────────────

describe("competency", () => {
  it("前置不存在", () => {
    const bundle = cleanBundle();
    bundle.competencies.set("child", mkCompetency("child", { prerequisites: ["ghost"] }));
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "competency child 的前置 ghost 不存在",
    );
  });

  it("依赖自己", () => {
    const bundle = mkBundle({
      competencies: [mkCompetency("self", { prerequisites: ["self"] })],
      patterns: [mkPattern("self_p", "self")],
      items: [mkItem("self_i", "self", "self_p")],
    });
    expect(validateContent(bundle, MIN_PATTERNS)).toEqual(["competency self 依赖自己"]);
  });

  it("自依赖 + 前置不存在会各报一条（两条 if 独立执行）", () => {
    // Python 里 prereq == comp.code 时第一条 if 不会触发（自己一定存在），
    // 所以这两条规则实际上互斥。这里钉住"互斥"这件事本身。
    const bundle = mkBundle({
      competencies: [mkCompetency("self", { prerequisites: ["self"] })],
      patterns: [mkPattern("self_p", "self")],
      items: [mkItem("self_i", "self", "self_p")],
    });
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems.filter((p) => p.includes("不存在"))).toEqual([]);
  });
});

// ── pattern ────────────────────────────────────────────────

describe("pattern", () => {
  it("cognitive_type 非法", () => {
    const bundle = cleanBundle();
    bundle.patterns.set("child_p", {
      ...mkPattern("child_p", "child"),
      cognitive_type: "counting" as Pattern["cognitive_type"],
    });
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "pattern child_p 的 cognitive_type 非法: counting",
    );
  });

  it("primary_competency 不存在", () => {
    const bundle = cleanBundle();
    bundle.patterns.set("child_p", mkPattern("child_p", "ghost"));
    bundle.items.set("child_i", mkItem("child_i", "child", "child_p"));
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain("pattern child_p 关联了不存在的 competency ghost");
    expect(problems).toContain("item child_i 的 pattern child_p 不允许用于 competency child");
  });

  it("applicable_competencies 里不存在的能力也报，且 primary 与它去重", () => {
    const bundle = cleanBundle();
    bundle.patterns.set(
      "child_p",
      mkPattern("child_p", "ghost_a", { applicable_competencies: ["ghost_b", "ghost_a"] }),
    );
    const problems = validateContent(bundle, SKIP_UPGRADE);
    // ⚠️ 按**集合**比，不按顺序：Python 那边是 `set(applicable) | {primary}`，
    // 迭代顺序来自 str 哈希 —— 实测同一段代码连跑三次给出三种顺序，
    // 所以"顺序"根本不是 Python 行为的一部分（S1-2c 对拍时同样按集合比）。
    // TS 侧选的是插入顺序（确定的），只要落在 Python 能产生的集合里就行。
    // 这条也钉住了去重：primary（ghost_a）同时出现在 applicable 里，只报一次。
    expect(new Set(problems.filter((p) => p.includes("关联了不存在的 competency")))).toEqual(
      new Set([
        "pattern child_p 关联了不存在的 competency ghost_b",
        "pattern child_p 关联了不存在的 competency ghost_a",
      ]),
    );
  });
});

// ── item ───────────────────────────────────────────────────

describe("item", () => {
  it("competency 不存在", () => {
    const bundle = cleanBundle();
    bundle.items.set("child_i", mkItem("child_i", "ghost", "child_p"));
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain("item child_i 的 competency ghost 不存在");
  });

  it("pattern 不存在（此时不再报「不允许用于」）", () => {
    const bundle = cleanBundle();
    bundle.items.set("child_i", mkItem("child_i", "child", "ghost"));
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain("item child_i 的 pattern ghost 不存在");
    expect(problems.filter((p) => p.includes("不允许用于"))).toEqual([]);
  });

  it("pattern 不适用于该 competency", () => {
    const bundle = cleanBundle();
    bundle.items.set("child_i", mkItem("child_i", "child", "base_p"));
    // child 因此一个「有题支撑的 pattern」都不剩 —— 关掉升级可达性，
    // 这条用例只钉「pattern 误挂」这一件事。
    expect(onlyProblem(validateContent(bundle, SKIP_UPGRADE))).toBe(
      "item child_i 的 pattern base_p 不允许用于 competency child",
    );
  });

  it("applicable_competencies 声明了也算适用", () => {
    const bundle = cleanBundle();
    bundle.patterns.set(
      "base_p",
      mkPattern("base_p", "base", { applicable_competencies: ["child"] }),
    );
    bundle.items.set("child_i", mkItem("child_i", "child", "base_p"));
    expect(validateContent(bundle, MIN_PATTERNS)).toEqual([]);
  });

  it("scaffold_level 非法", () => {
    const bundle = cleanBundle();
    bundle.items.set("child_i", {
      ...mkItem("child_i", "child", "child_p"),
      scaffold_level: "blocks+" as Item["scaffold_level"],
    });
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "item child_i 的 scaffold_level 非法: blocks+",
    );
  });

  it("缺少 answer（null 才报，0 是合法答案）", () => {
    const bundle = cleanBundle();
    bundle.items.set("child_i", mkItem("child_i", "child", "child_p", { answer: null }));
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe("item child_i 缺少 answer");

    const zero = cleanBundle();
    zero.items.set("child_i", mkItem("child_i", "child", "child_p", { answer: 0 }));
    expect(validateContent(zero, MIN_PATTERNS)).toEqual([]);
  });

  it("steps_style 非法", () => {
    const bundle = cleanBundle();
    bundle.items.set("child_i", {
      ...mkItem("child_i", "child", "child_p"),
      steps_style: "show" as Item["steps_style"],
    });
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "item child_i 的 steps_style 非法: show",
    );
  });

  it("缺少 hint_chain", () => {
    const bundle = cleanBundle();
    bundle.items.set("child_i", mkItem("child_i", "child", "child_p", { hint_chain: [] }));
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe("item child_i 缺少 hint_chain");
  });

  it("提示泄漏了答案", () => {
    const bundle = cleanBundle();
    bundle.items.set(
      "child_i",
      mkItem("child_i", "child", "child_p", { answer: 13, hint_chain: ["先算 8+2=10，再得 13"] }),
    );
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "item child_i 的提示泄漏了答案: 先算 8+2=10，再得 13",
    );
  });

  it("提示里是无关数字则不报（凑十的目标 10 不该算泄漏）", () => {
    const bundle = cleanBundle();
    bundle.items.set(
      "child_i",
      mkItem("child_i", "child", "child_p", { answer: 13, hint_chain: ["8 和几凑成 10？"] }),
    );
    expect(validateContent(bundle, MIN_PATTERNS)).toEqual([]);
  });

  it("answer 不是整数时一律不判泄漏（float / str / list）", () => {
    // null / undefined 不在这里：null 会先被「缺少 answer」那条规则拦下，
    // 而 loader 保证 answer 只会是 null（`row["answer"] ?? null`），
    // undefined 在真实链路上不存在。
    for (const answer of [13.5, "13", [13]]) {
      const bundle = cleanBundle();
      bundle.items.set(
        "child_i",
        mkItem("child_i", "child", "child_p", { answer, hint_chain: ["答案就是 13"] }),
      );
      expect(validateContent(bundle, SKIP_UPGRADE), `answer=${String(answer)}`).toEqual([]);
    }
  });

  it("error_rule 引用了不存在的 misconception", () => {
    const bundle = cleanBundle();
    bundle.items.set(
      "child_i",
      mkItem("child_i", "child", "child_p", { error_rules: [{ code: "ghost", match: {} }] }),
    );
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "item child_i 引用了不存在的 misconception ghost",
    );
  });

  it("error_rule 缺 code 时报文案是 None（Python 的 dict.get 语义）", () => {
    const bundle = cleanBundle();
    bundle.items.set(
      "child_i",
      mkItem("child_i", "child", "child_p", {
        error_rules: [{ match: {} } as unknown as Item["error_rules"][number]],
      }),
    );
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "item child_i 引用了不存在的 misconception None",
    );
  });

  it("error_rule 缺 match", () => {
    const bundle = cleanBundle();
    bundle.items.set(
      "child_i",
      mkItem("child_i", "child", "child_p", {
        error_rules: [{ code: "misc_a" } as unknown as Item["error_rules"][number]],
      }),
    );
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "item child_i 的 error_rule 缺少 match",
    );
  });

  it("error_rule 挂上存在的 misconception 且带 match 时不报", () => {
    const bundle = cleanBundle();
    bundle.items.set(
      "child_i",
      mkItem("child_i", "child", "child_p", { error_rules: [{ code: "misc_a", match: { a: 3 } }] }),
    );
    expect(validateContent(bundle, MIN_PATTERNS)).toEqual([]);
  });
});

// ── slot ───────────────────────────────────────────────────

describe("slot", () => {
  it("competency 不存在", () => {
    const bundle = cleanBundle();
    bundle.slots.set("sl", mkSlot("sl", "ghost"));
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain("slot sl 的 competency ghost 不存在");
    expect(problems).toContain("slot sl 的候选池为空（没有任何 item 能满足）");
  });

  it("pattern 不存在", () => {
    const bundle = cleanBundle();
    bundle.slots.set("sl", mkSlot("sl", "child", { pattern_id: "ghost" }));
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain("slot sl 的 pattern ghost 不存在");
    expect(problems).toContain("slot sl 的候选池为空（没有任何 item 能满足）");
  });

  it("pattern 不适用于该 competency", () => {
    const bundle = cleanBundle();
    bundle.slots.set("sl", mkSlot("sl", "child", { pattern_id: "base_p" }));
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain("slot sl 的 pattern base_p 不允许用于 competency child");
    expect(problems).toContain("slot sl 的候选池为空（没有任何 item 能满足）");
  });

  it("scaffold_level 非法（auto 与三档合法、null 也合法）", () => {
    const bundle = cleanBundle();
    bundle.slots.set("sl", mkSlot("sl", "child", { pattern_id: "child_p" }));
    bundle.slots.get("sl")!.scaffold_level = "half" as ChallengeSlot["scaffold_level"];
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "slot sl 的 scaffold_level 非法: half",
    );

    for (const level of ["blocks", "decompose", "direct", "auto", null]) {
      const ok = cleanBundle();
      ok.slots.set("sl", mkSlot("sl", "child", { pattern_id: "child_p" }));
      ok.slots.get("sl")!.scaffold_level = level as ChallengeSlot["scaffold_level"];
      expect(validateContent(ok, MIN_PATTERNS), `scaffold_level=${String(level)}`).toEqual([]);
    }
  });

  it("purpose 非法", () => {
    const bundle = cleanBundle();
    bundle.slots.set(
      "sl",
      mkSlot("sl", "child", { pattern_id: "child_p", purpose: "play" as ChallengeSlot["purpose"] }),
    );
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "slot sl 的 purpose 非法: play",
    );
  });

  it("难度区间倒置", () => {
    const bundle = cleanBundle();
    bundle.slots.set(
      "sl",
      mkSlot("sl", "child", { pattern_id: "child_p", difficulty_min: 4, difficulty_max: 2 }),
    );
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain("slot sl 的难度区间倒置: 4 > 2");
    expect(problems).toContain("slot sl 的候选池为空（没有任何 item 能满足）");
  });

  it("候选池为空", () => {
    const bundle = cleanBundle();
    bundle.slots.set(
      "sl",
      mkSlot("sl", "child", { pattern_id: "child_p", difficulty_min: 4, difficulty_max: 4 }),
    );
    expect(onlyProblem(validateContent(bundle, MIN_PATTERNS))).toBe(
      "slot sl 的候选池为空（没有任何 item 能满足）",
    );
  });

  it("候选池的判定用 `pattern_id is None` 而不是 truthiness：空串会去比 pattern_id == ''", () => {
    // Python 原样（loader.py:601 用 truthiness 校验 pattern 存在性，
    // :632 用 `is None` 判候选池）。空串因此"跳过 pattern 校验、但候选池收窄到空"。
    const bundle = cleanBundle();
    bundle.slots.set("sl", mkSlot("sl", "child", { pattern_id: "" }));
    expect(validateContent(bundle, MIN_PATTERNS)).toEqual([
      "slot sl 的候选池为空（没有任何 item 能满足）",
    ]);
  });

  it("不绑 pattern 时任意 pattern 的题都算候选", () => {
    const bundle = cleanBundle();
    bundle.slots.set(
      "sl",
      mkSlot("sl", "child", { pattern_id: null, difficulty_min: 1, difficulty_max: 1 }),
    );
    expect(validateContent(bundle, MIN_PATTERNS)).toEqual([]);
  });
});

// ── story ──────────────────────────────────────────────────

describe("story", () => {
  it("缺少 title", () => {
    const bundle = withStory(cleanBundle());
    bundle.stories.set("s", { ...bundle.stories.get("s")!, title: "" });
    expect(validateContent(bundle, MIN_PATTERNS)).toEqual(["story s 缺少 title"]);
  });

  it("target_competencies 指向不存在的 competency", () => {
    const bundle = withStory(cleanBundle());
    const story = bundle.stories.get("s")!;
    bundle.stories.set("s", { ...story, target_competencies: ["ghost"] });
    expect(validateContent(bundle, MIN_PATTERNS)).toEqual([
      "story s 指向了不存在的 competency ghost",
    ]);
  });

  it("beat sequence 有重复", () => {
    const bundle = withStory(cleanBundle());
    const story = bundle.stories.get("s")!;
    bundle.stories.set("s", {
      ...story,
      beats: [story.beats[0]!, { ...story.beats[1]!, sequence: 1 }],
    });
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain("story s 的 beat sequence 有重复");
    expect(problems).toContain("story s 的 beat sequence 必须是 1..N 连续（当前 [1, 1]）");
  });

  it("beat sequence 不连续时文案里是 Python 风格的列表", () => {
    const bundle = withStory(cleanBundle());
    const story = bundle.stories.get("s")!;
    bundle.stories.set("s", {
      ...story,
      beats: [{ ...story.beats[0]!, sequence: 1 }, { ...story.beats[1]!, sequence: 3 }],
    });
    const problems = validateContent(bundle, MIN_PATTERNS);
    // `[1, 3]` 而不是 JS 的 `1,3` —— 逐字对齐 Python 的 str(list)
    expect(problems).toContain("story s 的 beat sequence 必须是 1..N 连续（当前 [1, 3]）");
  });

  it("beat code 前缀不对", () => {
    const bundle = withStory(cleanBundle());
    const story = bundle.stories.get("s")!;
    bundle.stories.set("s", {
      ...story,
      beats: [{ ...story.beats[0]!, code: "other__b1" }, story.beats[1]!],
    });
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain(
      "story_beat other__b1 的 code 必须以「s__」开头（约定：story_code__local）",
    );
    // 连带：slot 找不到它所属的 beat
    expect(problems).toContain("slot s_slot 引用了不存在的 story_beat s__b1");
  });

  it("beat code 重复出现在多个故事里", () => {
    const bundle = withStory(cleanBundle());
    bundle.stories.set(
      "s2",
      mkStory("s2", {
        beats: [mkBeat("s2__b1", { slot_code: "s2_slot" })],
      }),
    );
    bundle.slots.set("s2_slot", mkSlot("s2_slot", "child", { pattern_id: "child_p", story_beat_id: "s2__b1" }));
    // 让 s2 的第一个 beat 与 s 的撞 code
    const s2 = bundle.stories.get("s2")!;
    bundle.stories.set("s2", { ...s2, beats: [{ ...s2.beats[0]!, code: "s__b1" }] });
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain("story_beat s__b1 重复出现在多个故事里");
  });

  it("beat type 非法", () => {
    const bundle = withStory(cleanBundle());
    const story = bundle.stories.get("s")!;
    bundle.stories.set("s", {
      ...story,
      beats: [{ ...story.beats[0]!, beat_type: "quiz" as StoryBeat["beat_type"] }, story.beats[1]!],
    });
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain("story_beat s__b1 的 type 非法: quiz");
  });

  it("beat 没有 text", () => {
    const bundle = withStory(cleanBundle());
    const story = bundle.stories.get("s")!;
    bundle.stories.set("s", {
      ...story,
      beats: [{ ...story.beats[0]!, narration: "" }, story.beats[1]!],
    });
    expect(validateContent(bundle, MIN_PATTERNS)).toEqual(["story_beat s__b1 没有 text"]);
  });

  it("挑战节拍没有挂 challenge_slot", () => {
    const bundle = withStory(cleanBundle());
    const story = bundle.stories.get("s")!;
    bundle.stories.set("s", {
      ...story,
      beats: [{ ...story.beats[0]!, slot_code: null }, story.beats[1]!],
    });
    const problems = validateContent(bundle, MIN_PATTERNS);
    expect(problems).toContain(
      "挑战节拍 s__b1 没有挂 challenge_slot —— 故事走到这里会无题可出",
    );
  });

  it("故事没有任何挑战节拍", () => {
    const bundle = withStory(cleanBundle());
    const story = bundle.stories.get("s")!;
    bundle.stories.set("s", {
      ...story,
      // 全改成叙述节拍（连带清掉 slot_code，否则「挑战节拍没挂槽」也会报），
      // 于是这个故事整场都没有数学训练
      beats: story.beats.map((b) => ({
        ...b,
        beat_type: "narration" as const,
        slot_code: null,
      })),
    });
    // 槽位改回独立训练槽，免得它反过来说"挂在了非挑战节拍上"
    bundle.slots.set("s_slot", mkSlot("s_slot", "child", { pattern_id: "child_p" }));
    expect(validateContent(bundle, SKIP_UPGRADE)).toEqual([
      "story s 没有任何挑战节拍（故事必须包含数学训练）",
    ]);
  });

  it("slot 引用不存在的 story_beat", () => {
    const bundle = withStory(cleanBundle());
    bundle.slots.set(
      "s_slot",
      mkSlot("s_slot", "child", { pattern_id: "child_p", story_beat_id: "s__ghost" }),
    );
    const problems = validateContent(bundle, SKIP_UPGRADE);
    expect(problems).toContain("slot s_slot 引用了不存在的 story_beat s__ghost");
  });

  it("slot 挂在非挑战节拍上", () => {
    const bundle = withStory(cleanBundle());
    const story = bundle.stories.get("s")!;
    // ⚠️ beat.slot_code 与 slot.story_beat_id 是两处声明，loader 的 linkSlotsToBeats
    // 负责让它们一致。合成 bundle 里必须手动同步，否则测的是自相矛盾的输入。
    bundle.stories.set("s", {
      ...story,
      beats: [{ ...story.beats[0]!, slot_code: null }, story.beats[1]!],
    });
    bundle.slots.set(
      "s_slot",
      mkSlot("s_slot", "child", { pattern_id: "child_p", story_beat_id: "s__b2" }),
    );
    const problems = validateContent(bundle, SKIP_UPGRADE);
    expect(problems).toContain("slot s_slot 挂在了非挑战节拍 s__b2（type=reward）上");
    // 连带：挑战节拍 s__b1 没人挂
    expect(problems).toContain(
      "挑战节拍 s__b1 没有挂 challenge_slot —— 故事走到这里会无题可出",
    );
  });

  it("不挂 story_beat 的独立训练槽不参与故事核对", () => {
    const bundle = cleanBundle();
    bundle.slots.set("standalone", mkSlot("standalone", "child", { pattern_id: "child_p" }));
    expect(validateContent(bundle, SKIP_UPGRADE)).toEqual([]);
  });
});

// ── 升级可达性 ─────────────────────────────────────────────

describe("升级可达性（有题支撑的 pattern 数）", () => {
  /** root → weak → down → far 的能力链，可指定每个能力"有题支撑"的 pattern 数 */
  function chainBundle(supportedCounts: Readonly<Record<string, number>>): ContentBundle {
    const prerequisites: Record<string, string[]> = {
      root: [],
      weak: ["root"],
      down: ["weak"],
      far: ["down"],
    };
    const competencies: Competency[] = [];
    const patterns: Pattern[] = [];
    const items: Item[] = [];
    for (const [code, prereqs] of Object.entries(prerequisites)) {
      competencies.push(mkCompetency(code, { prerequisites: prereqs }));
      const count = supportedCounts[code] ?? 2;
      for (let index = 0; index < count; index += 1) {
        const patternCode = `${code}_p${index}`;
        patterns.push(mkPattern(patternCode, code));
        items.push(mkItem(`${code}_i${index}`, code, patternCode));
      }
    }
    return mkBundle({ competencies, patterns, items });
  }

  it("有题支撑的 pattern 数不足必须被拦下，并列出传递阻塞的下游能力", () => {
    const problems = validateContent(chainBundle({ weak: 1 }), 2);
    const hits = problems.filter((p) => p.includes("永远无法升级"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(
      "weak：只有 1 个 pattern 有题支撑（weak_p0），升级需要 2 个 → 该能力永远无法升级；" +
        "受牵连的下游能力 2 个：down、far",
    );
    // 达标的能力不能被误报
    expect(problems.filter((p) => /^(root|down|far)：/.test(p))).toEqual([]);
  });

  it("声明了 pattern 但一道题都没有，不算「有题支撑」", () => {
    const bundle = chainBundle({ weak: 1 });
    bundle.patterns.set("weak_declared_only", mkPattern("weak_declared_only", "weak"));
    const hits = validateContent(bundle, 2).filter((p) => p.includes("永远无法升级"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("只有 1 个 pattern 有题支撑（weak_p0）");
  });

  it("pattern 不适用于该能力时不算支撑（applicable 也不含它）", () => {
    const bundle = chainBundle({ weak: 1 });
    // 给 weak 加一道挂 root_p0 的题：pattern 存在、有题，但 applies_to("weak") 为假
    bundle.items.set("weak_foreign", mkItem("weak_foreign", "weak", "root_p0"));
    const hits = validateContent(bundle, 2).filter((p) => p.includes("永远无法升级"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("只有 1 个 pattern 有题支撑（weak_p0）");
  });

  it("题挂在别的能力上时不算本能力的支撑（即使 pattern 也适用于本能力）", () => {
    // ⚠️ 这条钉的是 `item.competency_id !== competencyCode → continue` 那一步：
    // 少了它，一道挂在 base 上的题会因为"pattern 也适用于 child"而被算成
    // child 的支撑 —— 于是 child 看起来能升级，实际上孩子根本没题做。
    const bundle = mkBundle({
      competencies: [mkCompetency("base"), mkCompetency("child", { prerequisites: ["base"] })],
      patterns: [mkPattern("shared_p", "base", { applicable_competencies: ["child"] })],
      items: [mkItem("base_i", "base", "shared_p")],
    });
    const hits = validateContent(bundle, 1).filter((p) => p.includes("永远无法升级"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("child：只有 0 个 pattern 有题支撑（无）");
  });

  it("达标的内容不能被误报，且文案里没有「无」以外的空列举", () => {
    expect(validateContent(chainBundle({ weak: 2 }), 2)).toEqual([]);
  });

  it("一个 pattern 都没有时文案是「（无）」", () => {
    const problems = validateContent(chainBundle({ weak: 0 }), 2);
    const hit = problems.find((p) => p.startsWith("weak："))!;
    expect(hit).toContain("只有 0 个 pattern 有题支撑（无）");
  });

  it("min_patterns 为 null（配置里没写）时跳过整条检查", () => {
    expect(validateContent(chainBundle({ weak: 0 }), null)).toEqual([]);
  });

  it("min_patterns 小于 1 时跳过（0 或负数都不该把内容判死）", () => {
    expect(validateContent(chainBundle({ weak: 0 }), 0)).toEqual([]);
    expect(validateContent(chainBundle({ weak: 0 }), -3)).toEqual([]);
  });

  it("阈值边界是「>= need」：恰好达标不报、差一个才报", () => {
    expect(validateContent(chainBundle({ weak: 2 }), 2)).toEqual([]);
    expect(validateContent(chainBundle({ weak: 2 }), 3).filter((p) => p.includes("永远无法升级"))).toHaveLength(4);
  });

  it("多个能力不达标时按 code 排序（不是加载顺序）", () => {
    // chainBundle 的插入顺序是 root → weak → down → far；排序后是 down → far → weak。
    // 两者不同，所以这条断言能真正区分「排没排」。
    const problems = validateContent(chainBundle({ weak: 0, down: 0, far: 0 }), 2);
    const hits = problems.filter((p) => p.includes("永远无法升级"));
    expect(hits.map((p) => p.split("：")[0])).toEqual(["down", "far", "weak"]);
  });

  it("自环能力不会把自己算成自己的下游", () => {
    // Python 的 _dependents 里有 `current == code` 的排除，
    // 否则自环会让能力在文案里把自己列为"受牵连的下游"。
    const bundle = mkBundle({
      competencies: [mkCompetency("b", { prerequisites: ["b"] })],
    });
    const problems = validateContent(bundle, 2);
    const hits = problems.filter((p) => p.includes("永远无法升级"));
    expect(hits).toEqual([
      "b：只有 0 个 pattern 有题支撑（无），升级需要 2 个 → 该能力永远无法升级",
    ]);
    expect(problems).toContain("competency b 依赖自己");
  });
});

// ── 报错顺序 ───────────────────────────────────────────────

describe("报错顺序 = 内容加载顺序（不是字典序）", () => {
  it("competency 按 Map 插入顺序报，不按 code 排序", () => {
    const bundle = mkBundle({
      competencies: [
        mkCompetency("z", { prerequisites: ["ghost_z"] }),
        mkCompetency("a", { prerequisites: ["ghost_a"] }),
        mkCompetency("m", { prerequisites: ["ghost_m"] }),
      ],
    });
    // 这三个能力都没有 pattern/题，升级可达性会顺带报出来 —— 关掉它，
    // 这条用例只钉「报错顺序 = load_order」。
    expect(validateContent(bundle, SKIP_UPGRADE)).toEqual([
      "competency z 的前置 ghost_z 不存在",
      "competency a 的前置 ghost_a 不存在",
      "competency m 的前置 ghost_m 不存在",
    ]);
  });

  it("item 也按 Map 插入顺序报", () => {
    const bundle = cleanBundle();
    bundle.items.set("z_i", mkItem("z_i", "child", "child_p", { answer: null }));
    bundle.items.set("a_i", mkItem("a_i", "child", "child_p", { answer: null }));
    expect(validateContent(bundle, SKIP_UPGRADE)).toEqual([
      "item z_i 缺少 answer",
      "item a_i 缺少 answer",
    ]);
  });

  it("段间顺序：competency → pattern → item → slot → story → 升级可达性", () => {
    const bundle = cleanBundle();
    bundle.competencies.set("bad_c", mkCompetency("bad_c", { prerequisites: ["ghost"] }));
    bundle.patterns.set("bad_p", mkPattern("bad_p", "ghost"));
    bundle.items.set("bad_i", mkItem("bad_i", "child", "child_p", { answer: null }));
    bundle.slots.set("bad_s", mkSlot("bad_s", "child", { difficulty_min: 9, difficulty_max: 1 }));
    bundle.stories.set("bad_s2", mkStory("bad_s2", { title: "" }));
    const problems = validateContent(bundle, MIN_PATTERNS);
    const order = problems.map((p) => p.split(" ")[0]);
    expect(order.indexOf("competency")).toBeLessThan(order.indexOf("pattern"));
    expect(order.indexOf("pattern")).toBeLessThan(order.indexOf("item"));
    expect(order.indexOf("item")).toBeLessThan(order.indexOf("slot"));
    expect(order.indexOf("slot")).toBeLessThan(order.indexOf("story"));
    // 升级可达性在最末：它的文案以能力 code 开头
    expect(problems[problems.length - 1]).toContain("永远无法升级");
  });
});

// ── 阈值来源 ───────────────────────────────────────────────

describe("阈值来源（ADR-0002：只能有一个来源）", () => {
  it("minPatternsFromRaw 与 AlgorithmConfig 读到的值一致", () => {
    const raw = readConfigSection("algorithm");
    // 两条路径：一条从**刚读出的 YAML** 走（构建脚本用，产物还不存在），
    // 一条从构建产物走（运行时用）。任何一条改了默认值，这里立刻红。
    expect(minPatternsFromRaw(raw)).toBe(minPatternsFromConfig(new AlgorithmConfig(raw)));
  });

  it("minPatternsFromRaw 的缺键语义与 AlgorithmConfig.newPatternSuccessRule 一致", () => {
    for (const raw of [
      {},
      { upgrade_requires: {} },
      { upgrade_requires: { new_pattern_success: {} } },
      { upgrade_requires: { new_pattern_success: { min_patterns: 3 } } },
      { upgrade_requires: { new_pattern_success: { min_patterns: "4" } } },
      { upgrade_requires: "not-an-object" },
      { upgrade_requires: { new_pattern_success: null } },
    ]) {
      const expected = minPatternsFromConfig(new AlgorithmConfig(raw));
      expect(minPatternsFromRaw(raw), JSON.stringify(raw)).toBe(expected);
    }
  });

  it("真实配置的阈值就是校验门实际用的那个数", () => {
    const raw = readConfigSection("algorithm");
    expect(minPatternsFromRaw(raw)).toBe(2);
  });
});

// ── hintLeaksAnswer 的边界 ─────────────────────────────────

describe("hintLeaksAnswer 的 Python 边界", () => {
  it("bool 是 int 的子类：answer=true 配含 1 的提示算泄漏", () => {
    // 实测 Python：_hint_leaks_answer("这里有 1 个", True) -> True
    expect(hintLeaksAnswer("这里有 1 个", true)).toBe(true);
    expect(hintLeaksAnswer("这里有 0 个", false)).toBe(true);
    expect(hintLeaksAnswer("这里有 2 个", true)).toBe(false);
  });

  it("负号不参与匹配：answer=-5 配提示里的 -5 不算泄漏", () => {
    // Python 的 _NUMBER_TOKEN 是 \\d+，"答案是 -5" 里的 token 只有 {5}
    expect(hintLeaksAnswer("答案是 -5", -5)).toBe(false);
    expect(hintLeaksAnswer("答案是 -5", 5)).toBe(true);
  });

  it("浮点与字符串不判泄漏（float / str / null 都不是 int）", () => {
    expect(hintLeaksAnswer("这里有 3 个", "3")).toBe(false);
    expect(hintLeaksAnswer("这里有 3 个", null)).toBe(false);
    expect(hintLeaksAnswer("这里有 3 个", [3])).toBe(false);
    expect(hintLeaksAnswer("这里有 3 个", 3.5)).toBe(false);
  });

  it("⚠️ 已知差异：JSON 里的 3.0 与 3 不可区分，这里判为泄漏而 Python 不会", () => {
    // Python: isinstance(3.0, int) -> False；JS: Number.isInteger(3.0) -> True。
    // 这个差异在**解析后的对象上不可观测**，所以不能在这里"修"，
    // 只能由构建脚本在 YAML 原文上断言"内容里不存在小数标量"
    // （scripts/build-content.ts 的 assertNoDecimalScalars）。
    expect(hintLeaksAnswer("这里有 3 个", 3.0)).toBe(true);
    expect(Object.is(3.0, 3)).toBe(true);
  });

  it("整数照常判（3.0 那条差异的前提是 YAML 里不写小数）", () => {
    expect(hintLeaksAnswer("这里有 3 个", 3)).toBe(true);
    expect(hintLeaksAnswer("这里有 03 个", 3)).toBe(true);
    expect(hintLeaksAnswer("这里有 30 个", 3)).toBe(false);
  });
});

// ── validateBundle ─────────────────────────────────────────

describe("validateBundle：三段合并", () => {
  it("真实内容零问题", () => {
    const bundle = loadBundle();
    const minPatterns = minPatternsFromRaw(readConfigSection("algorithm"));
    expect(validateBundle(bundle, minPatterns)).toEqual([]);
  });

  it("认知规则的问题带 `item <code>: ` 前缀", () => {
    const bundle = cleanBundle();
    // 加法题却写了 3 + 4 = 8：checkAll 的自洽规则会拦下
    bundle.items.set(
      "child_i",
      mkItem("child_i", "child", "child_p", {
        problem: { a: 3, b: 4, op: "add" },
        answer: 8,
      }),
    );
    const problems = validateBundle(bundle, MIN_PATTERNS);
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem.startsWith("item child_i: ")).toBe(true);
    }
  });

  it("图的问题（环 / 孤立节点 / 无 pattern）也在 problems 里", () => {
    const bundle = mkBundle({
      competencies: [mkCompetency("lonely")],
    });
    const problems = validateBundle(bundle, MIN_PATTERNS);
    expect(problems).toContain("competency lonely 没有任何可用 pattern（该能力无法被训练）");
    expect(problems).toContain("competency lonely 是孤立节点（既无前置也无人依赖）");
  });
});
