/**
 * 认知有效性校验与答案独立复核 —— `backend/content/cognitive.py` 的 TypeScript 移植。
 *
 * 这是内容系统里最重要、也最容易被忽略的一层：
 *
 * > 一道题"数字变了"不等于"认知结构变了"。
 *
 * 例如：
 *   make_ten     要求两数之和 > 10 且都是个位数 —— 否则根本用不上凑十，孩子会退回数数
 *   carry_add    必须个位相加 ≥ 10 —— 否则不是进位题
 *   decompose    要求这个数"值得拆" —— 否则拆分是多余的步骤
 *   place_value  必须真的在问十位/个位 —— 否则只是普通口算
 *
 * 问题参数在不同 pattern 下语义不同，因此本模块用**显式的键名**区分，
 * 不让同一套 a/b 在不同结构之间串味：
 *
 *     a, b                两个加数（加法类）
 *     a, b (op="sub")     被减数、减数（减法类）
 *     known, target       已知部分、目标（缺失部分类）
 *     result, added       结果、增加量（逆向类）
 *
 * ⚠️ 移植纪律（输出会被逐字对拍，见 S1-2c）：
 *   1. 报错文案一个字都不能改 —— 包括全角括号、「」、波浪号与空格
 *   2. `STRUCTURE_RULES` 的**顺序即报错顺序**，别重排、别"顺手按能力分组"
 *   3. 数字一律走 `pyInt`（Python `int()` 语义），不用 `parseInt`
 *   4. `dict.get` 一律走 `pyGet`（键存在但为 null 时**不**取默认值）
 */
import { pyInt } from "@/src/py/pyint";
import { pyGet, pyStr } from "@/src/py/pyvalue";
import { ARITH_TOKEN_RE, EQUALITY_RE, OP_ALIASES, numberTokensIn } from "@/src/py/pyre";
import type { Item } from "./types";

type Problem = string | null;

// ── 基础工具 ───────────────────────────────────────────────

/** `item.problem.get(key)` —— Python 无默认值时返回 None */
function problemGet(item: Item, key: string): unknown {
  return pyGet(item.problem, key);
}

export function addends(item: Item): [number | null, number | null] {
  return [pyInt(problemGet(item, "a")), pyInt(problemGet(item, "b"))];
}

/** 返回（被减数, 减数）。缺失部分题的两个数语义相反，这里统一换算。 */
export function subPair(item: Item): [number | null, number | null] {
  if (item.pattern_id === "missing_part") {
    return [pyInt(problemGet(item, "target")), pyInt(problemGet(item, "known"))];
  }
  return [pyInt(problemGet(item, "a")), pyInt(problemGet(item, "b"))];
}

export function partPair(item: Item): [number | null, number | null] {
  return [pyInt(problemGet(item, "known")), pyInt(problemGet(item, "target"))];
}

export function reversePair(item: Item): [number | null, number | null] {
  return [pyInt(problemGet(item, "result")), pyInt(problemGet(item, "added"))];
}

/**
 * Python `abs(n) % 10`。
 *
 * ⚠️ 用 `Math.abs` 而不是裸 `%`：Python 的 `%` 对负数结果符号随除数（`-13 % 10 == 7`），
 * JS 的 `%` 随被除数（`-13 % 10 === -3`）。先取绝对值绕开这个坑，
 * 别改成"先取模再 abs" —— 那样 `-13` 会得到 3 而不是 7。
 */
export function ones(n: number): number {
  return Math.abs(n) % 10;
}

/** Python `abs(n) // 10` —— 对非负整数即整除 */
export function tens(n: number): number {
  return Math.floor(Math.abs(n) / 10);
}

/** Python `str(item.problem.get("op", "add"))` */
export function op(item: Item): string {
  return pyStr(pyGet(item.problem, "op", "add"));
}

// ── 结构有效性规则 ─────────────────────────────────────────

export interface CognitiveRule {
  /** null 表示该能力下所有结构都适用 */
  competency: string | null;
  /** null 表示该能力下所有结构都适用 */
  patterns: readonly string[] | null;
  /** 报错前缀里的标签，逐字对拍 */
  label: string;
  check: (item: Item) => Problem;
}

function ruleSdAdd10(item: Item): Problem {
  const [a, b] = addends(item);
  if (a === null || b === null) return null;
  if (a + b > 10) {
    return `10 以内加法的和不能超过 10（当前 ${a} + ${b} = ${a + b}）`;
  }
  if (a >= 10 || b >= 10) {
    return "10 以内加法不应出现两位数操作数";
  }
  return null;
}

function ruleSdSub10(item: Item): Problem {
  const [a, b] = subPair(item);
  if (a === null || b === null) return null;
  if (a > 10) {
    return `10 以内减法不应出现大于 10 的被减数（当前 ${a}）`;
  }
  if (b < 1) {
    return `减数至少是 1（当前 ${b}）`;
  }
  if (a - b < 0) {
    return `10 以内减法不应出现负数结果（${a} - ${b}）`;
  }
  return null;
}

function ruleSdSub20(item: Item): Problem {
  const [a, b] = subPair(item);
  if (a === null || b === null) return null;
  if (!(10 < a && a <= 20)) {
    return `20 以内减法的被减数必须落在 11~20（当前 ${a}）`;
  }
  if (a - b < 0) {
    return `20 以内减法不应出现负数结果（${a} - ${b}）`;
  }
  if (ones(a) >= ones(b)) {
    return `20 以内减法（退位）要求个位不够减（当前个位 ${ones(a)} ≥ ${ones(b)}）`;
  }
  return null;
}

function ruleSdAdd20(item: Item): Problem {
  const [a, b] = addends(item);
  if (a === null || b === null) return null;
  if (!(10 < a + b && a + b <= 20)) {
    return `20 以内加法的和必须落在 11~20（当前 ${a + b}）`;
  }
  return null;
}

/** 凑十题必须"需要凑十"。 */
function ruleMakeTen(item: Item): Problem {
  const [a, b] = addends(item);
  if (a === null || b === null) return null;
  if (a >= 10 || b >= 10) {
    return `凑十题的加数应小于 10（当前 ${a} / ${b}）`;
  }
  if (a + b <= 10) {
    return `凑十要求两数之和大于 10，否则用不上凑十（当前 ${a} + ${b} = ${a + b}）`;
  }
  if (10 - a >= b) {
    return `凑十要求 ${b} 能给出凑满 10 所需的 ${10 - a} 个（当前只有 ${b}）`;
  }
  return null;
}

function ruleCarryAdd(item: Item): Problem {
  const [a, b] = addends(item);
  if (a === null || b === null) return null;
  if (ones(a) + ones(b) < 10) {
    return `进位题必须个位相加 ≥ 10（当前个位 ${ones(a)} + ${ones(b)} = ${ones(a) + ones(b)}）`;
  }
  return null;
}

function ruleTdAddNocarry(item: Item): Problem {
  const [a, b] = addends(item);
  if (a === null || b === null) return null;
  if (ones(a) + ones(b) >= 10) {
    return `不进位题不能个位相加 ≥ 10（当前 ${ones(a) + ones(b)}）`;
  }
  if (Math.max(a, b) < 10) {
    return "两位数加法应至少有一个两位数操作数";
  }
  return null;
}

function ruleBorrowSub(item: Item): Problem {
  const [minuend, subtrahend] = subPair(item);
  if (minuend === null || subtrahend === null) return null;
  if (ones(minuend) >= ones(subtrahend)) {
    return `退位题必须个位不够减（被减数个位 ${ones(minuend)} ≥ 减数个位 ${ones(subtrahend)}）`;
  }
  return null;
}

function ruleTdSubNocarry(item: Item): Problem {
  const [minuend, subtrahend] = subPair(item);
  if (minuend === null || subtrahend === null) return null;
  if (ones(minuend) < ones(subtrahend)) {
    return `不退位题个位必须够减（当前 ${ones(minuend)} < ${ones(subtrahend)}）`;
  }
  return null;
}

function ruleRepresentPlaceValue(item: Item): Problem {
  const [a] = addends(item);
  if (a === null) return null;
  if (a < 10) {
    return `位值题必须是两位数（当前 ${a}）`;
  }
  const ask = problemGet(item, "ask");
  if (ask !== "tens" && ask !== "ones") {
    return "位值题必须显式声明问的是 tens 还是 ones";
  }
  return null;
}

function ruleDecomposeWorthwhile(item: Item): Problem {
  const [a, b] = addends(item);
  if (a === null || b === null) return null;
  if (Math.max(a, b) < 5) {
    return `两数都太小，拆分不会带来任何便利（${a} / ${b}）`;
  }
  return null;
}

function rulePartTargetLarger(item: Item): Problem {
  const [known, target] = partPair(item);
  if (known === null || target === null) return null;
  if (target <= known) {
    return `缺失部分题的目标（${target}）必须大于已知部分（${known}）`;
  }
  return null;
}

function ruleReverseResultLarger(item: Item): Problem {
  const [result, added] = reversePair(item);
  if (result === null || added === null) return null;
  if (added >= result) {
    return `逆向题的增加量（${added}）必须小于结果（${result}）`;
  }
  return null;
}

/**
 * (能力, 结构, 标签, 检查函数) —— 能力为 null 表示不限能力。
 *
 * Python 是 4 元组，这里换成命名对象：4 个位置里有 2 个是字符串，
 * 顺序错位不会报错、只会让规则悄悄挂到别的结构上。字段名让这种错误不可能发生。
 * **但数组顺序仍然是语义的一部分**（决定同一道题多条违规时的报错顺序）。
 */
export const STRUCTURE_RULES: readonly CognitiveRule[] = [
  { competency: "sd_add_10", patterns: ["direct_compute", "combine"], label: "和不超过 10", check: ruleSdAdd10 },
  { competency: "sd_sub_10", patterns: ["direct_compute", "missing_part"], label: "10 以内减法", check: ruleSdSub10 },
  { competency: "sd_add_20", patterns: ["direct_compute", "total"], label: "和在 11~20", check: ruleSdAdd20 },
  { competency: "sd_sub_20", patterns: ["direct_compute", "missing_part"], label: "20 以内退位减法", check: ruleSdSub20 },
  { competency: "make_ten", patterns: ["decompose", "direct_compute"], label: "必须需要凑十", check: ruleMakeTen },
  {
    competency: "carry_add",
    patterns: ["direct_compute", "increase", "combine", "carry_exchange"],
    label: "个位相加满十",
    check: ruleCarryAdd,
  },
  { competency: "td_add_nocarry", patterns: ["direct_compute", "combine"], label: "个位不进位", check: ruleTdAddNocarry },
  {
    competency: "borrow_sub",
    patterns: ["direct_compute", "missing_part", "carry_exchange"],
    label: "个位不够减",
    check: ruleBorrowSub,
  },
  { competency: "td_sub_nocarry", patterns: ["direct_compute"], label: "个位够减", check: ruleTdSubNocarry },
  { competency: null, patterns: ["represent_place_value"], label: "必须是两位数", check: ruleRepresentPlaceValue },
  { competency: null, patterns: ["decompose"], label: "拆分必须有意义", check: ruleDecomposeWorthwhile },
  { competency: null, patterns: ["missing_part"], label: "目标大于已知部分", check: rulePartTargetLarger },
  { competency: null, patterns: ["reverse"], label: "结果大于增加量", check: ruleReverseResultLarger },
];

export function checkCognitive(item: Item): string[] {
  const problems: string[] = [];
  for (const rule of STRUCTURE_RULES) {
    if (rule.competency !== null && item.competency_id !== rule.competency) continue;
    if (rule.patterns !== null && !rule.patterns.includes(item.pattern_id)) continue;
    const result = rule.check(item);
    if (result) {
      problems.push(`[认知有效性·${rule.label}] ${result}`);
    }
  }
  return problems;
}

// ── 答案独立复核 ───────────────────────────────────────────

/** 用与内容无关的独立方式求解，用于复核 answer 字段。 */
export function solve(item: Item): number | null {
  const pattern = item.pattern_id;

  if (pattern === "number_friends") {
    const [a] = addends(item);
    const target = pyInt(problemGet(item, "target"));
    if (a === null || target === null) return null;
    return target - a;
  }

  if (pattern === "represent_place_value") {
    const [a] = addends(item);
    if (a === null) return null;
    return problemGet(item, "ask") === "tens" ? tens(a) : ones(a);
  }

  if (pattern === "missing_part") {
    const [known, target] = partPair(item);
    if (known === null || target === null) return null;
    return target - known;
  }

  if (pattern === "reverse") {
    const [result, added] = reversePair(item);
    if (result === null || added === null) return null;
    return result - added;
  }

  const [a, b] = addends(item);
  if (a === null || b === null) return null;
  return op(item) === "sub" ? a - b : a + b;
}

export function checkAnswer(item: Item): string[] {
  const expected = solve(item);
  if (expected === null) return [];
  const actual = pyInt(item.answer);
  if (actual === null) {
    return ["答案不是整数，无法复核"];
  }
  if (actual !== expected) {
    return [`答案与独立求解不一致：内容写的是 ${actual}，独立求解得到 ${expected}`];
  }
  return [];
}

// ── steps 复核 ─────────────────────────────────────────────
// steps 是**示范路径**，不是提示。它出现在答案之后（给家长报告、复盘、教练引用），
// 因此写不写答案都可以。凑十法的最后一步就该停在「10 + 3」—— 把最后一步留给孩子，
// 这才是教学设计；反过来要求它写成「= 13」反而是错的。
//
// 所以这里只查两类**客观错误**：
//   1. 步骤里的算式算错了（8 + 5 = 12）—— 会直接把孩子教歪
//   2. 步骤给出的结论和答案矛盾（答案 13，步骤却是从别的题复制来的「8 + 4 = 12」）
// 至于"步骤没有走到答案"，那是**可疑**不是**错误**，交给 lint。

export interface StepEquality {
  /** 原始 step 文本（报错文案里要回显它） */
  step: string;
  /** 算式自己算出来的值 */
  computed: number;
  /** 内容里写的结果 */
  stated: number;
}

/**
 * 把「10 + 3」「13 减去 3」这类算式按从左到右求值。
 *
 * 只支持一元连算（不做优先级），因为这类内容里不会出现带括号的混合运算；
 * 真出现了，求值结果与答案不符会被报出来，人再判断。
 */
export function evalChain(expression: string): number | null {
  const tokens = [...expression.matchAll(ARITH_TOKEN_RE)].map((match) => match[0]);
  if (tokens.length === 0) return null;
  let total = pyInt(tokens[0]);
  if (total === null) return null;
  let index = 1;
  while (index + 1 < tokens.length) {
    const token = tokens[index];
    if (token === undefined) return null;
    const operator = OP_ALIASES.get(token);
    if (operator === undefined) return null;
    const operand = pyInt(tokens[index + 1]);
    if (operand === null) return null;
    if (operator === "+") {
      total += operand;
    } else if (operator === "-") {
      total -= operand;
    } else if (operator === "*") {
      total *= operand;
    } else if (operator === "/") {
      // Python: `total % operand != 0` —— 负数上 JS 的 % 结果符号不同，
      // 但"是否等于 0"的判定两边一致（`-0 === 0`），所以这个条件可以直接照抄
      if (operand === 0 || total % operand !== 0) return null;
      total = Math.floor(total / operand);
    }
    index += 2;
  }
  if (index !== tokens.length) {
    return null; // 尾部还有没消化掉的 token，说明不是干净的算式
  }
  return total;
}

/** 抽取 steps 里所有显式等式，返回（原始文本, 算出来的值, 内容写的结果）。 */
export function stepEqualities(item: Item): StepEquality[] {
  const out: StepEquality[] = [];
  for (const raw of item.steps) {
    const step = pyStr(raw);
    for (const match of step.matchAll(EQUALITY_RE)) {
      // 两个捕获组由正则保证存在；`stated` 匹配 [0-9]+，所以 parseInt 不会截断
      const expression = match[1]!;
      const stated = match[2]!;
      const computed = evalChain(expression);
      if (computed !== null) {
        out.push({ step, computed, stated: Number.parseInt(stated, 10) });
      }
    }
  }
  return out;
}

export function checkSteps(item: Item): string[] {
  const problems: string[] = [];

  for (const { step, computed, stated } of stepEqualities(item)) {
    if (computed !== stated) {
      problems.push(`steps 里的算式算错了：「${step}」应该是 ${computed}，内容写的是 ${stated}`);
    }
  }

  if (problems.length > 0) {
    return problems;
  }

  // 结论与答案矛盾 —— 典型的"从别的题复制步骤"
  const answer = pyInt(item.answer);
  if (answer === null || item.steps.length === 0) {
    return problems;
  }
  const text = item.steps.map((step) => pyStr(step)).join(" ");
  if (numberTokensIn(text).has(answer)) {
    return problems;
  }
  for (const { step, stated } of stepEqualities(item)) {
    if (stated !== answer) {
      problems.push(
        `steps 的结论（${stated}）与答案（${answer}）矛盾，而且步骤里完全没出现答案：「${step}」`,
      );
      break;
    }
  }
  return problems;
}

/**
 * 可疑但不阻塞：声明了 conclude，示范路径却没走到答案。
 *
 * 只有 `steps_style: conclude` 的题才检查 —— 默认的 `guide` 是**刻意的教学设计**
 * （凑十法的最后一步「10 + 3」就该留给孩子算），对它报"没走到答案"是误报。
 */
export function lintSteps(item: Item): string[] {
  if (item.steps_style !== "conclude") return [];
  const answer = pyInt(item.answer);
  if (answer === null) return [];
  const text = item.steps.map((step) => pyStr(step)).join(" ");
  if (numberTokensIn(text).has(answer)) return [];
  if (stepEqualities(item).some((equality) => equality.stated === answer)) return [];
  return [`steps_style=conclude，但示范路径全程没有出现答案 ${answer}`];
}

export function checkAll(item: Item): string[] {
  return [...checkCognitive(item), ...checkAnswer(item), ...checkSteps(item)];
}

export function lintAll(item: Item): string[] {
  return lintSteps(item);
}
