/**
 * lint / validate 的**同源变异对拍** —— 两侧读同一份 `lint_mutations.json`，
 * 各自在**真实内容**上施加同一组变异，比较 `{trace, problems, warnings}`。
 *
 * ── 为什么不能只对拍真实内容的现状 ──────────────────────
 *
 * 实测：1373 道题在 `validate_content` 下零报错，在 `lint_bundle` 下报 10 条警告，
 * **全部来自 `_lint_slot_ceiling`**。也就是说另外 8 条规则对真实内容的约束力是零 ——
 * TS 侧把它们逐个换成 `return []`，`check:content` 照样全绿。
 *
 * 所以规则类模块的正确性不能靠"真实内容跑一遍"。这里有两条互相独立的防线：
 *   · `tests/unit/lint.test.ts` —— 合成数据，每条规则正/反/边界都钉住；
 *   · 本文件 —— 真实内容 + 声明式变异，钉住"两侧对同一份输入的判断逐字相同"。
 * 合成数据证明"规则本身写得对"，变异对拍证明"移植没有走样"，缺一不可。
 *
 * ── 为什么 trace 也要逐字比 ────────────────────────────
 *
 * 只比 problems/warnings 的话，一个恰好不改变输出的解释器差异（比如两侧各自
 * 删掉了不同的题、而两组题产生同样的告警）会悄悄溜过去。trace 是
 * "这组 ops 到底改了什么实体"的产物，它一致才说明两侧面对的是同一个输入。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  lintBundle,
  computeStats,
  renderStatsReport,
  type ContentStats,
} from "@/src/content/lint";
import { validateBundle } from "@/src/content/compiler";
import { loadBundle } from "@/src/content/loader";
import { canonical } from "../helpers/canonical";
import {
  applyLintOps,
  lintRuleOf,
  RULE_MARKERS,
  type LintMutationSpec,
} from "../helpers/lint-mutations";

function readJson<T>(file: string, hint: string): T {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch (error) {
    throw new Error(`${hint}\n  路径：${file}\n  原因：${String(error)}`);
  }
}

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../oracle/fixtures");

const spec = readJson<LintMutationSpec>(
  path.join(FIXTURE_DIR, "lint_mutations.json"),
  "变异规格读不到",
);

interface LintCase {
  id: string;
  note: string;
  targets: string[];
  trace: string[];
  problems: string[];
  warnings: string[];
  stats: ContentStats;
  stats_report: string;
}

interface LintParity {
  content_version: string;
  rules_covered: string[];
  cases: LintCase[];
}

const REGENERATE =
  "对拍基准 fixture 缺失或过期。跑 `python3 scripts/oracle/dump_fixtures.py lint` 重新生成";

const fixture = readJson<LintParity>(
  path.join(FIXTURE_DIR, "lint_parity.json"),
  REGENERATE,
);

// 规格与 fixture 必须描述同一批变异 —— 只更新了一份就是"对拍基准与输入对不上"，
// 后面所有断言都会建立在一个错误的配对上。这条放在最前面。
describe("lint_parity：前置一致性", () => {
  it("变异规格与 fixture 的 case 一一对应（顺序也一致）", () => {
    expect(fixture.cases.map((c) => c.id)).toEqual(spec.mutations.map((m) => m.id));
  });

  it("每条 case 的 targets / note 与规格一致", () => {
    for (const [i, mutation] of spec.mutations.entries()) {
      const testCase = fixture.cases[i]!;
      expect(testCase.targets, `case ${mutation.id} 的 targets 与规格不符`).toEqual(mutation.targets);
      expect(testCase.note, `case ${mutation.id} 的 note 与规格不符`).toBe(mutation.note);
    }
  });
});

/**
 * fixture 自身的自证 —— 保证"这些对拍是有约束力的"。
 *
 * Python 侧 dump 时已经断言过一遍，这里再断言一次不是冗余：fixture 是**源码**，
 * 它会被提交、被 review、也可能被人手改。生成期通过了不代表提交进仓库的那份
 * 还是通过的那份。
 */
describe("lint_parity：fixture 自证", () => {
  const byId = new Map(fixture.cases.map((c) => [c.id, c]));
  const baseline = byId.get("baseline");

  it("基线存在，且真实内容的现状是 0 错误 / 10 警告", () => {
    expect(baseline, "fixture 里没有 baseline").toBeDefined();
    expect(baseline!.problems).toEqual([]);
    expect(baseline!.warnings.length).toBe(10);
  });

  it("9 条 lint 规则全部被至少一条变异触发过", () => {
    // 没有这一条，某条规则可能两侧都返回 []，"对拍"对它就是空转。
    const expected = RULE_MARKERS.map(([rule]) => rule);
    expect([...fixture.rules_covered].sort()).toEqual([...expected].sort());
  });

  it("每条 case 的目标规则都真的出现在它的输出里", () => {
    for (const testCase of fixture.cases) {
      for (const rule of testCase.targets) {
        const hit = testCase.warnings.some((w) => lintRuleOf(w) === rule);
        expect(hit, `case ${testCase.id} 声称触发 ${rule}，但输出了 0 条该规则的警告`).toBe(true);
      }
    }
  });

  it("每条 case 的警告都能归属到某个已知规则（没有规则被悄悄改名）", () => {
    for (const testCase of fixture.cases) {
      for (const warning of testCase.warnings) {
        expect(
          lintRuleOf(warning),
          `case ${testCase.id} 有一条警告不属于任何已知规则 —— 规则的文案改了但特征表没跟上：\n  ${warning}`,
        ).not.toBeNull();
      }
    }
  });

  it("expect_baseline 的负向对照输出与基线逐字相同", () => {
    const controls = spec.mutations.filter((m) => m.expect_baseline).map((m) => m.id);
    // 对照存在，否则这条断言是空转
    expect(controls.length).toBeGreaterThan(0);
    for (const id of controls) {
      const testCase = byId.get(id)!;
      for (const field of ["problems", "warnings", "stats_report"] as const) {
        expect(testCase[field], `${id} 声称输出与基线相同，实际 ${field} 不同`).toEqual(
          baseline![field],
        );
      }
      expect(testCase.stats, `${id} 声称输出与基线相同，实际 stats 不同`).toEqual(baseline!.stats);
    }
  });

  it("expect_problems 的变异真的让 validate 报错", () => {
    const ids = spec.mutations.filter((m) => m.expect_problems).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(byId.get(id)!.problems.length, `${id} 应当报错却一条都没报`).toBeGreaterThan(0);
    }
  });

  it("除基线与负向对照外，每条变异都改变了输出（没有空转变异）", () => {
    // 空转的变异会让"对拍通过"看起来像一条证据，实际上什么也没验。
    const inert = new Set([
      "baseline",
      ...spec.mutations.filter((m) => m.expect_baseline).map((m) => m.id),
    ]);
    for (const testCase of fixture.cases) {
      if (inert.has(testCase.id)) continue;
      const changed =
        canonical(testCase.warnings) !== canonical(baseline!.warnings) ||
        canonical(testCase.problems) !== canonical(baseline!.problems) ||
        canonical(testCase.stats) !== canonical(baseline!.stats) ||
        canonical(testCase.stats_report) !== canonical(baseline!.stats_report);
      expect(changed, `变异 ${testCase.id} 的输出与基线完全相同 —— 它是空转的`).toBe(true);
    }
  });

  it("覆盖度报表有真实输出，且排版约束不是恒真的", () => {
    // 报表只有表头时，"逐字对齐 Python format 规格"这条断言是恒真的。
    const lines = baseline!.stats_report.split("\n");
    expect(lines.length).toBeGreaterThan(30);
    for (const anchor of [
      "内容总览",
      "competency             items  blocks  decomp  direct  patterns",
      "-".repeat(92),
      "按认知结构分布",
      "示范路径写法",
      "槽位候选池宽度",
    ]) {
      expect(
        lines.some((line) => line.startsWith(anchor)),
        `报表里没有「${anchor}」这一节`,
      ).toBe(true);
    }
    expect(lines[0]).toBe("内容总览");
    // 每一节的行数都对得上，报表没被截断
    const slots = lines.slice(lines.indexOf("槽位候选池宽度") + 1);
    expect(slots.length).toBe(Object.keys(baseline!.stats.slots_detail).length);
    expect(slots.every((line) => line.trim().length > 0)).toBe(true);
    // ⚠️ 已知盲区：真实内容 52 个槽位的候选池最窄也有 8 道，所以 `width < 3` 的
    // 「⚠️」分支在这里**永远走不到**。那条分支只有 tests/unit/lint.test.ts 守。
    expect(baseline!.stats_report).not.toContain("⚠️");
  });
});

describe("lint_parity：逐条变异对拍", () => {
  for (const mutation of spec.mutations) {
    it(`${mutation.id} —— ${mutation.note}`, () => {
      // 每条变异重新加载：真实内容的加载是有状态的（linkSlotsToBeats 会回填
      // beat.slot_code），复用同一个 bundle 会让第二条变异从"上一条改过的内容"
      // 出发。Python 侧也是每条重新 load_bundle()。
      const bundle = loadBundle();
      expect(bundle.load_problems, "内容存在加载期问题，变异对拍不可信").toEqual([]);

      const expected = fixture.cases.find((c) => c.id === mutation.id);
      expect(expected, `fixture 里没有 case ${mutation.id}：${REGENERATE}`).toBeDefined();

      // ① trace：证明两侧施加的是同一组变异
      const trace = applyLintOps(bundle, mutation.ops);
      expect(trace, "变异 trace 不一致 —— 两侧的解释器分叉了").toEqual(expected!.trace);

      // ② problems：validate 逐字一致
      expect(validateBundle(bundle, null), "validate 输出不一致").toEqual(expected!.problems);

      // ③ warnings：lint 逐字一致（含文案里的数字，按字符串比）
      expect(lintBundle(bundle), "lint 输出不一致").toEqual(expected!.warnings);

      // ④ stats：14 个字段形状相似，最容易挂错源，整块深比较
      const stats = computeStats(bundle);
      expect(stats, "computeStats 输出不一致").toEqual(expected!.stats);

      // ⑤ 覆盖度报表：整份文本（含排版）。这是"逐字对齐 Python 的 format 规格"的
      //    唯一证据 —— 分隔线长度、列宽、末列前两个空格都在这 80 行里
      expect(renderStatsReport(stats), "覆盖度报表不一致").toBe(expected!.stats_report);
    });
  }
});
