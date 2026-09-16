/**
 * LLM 适配层 —— `backend/coach/llm.py` 的 TypeScript 移植。
 *
 * 默认**离线**：没有配置模型时返回 null，教练自动退回规则文案。
 * 这样开发、测试、断网、额度用尽都不会让孩子看到一个坏掉的界面。
 *
 * 接入真模型时只实现 `rewrite()` 一个方法即可 —— 注意它返回的文案
 * 仍然要过四道护栏（见 service.ts）。
 */

export interface LLMContext {
  competency: string;
  pattern: string;
  difficulty: number;
  tone: string;
}

export interface LLMAdapter {
  readonly name: string;
  available(): boolean;
  /** 改写一句话，不改事实。返回 null = 放弃改写，用规则文案。 */
  rewrite(instruction: string, ruleText: string, context: LLMContext): Promise<string | null>;
}

/** 离线：什么都不做，让调用方退回规则文案。 */
export class NullLLM implements LLMAdapter {
  readonly name = "null";

  available(): boolean {
    return false;
  }

  async rewrite(): Promise<string | null> {
    return null;
  }
}

/**
 * 最薄的一层 HTTP 适配。不绑定任何厂商 SDK：一个 POST，一个 JSON 里的
 * text 字段。用环境变量开启：
 *
 *     MATH_COACH_LLM_URL=https://.../v1/chat
 *     MATH_COACH_LLM_KEY=...
 *     MATH_COACH_LLM_MODEL=...
 */
export class HTTPLLM implements LLMAdapter {
  readonly name = "http";

  constructor(
    readonly url: string,
    readonly key = "",
    readonly model = "",
    /** Python 默认 6.0 秒 */
    readonly timeoutMs = 6000,
  ) {}

  available(): boolean {
    return Boolean(this.url);
  }

  async rewrite(instruction: string, ruleText: string, context: LLMContext): Promise<string | null> {
    const payload = {
      model: this.model,
      instruction,
      text: ruleText,
      context,
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.key) {
      headers["Authorization"] = `Bearer ${this.key}`;
    }
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data = (await response.json()) as unknown;
      const text =
        typeof data === "object" && data !== null
          ? (data as Record<string, unknown>)["text"]
          : undefined;
      // Python：`str(text) if text else None`
      return text ? String(text) : null;
    } catch {
      // 网络错 / 超时 / JSON 解析失败：一律退回规则文案
      return null;
    }
  }
}

export function defaultAdapter(): LLMAdapter {
  const url = (process.env["MATH_COACH_LLM_URL"] ?? "").trim();
  if (!url) {
    return new NullLLM();
  }
  return new HTTPLLM(
    url,
    (process.env["MATH_COACH_LLM_KEY"] ?? "").trim(),
    (process.env["MATH_COACH_LLM_MODEL"] ?? "").trim(),
  );
}
