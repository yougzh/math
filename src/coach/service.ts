/**
 * 教练编排 —— `backend/coach/service.py` 的 TypeScript 移植。
 *
 * 规则先说话，LLM 只能改写，护栏一票否决。
 *
 *     rule_text ──► LLM.rewrite ──► 四道护栏 ──► 通过？用 LLM 文案
 *                                         └── 不通过？用 rule_text
 *
 * 关键不变量：**任何未经护栏的文本都不会出现在返回值里**。
 * 被拦下的文本与原因会记在 `rejected` 里，方便复盘模型到底想说什么。
 */
import type { ContentBundle, Item } from "@/src/content/types";
import type { CompetencyGraph } from "@/src/engine/graph";
import { CoachConfig, loadCoachConfig } from "@/src/coach/config";
import { defaultAdapter, type LLMAdapter, type LLMContext } from "@/src/coach/llm";
import * as rules from "@/src/coach/rules";
import * as validators from "@/src/coach/validators";

export const REWRITE_INSTRUCTION =
  "把下面这句小学数学教练的话改写得更自然、更像对一个 8 岁孩子说的，" +
  "不要改变它给出的方法，不要说出答案，不要提到还没学的内容，" +
  "不要超过 40 个字，只输出改写后的一句话。";

export interface CoachMessageDict {
  tone: string;
  text: string;
  character: string;
  [key: string]: unknown;
}

export interface CoachHintDict {
  hint_level: number;
  hint_text: string;
  source: string;
  fallback_used: boolean;
  exhausted: boolean;
  [key: string]: unknown;
}

export class CoachMessage {
  tone: string;
  text: string;
  character = "小助手";
  /** rule | llm | fallback */
  source = "rule";
  level = 0;
  exhausted = false;
  /** 被护栏拦下的尝试 */
  rejected: string[] = [];

  constructor(init: { tone: string; text: string }) {
    this.tone = init.tone;
    this.text = init.text;
  }

  /** 反馈形状：用在做题后的 feedback 字段（见 api-contract §4）。 */
  toDict(): CoachMessageDict {
    return { tone: this.tone, text: this.text, character: this.character };
  }

  /** 提示形状：用在 `POST /v1/coach/hints` 的响应（见 api-contract §6）。 */
  toHintDict(): CoachHintDict {
    return {
      hint_level: this.level,
      hint_text: this.text,
      source: this.source,
      fallback_used: this.source === "fallback",
      exhausted: this.exhausted,
    };
  }
}

export class CoachService {
  readonly bundle: ContentBundle;
  readonly graph: CompetencyGraph;
  readonly cfg: CoachConfig;
  readonly llm: LLMAdapter;
  readonly allowLlm: boolean;

  constructor(
    bundle: ContentBundle,
    graph: CompetencyGraph,
    cfg?: CoachConfig,
    llm?: LLMAdapter,
    allowLlm = true,
  ) {
    this.bundle = bundle;
    this.graph = graph;
    this.cfg = cfg ?? loadCoachConfig(0);
    this.llm = llm ?? defaultAdapter();
    this.allowLlm = allowLlm;
  }

  // ── 提示 ─────────────────────────────────────────────
  hint(item: Item, hintsUsed: number, misconceptionCode?: string | null): Promise<CoachMessage> {
    const rule = rules.buildHintRuleText(item, hintsUsed, this.cfg, misconceptionCode);
    return this.maybeRewrite(rule, item, hintsUsed, "小助手");
  }

  // ── 反馈 ─────────────────────────────────────────────
  feedback(
    item: Item,
    correct: boolean,
    hintsUsed: number,
    opts: { misconceptionCodes?: string[] | null; seed?: number },
  ): Promise<CoachMessage> {
    const misconceptionCodes = opts.misconceptionCodes ?? [];
    const names: Record<string, string> = {};
    for (const code of misconceptionCodes) {
      const definition = this.bundle.misconceptions.get(code);
      if (definition !== undefined) {
        names[code] = definition.name;
      }
    }
    const rule = rules.buildFeedbackRule({
      item,
      correct,
      hints_used: hintsUsed,
      misconception_codes: misconceptionCodes,
      misconception_names: names,
      bundle: this.bundle,
      cfg: this.cfg,
      seed: opts.seed ?? 0,
    });
    return this.maybeRewrite(rule, item, opts.seed ?? 0, "小助手");
  }

  // ── 护栏通道 ─────────────────────────────────────────
  private async maybeRewrite(
    rule: rules.CoachRule,
    item: Item,
    seed: number,
    character: string,
  ): Promise<CoachMessage> {
    void seed;
    const ruleText = String(rule.text ?? "");
    const message = new CoachMessage({
      tone: String(rule.tone ?? "encourage"),
      text: ruleText,
    });
    message.character = String(rule.character ?? character);
    message.level = Math.trunc(Number(rule.level ?? 0));
    message.exhausted = Boolean(rule.exhausted ?? false);

    // 规则文案本身也必须过护栏：规则写错了同样会伤到孩子
    const ownProblems = validators.runAll(ruleText, item, this.graph, this.cfg);
    if (ownProblems.length > 0) {
      message.rejected.push(...ownProblems.map((p) => `规则文案未过护栏：${p}`));
      message.text = safeFallback(item, this.cfg);
      message.source = "fallback";
      return message;
    }

    if (!(this.allowLlm && this.llm.available())) {
      return message;
    }

    const context: LLMContext = {
      competency: item.competency_id,
      pattern: item.pattern_id,
      difficulty: item.difficulty,
      tone: message.tone,
    };
    const candidate = await this.llm.rewrite(REWRITE_INSTRUCTION, ruleText, context);
    if (!candidate) {
      return message;
    }

    const problems = validators.runAll(candidate, item, this.graph, this.cfg);
    if (problems.length > 0) {
      message.rejected.push(...problems);
      return message;
    }

    message.text = candidate;
    message.source = "llm";
    return message;
  }
}

/** 兜底文案：永远安全，永远有内容。 */
function safeFallback(item: Item, cfg: CoachConfig): string {
  const prompt = cfg.concept_prompt(item.competency_id);
  return prompt || "我们一步一步来。";
}

export function defaultService(
  bundle: ContentBundle,
  graph: CompetencyGraph,
  llm?: LLMAdapter,
): CoachService {
  return new CoachService(bundle, graph, loadCoachConfig(0), llm);
}
