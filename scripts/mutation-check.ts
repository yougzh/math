/**
 * 源码突变检查 —— 三道防线的第三道（测试的杀伤力自证）。
 *
 * 前两道防线（对拍 fixture、合成单测）证明"TS 和 Python 一样"；
 * 这一道证明"如果不一样，测试真的会叫"：往源码里注入一个手工设计的
 * 变异（每个都对应一个真实风险点），然后跑对拍测试 —— **必须挂**。
 * 挂了 = 变异被杀 = 这块行为真的有测试看着；没挂 = 对拍存在但失效，
 * 是"假绿"，比没有测试更危险。
 *
 * 变异点的选择原则（宁少勿滥，每个都要说得出为什么）：
 *   - 曾真实发生过的 bug（pickPattern 丢 tried 过滤、render_plan 丢 "s" 后缀）；
 *   - 静默失效型（signalDrift 的 Map 遍历、attempt_id 格式）；
 *   - 分支方向型（复习溢出语义、难度阶梯、judge 接受域）。
 *
 * 用法：
 *     npx tsx scripts/mutation-check.ts          # 全部突变
 *     npx tsx scripts/mutation-check.ts planner  # 只跑匹配 id 的
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

interface Mutation {
  id: string;
  /** 相对项目根的源文件 */
  file: string;
  /** 原文片段 —— 必须在文件里恰好出现 1 次 */
  from: string;
  /** 变异后的片段 */
  to: string;
  /** 用来杀这个突变的对拍测试 */
  test: string;
  /** 只跑测试名匹配该正则的子集（省时间；突变应被子集杀死） */
  pattern?: string;
  /** 为什么这个变异必须被杀 */
  note: string;
}

const MUTATIONS: Mutation[] = [
  {
    id: "selector-pick-pattern-tried",
    file: "src/engine/selector.ts",
    from: ".filter((i) => !tried.has(i.pattern_id))",
    to: ".filter(() => true)",
    test: "tests/acceptance/selector-parity.test.ts",
    note: "真实回归 bug：迁移探针会反复撞已练过的 pattern（p1 vs p2）",
  },
  {
    id: "selector-difficulty-step-backward",
    file: "src/engine/selector.ts",
    from: "Math.max(last + step, floor)",
    to: "Math.max(last - step, floor)",
    test: "tests/acceptance/selector-parity.test.ts",
    note: "难度阶梯倒退：ceil 允许的上界会低于最近难度，难度只会回撤",
  },
  {
    id: "intent-warmup-mastery-flip",
    file: "src/engine/intent.ts",
    from: "if (signals.mastery < minMastery) {",
    to: "if (signals.mastery > minMastery) {",
    test: "tests/acceptance/intent-parity.test.ts",
    note: "热身候选方向翻转：选已掌握的而不是未达标的，意图分布整体变样",
  },
  {
    id: "planner-story-order-flip",
    file: "src/engine/planner.ts",
    from: "const key: [number, string] = [s.order_index, s.code];\n    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {",
    to: "const key: [number, string] = [s.order_index, s.code];\n    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {",
    test: "tests/acceptance/planner-parity.test.ts",
    note: "故事挑选从\u201c最靠前一站\u201d翻转成\u201c最靠后一站\u201d —— cold_start 用真实内容（多站故事）杀它",
    // 注：warmup 池最多 1 个意图，kept 切片 ±1 是等价变异（任何测试都杀不死）；
    // 复习溢出语义由 reviews_overflow case（早退分支）+ intent 层变异共同覆盖。
  },
  {
    id: "planner-render-s-suffix",
    file: "src/engine/planner.ts",
    from: "${padStartWidth(String(seg.budget_s), 3)}s",
    to: "${padStartWidth(String(seg.budget_s), 3)}",
    test: "tests/acceptance/planner-parity.test.ts",
    note: "真实回归案例：Python '{:>3}s' 的字面量 s 后缀丢了，13 个 case 全挂",
  },
  {
    id: "detective-seed-mix",
    file: "src/engine/detective.ts",
    from: "new PyRandom(seed * 7919 + 13)",
    to: "new PyRandom(seed * 7919)",
    test: "tests/acceptance/detective-parity.test.ts",
    pattern: "生成",
    note: "谜题随机流换种子：全部生成 case 的谜题内容应整体漂移",
  },
  {
    id: "detective-judge-accept-9",
    file: "src/engine/detective.ts",
    from: "/^[+-]?[0-9]+$/.test(text)",
    to: "/^[0-9]+$/.test(text)",
    test: "tests/acceptance/detective-parity.test.ts",
    pattern: "judge",
    note: "judge 丢失正负号支持：\"+42\" 会被误拒（judge 是格式+值比较，含 9 但值不等的输入 expect=False，改 [0-8] 杀不死）",
  },
  {
    id: "detective-reveal-clamp",
    file: "src/engine/detective.ts",
    from: "Math.min(reveal_count, puzzle.clues.length - 1)",
    to: "Math.min(reveal_count, puzzle.clues.length)",
    test: "tests/acceptance/detective-parity.test.ts",
    // pattern 必须匹配生成 describe 里的 reveal=1/reveal=5 夹取 case
    //（\u201c揭示\u201d只匹配 revealAfterAttempt 的 4 项，碰不到夹取行为）
    pattern: "reveal=",
    note: "reveal 夹取上界放宽：可以揭示全部线索，谜题失去悬念（不变量被破坏）",
  },
  {
    id: "simulate-thinking-jitter",
    file: "scripts/simulate.ts",
    from: "0.9 + 0.2 * rng.random()",
    to: "0.9",
    test: "tests/acceptance/simulate-parity.test.ts",
    note: "思考时间抖动消失：rng 消费次数改变，整条随机流错位",
  },
  {
    id: "simulate-attempt-id-width",
    file: "scripts/simulate.ts",
    from: "`sim_${child_id}_${String(seq).padStart(4, \"0\")}`",
    to: "`sim_${child_id}_${String(seq).padStart(3, \"0\")}`",
    test: "tests/acceptance/simulate-parity.test.ts",
    note: "attempt_id 宽度变了：与 Python 的 '{:04d}' 不再逐字一致",
  },
  {
    id: "simulate-cold-seed",
    file: "scripts/simulate.ts",
    from: "new PyRandom(9001)",
    to: "new PyRandom(9002)",
    test: "tests/acceptance/simulate-parity.test.ts",
    pattern: "cold_start",
    note: "冷启动随机流换种子：cold_start 的全部 attempt 应整体漂移",
  },
];

function runVitest(test: string, pattern?: string): number {
  const args = ["vitest", "run", test, "--reporter=dot"];
  if (pattern) {
    args.push(`--testNamePattern=${pattern}`);
  }
  const r = spawnSync("npx", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  return r.status === null ? -1 : r.status;
}

function main(argv: readonly string[]): number {
  const filter = argv[0];
  const targets = filter
    ? MUTATIONS.filter((m) => m.id.includes(filter))
    : MUTATIONS;
  if (targets.length === 0) {
    console.error(`没有匹配 "${filter}" 的突变点`);
    return 2;
  }

  console.log(`突变检查：${targets.length} 个变异点（挂 = 被杀 = 好）\n`);
  const alive: Mutation[] = [];
  for (const m of targets) {
    const filePath = path.join(ROOT, m.file);
    const original = readFileSync(filePath, "utf8");
    const hits = original.split(m.from).length - 1;
    if (hits !== 1) {
      console.error(`✗ ${m.id}: from 片段匹配 ${hits} 次（必须恰好 1 次）—— 片段已过时，请更新`);
      return 2;
    }
    writeFileSync(filePath, original.replace(m.from, m.to));
    let status: number;
    try {
      status = runVitest(m.test, m.pattern);
    } finally {
      writeFileSync(filePath, original);
      const restored = readFileSync(filePath, "utf8");
      if (restored !== original) {
        console.error(`✗ ${m.id}: 还原失败！请 git checkout ${m.file}`);
        return 2;
      }
    }
    const killed = status !== 0;
    console.log(
      `${killed ? "✓ 被杀" : "✗ 存活"}  ${m.id}  (exit=${status})\n        ${m.note}`,
    );
    if (!killed) {
      alive.push(m);
    }
  }

  console.log(`\n结果：${targets.length - alive.length}/${targets.length} 被杀`);
  if (alive.length > 0) {
    console.error("存活突变 —— 对拍对它失效，先补测试或重新审视断言强度：");
    for (const m of alive) {
      console.error(`  - ${m.id}: ${m.note}`);
    }
    return 1;
  }
  console.log("全部变异都被测试杀死 —— 对拍的敏感性成立。");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
