/**
 * 声明式变异解释器 —— `scripts/oracle/dump_fixtures.py` 里 `_apply_lint_ops` 的对侧。
 *
 * 为什么两侧要各写一份：对拍的全部价值在于"两边独立地把同一件事做出来"。
 * 如果只有 Python 侧会施加变异，TS 侧拿到的就只剩一组期望值，而不是
 * 一组"可复现的输入" —— 那退化成快照，而快照是可以被 `-u` 一键刷新的。
 *
 * 这个文件里唯一与 Python 有耦合的是两个"协议"常量：`FILTERS` 和
 * `RULE_MARKERS`。它们**必须**与 `dump_fixtures.py` 里的同名字段一致，
 * 否则 trace 会分叉、规则归属会错位 —— 两处都写了注释互相指认。
 *
 * ⚠️ 刻意用 `Object.hasOwn` 而不是 `in` 来判定字段是否存在（Python 用 `hasattr`）：
 * `in` 会顺着原型链找到 `constructor` / `toString`，于是 spec 里把字段名打成
 * `"constructor"` 时 `in` 返回 true、静默写进一个谁也读不到的键，而 Python 那边
 * 会 `SystemExit`。这种"两侧改的东西不一样却都跑得通"的不对称正是要拦的。
 */
import type { ContentBundle, Item } from "@/src/content/types";

// ── spec 的 TypeScript 形状 ──────────────────────────────

export type LintOpKind =
  | "set_item"
  | "set_slot"
  | "delete_item"
  | "delete_items_where"
  | "set_items_where";

export interface LintOp {
  op: LintOpKind;
  /** `set_item` / `delete_item` 的实体 code */
  code?: string;
  /** 筛选条件（与 Python `LINT_FILTER_FIELDS` 的键一致） */
  competency?: string;
  scaffold_level?: string;
  pattern?: string;
  field?: string;
  value?: unknown;
}

export interface LintMutation {
  id: string;
  note: string;
  /** 这条变异必须触发的 lint 规则名；空数组表示"不针对任何规则"（基线/对照） */
  targets: string[];
  ops: LintOp[];
  /** 负向对照：输出必须与基线逐字相同 */
  expect_baseline?: boolean;
  /** 这条变异必须让 validate 报错 */
  expect_problems?: boolean;
}

export interface LintMutationSpec {
  note: string[];
  ops_grammar: Record<string, string>;
  mutations: LintMutation[];
}

// ── 协议常量（与 dump_fixtures.py 同源，改一处必须改两处）──

/**
 * op 的筛选键 → `Item` 上的真实字段名。
 *
 * 顺序照抄 Python 的 dict 字面量（`competency` / `scaffold_level` / `pattern`），
 * 但**序列化时排序** —— Python 那边 `json.dumps(..., sort_keys=True)` 会重排，
 * 直接按声明顺序拼字符串会让 trace 静默分叉。
 */
const FILTERS: ReadonlyArray<readonly [keyof LintOp & string, keyof Item & string]> = [
  ["competency", "competency_id"],
  ["scaffold_level", "scaffold_level"],
  ["pattern", "pattern_id"],
];

/**
 * 每条 lint 规则的文案特征，用于「9 条规则每条都被某条变异触发过」的自证。
 * 与 `tests/unit/lint.test.ts` 的 `RULE_MARKERS` 同源 —— 那边证明规则实现活着，
 * 这边证明 fixture 真的碰到了它。
 */
export const RULE_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["_lint_coverage", ["缺少脚手架级别"]],
  ["_lint_time_estimates", ["的预估耗时与难度反向", "estimated_seconds 不合理"]],
  ["_lint_duplicates", ["题面完全相同但答案不同："]],
  ["_lint_hint_depth", ["孩子卡住时没有台阶"]],
  ["_lint_slot_pools", ["候选池只有"]],
  ["_lint_story_shape", ["分钟，"]],
  ["_lint_steps", ["steps_style=conclude"]],
  ["_lint_prompt_self_contained", ["没有 prompt", "里一个数字都没有"]],
  [
    "_lint_slot_ceiling",
    ["声明的上限难度", "但该 pattern 在难度区间内没有题", "层在区间内只有别的 pattern 的题"],
  ],
];

/** 警告属于哪条规则；不属于任何一条返回 null（那本身就是个问题）。 */
export function lintRuleOf(warning: string): string | null {
  for (const [rule, markers] of RULE_MARKERS) {
    if (markers.some((marker) => warning.includes(marker))) return rule;
  }
  return null;
}

// ── 解释器 ───────────────────────────────────────────────

/**
 * 筛选条件的确定化文本，进 trace。
 *
 * 键用**筛选键名**（`competency`）而不是映射后的字段名（`competency_id`）——
 * Python 那边就是 `{key: op[key] for key in LINT_FILTER_FIELDS if key in op}`。
 * 写成字段名会让每条 `*_where` 变异的 trace 逐字不同（第一版就是这么错的，
 * 被 trace 断言当场抓住 —— 这正是它存在的理由）。
 *
 * 手写而不是 `JSON.stringify`：Python 的 `json.dumps` 默认分隔符是 `", "` / `": "`
 * （带空格），而 `JSON.stringify` 是 `,` / `:`（不带）—— 直接拿来用会逐字不同。
 */
function lintFilters(op: LintOp): string {
  const pairs = FILTERS.filter(([key]) => key in op).map(([key]) => [key, op[key]] as const);
  // sort_keys=True
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const body = pairs.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{${body.join(", ")}}`;
}

function matches(item: Item, op: LintOp): boolean {
  for (const [key, field] of FILTERS) {
    if (key in op && item[field] !== op[key]) return false;
  }
  return true;
}

/** 施加一组声明式变异，返回 trace。会在 spec 有问题时抛错，而不是静默跑完。 */
export function applyLintOps(bundle: ContentBundle, ops: readonly LintOp[]): string[] {
  const trace: string[] = [];

  for (const op of ops) {
    const kind = op.op;

    if (kind === "set_item" || kind === "set_slot") {
      const table = kind === "set_item" ? bundle.items : bundle.slots;
      const code = op.code ?? "";
      const target = table.get(code);
      if (target === undefined) {
        throw new Error(`变异指令指向不存在的实体：${kind} ${code}`);
      }
      const field = op.field ?? "";
      // 只允许改**已存在**的字段：spec 里打错一个字段名就在这里炸，
      // 而不是悄悄多出一个谁也读不到的键 —— 那会让两侧"改的东西不一样"
      // 却都跑得通。
      if (!Object.hasOwn(target, field)) {
        throw new Error(`变异指令的字段不存在：${code} ${field}`);
      }
      (target as unknown as Record<string, unknown>)[field] = op.value;
      trace.push(`${kind} ${code} ${field}`);
      continue;
    }

    if (kind === "delete_item") {
      const code = op.code ?? "";
      if (!bundle.items.delete(code)) {
        throw new Error(`变异指令指向不存在的题目：${code}`);
      }
      trace.push(`delete_item ${code}`);
      continue;
    }

    if (kind === "delete_items_where" || kind === "set_items_where") {
      if (!FILTERS.some(([key]) => key in op)) {
        throw new Error(`${kind} 至少要给一个筛选条件：${JSON.stringify(op)}`);
      }
      const codes = [...bundle.items.values()]
        .filter((item) => matches(item, op))
        .map((item) => item.code)
        .sort();
      if (codes.length === 0) {
        throw new Error(`${kind} 一道题都没选中：${JSON.stringify(op)}`);
      }
      for (const code of codes) {
        if (kind === "delete_items_where") {
          bundle.items.delete(code);
        } else {
          const field = op.field ?? "";
          const item = bundle.items.get(code)!;
          if (!Object.hasOwn(item, field)) {
            throw new Error(`变异指令的字段不存在：${code} ${field}`);
          }
          (item as unknown as Record<string, unknown>)[field] = op.value;
        }
      }
      trace.push(`${kind} ${lintFilters(op)} ${op.field ?? ""} -> ${codes.join(",")}`);
      continue;
    }

    throw new Error(`未知的变异指令：${String(kind)}`);
  }

  return trace;
}
