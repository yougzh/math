/**
 * 教练的四道护栏 —— `backend/coach/validators.py` 的 TypeScript 移植。
 *
 * 孩子看到的每一句教练文案，都必须先过这四关：
 *
 *     1. 不泄漏答案       —— 提示可以说方法，不能说出结果
 *     2. 不超纲           —— 不能提到还没学的能力（"进位"不能在凑十阶段出现）
 *     3. 长度可控         —— 8 岁孩子读不完成段的话
 *     4. 语气安全         —— 不出现否定评价（"错了"、"太慢"）
 *
 * 任何一条不过，就退回规则文案 —— 这是**决定**，不是建议：
 * LLM 的输出不可信，护栏是唯一让它进入孩子视野的通道。
 *
 * 正则纪律（见 src/py/pyre.ts）：`\d` 一律写成 `[0-9]`，把 Python（Unicode 数字）
 * 与 JS（ASCII）的宽度差异变窄而不是变宽。
 */
import type { Item } from "@/src/content/types";
import type { CompetencyGraph } from "@/src/engine/graph";
import type { CoachConfig } from "@/src/coach/config";

// "8 + 5 = 13" 这类显式结论（单次运算；cognitive.py 的连算版在 pyre.ts）
const EQUALITY_RE = /([0-9]+)\s*[+\-加乘除×÷]\s*([0-9]+)\s*[=＝]/;
const SENTENCE_END_RE = /[。！？!?；;]/;
const NUMBER_TOKEN_RE = /[0-9]+/g;

export function validateAnswerLeak(text: string, item: Item): string[] {
  /** 提示可以说方法，不能说结果。 */
  const answer = item.answer;
  // Python `isinstance(answer, int) and not isinstance(answer, bool)`：
  // 内容资产里没有 x.0 形态的答案，整数值 number 即 Python int（同 learning.ts 的注释）
  if (typeof answer !== "number" || !Number.isInteger(answer)) {
    return [];
  }
  const problems: string[] = [];
  const tokens = new Set<number>();
  for (const match of text.matchAll(NUMBER_TOKEN_RE)) {
    tokens.add(Number.parseInt(match[0], 10));
  }
  if (tokens.has(answer)) {
    problems.push(`泄漏答案：文案里出现了答案 ${answer}`);
  }
  if (EQUALITY_RE.test(text)) {
    problems.push("泄漏答案：文案里出现了完整算式");
  }
  return problems;
}

export function validateKnowledgeScope(
  text: string,
  item: Item,
  graph: CompetencyGraph,
): string[] {
  /**
   * 不能提到还没学到的能力。
   *
   * 允许出现的内容 = 当前能力 + 它的所有（传递）前置，包括：
   *   · 能力名（"进位加法"）
   *   · 能力特有说法（"进位"、"借位" —— 见 competency.terms）
   *
   * 术语表写在内容里而不是代码里：教学法用语会变，代码不该跟着改。
   */
  const problems: string[] = [];
  const allowed = new Set<string>([item.competency_id]);
  // Python 对 prerequisites 抛 KeyError/AttributeError 的情况 try/except 吞掉；
  // TS 版对未知 code 返回空数组 —— 净效果相同（allowed 只含当前能力）。
  for (const code of graph.prerequisites(item.competency_id, true)) {
    allowed.add(code);
  }

  for (const competency of graph.competencies.values()) {
    if (allowed.has(competency.code)) {
      continue;
    }
    const name = competency.name || "";
    if (name && text.includes(name)) {
      problems.push(`超纲：文案里出现了还没学的能力「${name}」`);
      continue;
    }
    for (const term of competency.terms ?? []) {
      if (term && text.includes(term)) {
        problems.push(`超纲：文案里用了还没学的说法「${term}」（属于「${name}」）`);
        break;
      }
    }
  }
  return problems;
}

export function validateLength(text: string, cfg: CoachConfig): string[] {
  const problems: string[] = [];
  const stripped = text.trim();
  if (!stripped) {
    return ["文案为空"];
  }
  if ([...stripped].length > cfg.max_chars) {
    problems.push(`文案太长：${[...stripped].length} 字，上限 ${cfg.max_chars} 字`);
  }
  const sentences = stripped.split(SENTENCE_END_RE).filter((s) => s.trim());
  if (sentences.length > cfg.max_sentences) {
    problems.push(`句子太多：${sentences.length} 句，上限 ${cfg.max_sentences} 句`);
  }
  if (
    (stripped.match(/！/g)?.length ?? 0) + (stripped.match(/!/g)?.length ?? 0) >
    cfg.max_exclamation_marks
  ) {
    problems.push("感叹号太多，会显得在催促");
  }
  return problems;
}

export function validateTone(text: string, cfg: CoachConfig): string[] {
  const hit = cfg.forbidden_phrases().filter((phrase) => text.includes(phrase));
  if (hit.length > 0) {
    return [`语气不合格，出现了否定评价：${hit.join("、")}`];
  }
  return [];
}

export function runAll(text: string, item: Item, graph: CompetencyGraph, cfg: CoachConfig): string[] {
  /** 返回空列表 = 通过全部护栏。 */
  const problems: string[] = [];
  problems.push(...validateAnswerLeak(text, item));
  problems.push(...validateKnowledgeScope(text, item, graph));
  problems.push(...validateLength(text, cfg));
  problems.push(...validateTone(text, cfg));
  return problems;
}
