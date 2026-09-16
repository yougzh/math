/**
 * 内容 lint 与统计 —— `backend/content/compiler.py` 的 lint / stats 两段的 TypeScript 移植。
 *
 * validate 与 lint 的区别（原模块注释）：
 *   validate 失败 = 内容**错误**，绝不能入库（答案错、认知结构不成立、引用不存在）
 *   lint   失败 = 内容**可疑或缺失**，可以入库但必须让人看见（覆盖缺口、时长与题量不匹配）
 *
 * 文件划分刻意镜像 Python 的函数边界：`validate_content` 在 validate.ts（loader.py 的一段），
 * `validate_bundle` 与编排在 compiler.ts（compiler.py 的前半），这里放
 * `lint_bundle` / `compute_stats` / `render_coverage`（compiler.py 的后半）。
 * 同源对拍时"这段 TS 对应哪个 Python 函数"应该一眼可查，而不是靠 grep。
 *
 * 移植纪律（与 validate.ts 相同，而且 lint 更容易踩）：
 *
 * 1. **warning 的产生顺序是输出的一部分**。`lintBundle` 里 9 条规则的调用顺序、
 *    每条规则内部迭代 bundle 的顺序，都直接决定 CLI 打印顺序与对拍结果 ——
 *    别重排、别"顺手按能力分组"。
 *
 * 2. **文案逐字照抄**，包括「」、`~`、全角括号，以及 Python 把 None 字符串化成
 *    `None` 这件事（`_lint_slot_ceiling` 的"实际最高"在一道题都没有时就是 None）。
 *
 * 3. **truthiness 与 `is None` 的区别是刻意的**。同一条规则里两种写法可能同时出现
 *    （`_lint_slot_ceiling` 的 `if not slot.pattern_id` 是 truthiness 判断，
 *    `_lint_slot_pools` 的 `slot.pattern_id is None` 是身份判断），别统一。
 *
 * 4. **唯一的越界**：`renderStatsReport` 在 Python 那边内联在 `tools/content_cli/main.py`
 *    的 `cmd_stats` 里，没有独立函数。提到这里来的理由写在它的文档注释里
 *    （那个 `⚠️` 分支真实内容永远走不到，留在 CLI 脚本里就等于没人守）。
 */
import { sortedBy, sortedStrings } from "@/src/py/pysort";
import { numberTokensIn } from "@/src/py/pyre";
import { pyFormat1f, pyGet, pyNumberListRepr, pyStr } from "@/src/py/pyvalue";

import { lintAll } from "./cognitive";
import {
  AUTO_SCAFFOLD,
  SCAFFOLD_LEVELS,
  itemsFor,
  type ChallengeSlot,
  type ContentBundle,
  type Item,
} from "./types";

// ── 小工具 ─────────────────────────────────────────────────

/**
 * Python 的 `{}` —— 一个**没有原型链**的字典。
 *
 * 用 `Object.create(null)` 而不是 `{}`：`"constructor" in {}` 在 JS 里是 true、
 * 在 Python 的 dict 里是 false。这里的键全部来自 YAML 字符串
 * （`item.pattern_id`、`slot.code` 在 loader 里都是 `as` 强转，运行时可以是任意
 * 字符串），一旦撞上 `constructor`：
 *   - `Object.keys()` 仍然正常，但 `coverage[key]` 会读到继承来的函数；
 *   - 键是 `__proto__` 时更糟 —— 赋值会去改原型链，那条数据**静默消失**。
 * 同一个理由见 `pyvalue.ts` 的 `pyGet`（那里用 `Object.hasOwn`）。
 */
function pyDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * 槽位的候选池 —— `(能力, pattern, 难度区间)` 三元组筛题。
 *
 * Python 里这段列表推导出现了**三份**（`validate_content` 的候选池、
 * `_lint_slot_pools`、`compute_stats` 的 `slots_detail`），逐字相同。
 * 这里抽成一个函数：三处保持一致的唯一可靠办法是只有一处。
 *
 * ⚠️ 注意 `slot.pattern_id is None`（身份判断，不是 truthiness）——
 * 与 `_lint_slot_ceiling` 的 `if not slot.pattern_id` 刻意不同，照抄 Python。
 */
function slotCandidates(bundle: ContentBundle, slot: ChallengeSlot): Item[] {
  return [...bundle.items.values()].filter(
    (item) =>
      item.competency_id === slot.competency_id &&
      (slot.pattern_id === null || item.pattern_id === slot.pattern_id) &&
      slot.difficulty_min <= item.difficulty &&
      item.difficulty <= slot.difficulty_max,
  );
}

/**
 * 一段文本里的数字 -> Python 的 `{int(tok) for tok in _NUMBER_TOKEN.findall(text)}`。
 *
 * 单独包一层只是为了让"`_NUMBER_TOKEN` 只认数字不认负号"这件事在调用点可见：
 * `-5` 会给出 `5`。
 */
function promptNumbersIn(text: string): Set<number> {
  return numberTokensIn(text);
}

// ── Lint ───────────────────────────────────────────────────

/**
 * 9 条 lint 规则。**调用顺序即警告顺序**，逐条照抄 compiler.py:70-78。
 *
 * 真实内容下只有 `_lint_slot_ceiling` 会报（10 条），其余 8 条一条都不报 ——
 * 所以"对真实内容跑一遍"对另外 8 条**零约束力**，它们只能靠合成数据单测钉住
 * （见 tests/unit/lint.test.ts 的"每条规则至少被触发过一次"自证断言）。
 */
export function lintBundle(bundle: ContentBundle): string[] {
  const warnings: string[] = [];

  warnings.push(...lintCoverage(bundle));
  warnings.push(...lintTimeEstimates(bundle));
  warnings.push(...lintDuplicates(bundle));
  warnings.push(...lintHintDepth(bundle));
  warnings.push(...lintSlotPools(bundle));
  warnings.push(...lintStoryShape(bundle));
  warnings.push(...lintSteps(bundle));
  warnings.push(...lintPromptSelfContained(bundle));
  warnings.push(...lintSlotCeiling(bundle));

  return warnings;
}

/**
 * 脚手架覆盖：某个能力缺一整档，脚手架递退（blocks → decompose → direct）
 * 就会在那里跳级 —— 孩子的支撑突然被抽走，而不是逐级撤掉。
 */
function lintCoverage(bundle: ContentBundle): string[] {
  const warnings: string[] = [];
  for (const competency of bundle.competencies.values()) {
    const items = itemsFor(bundle, competency.code);
    if (items.length === 0) continue; // 完全没有题由 validate 报错（不可训练）
    const present = new Set(items.map((item) => item.scaffold_level as string));
    const missing = SCAFFOLD_LEVELS.filter((level) => !present.has(level));
    if (missing.length > 0) {
      warnings.push(
        `competency ${competency.code} 缺少脚手架级别 ${missing.join("/")} 的题目：` +
          `脚手架递退会在此处跳级`,
      );
    }
  }
  return warnings;
}

/** 同 interaction_type 内，难度与预估耗时应单调。 */
function lintTimeEstimates(bundle: ContentBundle): string[] {
  const warnings: string[] = [];
  const byInteraction = new Map<string, Item[]>();
  for (const item of bundle.items.values()) {
    const bucket = byInteraction.get(item.interaction_type);
    if (bucket === undefined) byInteraction.set(item.interaction_type, [item]);
    else bucket.push(item);
  }

  // Python 是 `sorted(by_interaction.items())` —— 按 interaction_type 的**字符串序**，
  // 不是加载顺序
  for (const interaction of sortedStrings(byInteraction.keys())) {
    const bucket = byInteraction.get(interaction)!;
    if (bucket.length < 3) continue;
    const items = sortedBy(bucket, (item) => item.difficulty);
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const cheapest = first.estimated_seconds;
    const dearest = last.estimated_seconds;
    if (cheapest > dearest) {
      warnings.push(
        `interaction ${interaction} 的预估耗时与难度反向：` +
          `难度 ${first.difficulty} 用 ${cheapest}s，难度 ${last.difficulty} 用 ${dearest}s`,
      );
    }
    // ⚠️ 这一段在 `continue` **之后**：题数 < 3 的 interaction 即使有
    // estimated_seconds <= 0 的题也不会被报出来。Python 原样，别"顺手"提前。
    for (const item of items) {
      if (item.estimated_seconds <= 0) {
        warnings.push(`item ${item.code} 的 estimated_seconds 不合理`);
      }
    }
  }
  return warnings;
}

/**
 * 题面完全相同但答案不同 —— 几乎总是复制粘贴时改了一半。
 *
 * ⚠️ 已知差异：Python 的 `answer != other.answer` 按**值**比较，这里用 `!==`（引用）。
 * 两处会分叉，当前内容都不可达（1,373 道题的 answer 全是 int）：
 *   - `answer: true` 与 `answer: 1`：Python 判相等，这里判不等；
 *   - 容器 answer（`[1, 2]`）：Python 按值比，这里按引用比。
 * 两个方向的后果都只是**多报一条**警告（看得见），不会漏报。
 * 真要用到容器答案时，这里得换成一个按值比较的 `pyEquals`。
 */
function lintDuplicates(bundle: ContentBundle): string[] {
  const warnings: string[] = [];
  // 键是 Python 的元组 `(interaction_type, prompt)`。用嵌套 Map 而不是把两段拼成
  // 一个字符串 —— 拼接需要一个"不可能出现在 interaction_type / prompt 里"的分隔符，
  // 而那种"不可能"没法验证。嵌套 Map 的相等性直接就是元组相等性。
  const seen = new Map<string, Map<string, Item>>();
  for (const item of bundle.items.values()) {
    const prompt = pyStr(pyGet(item.problem, "prompt", "")).trim();
    if (!prompt) continue;
    let byPrompt = seen.get(item.interaction_type);
    if (byPrompt === undefined) {
      byPrompt = new Map<string, Item>();
      seen.set(item.interaction_type, byPrompt);
    }
    const other = byPrompt.get(prompt);
    if (other !== undefined && other.answer !== item.answer) {
      warnings.push(`题面完全相同但答案不同：${other.code} / ${item.code}（「${prompt}」）`);
    }
    // 无条件覆盖（Python 是 `seen[key] = item`）：连续三道同题面时比的是"相邻两两"
    byPrompt.set(prompt, item);
  }
  return warnings;
}

/** 难度 ≥ 3 却只有一级提示 —— 孩子卡住时没有台阶可下。 */
function lintHintDepth(bundle: ContentBundle): string[] {
  const warnings: string[] = [];
  for (const item of bundle.items.values()) {
    if (item.difficulty >= 3 && item.hint_chain.length < 2) {
      warnings.push(
        `item ${item.code} 难度 ${item.difficulty} 但只有 ${item.hint_chain.length} 级提示，` +
          `孩子卡住时没有台阶`,
      );
    }
  }
  return warnings;
}

/** 槽位候选池过窄会导致同一道题反复出现。 */
function lintSlotPools(bundle: ContentBundle): string[] {
  const warnings: string[] = [];
  for (const slot of bundle.slots.values()) {
    const candidates = slotCandidates(bundle, slot);
    if (candidates.length > 0 && candidates.length < 3) {
      warnings.push(`slot ${slot.code} 候选池只有 ${candidates.length} 道题，容易重复出现`);
    }
  }
  return warnings;
}

/**
 * 故事时长与挑战数量应当匹配：每个挑战约 1 分钟。
 *
 * ⚠️ 这里的 `estimated_seconds / 60.0` 与 `{:.1f}` 是 `pyFormat1f` 存在的唯一理由：
 * 两者都是 half-way 舍入分歧点（Python half-even、JS 取较大），15 秒的槽位
 * 会在文案里写成 "0.2 分钟" 还是 "0.3 分钟" 完全取决于用哪个实现。
 */
function lintStoryShape(bundle: ContentBundle): string[] {
  const warnings: string[] = [];
  const stories = new Map<string, { challenges: number; seconds: number }>();
  for (const slot of bundle.slots.values()) {
    if (!slot.story_beat_id) continue;
    // Python 的 `split("__")[0]`：取第一个 "__" 之前的部分
    const storyCode = slot.story_beat_id.split("__")[0]!;
    let row = stories.get(storyCode);
    if (row === undefined) {
      row = { challenges: 0, seconds: 0 };
      stories.set(storyCode, row);
    }
    row.challenges += 1;
    row.seconds += slot.estimated_seconds;
  }

  // `sorted(stories.items())` 按 story_code 排序；键唯一，所以排键即可
  for (const storyCode of sortedStrings(stories.keys())) {
    const row = stories.get(storyCode)!;
    const minutes = row.seconds / 60.0;
    if (minutes < 4) {
      warnings.push(
        `故事 ${storyCode} 的挑战内容只有约 ${pyFormat1f(minutes)} 分钟，不足 5 分钟的下限`,
      );
    }
    if (minutes > 10) {
      warnings.push(
        `故事 ${storyCode} 的挑战内容约 ${pyFormat1f(minutes)} 分钟，超过 10 分钟上限`,
      );
    }
  }
  return warnings;
}

/** 题目自身的"可疑但不阻塞"（cognitive.lint_all 目前只有 steps 一条）。 */
function lintSteps(bundle: ContentBundle): string[] {
  const warnings: string[] = [];
  for (const item of bundle.items.values()) {
    for (const warning of lintAll(item)) {
      warnings.push(`item ${item.code}: ${warning}`);
    }
  }
  return warnings;
}

/**
 * 题面必须自包含。
 *
 * 题目参数里有数字（8 和 5），题面却写成「一共有多少个？」——
 * 这道题一旦被**没有故事**的核心训练槽选中，孩子看到的是一道无法回答的题。
 * 故事只能叠加情境，不能补齐题面。
 */
function lintPromptSelfContained(bundle: ContentBundle): string[] {
  const warnings: string[] = [];
  for (const item of bundle.items.values()) {
    const prompt = pyStr(pyGet(item.problem, "prompt", "")).trim();
    if (!prompt) {
      warnings.push(`item ${item.code} 没有 prompt`);
      continue;
    }
    const promptNumbers = promptNumbersIn(prompt);
    // Python 的 `isinstance(value, int) and not isinstance(value, bool)`：
    // bool 是 int 的子类，所以要显式排除 —— JS 的 typeof 天然把两者分开。
    // 只遍历 problem 的**顶层**值（照抄 `item.problem.values()`：列表里的数字不算）。
    const paramNumbers = new Set<number>();
    for (const value of Object.values(item.problem)) {
      if (typeof value !== "number" || !Number.isInteger(value)) continue;
      for (const token of promptNumbersIn(pyStr(value))) paramNumbers.add(token);
    }
    if (paramNumbers.size > 0 && promptNumbers.size === 0) {
      const listed = pyNumberListRepr(sortedBy(paramNumbers, (value) => value));
      warnings.push(
        `item ${item.code} 题面「${prompt}」里一个数字都没有，但参数是 ${listed} —— ` +
          `题面依赖故事补齐信息，被独立训练槽选中时会无法回答`,
      );
    }
  }
  return warnings;
}

/**
 * 槽位声明的难度区间，右端必须真的够得着。
 *
 * 两类缺口（模拟体检规则 1 的两个根因）：
 *
 *   a) **难度档缺口** —— 槽声明 [1,4]，但该能力的题最高只到 3。
 *      区间右端是死的，熟练度再高也推不进最后一段；
 *   b) **绑定 pattern 的档覆盖收缩** —— 槽绑了 pattern，但这个 pattern
 *      在区间内（或某个脚手架层里）没有题。运行时选择器会在"整个区间
 *      都没有该 pattern 的题"时静默放宽 pattern 兜底 —— 于是迁移/挑战槽
 *      「必须换一个没做过的结构」的意图在运行时落空，transfer 证据攒不出来，
 *      而这一层只在体检报告里显示为"迁移测试落地率低"，看不出真正原因。
 *
 * 这是 lint（警告）不是 validate（错误）：内容缺一档题不会让孩子做不了题，
 * 只是训练意图打折；但如果哪天缺口大到影响升级链路，应该升级为硬规则。
 *
 * 真实内容下这条规则会报出 10 条 —— 它是 9 条规则里**唯一**有真实输出的，
 * 因此也是唯一一条"只跑真实内容就能对拍"的。
 */
function lintSlotCeiling(bundle: ContentBundle): string[] {
  const warnings: string[] = [];
  for (const slot of bundle.slots.values()) {
    const items = [...bundle.items.values()].filter(
      (item) =>
        item.competency_id === slot.competency_id &&
        slot.difficulty_min <= item.difficulty &&
        item.difficulty <= slot.difficulty_max,
    );
    const label =
      `slot ${slot.code}（${slot.competency_id} 难度 ` +
      `${slot.difficulty_min}~${slot.difficulty_max}）`;

    // a) 上限档无题
    const atCeiling = items.filter((item) => item.difficulty === slot.difficulty_max);
    if (atCeiling.length === 0) {
      // Python 的 `max(..., default=None)` —— 一道题都没有时是 None，
      // 文案里就是一个 "None"（`pyStr(null)` 给的不是空串）
      let reachable: number | null = null;
      for (const item of items) {
        if (reachable === null || item.difficulty > reachable) reachable = item.difficulty;
      }
      warnings.push(
        `${label} 声明的上限难度 ${slot.difficulty_max} 在内容里不存在任何题` +
          `（实际最高 ${pyStr(reachable)}）—— 熟练度高的孩子永远推不到这个槽位的顶`,
      );
    }

    // b) 绑定 pattern 的覆盖
    // ⚠️ truthiness（空串跳过），不是 `is None` —— 与 slotCandidates 刻意不同
    if (!slot.pattern_id) continue;
    const bound = items.filter((item) => item.pattern_id === slot.pattern_id);
    if (bound.length === 0) {
      warnings.push(
        `${label} 绑定 pattern ${slot.pattern_id}，但该 pattern 在难度区间内没有题 —— ` +
          `运行时会静默放宽成别的 pattern，这个槽声明的训练意图会落空`,
      );
      continue;
    }
    const byScaffold = new Map<string, Set<number>>();
    const boundScaffolds = new Map<string, Set<number>>();
    for (const item of items) addDifficulty(byScaffold, item.scaffold_level, item.difficulty);
    for (const item of bound) addDifficulty(boundScaffolds, item.scaffold_level, item.difficulty);
    // 槽位显式声明脚手架（非 auto）时只查那一层 —— 别的层它根本不会用
    const layers =
      slot.scaffold_level && slot.scaffold_level !== AUTO_SCAFFOLD
        ? [slot.scaffold_level]
        : sortedStrings(byScaffold.keys());
    for (const scaffold of layers) {
      if (boundScaffolds.has(scaffold)) continue;
      if (!byScaffold.has(scaffold)) continue; // 该层没有题是另一个问题（coverage lint 已覆盖）
      const others = pyNumberListRepr(sortedBy(byScaffold.get(scaffold)!, (value) => value));
      warnings.push(
        `${label} 绑定 pattern ${slot.pattern_id}，但脚手架 ${scaffold} 层在区间内` +
          `只有别的 pattern 的题 ${others} —— 处于该层的孩子会拿到不是 ` +
          `${slot.pattern_id} 的题`,
      );
    }
  }
  return warnings;
}

function addDifficulty(map: Map<string, Set<number>>, key: string, value: number): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, new Set([value]));
  else bucket.add(value);
}

// ── Stats ──────────────────────────────────────────────────

/**
 * `by_scaffold` 的键是固定的三档（Python 是 `{s: 0 for s in SCAFFOLD_ORDER}`），
 * 所以用定键接口而不是索引签名 —— 上面 `renderCoverage` 的三次取值就不需要
 * `!` 断言，少的那个字段会在编译期报出来。
 */
export interface ScaffoldCounts {
  blocks: number;
  decompose: number;
  direct: number;
}

export interface StepsStyleCounts {
  guide: number;
  conclude: number;
}

export interface CompetencyCoverage {
  name: string;
  items: number;
  by_scaffold: ScaffoldCounts;
  patterns: string[];
}

/**
 * `compute_stats` 的返回形状。字段名照抄 Python（snake_case），
 * 因为这份结构将来要出现在 dump / 报表里。
 */
export interface ContentStats {
  competencies: number;
  patterns: number;
  items: number;
  slots: number;
  story_slots: number;
  standalone_slots: number;
  misconceptions: number;
  coverage: Record<string, CompetencyCoverage>;
  items_by_pattern: Record<string, number>;
  items_by_steps_style: StepsStyleCounts;
  slots_detail: Record<string, number>;
}

export function computeStats(bundle: ContentBundle): ContentStats {
  const coverage = pyDict<CompetencyCoverage>();
  for (const competency of bundle.competencies.values()) {
    const items = itemsFor(bundle, competency.code);
    const byScaffold: ScaffoldCounts = { blocks: 0, decompose: 0, direct: 0 };
    for (const item of items) {
      // `Object.hasOwn` 就是 Python 的 `in`（只看自己的键）——
      // 裸 `in` 会让 `scaffold_level: "constructor"` 把计数加到继承来的函数上
      if (Object.hasOwn(byScaffold, item.scaffold_level)) {
        byScaffold[item.scaffold_level as keyof ScaffoldCounts] += 1;
      }
    }
    coverage[competency.code] = {
      name: competency.name,
      items: items.length,
      by_scaffold: byScaffold,
      patterns: sortedStrings(new Set(items.map((item) => item.pattern_id))),
    };
  }

  const patterns = pyDict<number>();
  for (const item of bundle.items.values()) {
    patterns[item.pattern_id] = (Object.hasOwn(patterns, item.pattern_id)
      ? patterns[item.pattern_id]!
      : 0) + 1;
  }

  const byStepsStyle: StepsStyleCounts = { guide: 0, conclude: 0 };
  for (const item of bundle.items.values()) {
    if (Object.hasOwn(byStepsStyle, item.steps_style)) {
      byStepsStyle[item.steps_style as keyof StepsStyleCounts] += 1;
    }
  }

  const slotsDetail = pyDict<number>();
  for (const slot of bundle.slots.values()) {
    slotsDetail[slot.code] = slotCandidates(bundle, slot).length;
  }

  // `dict(sorted(patterns.items()))` —— 排序后再装桶，所以输出顺序确定，
  // 不受 JS 对象"整数样式的键排最前"这条规则影响
  const itemsByPattern = pyDict<number>();
  for (const code of sortedStrings(Object.keys(patterns))) itemsByPattern[code] = patterns[code]!;

  let storySlots = 0;
  for (const slot of bundle.slots.values()) if (slot.story_beat_id) storySlots += 1;

  return {
    competencies: bundle.competencies.size,
    patterns: bundle.patterns.size,
    items: bundle.items.size,
    slots: bundle.slots.size,
    story_slots: storySlots,
    standalone_slots: bundle.slots.size - storySlots,
    misconceptions: bundle.misconceptions.size,
    coverage,
    items_by_pattern: itemsByPattern,
    items_by_steps_style: byStepsStyle,
    slots_detail: slotsDetail,
  };
}

/**
 * `render_coverage` —— 覆盖表。
 *
 * Python 的 `"{:<22} {:>5} {:>7} {:>7} {:>7}  {}"` 逐字搬过来（含最后那个**两个空格**）：
 * Python 的 format 计数**字符**数而不是显示宽度，`padEnd`/`padStart` 同样按
 * code unit 计数 —— 内容里的 code 全是 ASCII，两者一致。
 *
 * ⚠️ 迭代前必须先排序：JS 对象会把"整数样式"的键（"0"、"12"）排到最前面，
 * Python 的 dict 保持插入顺序。这里 `sortedStrings` 先排一遍，差异就不存在了。
 */
export function renderCoverage(stats: ContentStats): string {
  const lines: string[] = [
    `${"competency".padEnd(22)} ${"items".padStart(5)} ${"blocks".padStart(7)} ` +
      `${"decomp".padStart(7)} ${"direct".padStart(7)}  patterns`,
    "-".repeat(92),
  ];
  for (const code of sortedStrings(Object.keys(stats.coverage))) {
    const row = stats.coverage[code]!;
    lines.push(
      `${code.padEnd(22)} ${String(row.items).padStart(5)} ` +
        `${String(row.by_scaffold.blocks).padStart(7)} ` +
        `${String(row.by_scaffold.decompose).padStart(7)} ` +
        `${String(row.by_scaffold.direct).padStart(7)}  ` +
        `${row.patterns.join(", ") || "—"}`,
    );
  }
  return lines.join("\n");
}

/**
 * `content_cli stats` 的整份报表 —— 内容总览 + 覆盖表 + 按结构分布 + 示范路径写法 + 候选池宽度。
 *
 * ⚠️ **这是本文件里唯一一处「Python 不在 compiler.py 里」的移植**：Python 那段装配
 * 内联在 `tools/content_cli/main.py:78-107` 的 `cmd_stats` 里，没有独立函数。
 * 之所以提到这里来：它有一处**真实内容永远走不到的分支** ——
 * `mark = "⚠️" if width < 3 else "  "`，而真实内容 52 个槽位的候选池最窄也有 8 道。
 * 留在 CLI 脚本里就等于把那个分支放进一个没有对拍、也没有单测的位置。
 * 放在 `renderCoverage` 旁边是因为两者是同一类东西：把 stats 渲染成人看的表。
 *
 * 排版规格逐字照抄 `"{:<22} {:>4}"` / `"  {} {:<32} {:>3} 道"` —— 含 `｜`（全角竖线）。
 */
export function renderStatsReport(stats: ContentStats): string {
  const lines: string[] = [
    "内容总览",
    `  能力 ${stats.competencies} ｜ 结构 ${stats.patterns} ｜ 题目 ${stats.items} ｜ ` +
      `槽位 ${stats.slots}（故事 ${stats.story_slots} / 独立 ${stats.standalone_slots}）｜ ` +
      `误区 ${stats.misconceptions}`,
    "",
    renderCoverage(stats),
    "",
    "按认知结构分布",
  ];

  // Python 是 `stats["items_by_pattern"].items()`（插入顺序）。computeStats 已经把它
  // 排过序了，这里再排一遍结果相同 —— 好处是报表的顺序不依赖 computeStats 用哪种
  // 容器表示，将来谁把它换成普通对象也不会被 JS 的"整数样式键排最前"静默换序。
  for (const code of sortedStrings(Object.keys(stats.items_by_pattern))) {
    lines.push(`  ${code.padEnd(22)} ${String(stats.items_by_pattern[code]!).padStart(4)}`);
  }

  const style = stats.items_by_steps_style;
  lines.push(
    "",
    `示范路径写法：guide（最后一步留给孩子）${style.guide} 道 ｜ ` +
      `conclude（写出答案）${style.conclude} 道`,
    "",
    "槽位候选池宽度",
  );

  // ⚠️ `sorted(...)` 是按 slot_code 排序，不是槽位加载顺序
  for (const code of sortedStrings(Object.keys(stats.slots_detail))) {
    const width = stats.slots_detail[code]!;
    const mark = width < 3 ? "⚠️" : "  ";
    lines.push(`  ${mark} ${code.padEnd(32)} ${String(width).padStart(3)} 道`);
  }

  return lines.join("\n");
}
