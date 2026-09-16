/**
 * 内容校验 —— `backend/content/loader.py` 的「轻量校验」一段的 TypeScript 移植。
 *
 * validate 与 lint 的区别（见 compiler.py 的模块注释）：
 *   validate 失败 = 内容**错误**，绝不能入库（答案错、认知结构不成立、引用不存在）
 *   lint   失败 = 内容**可疑或缺失**，可以入库但必须让人看见（覆盖缺口、时长不匹配）
 * 这个文件只有 validate；lint 在 compiler.ts。
 *
 * 移植纪律：
 *
 * 1. **报错顺序是输出的一部分**。下面的循环几乎都直接迭代 bundle 的 Map，
 *    所以顺序 = 内容加载顺序（content.index.json 的 load_order）。
 *    别改成"看起来更确定"的排序 —— 对拍会把顺序差异报出来。
 *
 * 2. **文案逐字照抄**，包括全角括号、「」、`→`，以及 Python 把 None/True/False
 *    字符串化成 `None`/`True`/`False` 这件事（用 `pyStr`，不用裸模板字符串）。
 *
 * 3. **Python 的 `set` 迭代顺序跨进程不稳定**（str hash 随机化，实测同一段
 *    `set(...) | {...}` 连跑三次给出三种顺序）。下面 pattern 关联能力那段
 *    在 TS 侧按"插入顺序去重"实现：它保证产生 Python 能产生的**那一组**输出，
 *    但不承诺是同一次运行的顺序。真实内容下这条规则一条都不报，
 *    对拍时按集合比较（见 S1-2c）。
 */
import { sortedStrings } from "@/src/py/pysort";
import {
  ALLOWED_PURPOSES,
  ALLOWED_STEPS_STYLES,
  AUTO_SCAFFOLD,
  BEAT_TYPES,
  COGNITIVE_TYPES,
  SCAFFOLD_LEVELS,
  challengeBeats,
  patternAppliesTo,
  type ContentBundle,
} from "./types";
import { numberTokensIn } from "@/src/py/pyre";
import { pyGet, pyNumberListRepr, pyStr } from "@/src/py/pyvalue";

// ── 小工具 ─────────────────────────────────────────────────

/** 运行时的枚举白名单检查。loader 用 `as` 强转，所以类型系统在这里帮不上忙。 */
function inAllowed(value: string, allowed: readonly string[]): boolean {
  return allowed.includes(value);
}

/** 取出一个「应该是对象」的值；不是对象一律当空对象（与 AlgorithmConfig.get 的中途缺失语义一致） */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ── 升级门阈值 ─────────────────────────────────────────────

/**
 * 升级要求"至少几个不同 pattern 成功过"：`upgrade_requires.new_pattern_success.min_patterns`。
 *
 * 输入是**算法配置的原始对象**（`config/algorithm/v0.yaml` 的顶层内容）。
 * 返回 null 表示配置里没写这个键 —— 调用方**跳过**该检查，而不是退回硬编码值。
 *
 * ⚠️ 为什么这里不直接调 `AlgorithmConfig.newPatternSuccessRule()`：
 * `src/engine/config.ts` **顶层静态 import** 了构建产物
 * `src/generated/config.json`（为了让 Next.js 的 output file tracing 把它打进
 * serverless bundle，运行时读 YAML 会变成"本地能跑线上 500"），
 * 而那份产物正是构建脚本自己要产出的东西 —— 构建脚本 import 它，首次构建
 * 会在**模块解析阶段**就 "Cannot find module"，内容构建从此无法自举。
 *
 * ADR-0002 要求阈值只能有一个来源，所以这里的取值语义必须与
 * `newPatternSuccessRule()` 逐字一致（`get([...], default={})`：路径上任一层
 * 缺失都给 {}，然后 `.get("min_patterns")` 缺键给 None）。
 * `tests/unit/validate.test.ts` 里有一条测试拿真实配置断言两条路径**结果相同** ——
 * 将来谁改了 AlgorithmConfig 的默认值，会在那里立刻变红。
 */
export function minPatternsFromRaw(algorithm: Record<string, unknown>): number | null {
  const requires = asRecord(pyGet(algorithm, "upgrade_requires", {}));
  const rule = asRecord(pyGet(requires, "new_pattern_success", {}));
  const value = pyGet(rule, "min_patterns");
  return value === null || value === undefined ? null : Math.trunc(Number(value));
}

// ── 提示泄漏 ───────────────────────────────────────────────

/**
 * Python `isinstance(answer, int)` 的等价物。
 *
 * ⚠️ bool 是 int 的**子类**（True == 1 / False == 0），所以 `answer: true`
 * 配上一句含 "1" 的提示，Python 会判为"提示泄漏了答案"（实测确认）。
 * 这不是笔误，是 Python 的原行为 —— 照抄，别"顺手"把 bool 排除掉。
 *
 * ⚠️ 已知差异：YAML 里的 `3.0` 经 JSON 之后与 `3` 不可区分，所以
 * `Number.isInteger(3.0)` 为 true 而 `isinstance(3.0, int)` 为 false。
 * 这个差异在解析后的对象上**不可观测**，只能由构建脚本在 YAML 原文上
 * 断言"内容里不存在小数标量"（见 scripts/build-content.ts）。
 */
function isPythonInt(value: unknown): boolean {
  return typeof value === "boolean" || (typeof value === "number" && Number.isInteger(value));
}

/**
 * 提示里出现了答案的数字就算泄漏。
 *
 * 注意 `_NUMBER_TOKEN` 只认数字不认负号，所以 `answer: -5` 不会因为提示里的
 * "-5" 被判泄漏（Python 实测为 False）。全角数字是另一处已知差异：
 * Python 的 `\d` 匹配 Unicode 十进制数字（`int("３") == 3`），这里只认 ASCII ——
 * 同样由构建脚本断言内容里无非 ASCII 十进制数字。
 */
export function hintLeaksAnswer(hint: string, answer: unknown): boolean {
  if (!isPythonInt(answer)) return false;
  const tokens = numberTokensIn(hint);
  // bool → 1/0 才与 Python 的 `answer in tokens` 等价（True == 1）
  return tokens.has(typeof answer === "boolean" ? (answer ? 1 : 0) : (answer as number));
}

// ── 内容事实查询 ───────────────────────────────────────────

/**
 * （传递）依赖 code 的能力 —— 自己用 prerequisites 反推，不依赖 engine 层。
 *
 * ⚠️ 与 `CompetencyGraph.dependents()` 不是一回事：那个是**直接**依赖、给引擎用；
 * 这个是**传递闭包**、排除自环、给校验文案用。别想着合并。
 */
function dependents(bundle: ContentBundle, code: string): string[] {
  const reverse = new Map<string, string[]>();
  for (const comp of bundle.competencies.values()) {
    for (const prereq of comp.prerequisites) {
      const bucket = reverse.get(prereq);
      if (bucket === undefined) reverse.set(prereq, [comp.code]);
      else bucket.push(comp.code);
    }
  }

  const seen = new Set<string>();
  const stack = [...(reverse.get(code) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current) || current === code) continue;
    seen.add(current);
    stack.push(...(reverse.get(current) ?? []));
  }
  return sortedStrings(seen);
}

/**
 * 该能力下"有题支撑"的 pattern 名单（去重、排序）。
 *
 * 只认 item.competency_id 命中、且 pattern 真的适用于该能力的题：
 * 运行时 count_successful_patterns 只在 patterns_for(competency) 上累计信号，
 * pattern 不适用或没有题，孩子就永远"成功"不了它。
 */
function supportedPatterns(bundle: ContentBundle, competencyCode: string): string[] {
  const codes = new Set<string>();
  for (const item of bundle.items.values()) {
    if (item.competency_id !== competencyCode) continue;
    const pattern = bundle.patterns.get(item.pattern_id);
    if (pattern !== undefined && patternAppliesTo(pattern, competencyCode)) {
      codes.add(pattern.code);
    }
  }
  return sortedStrings(codes);
}

/**
 * 结构性死路：能力有题支撑的 pattern 数不足，永远无法升级。
 *
 * 升级硬条件要求"至少 N 个不同 pattern 成功过"（N 来自配置）。但 pattern
 * 只有真的产出了题目，孩子才可能把它成功一次 —— 所以这里数的是**有题支撑**的
 * pattern。某个能力只有 < N 个 pattern 的题时，它在结构上就永远升不了级，
 * 而且会沿 prerequisites 把整条下游一起拖死。
 *
 * 这类缺陷过去只能靠人工读模拟报告发现（tools/simulate.py 的 Q7），
 * 现在编译器直接拦住。
 *
 * `minPatterns` 为 null 时跳过（配置里没写这个键）。**刻意不做默认参数**：
 * "忘了传"必须是一个编译错误，不能静默关掉这条检查。
 */
export function validateUpgradablePatterns(
  bundle: ContentBundle,
  minPatterns: number | null,
): string[] {
  const need = minPatterns;
  if (need === null || need < 1) return [];

  const problems: string[] = [];
  for (const code of sortedStrings(bundle.competencies.keys())) {
    const patterns = supportedPatterns(bundle, code);
    if (patterns.length >= need) continue;
    let message =
      `${code}：只有 ${patterns.length} 个 pattern 有题支撑（${patterns.join("、") || "无"}），` +
      `升级需要 ${need} 个 → 该能力永远无法升级`;
    const downstream = dependents(bundle, code);
    if (downstream.length > 0) {
      message += `；受牵连的下游能力 ${downstream.length} 个：${downstream.join("、")}`;
    }
    problems.push(message);
  }
  return problems;
}

// ── 故事 ───────────────────────────────────────────────────

/**
 * 故事叙事与挑战槽必须严丝合缝。
 *
 * 最容易出的错是"故事讲到要算一算，系统却不知道该算什么"——
 * 孩子看到一个挑战节拍，却没有题可出。所以这里逐条核对。
 */
function validateStories(bundle: ContentBundle): string[] {
  const problems: string[] = [];
  const beatToStory = new Map<string, string>();

  for (const story of bundle.stories.values()) {
    if (!story.title) {
      problems.push(`story ${story.code} 缺少 title`);
    }
    for (const competency of story.target_competencies) {
      if (!bundle.competencies.has(competency)) {
        problems.push(`story ${story.code} 指向了不存在的 competency ${competency}`);
      }
    }

    const sequences = story.beats.map((b) => b.sequence);
    if (sequences.length !== new Set(sequences).size) {
      problems.push(`story ${story.code} 的 beat sequence 有重复`);
    }
    // Python: sorted(sequences) != list(range(1, len(sequences) + 1))
    const ordered = [...sequences].sort((a, b) => a - b);
    if (ordered.length > 0 && !ordered.every((value, index) => value === index + 1)) {
      problems.push(
        `story ${story.code} 的 beat sequence 必须是 1..N 连续（当前 ${pyNumberListRepr(ordered)}）`,
      );
    }

    for (const beat of story.beats) {
      const prefix = `${story.code}__`;
      if (!beat.code.startsWith(prefix)) {
        problems.push(
          `story_beat ${beat.code} 的 code 必须以「${prefix}」开头（约定：story_code__local）`,
        );
      }
      if (beatToStory.has(beat.code)) {
        problems.push(`story_beat ${beat.code} 重复出现在多个故事里`);
      }
      // 无条件覆盖：Python 是 `beat_to_story[beat.code] = story.code`，
      // 重复时报完错仍以后者为准，后面 slot 的反向核对据此找所属故事。
      beatToStory.set(beat.code, story.code);
      if (!inAllowed(beat.beat_type, BEAT_TYPES)) {
        problems.push(`story_beat ${beat.code} 的 type 非法: ${beat.beat_type}`);
      }
      if (!beat.narration) {
        problems.push(`story_beat ${beat.code} 没有 text`);
      }
      if (beat.beat_type === "challenge" && !beat.slot_code) {
        problems.push(`挑战节拍 ${beat.code} 没有挂 challenge_slot —— 故事走到这里会无题可出`);
      }
    }

    if (challengeBeats(story).length === 0) {
      problems.push(`story ${story.code} 没有任何挑战节拍（故事必须包含数学训练）`);
    }
  }

  // slot 侧的反向核对
  for (const slot of bundle.slots.values()) {
    if (!slot.story_beat_id) continue;
    const owner = beatToStory.get(slot.story_beat_id);
    if (owner === undefined) {
      problems.push(`slot ${slot.code} 引用了不存在的 story_beat ${slot.story_beat_id}`);
      continue;
    }
    const beat = bundle.stories.get(owner)!.beats.find((b) => b.code === slot.story_beat_id);
    if (beat !== undefined && beat.beat_type !== "challenge") {
      problems.push(`slot ${slot.code} 挂在了非挑战节拍 ${beat.code}（type=${beat.beat_type}）上`);
    }
  }

  return problems;
}

// ── 主入口 ─────────────────────────────────────────────────

/**
 * 内容体检。任何一条问题都会让 Compiler 判定内容不可用。
 *
 * `minPatterns`：升级门要求的 pattern 数，`null` = 配置里没写这个键（跳过该项）。
 *
 * ⚠️ 这个参数**没有默认值** —— Python 的 `min_patterns=None` 兼了「没传」与
 * 「配置里没写」两义，而"忘了传"在 TS 这边应该是一个编译错误：
 * 一个内容校验函数最不该有的行为，就是因为调用方少写一个参数而**静默关闭**
 * 一整条检查，然后一路全绿到线上。
 */
export function validateContent(bundle: ContentBundle, minPatterns: number | null): string[] {
  // 先报加载阶段的问题：code 重复会让后面所有检查都建立在"残缺的内容"上
  const problems: string[] = [...bundle.load_problems];

  for (const comp of bundle.competencies.values()) {
    for (const prereq of comp.prerequisites) {
      if (!bundle.competencies.has(prereq)) {
        problems.push(`competency ${comp.code} 的前置 ${prereq} 不存在`);
      }
      if (prereq === comp.code) {
        problems.push(`competency ${comp.code} 依赖自己`);
      }
    }
  }

  for (const pattern of bundle.patterns.values()) {
    if (!inAllowed(pattern.cognitive_type, COGNITIVE_TYPES)) {
      problems.push(`pattern ${pattern.code} 的 cognitive_type 非法: ${pattern.cognitive_type}`);
    }
    // Python 是 `set(applicable) | {primary}`。set 迭代顺序跨进程不稳定，
    // 这里按插入顺序去重：语义等价（并集 + 去重），顺序更确定。
    for (const compCode of new Set([
      ...pattern.applicable_competencies,
      pattern.primary_competency,
    ])) {
      if (!bundle.competencies.has(compCode)) {
        problems.push(`pattern ${pattern.code} 关联了不存在的 competency ${compCode}`);
      }
    }
  }

  for (const item of bundle.items.values()) {
    if (!bundle.competencies.has(item.competency_id)) {
      problems.push(`item ${item.code} 的 competency ${item.competency_id} 不存在`);
    }
    if (!bundle.patterns.has(item.pattern_id)) {
      problems.push(`item ${item.code} 的 pattern ${item.pattern_id} 不存在`);
    } else {
      const pattern = bundle.patterns.get(item.pattern_id)!;
      if (!patternAppliesTo(pattern, item.competency_id)) {
        problems.push(
          `item ${item.code} 的 pattern ${pattern.code} 不允许用于 competency ${item.competency_id}`,
        );
      }
    }
    if (!inAllowed(item.scaffold_level, SCAFFOLD_LEVELS)) {
      problems.push(`item ${item.code} 的 scaffold_level 非法: ${item.scaffold_level}`);
    }
    if (item.answer === null) {
      problems.push(`item ${item.code} 缺少 answer`);
    }
    if (!inAllowed(item.steps_style, ALLOWED_STEPS_STYLES)) {
      problems.push(`item ${item.code} 的 steps_style 非法: ${item.steps_style}`);
    }
    if (item.hint_chain.length === 0) {
      problems.push(`item ${item.code} 缺少 hint_chain`);
    }
    for (const hint of item.hint_chain) {
      if (hintLeaksAnswer(hint, item.answer)) {
        problems.push(`item ${item.code} 的提示泄漏了答案: ${hint}`);
      }
    }
    for (const rule of item.error_rules) {
      // Python 的 `rule.get("code")` 缺键给 None，`None in misconceptions` 恒为假。
      // 这里显式要求 string：非字符串值不可能命中 Map 的键（Python 的 dict 键都是 str）。
      const code = pyGet(rule, "code");
      if (typeof code !== "string" || !bundle.misconceptions.has(code)) {
        problems.push(`item ${item.code} 引用了不存在的 misconception ${pyStr(code)}`);
      }
      if (!Object.hasOwn(rule, "match")) {
        problems.push(`item ${item.code} 的 error_rule 缺少 match`);
      }
    }
  }

  for (const slot of bundle.slots.values()) {
    if (!bundle.competencies.has(slot.competency_id)) {
      problems.push(`slot ${slot.code} 的 competency ${slot.competency_id} 不存在`);
    }
    // 这里用 truthiness（空串跳过检查），下面候选池用的是 `is None` —— 不一致
    // 是 Python 的原样（loader.py:601 vs :632），别"顺手"统一。
    if (slot.pattern_id) {
      const pattern = bundle.patterns.get(slot.pattern_id);
      if (pattern === undefined) {
        problems.push(`slot ${slot.code} 的 pattern ${slot.pattern_id} 不存在`);
      } else if (!patternAppliesTo(pattern, slot.competency_id)) {
        problems.push(
          `slot ${slot.code} 的 pattern ${slot.pattern_id} 不允许用于 competency ${slot.competency_id}`,
        );
      }
    }
    const scaffold = slot.scaffold_level as string | null;
    if (
      !inAllowed(scaffold ?? "", SCAFFOLD_LEVELS) &&
      scaffold !== AUTO_SCAFFOLD &&
      scaffold !== null
    ) {
      problems.push(`slot ${slot.code} 的 scaffold_level 非法: ${pyStr(scaffold)}`);
    }
    if (!inAllowed(slot.purpose, ALLOWED_PURPOSES)) {
      problems.push(`slot ${slot.code} 的 purpose 非法: ${slot.purpose}`);
    }
    if (slot.difficulty_min > slot.difficulty_max) {
      problems.push(
        `slot ${slot.code} 的难度区间倒置: ${slot.difficulty_min} > ${slot.difficulty_max}`,
      );
    }
    // ADR-0001：必须保证候选池非空，否则运行时会出现"故事走到这里却没题可出"
    const candidates = [...bundle.items.values()].filter(
      (item) =>
        item.competency_id === slot.competency_id &&
        (slot.pattern_id === null || item.pattern_id === slot.pattern_id) &&
        slot.difficulty_min <= item.difficulty &&
        item.difficulty <= slot.difficulty_max,
    );
    if (candidates.length === 0) {
      problems.push(`slot ${slot.code} 的候选池为空（没有任何 item 能满足）`);
    }
  }

  problems.push(...validateStories(bundle));
  problems.push(...validateUpgradablePatterns(bundle, minPatterns));
  return problems;
}
