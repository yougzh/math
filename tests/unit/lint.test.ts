/**
 * `src/content/lint.ts` 的单测。
 *
 * 为什么必须有这个文件
 * -------------------
 * 实测：真实 content/**（1373 道题）在 `lintBundle` 下报 10 条警告，
 * **全部来自 9 条规则里的 `_lint_slot_ceiling`**。也就是说另外 8 条规则
 * 对真实内容的约束力是**零** —— TS 侧把它们逐个换成 `return []`，
 * `check:content` 照样全绿、对拍照样全绿。
 *
 * 所以这里全部用**合成 bundle**，并且配一条自证断言：
 * 「9 条规则每条都至少被触发过一次」（见文件末尾）。没有那条断言，
 * 删掉一整条规则的实现不会有任何测试变红。
 *
 * 使用纪律与 validate.test.ts 相同：先从零输出的基线出发，**只改一处**，
 * 再断言"刚好报出这一条"。
 *
 * 与 S1-2c 的分工：这里钉的是"TS 的行为符合我对 Python 的理解"；
 * S1-2c 的同源变异对拍钉的是"我的理解本身对不对"。
 */
import { describe, expect, it } from "vitest";

import { compileReport } from "@/src/content/compiler";
import { computeStats, lintBundle, renderCoverage, renderStatsReport } from "@/src/content/lint";
import { loadBundle, readConfigSection } from "@/src/content/loader";
import { AUTO_SCAFFOLD } from "@/src/content/types";
import type { ChallengeSlot, ContentBundle, Item, ScaffoldLevel } from "@/src/content/types";
import { minPatternsFromRaw } from "@/src/content/validate";
import {
  mkBeat,
  mkBundle,
  mkCompetency,
  mkItem,
  mkPattern,
  mkSlot,
  mkStory,
} from "../helpers/content-fixtures";

// ── 构造工具 ───────────────────────────────────────────────

/**
 * 一道梯子题的字段：题面自包含、答案自洽、两级提示 —— lint 关心的三件事一次给全。
 *
 * 题面用两个连续整数，靠调用方给不同的 `a` 来避免撞车。**不撞车是硬要求**：
 * `_lint_duplicates` 的键是 `(interaction_type, 题面)`，两个能力的题面一旦相同，
 * 任何"只改一处答案"的用例都会顺带撞出重复告警，测试就没法收敛了
 * （真实内容里 51 处同题面同答案的跨槽复用正是这个情况，所以那条规则必须能区分）。
 */
function fields(a: number): Pick<Item, "problem" | "answer" | "hint_chain"> {
  const b = a + 1;
  return {
    problem: { a, b, prompt: `${a} + ${b} = ?` },
    answer: a + b,
    hint_chain: [`先数 ${a}`, `再数 ${b}`],
  };
}

/**
 * 难度 1/2/3 对应 blocks/decompose/direct 三层，耗时随难度单调增。
 * 一个能力有一整套这样的题，`_lint_coverage` 与 `_lint_time_estimates` 就都安静了。
 */
const LADDER: ReadonlyArray<{ difficulty: number; scaffold: ScaffoldLevel; seconds: number }> = [
  { difficulty: 1, scaffold: "blocks", seconds: 15 },
  { difficulty: 2, scaffold: "decompose", seconds: 20 },
  { difficulty: 3, scaffold: "direct", seconds: 25 },
];

/** 每个能力一段专属的数字区间 —— 见 `fields` 的注释 */
const NUMBER_BASE: Record<string, number> = { base: 0, child: 100 };

function baseOf(competency: string): number {
  return NUMBER_BASE[competency] ?? 0;
}

function ladderItems(competency: string, pattern: string): Item[] {
  return LADDER.map(({ difficulty, scaffold, seconds }) =>
    mkItem(`${competency}_d${difficulty}`, competency, pattern, {
      difficulty,
      scaffold_level: scaffold,
      estimated_seconds: seconds,
      ...fields(baseOf(competency) + difficulty),
    }),
  );
}

/**
 * lint 的零输出基线：两个能力，每个在 blocks/decompose/direct 三层各一道题。
 *
 * 刻意**没有 slot / story** —— 那三条规则（池宽、故事时长、难度上限）的用例
 * 自己往上加，加的时候才看得清"这一条警告是新加的部件带来的"。
 *
 * 与 `cleanBundle()`（validate 的基线）刻意并存：validate 的基线只有 2 道题、
 * 没有 prompt，在 lint 下会报 2 条「没有 prompt」、`_lint_coverage` 也会报。
 * 硬合成一个"两边都干净"的基线，会让两边的用例都背上无关的约束。
 */
function lintCleanBundle(): ContentBundle {
  return mkBundle({
    competencies: [mkCompetency("base"), mkCompetency("child", { prerequisites: ["base"] })],
    patterns: [mkPattern("base_p", "base"), mkPattern("child_p", "child")],
    items: [...ladderItems("base", "base_p"), ...ladderItems("child", "child_p")],
  });
}

/**
 * 给基线加一个"故事 + 一个挑战槽"，槽的形状默认与基线内容咬合（child/child_p/难度 1~3），
 * 因此**只有故事时长**这一条可能被触发。
 *
 * 不能复用 fixtures 里的 `withStory()`：那个槽声明的是「难度 1~5」，
 * 而基线内容最高只到 3 —— 那正是 `_lint_slot_ceiling` 要报的缺口，
 * 会把故事时长的用例污染成两条警告。
 */
function addStory(
  bundle: ContentBundle,
  storyCode: string,
  seconds: number,
  slotOverrides: Partial<ChallengeSlot> = {},
): ContentBundle {
  const beatId = `${storyCode}__b1`;
  bundle.stories.set(
    storyCode,
    mkStory(storyCode, {
      target_competencies: ["child"],
      beats: [
        mkBeat(beatId, { sequence: 1, beat_type: "challenge", slot_code: `${storyCode}_slot` }),
        mkBeat(`${storyCode}__b2`, { sequence: 2, beat_type: "reward", narration: "太棒了" }),
      ],
    }),
  );
  bundle.slots.set(
    `${storyCode}_slot`,
    mkSlot(`${storyCode}_slot`, "child", {
      pattern_id: "child_p",
      story_beat_id: beatId,
      difficulty_min: 1,
      difficulty_max: 3,
      estimated_seconds: seconds,
      ...slotOverrides,
    }),
  );
  return bundle;
}

/**
 * 往某个 `(能力, pattern, 脚手架层)` 塞 `count` 道难度相同的题。
 *
 * 用途是构造"某层只有别的 pattern 的题"这类场景 —— 那里同时要求候选池 ≥3
 * （否则 `_lint_slot_pools` 会一起报），所以必须能批量造同层的题。
 * `offset` 由调用方给，用来保证题面不撞车。
 */
function addLump(
  bundle: ContentBundle,
  prefix: string,
  count: number,
  target: { competency: string; pattern: string; scaffold: ScaffoldLevel; difficulty: number; offset: number },
): void {
  for (let index = 0; index < count; index += 1) {
    const code = `${prefix}_${index}`;
    bundle.items.set(
      code,
      mkItem(code, target.competency, target.pattern, {
        difficulty: target.difficulty,
        scaffold_level: target.scaffold,
        estimated_seconds: target.difficulty * 5 + 20,
        ...fields(target.offset + index),
      }),
    );
  }
}

function item(bundle: ContentBundle, code: string): Item {
  return bundle.items.get(code)!;
}

/** 把 base 或 child 的三道题整体换掉，保持梯子的形状、只改关心的那几个字段 */
function replaceLadder(
  bundle: ContentBundle,
  competency: string,
  overrides: Partial<Item>,
): ContentBundle {
  for (const row of LADDER) {
    const code = `${competency}_d${row.difficulty}`;
    bundle.items.set(
      code,
      mkItem(code, competency, `${competency}_p`, { ...item(bundle, code), ...overrides }),
    );
  }
  return bundle;
}

function warningsOf(bundle: ContentBundle): string[] {
  return lintBundle(bundle);
}

/** 断言 warnings 里刚好有这一条（用来钉"只报这一条、别的不许报"） */
function onlyWarning(warnings: readonly string[]): string {
  expect(warnings, `期望刚好 1 条警告，实际 ${warnings.length} 条：${warnings.join(" | ")}`)
    .toHaveLength(1);
  return warnings[0]!;
}

// ── 基线自证 ───────────────────────────────────────────────

describe("干净基线", () => {
  it("合成基线自身零警告（后面每条用例都从它出发只改一处）", () => {
    expect(warningsOf(lintCleanBundle())).toEqual([]);
  });

  it("带一个完整故事（时长落在 4~10 分钟内）的基线也零警告", () => {
    expect(warningsOf(addStory(lintCleanBundle(), "s", 300))).toEqual([]);
  });

  it("真实内容：警告非空且全部来自 _lint_slot_ceiling（特征化，不是移植正确性的证据）", () => {
    const warnings = warningsOf(loadBundle());
    // 这条断言的价值在于**记录**一个事实：另外 8 条规则在真实内容上零输出，
    // 所以它们只能靠本文件的合成用例守住。哪天内容长出别的警告，这里会变红，
    // 提醒改动者去 S1-2c 的 fixture 里同步期望值。
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(
        warning.includes("声明的上限难度") ||
          warning.includes("但该 pattern 在难度区间内没有题") ||
          warning.includes("层在区间内只有别的 pattern 的题"),
        `真实内容出现了 _lint_slot_ceiling 之外的警告：${warning}`,
      ).toBe(true);
    }
  });
});

// ── _lint_coverage ─────────────────────────────────────────

/** 每个能力都必须有 blocks/decompose/direct 三层 —— 缺一层，脚手架递退就在那里跳级 */
describe("_lint_coverage", () => {
  function withoutTiers(competency: string, keep: readonly ScaffoldLevel[]): string[] {
    const bundle = lintCleanBundle();
    for (const row of LADDER) {
      if (keep.includes(row.scaffold)) continue;
      bundle.items.delete(`${competency}_d${row.difficulty}`);
    }
    return warningsOf(bundle);
  }

  it("缺 blocks/decompose 两档时一条警告列出两档", () => {
    expect(onlyWarning(withoutTiers("base", ["direct"]))).toBe(
      "competency base 缺少脚手架级别 blocks/decompose 的题目：脚手架递退会在此处跳级",
    );
  });

  it("缺的档位按 SCAFFOLD_LEVELS 的顺序列出，不是字母序", () => {
    // 只留 blocks 时缺的是 decompose/direct —— 字母序会给 blocks/direct
    expect(onlyWarning(withoutTiers("base", ["blocks"]))).toContain(
      "缺少脚手架级别 decompose/direct 的题目",
    );
    // 只留 decompose 时缺的是 blocks/direct（两种顺序在这里恰好相同，
    // 所以上面那条才是判别性的）
    expect(onlyWarning(withoutTiers("base", ["decompose"]))).toContain(
      "缺少脚手架级别 blocks/direct 的题目",
    );
  });

  it("完全没有题的能力不报（那是 validate 的错误，不是 lint 的警告）", () => {
    const bundle = lintCleanBundle();
    for (const code of [...bundle.items.keys()]) {
      if (item(bundle, code).competency_id === "base") bundle.items.delete(code);
    }
    expect(warningsOf(bundle)).toEqual([]);
  });
});

// ── _lint_time_estimates ───────────────────────────────────

describe("_lint_time_estimates", () => {
  /**
   * 每个能力的三道题各自组成一个 interaction。
   *
   * 两个能力**必须用不同的 interaction_type**：否则 6 道题落进同一个桶，
   * "题数 < 3 就跳过"的边界用例永远构造不出来。
   */
  function timeBundle(
    baseSeconds: readonly number[],
    childSeconds: readonly number[] = [15, 20, 25],
    baseName = "number_pad",
    childName = "pad_child",
  ): ContentBundle {
    const bundle = lintCleanBundle();
    const plan = [
      ["base", "base_p", baseName, baseSeconds],
      ["child", "child_p", childName, childSeconds],
    ] as const;
    for (const [competency, pattern, interaction, seconds] of plan) {
      LADDER.forEach((row, index) => {
        const code = `${competency}_d${row.difficulty}`;
        bundle.items.set(
          code,
          mkItem(code, competency, pattern, {
            difficulty: row.difficulty,
            scaffold_level: row.scaffold,
            interaction_type: interaction,
            estimated_seconds: seconds[index]!,
            ...fields(baseOf(competency) + row.difficulty),
          }),
        );
      });
    }
    return bundle;
  }

  it("难度越高耗时反而越短时报反向", () => {
    expect(onlyWarning(warningsOf(timeBundle([30, 20, 10])))).toBe(
      "interaction number_pad 的预估耗时与难度反向：难度 1 用 30s，难度 3 用 10s",
    );
  });

  it("耗时相等不报（两个方向都不算反向）", () => {
    expect(warningsOf(timeBundle([20, 20, 20]))).toEqual([]);
  });

  it("题数 < 3 的 interaction 整段跳过 —— 连反向也不报", () => {
    // 把 base 的三道题拆成三个只有 1 道题的 interaction（不能直接删题 ——
    // 那会顺带触发 _lint_coverage 的缺档告警，用例就不收敛了）
    const bundle = timeBundle([30, 20, 10]);
    LADDER.forEach((row) => {
      const code = `base_d${row.difficulty}`;
      bundle.items.set(
        code,
        mkItem(code, "base", "base_p", {
          ...item(bundle, code),
          interaction_type: `solo_${row.difficulty}`,
        }),
      );
    });
    expect(warningsOf(bundle)).toEqual([]);
  });

  it("题数 < 3 时也不检查 estimated_seconds —— 检查在 continue 之后（Python 原样）", () => {
    const bundle = timeBundle([0, 20, 25]);
    // 把 base_d3 挪到别的 interaction：number_pad 只剩 2 道题（含 0 秒的那道）
    bundle.items.set(
      "base_d3",
      mkItem("base_d3", "base", "base_p", {
        ...item(bundle, "base_d3"),
        interaction_type: "solo_3",
      }),
    );
    expect(warningsOf(bundle)).toEqual([]);
  });

  it("题数 ≥ 3 时 0 秒会报", () => {
    expect(warningsOf(timeBundle([0, 20, 25]))).toEqual([
      "item base_d1 的 estimated_seconds 不合理",
    ]);
  });

  it("负秒也报", () => {
    expect(onlyWarning(warningsOf(timeBundle([-5, 20, 25])))).toBe(
      "item base_d1 的 estimated_seconds 不合理",
    );
  });

  it("多个 interaction 按名字的字符串序报，不是加载顺序", () => {
    // base 的三道题插在 child 之前，但 base 用 z_pad、child 用 a_pad，
    // 期望输出里 a_pad 在前
    const bundle = timeBundle([99, 20, 10], [99, 20, 10], "z_pad", "a_pad");
    const warnings = warningsOf(bundle);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("interaction a_pad");
    expect(warnings[1]).toContain("interaction z_pad");
  });
});

// ── _lint_duplicates ───────────────────────────────────────

describe("_lint_duplicates", () => {
  function withPrompt(answers: readonly unknown[], prompt = "8 + 5 = ?"): ContentBundle {
    const bundle = lintCleanBundle();
    LADDER.forEach((row, index) => {
      const code = `base_d${row.difficulty}`;
      bundle.items.set(
        code,
        mkItem(code, "base", "base_p", {
          ...item(bundle, code),
          problem: { a: 8, b: 5, prompt },
          answer: answers[index],
        }),
      );
    });
    return bundle;
  }

  it("同 interaction 同题面、答案不同时报出来（回显先出现的那道题）", () => {
    expect(onlyWarning(warningsOf(withPrompt([13, 13, 12])))).toBe(
      "题面完全相同但答案不同：base_d2 / base_d3（「8 + 5 = ?」）",
    );
  });

  it("同题面但答案相同不报 —— 真实内容里有 51 处这种（刻意留的跨槽复用）", () => {
    expect(warningsOf(withPrompt([13, 13, 13]))).toEqual([]);
  });

  it("连续三道同题面时只比相邻两两（seen 是覆盖写，不是首次留存）", () => {
    // A(13) B(13) C(12)：A/B 相同、B/C 不同 → 只有 B/C 一条（而不是 A/C）
    expect(onlyWarning(warningsOf(withPrompt([13, 13, 12])))).toContain("base_d2 / base_d3");
  });

  it("题面相同但 interaction_type 不同不报（键是元组）", () => {
    const bundle = withPrompt([13, 13, 12]);
    LADDER.forEach((row) => {
      const code = `base_d${row.difficulty}`;
      bundle.items.set(
        code,
        mkItem(code, "base", "base_p", {
          ...item(bundle, code),
          interaction_type: `pad_${row.difficulty}`,
        }),
      );
    });
    expect(warningsOf(bundle)).toEqual([]);
  });

  it("没有 prompt 的题整个跳过（不会被当成同一个空题面）", () => {
    const bundle = lintCleanBundle();
    for (const row of LADDER) {
      const code = `base_d${row.difficulty}`;
      bundle.items.set(code, mkItem(code, "base", "base_p", { ...item(bundle, code), problem: {} }));
    }
    // 三道题都没有 prompt：只看得到 3 条「没有 prompt」，看不到重复告警
    expect(warningsOf(bundle)).toEqual([
      "item base_d1 没有 prompt",
      "item base_d2 没有 prompt",
      "item base_d3 没有 prompt",
    ]);
  });

  it("题面前后的空白会被 strip 掉再比较", () => {
    const bundle = lintCleanBundle();
    bundle.items.set(
      "base_d1",
      mkItem("base_d1", "base", "base_p", {
        ...item(bundle, "base_d1"),
        problem: { a: 8, b: 5, prompt: "8 + 5 = ?" },
        answer: 13,
      }),
    );
    bundle.items.set(
      "base_d2",
      mkItem("base_d2", "base", "base_p", {
        ...item(bundle, "base_d2"),
        problem: { a: 8, b: 5, prompt: "  8 + 5 = ?  " },
        answer: 12,
      }),
    );
    // 不 strip 的话两条键不同、根本不会比较 → 这条用例会变成"零警告"
    expect(onlyWarning(warningsOf(bundle))).toBe(
      "题面完全相同但答案不同：base_d1 / base_d2（「8 + 5 = ?」）",
    );
  });

  it("⚠️ 已知差异：answer 的 true 与 1 在 Python 里相等、这里不等", () => {
    // Python: True == 1 → 不报；TS: true !== 1 → 报。只影响"多报一条"。
    expect(onlyWarning(warningsOf(withPrompt([true, 1, 1])))).toBe(
      "题面完全相同但答案不同：base_d1 / base_d2（「8 + 5 = ?」）",
    );
  });
});

// ── _lint_hint_depth ───────────────────────────────────────

describe("_lint_hint_depth", () => {
  function withHints(difficulty: number, hints: readonly string[]): string[] {
    const bundle = lintCleanBundle();
    const code = `base_d${difficulty}`;
    bundle.items.set(code, mkItem(code, "base", "base_p", {
      ...item(bundle, code),
      hint_chain: [...hints],
    }));
    return warningsOf(bundle);
  }

  it("难度 3 只有 1 级提示时报", () => {
    expect(onlyWarning(withHints(3, ["数一数"]))).toBe(
      "item base_d3 难度 3 但只有 1 级提示，孩子卡住时没有台阶",
    );
  });

  it("难度 3 有 2 级提示不报（边界）", () => {
    expect(withHints(3, ["数一数", "再看看"])).toEqual([]);
  });

  it("难度 2 只有 1 级提示不报（边界在 3）", () => {
    expect(withHints(2, ["数一数"])).toEqual([]);
  });

  it("难度 5 一级提示都没有时报「只有 0 级提示」", () => {
    const bundle = lintCleanBundle();
    bundle.items.set("base_d3", mkItem("base_d3", "base", "base_p", {
      ...item(bundle, "base_d3"),
      difficulty: 5,
      hint_chain: [],
    }));
    expect(onlyWarning(warningsOf(bundle))).toBe(
      "item base_d3 难度 5 但只有 0 级提示，孩子卡住时没有台阶",
    );
  });
});

// ── _lint_slot_pools ───────────────────────────────────────

describe("_lint_slot_pools", () => {
  function withPoolSize(size: number): string[] {
    const bundle = addStory(lintCleanBundle(), "s", 300);
    const slot = bundle.slots.get("s_slot")!;
    bundle.slots.set("s_slot", {
      ...slot,
      difficulty_min: 1,
      difficulty_max: size === 0 ? 0 : LADDER[size - 1]!.difficulty,
    });
    return warningsOf(bundle);
  }

  it("候选池 1 道题时报", () => {
    expect(onlyWarning(withPoolSize(1))).toBe("slot s_slot 候选池只有 1 道题，容易重复出现");
  });

  it("候选池 2 道题时报（边界）", () => {
    expect(onlyWarning(withPoolSize(2))).toBe("slot s_slot 候选池只有 2 道题，容易重复出现");
  });

  it("候选池 3 道题不报（边界）", () => {
    expect(withPoolSize(3)).toEqual([]);
  });

  it("候选池为空不报（那是 validate 的错误）", () => {
    expect(withPoolSize(0).some((warning) => warning.includes("候选池"))).toBe(false);
  });

  it("pattern 绑定会进一步收窄池子 —— 同时触发脚手架层覆盖告警（同一缺口的两个面）", () => {
    const bundle = addStory(lintCleanBundle(), "s", 300);
    bundle.patterns.set("other_p", mkPattern("other_p", "child"));
    bundle.items.set(
      "child_d2",
      mkItem("child_d2", "child", "other_p", {
        ...item(bundle, "child_d2"),
        pattern_id: "other_p",
      }),
    );
    expect(warningsOf(bundle)).toEqual([
      "slot s_slot 候选池只有 2 道题，容易重复出现",
      "slot s_slot（child 难度 1~3） 绑定 pattern child_p，但脚手架 decompose 层在区间内" +
        "只有别的 pattern 的题 [2] —— 处于该层的孩子会拿到不是 child_p 的题",
    ]);
  });

  it("pattern 为 null 时按整个能力算池子（is None，不是 truthiness）", () => {
    const bundle = addStory(lintCleanBundle(), "s", 300, { pattern_id: null });
    expect(warningsOf(bundle)).toEqual([]);
  });
});

// ── _lint_story_shape ──────────────────────────────────────

describe("_lint_story_shape", () => {
  it("不足 4 分钟时报「不足 5 分钟的下限」（4 与 5 的不一致是 Python 原样）", () => {
    expect(onlyWarning(warningsOf(addStory(lintCleanBundle(), "s", 200)))).toBe(
      "故事 s 的挑战内容只有约 3.3 分钟，不足 5 分钟的下限",
    );
  });

  it("刚好 4.00 分钟不报 —— 判定是 < 4，文案说的却是 5", () => {
    expect(warningsOf(addStory(lintCleanBundle(), "s", 240))).toEqual([]);
  });

  it("刚好 10.00 分钟不报（判定是 > 10）", () => {
    expect(warningsOf(addStory(lintCleanBundle(), "s", 600))).toEqual([]);
  });

  it("超过 10 分钟时报，且 10.0166 会格式化成 10.0（看着矛盾，但格式就是一位小数）", () => {
    expect(onlyWarning(warningsOf(addStory(lintCleanBundle(), "s", 601)))).toBe(
      "故事 s 的挑战内容约 10.0 分钟，超过 10 分钟上限",
    );
  });

  it("⚠️ 15 秒 = 0.25 分钟：half-even 给 0.2，JS 的 toFixed(1) 会给 0.3", () => {
    // 这一条同时是 _lint_story_shape 的用例和 pyFormat1f 的接入证据：
    // 换成 `value.toFixed(1)` 这里立刻变成 0.3
    expect(onlyWarning(warningsOf(addStory(lintCleanBundle(), "s", 15)))).toBe(
      "故事 s 的挑战内容只有约 0.2 分钟，不足 5 分钟的下限",
    );
  });

  it("⚠️ 615 秒 = 10.25 分钟：half-even 给 10.2（toFixed 会给 10.3）", () => {
    expect(onlyWarning(warningsOf(addStory(lintCleanBundle(), "s", 615)))).toBe(
      "故事 s 的挑战内容约 10.2 分钟，超过 10 分钟上限",
    );
  });

  it("同一故事的多个挑战槽时长相加", () => {
    const bundle = addStory(lintCleanBundle(), "s", 150);
    bundle.stories.get("s")!.beats.push(
      mkBeat("s__b3", { sequence: 3, beat_type: "challenge", slot_code: "s_slot2" }),
    );
    bundle.slots.set(
      "s_slot2",
      mkSlot("s_slot2", "child", {
        pattern_id: "child_p",
        story_beat_id: "s__b3",
        difficulty_min: 1,
        difficulty_max: 3,
        estimated_seconds: 150,
      }),
    );
    // 150 + 150 = 300s = 5.0 分钟，落在线内
    expect(warningsOf(bundle)).toEqual([]);
  });

  it("按 story_code 排序报，不是槽位的加载顺序", () => {
    const bundle = addStory(lintCleanBundle(), "s_b", 60);
    addStory(bundle, "s_a", 60);
    const warnings = warningsOf(bundle);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("故事 s_a ");
    expect(warnings[1]).toContain("故事 s_b ");
  });

  it("story_beat_id 按第一个 __ 切出 story_code", () => {
    const bundle = lintCleanBundle();
    bundle.slots.set(
      "st09_b2_carry_add",
      mkSlot("st09_b2_carry_add", "child", {
        pattern_id: "child_p",
        story_beat_id: "st09__b2",
        difficulty_min: 1,
        difficulty_max: 3,
        estimated_seconds: 60,
      }),
    );
    expect(onlyWarning(warningsOf(bundle))).toContain("故事 st09 的挑战内容只有约 1.0 分钟");
  });

  it("没有 story_beat_id 的独立训练槽不计入任何故事", () => {
    const bundle = lintCleanBundle();
    bundle.slots.set(
      "core_slot",
      mkSlot("core_slot", "child", {
        pattern_id: "child_p",
        story_beat_id: null,
        difficulty_min: 1,
        difficulty_max: 3,
        estimated_seconds: 1,
      }),
    );
    expect(warningsOf(bundle)).toEqual([]);
  });
});

// ── _lint_steps（cognitive.lint_all）────────────────────────

describe("_lint_steps", () => {
  function withSteps(style: Item["steps_style"], steps: readonly string[], answer: unknown): string[] {
    const bundle = lintCleanBundle();
    bundle.items.set(
      "base_d3",
      mkItem("base_d3", "base", "base_p", {
        ...item(bundle, "base_d3"),
        steps_style: style,
        steps: [...steps],
        answer,
      }),
    );
    return warningsOf(bundle);
  }

  it("steps_style=conclude 但示范路径里没有答案时报", () => {
    expect(onlyWarning(withSteps("conclude", ["先凑十", "再加剩下的"], 7))).toBe(
      "item base_d3: steps_style=conclude，但示范路径全程没有出现答案 7",
    );
  });

  it("steps_style=guide 时同样的 steps 不报（默认是刻意的教学设计）", () => {
    expect(withSteps("guide", ["先凑十", "再加剩下的"], 7)).toEqual([]);
  });

  it("conclude 且 steps 里出现了答案不报", () => {
    expect(withSteps("conclude", ["3 + 4 = 7"], 7)).toEqual([]);
  });

  it("答案不是整数时直接跳过（没法比对）", () => {
    expect(withSteps("conclude", ["随便写点什么"], "七")).toEqual([]);
  });
});

// ── _lint_prompt_self_contained ────────────────────────────

describe("_lint_prompt_self_contained", () => {
  function withProblem(problem: Record<string, unknown>): string[] {
    const bundle = lintCleanBundle();
    bundle.items.set(
      "base_d3",
      mkItem("base_d3", "base", "base_p", { ...item(bundle, "base_d3"), problem }),
    );
    return warningsOf(bundle);
  }

  it("缺 prompt 键时报「没有 prompt」", () => {
    expect(onlyWarning(withProblem({ a: 8, b: 5 }))).toBe("item base_d3 没有 prompt");
  });

  it("prompt 是空白串时报「没有 prompt」", () => {
    expect(onlyWarning(withProblem({ a: 8, b: 5, prompt: "   " }))).toBe(
      "item base_d3 没有 prompt",
    );
  });

  it("prompt 是显式 null 时报的是「参数是 [5, 8]」而不是「没有 prompt」", () => {
    // Python 的 `str(None)` 是 "None"，非空 → 走不到"没有 prompt"分支，
    // 而是落进"题面里一个数字都没有"（"None" 里确实没有数字）
    expect(onlyWarning(withProblem({ a: 8, b: 5, prompt: null }))).toBe(
      "item base_d3 题面「None」里一个数字都没有，但参数是 [5, 8] —— " +
        "题面依赖故事补齐信息，被独立训练槽选中时会无法回答",
    );
  });

  it("题面里有数字就不报（参数有数字也无所谓）", () => {
    expect(withProblem({ a: 8, b: 5, prompt: "8 + 5 = ?" })).toEqual([]);
  });

  it("题面没数字、参数有整数时报，参数按数值升序列出", () => {
    expect(onlyWarning(withProblem({ a: 8, b: 3, c: 20, prompt: "一共多少个？" }))).toBe(
      "item base_d3 题面「一共多少个？」里一个数字都没有，但参数是 [3, 8, 20] —— " +
        "题面依赖故事补齐信息，被独立训练槽选中时会无法回答",
    );
  });

  it("题面没数字、参数只有 bool 时不报（bool 不是 int）", () => {
    expect(withProblem({ flag: true, other: false, prompt: "对吗？" })).toEqual([]);
  });

  it("题面没数字、参数只有小数时不报", () => {
    expect(withProblem({ ratio: 3.5, prompt: "对吗？" })).toEqual([]);
  });

  it("只遍历 problem 的顶层值 —— 列表里的数字不算参数", () => {
    expect(onlyWarning(withProblem({ a: 8, options: [3, 4], prompt: "选一个" }))).toBe(
      "item base_d3 题面「选一个」里一个数字都没有，但参数是 [8] —— " +
        "题面依赖故事补齐信息，被独立训练槽选中时会无法回答",
    );
  });

  it("参数是字符串「8」时不报（isinstance('8', int) 为假）", () => {
    expect(withProblem({ a: "8", prompt: "对吗？" })).toEqual([]);
  });

  it("负参数的负号不参与匹配（-8 给的是 8）", () => {
    expect(onlyWarning(withProblem({ a: -8, prompt: "对吗？" }))).toBe(
      "item base_d3 题面「对吗？」里一个数字都没有，但参数是 [8] —— " +
        "题面依赖故事补齐信息，被独立训练槽选中时会无法回答",
    );
  });
});

// ── _lint_slot_ceiling ─────────────────────────────────────

describe("_lint_slot_ceiling", () => {
  it("上限档没有题时报，并给出区间内实际最高难度", () => {
    const bundle = addStory(lintCleanBundle(), "s", 300, { difficulty_max: 5 });
    expect(warningsOf(bundle)).toEqual([
      "slot s_slot（child 难度 1~5） 声明的上限难度 5 在内容里不存在任何题" +
        "（实际最高 3）—— 熟练度高的孩子永远推不到这个槽位的顶",
    ]);
  });

  it("区间内一道题都没有时报「实际最高 None」", () => {
    const bundle = lintCleanBundle();
    bundle.slots.set(
      "empty_slot",
      mkSlot("empty_slot", "ghost", { pattern_id: null, difficulty_min: 1, difficulty_max: 4 }),
    );
    expect(warningsOf(bundle)).toEqual([
      "slot empty_slot（ghost 难度 1~4） 声明的上限难度 4 在内容里不存在任何题" +
        "（实际最高 None）—— 熟练度高的孩子永远推不到这个槽位的顶",
    ]);
  });

  it("上限档无题 + pattern 在区间内也无题 = 两条都报（上限那条不 continue）", () => {
    const bundle = addStory(lintCleanBundle(), "s", 300, {
      pattern_id: "ghost_p",
      difficulty_max: 5,
    });
    const warnings = warningsOf(bundle);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("声明的上限难度 5");
    expect(warnings[1]).toBe(
      "slot s_slot（child 难度 1~5） 绑定 pattern ghost_p，但该 pattern 在难度区间内没有题 —— " +
        "运行时会静默放宽成别的 pattern，这个槽声明的训练意图会落空",
    );
  });

  it("pattern 在区间内没有题时不再往下查脚手架层", () => {
    const bundle = addStory(lintCleanBundle(), "s", 300, { pattern_id: "ghost_p" });
    expect(warningsOf(bundle)).toEqual([
      "slot s_slot（child 难度 1~3） 绑定 pattern ghost_p，但该 pattern 在难度区间内没有题 —— " +
        "运行时会静默放宽成别的 pattern，这个槽声明的训练意图会落空",
    ]);
  });

  it("pattern_id 是空串时整个跳过 pattern 检查（truthiness，不是 is None）", () => {
    const bundle = addStory(lintCleanBundle(), "s", 300, { pattern_id: "" });
    expect(warningsOf(bundle)).toEqual([]);
  });

  it("槽位显式声明的层里只有别的 pattern 的题时报", () => {
    const bundle = lintCleanBundle();
    bundle.patterns.set("other_p", mkPattern("other_p", "child"));
    // other_p 只在 blocks 层有三道题 → 池子够宽（3 道），但 slot 只查 decompose 层
    addLump(bundle, "other", 3, {
      competency: "child",
      pattern: "other_p",
      scaffold: "blocks",
      difficulty: 1,
      offset: 200,
    });
    bundle.slots.set(
      "s_slot",
      mkSlot("s_slot", "child", {
        pattern_id: "other_p",
        scaffold_level: "decompose",
        difficulty_min: 1,
        difficulty_max: 3,
        estimated_seconds: 300,
      }),
    );
    expect(onlyWarning(warningsOf(bundle))).toBe(
      "slot s_slot（child 难度 1~3） 绑定 pattern other_p，但脚手架 decompose 层在区间内" +
        "只有别的 pattern 的题 [2] —— 处于该层的孩子会拿到不是 other_p 的题",
    );
  });

  it("别的 pattern 的难度按数值排序，不是字符串排序（[2, 10] 不是 [10, 2]）", () => {
    const bundle = lintCleanBundle();
    bundle.patterns.set("other_p", mkPattern("other_p", "child"));
    bundle.items.delete("child_d2");
    addLump(bundle, "child5", 1, {
      competency: "child", pattern: "child_p", scaffold: "direct", difficulty: 5, offset: 500,
    });
    addLump(bundle, "other2", 1, {
      competency: "child", pattern: "other_p", scaffold: "decompose", difficulty: 2, offset: 300,
    });
    addLump(bundle, "other10", 1, {
      competency: "child", pattern: "other_p", scaffold: "decompose", difficulty: 10, offset: 400,
    });
    bundle.slots.set(
      "s_slot",
      mkSlot("s_slot", "child", {
        pattern_id: "child_p",
        scaffold_level: "decompose",
        difficulty_min: 1,
        difficulty_max: 10,
        estimated_seconds: 300,
      }),
    );
    // child_p 在区间内 3 道（池子够宽）、至少有一道到上限档 10 → 只剩脚手架层这一条
    const warnings = warningsOf(bundle);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("只有别的 pattern 的题 [2, 10] ——");
  });

  it("自动层按脚手架名排序报，不按题的加载顺序", () => {
    // 这条钉的是 `sorted(by_scaffold)`。不排序的话层序 = **首次出现顺序**，
    // 而真实内容与合成基线里首次出现顺序恰好都等于字典序 ——
    // 也就是"排序"这件事在别处全都测不出来（已用变异测试确认：
    // 去掉 sortedStrings 后其余全部用例仍绿）。
    const bundle = lintCleanBundle();
    bundle.patterns.set("other_p", mkPattern("other_p", "child"));
    bundle.items.delete("child_d1");
    bundle.items.delete("child_d2");
    // 加载顺序：child_d3(direct) → decompose → blocks
    addLump(bundle, "other_dec", 3, {
      competency: "child", pattern: "other_p", scaffold: "decompose", difficulty: 2, offset: 300,
    });
    addLump(bundle, "other_blk", 3, {
      competency: "child", pattern: "other_p", scaffold: "blocks", difficulty: 1, offset: 200,
    });
    bundle.items.set(
      "child_d5",
      mkItem("child_d5", "child", "child_p", {
        difficulty: 5, scaffold_level: "direct", estimated_seconds: 25, ...fields(500),
      }),
    );
    bundle.items.set(
      "child_d10",
      mkItem("child_d10", "child", "child_p", {
        difficulty: 10, scaffold_level: "direct", estimated_seconds: 25, ...fields(600),
      }),
    );
    bundle.slots.set(
      "s_slot",
      mkSlot("s_slot", "child", {
        pattern_id: "child_p",
        scaffold_level: AUTO_SCAFFOLD,
        difficulty_min: 1,
        difficulty_max: 10,
        estimated_seconds: 300,
      }),
    );
    const warnings = warningsOf(bundle);
    expect(warnings).toHaveLength(2);
    // blocks 在 decompose 之前 —— 按名排序的结果，不是加载顺序（那是 decompose 在前）
    expect(warnings[0]).toContain("脚手架 blocks 层在区间内只有别的 pattern 的题 [1] ——");
    expect(warnings[1]).toContain("脚手架 decompose 层在区间内只有别的 pattern 的题 [2] ——");
  });

  it("显式声明的层里该 pattern 有题时不报（哪怕别的层没有）", () => {
    const bundle = addStory(lintCleanBundle(), "s", 300, { scaffold_level: "decompose" });
    expect(warningsOf(bundle)).toEqual([]);
  });

  it("显式声明的层里一道题都没有时不报（那是 _lint_coverage 的事）", () => {
    const bundle = lintCleanBundle();
    bundle.items.delete("child_d1");
    addLump(bundle, "child2b", 1, {
      competency: "child", pattern: "child_p", scaffold: "decompose", difficulty: 2, offset: 600,
    });
    bundle.slots.set(
      "s_slot",
      mkSlot("s_slot", "child", {
        pattern_id: "child_p",
        scaffold_level: "blocks",
        difficulty_min: 1,
        difficulty_max: 3,
        estimated_seconds: 300,
      }),
    );
    expect(onlyWarning(warningsOf(bundle))).toBe(
      "competency child 缺少脚手架级别 blocks 的题目：脚手架递退会在此处跳级",
    );
  });

  it("多个槽位按加载顺序报（不是按 code 排序）", () => {
    const bundle = addStory(lintCleanBundle(), "s_b", 300, { difficulty_max: 5 });
    addStory(bundle, "s_a", 300, { difficulty_max: 6 });
    const warnings = warningsOf(bundle);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("slot s_b_slot");
    expect(warnings[1]).toContain("slot s_a_slot");
  });
});

// ── computeStats / renderCoverage ──────────────────────────

describe("computeStats", () => {
  it("覆盖率按能力、按能力加载顺序给出，by_scaffold 恒有三档", () => {
    const stats = computeStats(lintCleanBundle());
    expect(Object.keys(stats.coverage)).toEqual(["base", "child"]);
    expect(stats.coverage["base"]).toEqual({
      name: "base",
      items: 3,
      by_scaffold: { blocks: 1, decompose: 1, direct: 1 },
      patterns: ["base_p"],
    });
    expect(stats.competencies).toBe(2);
    expect(stats.items).toBe(6);
    expect(stats.slots).toBe(0);
    expect(stats.story_slots).toBe(0);
    expect(stats.standalone_slots).toBe(0);
  });

  it("scaffold_level 是非法值时不计入 by_scaffold，也不会撞上 Object.prototype", () => {
    const bundle = lintCleanBundle();
    bundle.items.set(
      "base_d3",
      mkItem("base_d3", "base", "base_p", {
        ...item(bundle, "base_d3"),
        scaffold_level: "constructor" as ScaffoldLevel,
      }),
    );
    expect(computeStats(bundle).coverage["base"]!.by_scaffold).toEqual({
      blocks: 1,
      decompose: 1,
      direct: 0,
    });
  });

  it("items_by_pattern 按 pattern code 排序，story_slots 只数挂了节拍的槽", () => {
    const bundle = addStory(lintCleanBundle(), "s", 300);
    bundle.slots.set("core_slot", mkSlot("core_slot", "base"));
    const stats = computeStats(bundle);
    expect(Object.keys(stats.items_by_pattern)).toEqual(["base_p", "child_p"]);
    expect(stats.items_by_pattern["base_p"]).toBe(3);
    expect(stats.story_slots).toBe(1);
    expect(stats.standalone_slots).toBe(1);
    // 插入顺序：故事槽在前，独立槽在后
    expect(Object.keys(stats.slots_detail)).toEqual(["s_slot", "core_slot"]);
    expect(stats.slots_detail["s_slot"]).toBe(3);
    expect(stats.slots_detail["core_slot"]).toBe(3);
  });

  it("steps_style 非法的题不计入", () => {
    const bundle = lintCleanBundle();
    bundle.items.set(
      "base_d3",
      mkItem("base_d3", "base", "base_p", {
        ...item(bundle, "base_d3"),
        steps_style: "constructor" as Item["steps_style"],
      }),
    );
    expect(computeStats(bundle).items_by_steps_style).toEqual({ guide: 5, conclude: 0 });
  });

  it("items_by_pattern 的键序是排序后的，不是 pattern 首次出现的顺序", () => {
    // 真实内容里 pattern 的首次出现顺序**恰好**等于字典序（实测 10/10），
    // 所以这条排序在 fixture 对拍里也是测不出来的（变异已确认存活）。
    const bundle = lintCleanBundle();
    bundle.patterns.set("a_p", mkPattern("a_p", "base"));
    bundle.items.set(
      "base_a",
      mkItem("base_a", "base", "a_p", {
        difficulty: 1, scaffold_level: "blocks", estimated_seconds: 15, ...fields(700),
      }),
    );
    expect(Object.keys(computeStats(bundle).items_by_pattern)).toEqual(["a_p", "base_p", "child_p"]);
  });

  it("coverage 里每个能力的 patterns 是排序后的，不是题目出现顺序", () => {
    const bundle = lintCleanBundle();
    bundle.patterns.set("a_p", mkPattern("a_p", "base"));
    // 难度 3 + code 排在 base_d3 之后 → 首次出现顺序是 [base_p, a_p]，与字典序相反
    bundle.items.set(
      "base_z",
      mkItem("base_z", "base", "a_p", {
        difficulty: 3, scaffold_level: "direct", estimated_seconds: 25, ...fields(700),
      }),
    );
    expect(computeStats(bundle).coverage["base"]!.patterns).toEqual(["a_p", "base_p"]);
  });

  it("standalone_slots 是槽位总数减去故事槽，不是 story_slots 的副本", () => {
    // 只有一个故事槽 + 一个独立槽时两者相等（1 与 1），所以别处的断言区分不出来。
    const bundle = addStory(lintCleanBundle(), "s1", 300);
    addStory(bundle, "s2", 300);
    bundle.slots.set("core_slot", mkSlot("core_slot", "base", { difficulty_max: 3 }));
    const stats = computeStats(bundle);
    expect(stats.slots).toBe(3);
    expect(stats.story_slots).toBe(2);
    expect(stats.standalone_slots).toBe(1);
  });
});

describe("renderCoverage", () => {
  it("排版逐字对齐 Python 的 format 规格（宽度 22/5/7/7/7，末列前两个空格）", () => {
    expect(renderCoverage(computeStats(lintCleanBundle()))).toBe(
      [
        "competency             items  blocks  decomp  direct  patterns",
        "-".repeat(92),
        "base                       3       1       1       1  base_p",
        "child                      3       1       1       1  child_p",
      ].join("\n"),
    );
  });

  it("多个 pattern 用逗号加空格连接", () => {
    const bundle = lintCleanBundle();
    bundle.patterns.set("other_p", mkPattern("other_p", "base"));
    addLump(bundle, "other", 1, {
      competency: "base", pattern: "other_p", scaffold: "blocks", difficulty: 1, offset: 700,
    });
    expect(renderCoverage(computeStats(bundle)).split("\n")[2]).toContain("base_p, other_p");
  });

  it("没有 pattern 时那一列给一个破折号", () => {
    const bundle = lintCleanBundle();
    for (const code of [...bundle.items.keys()]) {
      if (item(bundle, code).competency_id === "base") bundle.items.delete(code);
    }
    expect(renderCoverage(computeStats(bundle)).split("\n")[2]).toBe(
      "base                       0       0       0       0  —",
    );
  });

  it("空内容只有表头与分隔线", () => {
    const lines = renderCoverage(computeStats(mkBundle({}))).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("-".repeat(92));
  });
});

describe("renderStatsReport", () => {
  it("五节的骨架与相对顺序（总览 / 覆盖表 / 按结构分布 / 示范路径 / 候选池宽度）", () => {
    const bundle = addStory(lintCleanBundle(), "s", 300);
    const lines = renderStatsReport(computeStats(bundle)).split("\n");
    expect(lines[0]).toBe("内容总览");
    expect(lines[1]).toBe("  能力 2 ｜ 结构 2 ｜ 题目 6 ｜ 槽位 1（故事 1 / 独立 0）｜ 误区 0");
    expect(lines[2]).toBe("");
    // 覆盖表接在这里（它自己的排版由 renderCoverage 的用例与 fixture 守）
    expect(lines[3]).toBe("competency             items  blocks  decomp  direct  patterns");
    expect(lines[4]).toBe("-".repeat(92));
    expect(lines[8]).toBe("按认知结构分布");
    expect(lines[12]).toBe("示范路径写法：guide（最后一步留给孩子）6 道 ｜ conclude（写出答案）0 道");
    expect(lines[14]).toBe("槽位候选池宽度");
  });

  it("按结构分布的行宽：pattern 左对齐 22、道数右对齐 4", () => {
    const lines = renderStatsReport(computeStats(lintCleanBundle())).split("\n");
    // 从节名往后取，不能用 includes("base_p") 找 —— 覆盖表的 patterns 列也有 base_p
    const row = lines[lines.indexOf("按认知结构分布") + 1]!;
    expect(row).toBe(`  ${"base_p".padEnd(22)} ${"3".padStart(4)}`);
    expect(row.length).toBe(29);
  });

  it("候选池窄于 3 道时打 ⚠️，标记与两个空格等宽（列不会错开）", () => {
    // ⚠️ 真实内容 52 个槽位的候选池最窄也有 8 道 → 这条分支在 fixture 对拍里
    // **永远走不到**（见 tests/acceptance/lint-parity.test.ts 的同名断言）。
    // 它是整个报表里唯一一处只有本用例守着的排版。
    const bundle = lintCleanBundle();
    bundle.slots.set(
      "slot_narrow",
      mkSlot("slot_narrow", "child", {
        pattern_id: "child_p", difficulty_min: 3, difficulty_max: 3,
      }),
    );
    bundle.slots.set(
      "slot_widest",
      mkSlot("slot_widest", "child", {
        pattern_id: "child_p", difficulty_min: 1, difficulty_max: 3,
      }),
    );
    const lines = renderStatsReport(computeStats(bundle)).split("\n");
    const narrow = lines.find((line) => line.includes("slot_narrow"))!;
    const widest = lines.find((line) => line.includes("slot_widest"))!;

    expect(narrow).toBe(`  ⚠️ ${"slot_narrow".padEnd(32)} ${"1".padStart(3)} 道`);
    expect(widest).toBe(`     ${"slot_widest".padEnd(32)} ${"3".padStart(3)} 道`);
    // 标记恰占两格 → 两个槽位的 code 起始列相同（换成 "⚠" 或 "!!" 都会错开）
    expect(narrow.indexOf("slot_narrow")).toBe(widest.indexOf("slot_widest"));
  });

  it("槽位候选池按 slot_code 排序，不是槽位加载顺序", () => {
    const bundle = lintCleanBundle();
    // 加载顺序：slot_zzz 在前、slot_aaa 在后
    bundle.slots.set("slot_zzz", mkSlot("slot_zzz", "child", { difficulty_min: 1, difficulty_max: 3 }));
    bundle.slots.set("slot_aaa", mkSlot("slot_aaa", "child", { difficulty_min: 1, difficulty_max: 3 }));
    const lines = renderStatsReport(computeStats(bundle)).split("\n");
    const rows = lines.slice(lines.indexOf("槽位候选池宽度") + 1);
    expect(rows.map((line) => line.trim().split(/\s+/)[0])).toEqual(["slot_aaa", "slot_zzz"]);
  });

  it("按结构分布的键序不依赖 JS 的整数样式键规则", () => {
    // ⚠️ 只有这条用例能区分 `sortedStrings(Object.keys(x))` 与裸 `Object.keys(x)`：
    // 键是 "2" / "10" 这种整数样式字符串时，JS **按数值**把它们提到最前（["2","10"]），
    // 而 Python 的 dict 保持 `sorted()` 给的字符串序（["10","2"]）。
    // 真实内容的 pattern code 全是标识符 → 这一条在 fixture 对拍里也测不出来。
    const bundle = lintCleanBundle();
    for (const code of ["10", "2"]) {
      bundle.patterns.set(code, mkPattern(code, "base"));
      bundle.items.set(
        `base_p${code}`,
        mkItem(`base_p${code}`, "base", code, { difficulty: 1, ...fields(810 + Number(code)) }),
      );
    }
    const lines = renderStatsReport(computeStats(bundle)).split("\n");
    const start = lines.indexOf("按认知结构分布") + 1;
    const rows = lines.slice(start, start + 4);
    expect(rows.map((line) => line.trim().split(/\s+/)[0])).toEqual([
      "10",
      "2",
      "base_p",
      "child_p",
    ]);
  });

  it("空内容：报表仍有完整的五节，只是每节零行", () => {
    const lines = renderStatsReport(computeStats(mkBundle({}))).split("\n");
    expect(lines[0]).toBe("内容总览");
    expect(lines[1]).toBe("  能力 0 ｜ 结构 0 ｜ 题目 0 ｜ 槽位 0（故事 0 / 独立 0）｜ 误区 0");
    expect(lines).toContain("按认知结构分布");
    expect(lines).toContain("槽位候选池宽度");
    expect(lines[lines.length - 1]).toBe("槽位候选池宽度");
  });
});

// ── 自证：9 条规则每条都至少被触发过一次 ────────────────────

/**
 * 每条规则有一个**独一无二的文案特征**。下面那条测试把"最短触发路径"的产物
 * 收集起来，断言 9 个特征全部命中。
 *
 * 这是双保险：某条规则被改成 `return []` 时，它自己的用例会红 —— 但如果有人
 * **连用例一起删掉**，就没人拦得住了。有了这条断言，"哪条规则被整个漏掉了"
 * 是一个显式的失败。
 */
const RULE_MARKERS: ReadonlyArray<readonly [string, (warning: string) => boolean]> = [
  ["_lint_coverage", (w) => w.includes("缺少脚手架级别")],
  [
    "_lint_time_estimates",
    (w) => w.includes("的预估耗时与难度反向") || w.includes("estimated_seconds 不合理"),
  ],
  ["_lint_duplicates", (w) => w.startsWith("题面完全相同但答案不同：")],
  ["_lint_hint_depth", (w) => w.endsWith("孩子卡住时没有台阶")],
  ["_lint_slot_pools", (w) => w.includes("候选池只有")],
  ["_lint_story_shape", (w) => w.includes("分钟，")],
  ["_lint_steps", (w) => w.includes("steps_style=conclude")],
  [
    "_lint_prompt_self_contained",
    (w) => w.includes("没有 prompt") || w.includes("里一个数字都没有"),
  ],
  [
    "_lint_slot_ceiling",
    (w) =>
      w.includes("声明的上限难度") ||
      w.includes("但该 pattern 在难度区间内没有题") ||
      w.includes("层在区间内只有别的 pattern 的题"),
  ],
];

describe("自证", () => {
  /** 每条规则的最短触发路径 —— 与上面各 describe 里的正向用例同源 */
  function canonicalTriggers(): string[][] {
    const missingTier = lintCleanBundle();
    missingTier.items.delete("base_d1");

    const reversed = replaceLadder(lintCleanBundle(), "base", { estimated_seconds: 99 });

    const duplicate = lintCleanBundle();
    duplicate.items.set(
      "base_d2",
      mkItem("base_d2", "base", "base_p", {
        ...item(duplicate, "base_d2"),
        problem: { a: 1, b: 2, prompt: "1 + 2 = ?" },
      }),
    );

    const shallow = replaceLadder(lintCleanBundle(), "base", { hint_chain: ["只有一级"] });

    const narrowPool = lintCleanBundle();
    narrowPool.slots.set(
      "core_slot",
      mkSlot("core_slot", "child", { pattern_id: "child_p", difficulty_min: 1, difficulty_max: 1 }),
    );

    const shortStory = addStory(lintCleanBundle(), "s", 60);

    const conclude = replaceLadder(lintCleanBundle(), "base", {
      steps_style: "conclude",
      steps: ["没有答案"],
    });

    const noPrompt = replaceLadder(lintCleanBundle(), "base", { problem: { a: 1, b: 2 } });

    const unreachableCeiling = addStory(lintCleanBundle(), "s", 300, { difficulty_max: 9 });

    return [
      warningsOf(missingTier),
      warningsOf(reversed),
      warningsOf(duplicate),
      warningsOf(shallow),
      warningsOf(narrowPool),
      warningsOf(shortStory),
      warningsOf(conclude),
      warningsOf(noPrompt),
      warningsOf(unreachableCeiling),
    ];
  }

  it("9 条规则每条都至少被触发过一次（防止某条被写成 return [] 而测试全绿）", () => {
    const hit = new Set<string>();
    for (const warnings of canonicalTriggers()) {
      for (const warning of warnings) {
        for (const [rule, matches] of RULE_MARKERS) if (matches(warning)) hit.add(rule);
      }
    }
    expect([...hit].sort()).toEqual(RULE_MARKERS.map(([rule]) => rule).sort());
  });

  it("每个探针都真的报出了东西（否则上面那条可能靠别的探针误命中）", () => {
    for (const warnings of canonicalTriggers()) {
      expect(warnings.length).toBeGreaterThan(0);
    }
  });

  it("compileReport 把 validate / lint / stats 三段拼在一起", () => {
    const bundle = loadBundle();
    const report = compileReport(bundle, minPatternsFromRaw(readConfigSection("algorithm")));
    expect(report.problems).toEqual([]);
    expect(report.warnings).toHaveLength(10);
    expect(report.stats.items).toBe(1373);
  });
});
