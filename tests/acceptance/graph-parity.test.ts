/**
 * 能力图谱对拍 —— TS 的 CompetencyGraph vs Python 的黄金语料。
 *
 * 真实图（10 个能力）+ 合成图（环 / 自依赖 / 孤立 / 无 pattern / stage 不同）。
 *
 * ## 为什么合成图不是"锦上添花"
 *
 * 真实内容里 10 个能力**全是 stage 1**，于是 `topological_order` 的排序键
 * `(stage, code)` 退化成 `code` —— 把 stage 那一维删掉，对拍照样全绿。
 * 这和 S1-1 里 `toContentDump` 踩的是**同一个盲区**：fixture 只能证明
 * "现有数据走过的分支"是对的。
 *
 * 所以 `stage 不同：topological_order 必须按 (stage, code) 而不是 code`
 * 那条合成用例是这里最有价值的一条：它用 `{"z": [], "a": []}` +
 * `{z:1, a:2}` 让两种排序给出**不同**的答案（`[z,a]` vs `[a,z]`）。
 *
 * 另外两条容易漏的：
 *   - `插入顺序影响 validate 的报错顺序` —— validate 迭代的是 dict 的
 *     **插入顺序**而不是排序结果，用逆字典序插入才测得出；
 *   - `find_cycles 可能重复报告同一个环` —— 这是 Python 刻意的行为，
 *     去重会让文案顺序也变。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CompetencyGraph } from "@/src/engine/graph";
import type { CognitiveType, ContentBundle, Pattern } from "@/src/content/types";
import { canonical } from "../helpers/canonical";
import { invokeExpression, methodsUsedIn } from "../helpers/invoke";

/** 合成图里的 pattern 声明：[认知类型, 主能力, 适用能力?] */
type PatternSpec = [CognitiveType, string] | [CognitiveType, string, string[]];

interface SyntheticGraph {
  name: string;
  /** 前驱关系；**键序不可信**（fixture 是 sort_keys 的），顺序看 competency_order */
  competencies: Record<string, string[]>;
  /**
   * 插入顺序 —— 必须单独带一份。
   *
   * `validate()` 迭代的是 dict 的插入顺序而不是排序结果，而 fixture 的
   * `sort_keys=True` 会把 JSON 对象的键按字典序重排。不读这个字段的话，
   * "插入顺序影响报错顺序"那条用例会被悄悄测成"排序顺序"。
   */
  competency_order: string[];
  /** 实际生效的 patterns（Python 侧在未指定时会为每个能力自动补一个） */
  patterns: Record<string, PatternSpec>;
  stages: Record<string, number>;
  expressions: string[];
  values: Record<string, unknown>;
  /** 只有刻意要覆盖 next_unmastered 的图才有（见 dump_fixtures.py 的 GRAPH_SYNTHETIC） */
  mastery_probes?: Array<{ mastered: string[]; expect: string | null }>;
  /** 同上，覆盖 weakest_prerequisite 的并列取小 */
  weakest_probes?: Array<{ code: string; expect: string | null }>;
}

interface Fixture {
  real: Record<string, unknown>;
  expressions: string[];
  mastery_probes: Array<{ name: string; mastered: string[]; expect: string | null }>;
  weakest_probes: Array<{ name: string; code: string; expect: string | null }>;
  synthetic: SyntheticGraph[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/graph_parity.json",
);

const fixture = ((): Fixture => {
  try {
    return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;
  } catch (error) {
    throw new Error(
      `图谱对拍基准读不到。\n  路径：${FIXTURE_PATH}\n` +
        `  重新生成：python3 scripts/oracle/dump_fixtures.py graph\n` +
        `  原因：${String(error)}`,
    );
  }
})();

/** Python 名 → TS 名。属性（competencies / patterns）两侧同名，不用列。 */
const METHOD_NAMES: Record<string, string> = {
  prerequisites: "prerequisites",
  dependents: "dependents",
  topological_order: "topologicalOrder",
  patterns_for: "patternsFor",
  find_cycles: "findCycles",
  validate: "validate",
};

function makeBundle(spec: {
  competencies: Record<string, string[]>;
  competency_order: string[];
  patterns: Record<string, PatternSpec>;
  stages: Record<string, number>;
}): ContentBundle {
  const competencies = new Map(
    spec.competency_order.map((code) => [
      code,
      {
        code,
        name: code,
        description: "",
        prerequisites: [...(spec.competencies[code] ?? [])],
        stage: spec.stages[code] ?? 1,
        terms: [],
      },
    ]),
  );
  const patterns = new Map<string, Pattern>(
    Object.entries(spec.patterns).map(([code, declaration]) => [
      code,
      {
        code,
        name: code,
        cognitive_type: declaration[0],
        primary_competency: declaration[1],
        applicable_competencies: declaration[2] === undefined ? [] : [...declaration[2]],
        description: "",
      },
    ]),
  );
  return {
    competencies,
    patterns,
    items: new Map(),
    misconceptions: new Map(),
    slots: new Map(),
    stories: new Map(),
    load_problems: [],
  };
}

/**
 * 与 `scripts/oracle/dump_fixtures.py` 的 `_graph_value` **对称**的规范化。
 *
 * `patterns_for` 只比 code 列表：`cmd_dump` 把 `applicable_competencies` 规范化成
 * `sorted(set(...) | {primary})`，而运行时的 Pattern 保留 YAML 原始顺序 ——
 * 两边这一项本来就不同（见 dump_fixtures.py 里的完整论证）。
 *
 * 两侧对称实现是**自证的**：一边做了一边没做，比较会立刻失败，
 * 而不是悄悄放过（这一条在本次迁移里已经真的报红过一次）。
 */
function normalize(expression: string, value: unknown): unknown {
  if (expression.startsWith("patterns_for[") && Array.isArray(value)) {
    return value.map((pattern) => (pattern as Pattern).code);
  }
  return value;
}

function compare(
  graph: CompetencyGraph,
  expressions: readonly string[],
  expected: Record<string, unknown>,
): string[] {
  const divergences: string[] = [];
  for (const expression of expressions) {
    const actual = normalize(expression, invokeExpression(graph, METHOD_NAMES, expression));
    if (canonical(actual) !== canonical(expected[expression])) {
      divergences.push(
        `   ${expression}\n` +
          `     期望：${canonical(expected[expression])}\n` +
          `     实际：${canonical(actual)}`,
      );
    }
  }
  return divergences;
}

// 真实图需要走 bundle：用运行时入口是为了顺带验证 load_order 重建后的顺序
async function loadRealGraph(): Promise<CompetencyGraph> {
  const { contentBundle } = await import("@/src/content/bundle");
  return new CompetencyGraph(contentBundle());
}

describe("CompetencyGraph（真实内容）", () => {
  it("全部查询与 Python 一致", async () => {
    const graph = await loadRealGraph();
    const divergences = compare(graph, fixture.expressions, fixture.real);
    expect(
      divergences.join("\n"),
      `${divergences.length}/${fixture.expressions.length} 条查询与 Python 不一致。`,
    ).toBe("");
  });

  it("表达式清单与结果键一一对应（没有只生成不比较的）", () => {
    expect([...fixture.expressions].sort()).toEqual(Object.keys(fixture.real).sort());
  });

  it("METHOD_NAMES 里没有死键", () => {
    const used = methodsUsedIn(fixture.expressions);
    const dead = Object.keys(METHOD_NAMES).filter((name) => !used.has(name));
    expect(dead, "这些映射没有被任何 fixture 表达式用到").toEqual([]);
  });
});

describe("CompetencyGraph.next_unmastered（真实内容）", () => {
  for (const probe of fixture.mastery_probes) {
    it(probe.name, async () => {
      const graph = await loadRealGraph();
      const mastered = new Set(probe.mastered);
      expect(graph.nextUnmastered((code) => mastered.has(code))).toBe(probe.expect);
    });
  }
});

describe("CompetencyGraph.weakest_prerequisite（真实内容）", () => {
  for (const probe of fixture.weakest_probes) {
    it(probe.name, async () => {
      const graph = await loadRealGraph();
      // 分数用 code 长度 —— 会有并列，正好钉住"并列取 code 较小者"
      expect(graph.weakestPrerequisite(probe.code, (code) => code.length)).toBe(probe.expect);
    });
  }
});

describe("CompetencyGraph（合成图：真实内容到不了的分支）", () => {
  for (const spec of fixture.synthetic) {
    it(spec.name, () => {
      const graph = new CompetencyGraph(makeBundle(spec));
      const divergences = compare(graph, spec.expressions, spec.values);
      for (const probe of spec.mastery_probes ?? []) {
        const mastered = new Set(probe.mastered);
        const actual = graph.nextUnmastered((code) => mastered.has(code));
        if (actual !== probe.expect) {
          divergences.push(
            `   next_unmastered（已掌握 ${canonical(probe.mastered)}）\n` +
              `     期望：${canonical(probe.expect)}\n` +
              `     实际：${canonical(actual)}`,
          );
        }
      }
      for (const probe of spec.weakest_probes ?? []) {
        // 分数用 code 长度 —— 合成图的 diamond 里 b/c/d 全都是 1，必然并列
        const actual = graph.weakestPrerequisite(probe.code, (code) => code.length);
        if (actual !== probe.expect) {
          divergences.push(
            `   weakest_prerequisite("${probe.code}")\n` +
              `     期望：${canonical(probe.expect)}\n` +
              `     实际：${canonical(actual)}`,
          );
        }
      }
      expect(divergences.join("\n"), "合成图上的行为与 Python 不一致").toBe("");
    });
  }

  it("合成图确实覆盖了真实内容覆盖不到的分支", () => {
    // 这三条是"删掉 stage / 去重环 / 改成排序迭代"时唯一的防线 ——
    // 没有这条断言，将来有人"精简"合成图时可以悄悄删光它们而不自知。
    const names = fixture.synthetic.map((spec) => spec.name).join("\n");
    expect(names).toContain("topological_order 必须按 (stage, code)");
    expect(names).toContain("插入顺序影响 validate 的报错顺序");
    expect(names).toContain("自依赖");
    expect(names).toContain("没有可用 pattern 的能力");
  });
});
