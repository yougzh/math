/**
 * 能力图谱 —— `backend/engine/graph.py` 的 TypeScript 移植。
 *
 * Competency 是知识骨架，Problem Pattern 挂在能力上。
 * Planner 依据这张图决定"下一步练什么"和"回退到哪里"。
 *
 * ⚠️ 遍历顺序即输出顺序：`validate()` 直接迭代 `competencies.values()`，
 * 所以报错顺序取决于**内容加载顺序**（bundle 已按 load_order 重建）。
 * 对拍时"报错文案顺序"也是断言的一部分 —— 别把迭代改成"看起来更确定"的排序。
 */
import { type Competency, type ContentBundle, type Pattern, patternAppliesTo } from "@/src/content/types";
import { sortedBy, sortedStrings } from "@/src/py/pysort";

export class CompetencyGraph {
  readonly competencies: Map<string, Competency>;
  readonly patterns: Map<string, Pattern>;
  private topo: string[] | null = null;

  constructor(bundle: ContentBundle) {
    this.competencies = new Map(bundle.competencies);
    this.patterns = new Map(bundle.patterns);
  }

  // ── 边 ──────────────────────────────────────────────

  /** 前置能力。transitive=true 时返回（传递闭包）去重后**排序**的集合 */
  prerequisites(code: string, transitive = false): string[] {
    const comp = this.competencies.get(code);
    if (comp === undefined) return [];
    if (!transitive) return [...comp.prerequisites];

    const seen = new Set<string>();
    const stack = [...comp.prerequisites];
    while (stack.length > 0) {
      // Python 是 list.pop()（LIFO，取尾部）—— 顺序不影响最终集合，但保持同构
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const parent = this.competencies.get(current);
      if (parent !== undefined) stack.push(...parent.prerequisites);
    }
    return sortedStrings(seen);
  }

  /** 直接依赖 code 的能力（不含传递），按 code 排序 */
  dependents(code: string): string[] {
    return sortedStrings(
      [...this.competencies.values()].filter((c) => c.prerequisites.includes(code)).map((c) => c.code),
    );
  }

  // ── 拓扑 ────────────────────────────────────────────

  /** 确定性顺序：按 (stage, code) 稳定排序后做 DFS，保证 replay 可重现 */
  topologicalOrder(): string[] {
    if (this.topo !== null) return [...this.topo];

    const order: string[] = [];
    const visited = new Map<string, number>(); // 0=未访问 1=访问中 2=已完成

    const visit = (code: string): void => {
      const state = visited.get(code) ?? 0;
      if (state === 2) return;
      if (state === 1) return; // 有环时由 validate() 报错，这里只保证不死循环
      visited.set(code, 1);
      const comp = this.competencies.get(code);
      if (comp !== undefined) {
        // Python 是 sorted(comp.prerequisites)
        for (const prereq of sortedStrings(comp.prerequisites)) visit(prereq);
      }
      visited.set(code, 2);
      order.push(code);
    };

    const roots = sortedBy(
      this.competencies.keys(),
      (code) => this.competencies.get(code)!.stage,
      (code) => code,
    );
    for (const code of roots) {
      if ((visited.get(code) ?? 0) === 0) visit(code);
    }

    this.topo = order;
    return [...order];
  }

  // ── Pattern 关联 ────────────────────────────────────

  /**
   * 该能力可用的 pattern，按 (cognitive_type, code) 排序。
   *
   * 排序键是**引擎层策略**：`loader._supported_patterns` 数的是"有题支撑"的
   * pattern（按 code 排），而这里是"图上有声明"的 pattern（按认知类型分组）。
   * 两者用途不同，别想着合并。
   */
  patternsFor(competencyCode: string): Pattern[] {
    return sortedBy(
      [...this.patterns.values()].filter((p) => patternAppliesTo(p, competencyCode)),
      (p) => p.cognitive_type,
      (p) => p.code,
    );
  }

  // ── 校验 ────────────────────────────────────────────

  /**
   * 找环。返回的每个环都是「从重复出现的那个节点起、回到它自己」的路径。
   *
   * 与 Python 一致地**可能重复报告同一个环**（不同入口 DFS 会各报一次）——
   * 这是刻意保留的：validator 的输出要逐字对拍，去重会让文案顺序也变。
   */
  findCycles(): string[][] {
    const cycles: string[][] = [];
    const color = new Map<string, number>();
    const stack: string[] = [];

    const dfs = (code: string): void => {
      color.set(code, 1);
      stack.push(code);
      const comp = this.competencies.get(code);
      const prereqs = comp === undefined ? [] : sortedStrings(comp.prerequisites);
      for (const prereq of prereqs) {
        if (!this.competencies.has(prereq)) continue;
        const c = color.get(prereq) ?? 0;
        if (c === 1) {
          // Python: stack[stack.index(prereq):] + [prereq] —— index 取**第一次**出现
          cycles.push([...stack.slice(stack.indexOf(prereq)), prereq]);
        } else if (c === 0) {
          dfs(prereq);
        }
      }
      stack.pop();
      color.set(code, 2);
    };

    for (const code of sortedStrings(this.competencies.keys())) {
      if ((color.get(code) ?? 0) === 0) dfs(code);
    }
    return cycles;
  }

  validate(): string[] {
    const problems: string[] = [];

    for (const cycle of this.findCycles()) {
      problems.push(`能力图存在环: ${cycle.join(" → ")}`);
    }

    for (const comp of this.competencies.values()) {
      for (const prereq of comp.prerequisites) {
        if (prereq === comp.code) {
          problems.push(`competency ${comp.code} 依赖自己`);
        }
      }
      if (this.patternsFor(comp.code).length === 0) {
        problems.push(`competency ${comp.code} 没有任何可用 pattern（该能力无法被训练）`);
      }
      if (comp.prerequisites.length === 0 && this.dependents(comp.code).length === 0) {
        problems.push(`competency ${comp.code} 是孤立节点（既无前置也无人依赖）`);
      }
    }

    return problems;
  }

  // ── 查询辅助 ────────────────────────────────────────

  /** 按拓扑顺序返回第一个"前置都已掌握、但自身未掌握"的能力 */
  nextUnmastered(isMastered: (code: string) => boolean): string | null {
    for (const code of this.topologicalOrder()) {
      if (isMastered(code)) continue;
      if (this.prerequisites(code).every((p) => isMastered(p))) return code;
    }
    return null;
  }

  /**
   * 在（传递）前置能力里找得分最低的一个，作为回退目标。
   * Python 是 `min(prereqs, key=lambda p: (score(p), p))` —— 并列时按 code 取小。
   */
  weakestPrerequisite(code: string, score: (code: string) => number): string | null {
    const prereqs = this.prerequisites(code, true);
    if (prereqs.length === 0) return null;
    let best = prereqs[0]!;
    for (const candidate of prereqs) {
      if (score(candidate) < score(best) || (score(candidate) === score(best) && candidate < best)) {
        best = candidate;
      }
    }
    return best;
  }
}
