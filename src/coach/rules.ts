/**
 * 规则版教练 —— `backend/coach/rules.py` 的 TypeScript 移植。
 *
 * 不依赖任何模型，离线也能说话。负责两件事：
 *   1. 挑下一级提示（来自 item.hint_chain，逐级给出，不跳级）
 *   2. 给反馈（对/错/用提示/慢但对/命中误区）
 *
 * LLM 只能**改写**这里的文案，不能自己决定说什么 —— 因为说什么受教学法约束，
 * 怎么写才自然才是语言模型擅长的。这个分工让系统在模型不可用时依然完整。
 */
import type { Item, ContentBundle } from "@/src/content/types";
import type { CoachConfig } from "@/src/coach/config";

export interface CoachRule {
  tone: string;
  text: string;
  level?: number;
  exhausted?: boolean;
  character?: string;
  misconception_hint?: string;
}

export function nextHintLevel(hintsUsed: number, item: Item): number {
  /** 提示按级给，不跳级。提示链用完了返回 0，表示"该换一种帮法"。 */
  const total = item.hint_chain.length;
  if (total === 0 || hintsUsed >= total) {
    return 0;
  }
  return hintsUsed + 1;
}

export function hintText(item: Item, level: number): string {
  if (level <= 0 || level > item.hint_chain.length) {
    return "";
  }
  return String(item.hint_chain[level - 1]);
}

function pick(options: string[], seed: number): string {
  /** 确定性挑选：同一个孩子同一道题不会每次看到不同开场词。 */
  if (options.length === 0) {
    return "";
  }
  // Python 的 % 对负数也返回非负 —— 保持同语义
  return options[((seed % options.length) + options.length) % options.length]!;
}

export function buildHintRuleText(
  item: Item,
  hintsUsed: number,
  cfg: CoachConfig,
  _misconceptionCode?: string | null,
): CoachRule {
  /** 规则版提示：先给误区指向的概念，再给 hint_chain 的下一级。 */
  let level = nextHintLevel(hintsUsed, item);
  let text = hintText(item, level);
  if (!text) {
    // 提示链用完了：退回到该能力的通用思维提示，而不是放弃
    text = cfg.concept_prompt(item.competency_id) || "先把题目再读一遍。";
    level = 0;
  }
  return {
    tone: "encourage",
    text,
    level,
    exhausted: level === 0,
  };
}

export function buildFeedbackRule(params: {
  item: Item;
  correct: boolean;
  hints_used: number;
  misconception_codes: string[];
  misconception_names: Record<string, string>;
  bundle: ContentBundle;
  cfg: CoachConfig;
  seed?: number;
}): CoachRule {
  /** 按"对/错 × 是否用提示"给出反馈文案与语气。 */
  const { item, correct, hints_used, misconception_codes, misconception_names, cfg } = params;
  const seed = params.seed ?? 0;

  let key: string;
  if (correct && hints_used === 0) {
    key = "correct_without_hint";
  } else if (correct) {
    key = "correct_with_hint";
  } else if (misconception_codes.length > 0) {
    key = "incorrect_with_misconception";
  } else {
    key = "incorrect";
  }

  const tone = cfg.feedback_tone(key, correct ? "encourage" : "repair");
  const opener = pick(cfg.openers(tone), seed);

  const texts = cfg.feedback_texts(key);
  const template = texts.length > 0 ? pick(texts, seed) : "{opener}。";

  let misconceptionHint = "";
  if (misconception_codes.length > 0) {
    const first = misconception_codes[0]!;
    const name = misconception_names[first] ?? "";
    const prompt = cfg.concept_prompt(item.competency_id);
    // 只描述该能力范围内的动作，不点破具体答案
    misconceptionHint = prompt || "我们回头看看题目问的是什么。";
    if (name && !prompt) {
      misconceptionHint = `这个坑叫「${name}」，我们换个办法绕过去。`;
    }
  }

  // Python `template.format(opener=..., misconception_hint=...)`：
  // 模板里只有这两个具名占位，逐个替换等价
  const text = template
    .replaceAll("{opener}", opener)
    .replaceAll("{misconception_hint}", misconceptionHint);
  return {
    tone,
    text,
    character: "小助手",
    misconception_hint: misconceptionHint,
  };
}
