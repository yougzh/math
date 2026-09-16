/**
 * 内容校验 / lint / 覆盖度报表 —— `tools/content_cli` 的 TypeScript 等价物。
 *
 *   npm run check:content            # = content_cli validate
 *   npm run stats:content            # = content_cli stats
 *
 * 与构建脚本共用同一条链（loadBundle → compileReport），区别只在"失败之后做什么"：
 * 构建脚本**只**因 validate 错误拒绝产出，这里把警告也打印出来。单独留一个入口，
 * 是因为改内容时不想为了看一条报错跑完整条构建。
 *
 * ⚠️ **警告不阻塞也不进构建门**，这是刻意的（对齐 content_cli 的退出码约定）：
 * lint 拦的是"可疑或缺失"（覆盖缺口、时长与题量不匹配），而不是错误。
 * 但"不阻塞"不等于"可以看不见" —— Python 那边也只有 `content_cli` 会展示它，
 * `tools/init_db.py` 同样不看警告。所以这里是警告唯一的出口，
 * 真实内容当前有 10 条（全部来自 `_lint_slot_ceiling`）。
 *
 * `--stats` 模式（对齐 `cmd_stats`）**在有问题时直接拒绝出报表**：统计结果建立在
 * 一份有错的内容上没有意义。这条与 Python 一致，不是这里的额外要求。
 *
 * 退出码约定（对齐 content_cli）：
 *   validate 发现问题 → 1（CI 必须拦住）
 *   只有警告          → 0（不阻塞）
 *   stats 模式下有错误 → 1
 *   其余意外（读不到文件、配置缺失）→ 1
 */
import path from "node:path";

import { compileReport, reportSummary } from "../src/content/compiler";
import { renderStatsReport } from "../src/content/lint";
import { loadBundle, readConfigSection } from "../src/content/loader";
import { minPatternsFromRaw } from "../src/content/validate";

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

/** 错误最多全打印，警告按 Python `_print_list(limit=50)` 截断 */
const PROBLEM_LIMIT = 200;
const WARNING_LIMIT = 50;

function printList(title: string, rows: readonly string[], limit: number): void {
  if (rows.length === 0) return;
  console.log(`\n${title}（${rows.length} 条）`);
  for (const row of rows.slice(0, limit)) console.log(`  • ${row}`);
  if (rows.length > limit) console.log(`  … 还有 ${rows.length - limit} 条未显示`);
}

function cmdStats(): number {
  const report = compileReport(loadBundle(), minPatternsFromRaw(readConfigSection("algorithm")));
  if (report.problems.length > 0) {
    console.log(`❌ 有 ${report.problems.length} 条错误，统计结果不可信。`);
    return 1;
  }
  console.log(renderStatsReport(report.stats));
  return 0;
}

function cmdValidate(): number {
  const report = compileReport(loadBundle(), minPatternsFromRaw(readConfigSection("algorithm")));

  console.log(reportSummary(report));
  printList("❌ 错误", report.problems, PROBLEM_LIMIT);
  printList("⚠️ 警告", report.warnings, WARNING_LIMIT);

  if (report.problems.length > 0) {
    console.log("\n内容有错误，禁止入库。修完再跑一次。");
    return 1;
  }
  console.log("\n内容可以入库。");
  if (report.warnings.length > 0) {
    console.log(`（上面 ${report.warnings.length} 条警告请人工过目，不阻塞入库）`);
  }
  return 0;
}

process.exitCode = process.argv.includes("--stats") ? cmdStats() : cmdValidate();
