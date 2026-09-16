/**
 * Content Compiler —— `backend/content/compiler.py` 的 TypeScript 移植。
 *
 *     YAML → Validate → Lint → (Preview) → Import → DB
 *
 * 文件划分刻意镜像 Python 的函数边界：
 *   validate_content        validate.ts（loader.py 的一段）
 *   validate_bundle         这个文件（compiler.py 的前半）
 *   lint_bundle / stats     lint.ts（compiler.py 的后半）
 *   compile_bundle          这个文件（编排）
 * 同源对拍时"这段 TS 对应哪个 Python 函数"应该一眼可查，而不是靠 grep。
 *
 * 没移植 `preview_item` / `preview_story`：它们是给 `content_cli preview` 用的
 * 人肉看的排版，不进构建门、输出也没有对拍对象 —— 移植它等于新增一段
 * 无人验证的代码。真需要预览时随时可加。
 */
import { checkAll } from "./cognitive";
import { computeStats, lintBundle, type ContentStats } from "./lint";
import { type ContentBundle } from "./types";
import { validateContent } from "./validate";
import { CompetencyGraph } from "@/src/engine/graph";

/**
 * 结构性校验 + 认知有效性 + 答案独立复核。
 *
 * 三段缺一不可：
 *   1. `validateContent` —— 引用完整性、枚举合法性、升级链路、故事与槽位的咬合；
 *   2. 逐题 `checkAll` —— 题面参数与答案/步骤的自洽（认知规则表）；
 *   3. `CompetencyGraph.validate()` —— 能力图自身的形状（环、孤立节点、无 pattern）。
 *
 * 2 与 3 是**独立复核**：内容层说"这道题的字段都对"，认知层再问一遍
 * "这道题本身算得通吗"。两边都过才算过。
 */
export function validateBundle(bundle: ContentBundle, minPatterns: number | null): string[] {
  const problems = [...validateContent(bundle, minPatterns)];

  for (const item of bundle.items.values()) {
    for (const problem of checkAll(item)) {
      problems.push(`item ${item.code}: ${problem}`);
    }
  }

  problems.push(...new CompetencyGraph(bundle).validate());
  return problems;
}

/**
 * `compile_bundle` 的产物：错误 + 警告 + 统计。
 *
 * Python 那边是个带 `ok` / `summary()` 的 dataclass，这里拆成"纯数据 + 两个函数"
 * —— 一份能被 `toEqual` 直接比对的数据，比一个带方法的对象好测。
 */
export interface CompileReport {
  problems: string[];
  warnings: string[];
  stats: ContentStats;
}

export function compileReport(bundle: ContentBundle, minPatterns: number | null): CompileReport {
  return {
    problems: validateBundle(bundle, minPatterns),
    warnings: lintBundle(bundle),
    stats: computeStats(bundle),
  };
}

/** `CompileReport.summary()` 的两行文案，逐字照抄。 */
export function reportSummary(report: CompileReport): string {
  return [
    `内容编译结果：${report.problems.length === 0 ? "✅ 通过" : "❌ 未通过"}`,
    `  错误 ${report.problems.length} 条 / 警告 ${report.warnings.length} 条`,
  ].join("\n");
}
