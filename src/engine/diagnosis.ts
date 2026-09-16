/**
 * 错误认知诊断 —— `backend/engine/diagnosis.py` 的 TypeScript 移植。
 *
 * 比记录"答错"有价值得多的是记录"错在哪里"：
 *   23 + 14 答成 47  → 位值混淆  → 回退到位值实验室
 *   8 + 5 答成 12    → 依赖数数  → 降低脚手架的抽象层级
 *
 * P0 实现：内容层声明的 error_rules 精确匹配 + 配置层的通用兜底规则。
 *
 * ══ 四处容易"顺手改错"的地方 ══════════════════════════════
 *
 * ① **四个 match 键是四段独立的 `if`，不是 `else if`**。
 *    同时写了 `{answer_off_by: 1, answer_equals: 12}` 的规则要求**两者都成立**，
 *    而不是先命中谁算谁。改成 else-if 会让"两个条件都写上"这种交叉约束失效。
 *
 * ② **`return bool(match)`** —— 一个键都不认识的 match（比如
 *    `{answer_near: 3}`）返回 **True**，不是 False。这是 Python 的原样行为：
 *    没有 `if` 命中就落到最后的真值判断，非空 dict 恒为真。
 *    也就是说**写错键名的规则会匹配所有错误答案**。听着像 bug，
 *    但它是内容作者的"通配"写法（`{any_wrong: true}` 这种），照抄。
 *
 * ③ **`answer_off_by_multiple_of` 的 `not step`** 是**真值**判断：
 *    `step` 为 0 时直接不匹配（0 做除数会崩，Python 用 `not step` 挡在前面）。
 *    写成 `step === null` 就漏掉了 0，然后 `% 0` 得到 NaN，
 *    `NaN !== 0` 为真 → 恰好"不匹配" —— **结果碰巧一样**，
 *    所以这个错误在测试里看不出来，只能靠读代码守住。用 `!step`（照抄真值语义）。
 *
 * ④ **`diagnose` 对 `item === null` 仍然跑通用规则**（expected 传 None）。
 *    此时 `answer_equals` / `answer_in` 这类只看 submitted 的规则照样能命中 ——
 *    "题目都没加载出来但答案错了"也是有诊断价值的。
 */
import type { Item } from "@/src/content/types";
import type { AlgorithmConfig } from "@/src/engine/config";
import type { Attempt } from "@/src/engine/types";
import { pyInt } from "@/src/py/pyint";
import { pyGet } from "@/src/py/pyvalue";

/**
 * `_as_int` 的实现直接复用 `pyInt`。
 *
 * 两者的语义是同一个"Python 的 int(x)，失败给 None"：
 *   - bool → None（`True` 是 int 的子类，不排掉会算出 1）
 *   - 整数值的 number → 它自己
 *   - 字符串 → `pyIntFromText`（拒绝 "3.0" / "0x10" 这类）
 *   - 其余 → None
 * 已知差异（`3.0` 会被当成 3）写在 `pyint.ts` 的模块头，且被构建脚本的
 * "内容里不许有小数常量"断言挡住 —— 这里不再重复一套实现，
 * 否则两处会各自漂移。
 */
function asInt(value: unknown): number | null {
  return pyInt(value);
}

/** 内容规则与配置规则的最小形状（`ErrorRule` 与 `RawConfig` 都能赋给它） */
export interface DiagnosableRule {
  code?: unknown;
  match?: unknown;
}

/**
 * 单条规则是否命中。
 *
 * `match` 的取值刻意保留 `unknown` 的宽松：Python 的 `"key" in match`
 * 在 `match` 是 None 时会抛 TypeError，这里用 `Object.hasOwn` 抛同样的错
 * （`Object.hasOwn(null, k)` 也是 TypeError）—— 配置写错必须炸，不能静默不匹配。
 */
export function ruleMatches(match: Record<string, unknown>, submitted: unknown, expected: unknown): boolean {
  const sub = asInt(submitted);
  const exp = asInt(expected);

  if (Object.hasOwn(match, "answer_equals")) {
    if (sub === null || sub !== asInt(match["answer_equals"])) return false;
  }

  if (Object.hasOwn(match, "answer_in")) {
    // Python 是 `sub not in {_as_int(v) for v in match["answer_in"]}` ——
    // 集合推导会迭代任意可迭代对象，字符串会被拆成单个字符。
    // 数组是正常形态；字符串照抄"拆字符"；其余（对象/数字）在 Python 里会抛
    // TypeError，这里降级成空集 —— 空集让下面的 `not in` 恒真 → 不匹配，
    // 与"畸形配置不会意外命中"的意图一致。
    const raw = match["answer_in"];
    const values = Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? Array.from(raw)
        : [];
    const allowed = new Set(values.map((value) => asInt(value)));
    if (sub === null || !allowed.has(sub)) return false;
  }

  if (Object.hasOwn(match, "answer_off_by")) {
    const delta = asInt(match["answer_off_by"]);
    if (sub === null || exp === null || delta === null || Math.abs(sub - exp) !== delta) {
      return false;
    }
  }

  if (Object.hasOwn(match, "answer_off_by_multiple_of")) {
    const step = asInt(match["answer_off_by_multiple_of"]);
    // `!step` 而不是 `step === null`：0 也要挡（见模块头 ③）
    if (sub === null || exp === null || !step || sub === exp || (sub - exp) % step !== 0) {
      return false;
    }
    // `%` 的符号语义 JS 与 Python 不同（JS 向零取余、Python 向负无穷取模），
    // 但这里只判"是不是 0"，而 `a % b === 0` ⟺ `b | a` 与符号无关。
    // 例：`(-10) % 10` 在 JS 给 -0、在 Python 给 0，而 `-0 === 0` 为真。
  }

  // 非空 dict 恒为真 —— 包括"一个键都不认识"的 match（见模块头 ②）
  return Object.keys(match).length > 0;
}

/**
 * 按顺序匹配规则，返回命中的 code（**去重且保序**）。
 *
 * `code` 缺失或为空串时跳过 —— 照抄 Python 的 `if code and code not in codes`。
 */
export function matchRules(
  rules: readonly DiagnosableRule[],
  submitted: unknown,
  expected: unknown,
): string[] {
  const codes: string[] = [];
  for (const rule of rules) {
    // `rule.get("match", {})` 只在**键不存在**时给 {}；键存在但是 None 时
    // Python 会把它传给 rule_matches 然后抛 TypeError。这里保留同样的路径
    // （断言只是编译期的，运行时 null 会走到 Object.hasOwn 的 TypeError）。
    const match = pyGet(rule, "match", {}) as Record<string, unknown>;
    if (!ruleMatches(match, submitted, expected)) continue;
    const code = pyGet(rule, "code", null);
    if (code && !codes.includes(code as string)) {
      codes.push(code as string);
    }
  }
  return codes;
}

/**
 * 返回本次作答命中的错误认知 code 列表。
 *
 * 内容层规则优先；一条都没命中时，才用配置里的通用规则兜底。
 * 通用规则只兜最常见的结构性错误（如答案差了整十 → 位值混淆）。
 */
export function diagnose(attempt: Attempt, item: Item | null, cfg: AlgorithmConfig): string[] {
  // 做对了不算错误认知，但**调用方已经判定过的** code 照样带出去
  // （例如 Planner 挂上去的 question_structure_missed）
  if (attempt.correct) return [...attempt.misconception_codes];

  let codes: string[] = [];
  // `item.error_rules` 用真值判断：空数组等于"内容层没声明规则"，走兜底
  if (item !== null && item.error_rules.length > 0) {
    codes = matchRules(item.error_rules, attempt.submitted_answer, item.answer);
  }

  if (codes.length === 0) {
    codes = matchRules(
      cfg.genericErrorRules(),
      attempt.submitted_answer,
      item === null ? null : item.answer,
    );
  }

  for (const code of attempt.misconception_codes) {
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}
