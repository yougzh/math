/**
 * 教练文案配置 —— `backend/coach/config.py` 的 TypeScript 移植。
 *
 * 与算法配置分开：算法决定"推什么"，教练决定"怎么说"。
 *
 * 读取面与 `src/engine/config.ts` 同一决策：构建期读 YAML
 * （build-content.ts 把 `config/coach/*.yaml` 编进产物），运行时只读
 * `src/generated/config.json` 的 `coach` 段 —— serverless 上运行时读
 * YAML 会因 cwd/文件追踪问题静默失败。
 */
import generatedConfig from "../generated/config.json";

export class CoachConfig {
  readonly data: Record<string, unknown>;
  readonly version: number;

  constructor(data: Record<string, unknown>) {
    this.data = data;
    const version = data["version"];
    this.version = typeof version === "number" ? Math.trunc(version) : 0;
  }

  private limitsInt(key: string, fallback: number): number {
    const limits = (this.data["limits"] ?? {}) as Record<string, unknown>;
    const value = limits[key];
    if (value === undefined || value === null) {
      return fallback;
    }
    // Python int()：截断而不是四舍五入
    return Math.trunc(Number(value));
  }

  // ── 限额 ──────────────────────────────────────────────
  get max_chars(): number {
    return this.limitsInt("max_chars", 42);
  }

  get max_sentences(): number {
    return this.limitsInt("max_sentences", 2);
  }

  get max_exclamation_marks(): number {
    return this.limitsInt("max_exclamation_marks", 1);
  }

  // ── 语气 ──────────────────────────────────────────────
  forbidden_phrases(): string[] {
    const value = this.data["tone_forbidden_phrases"];
    return Array.isArray(value) ? [...(value as string[])] : [];
  }

  openers(tone: string): string[] {
    const table = (this.data["tone_openers"] ?? {}) as Record<string, unknown>;
    const value = table[tone];
    return Array.isArray(value) ? [...(value as string[])] : [];
  }

  feedback_texts(key: string): string[] {
    const table = (this.data["feedback_templates"] ?? {}) as Record<string, unknown>;
    const row = (table[key] ?? {}) as Record<string, unknown>;
    const texts = row["texts"];
    return Array.isArray(texts) ? [...(texts as string[])] : [];
  }

  feedback_tone(key: string, fallback = "encourage"): string {
    const table = (this.data["feedback_templates"] ?? {}) as Record<string, unknown>;
    const row = (table[key] ?? {}) as Record<string, unknown>;
    const tone = row["tone"];
    return tone === undefined || tone === null ? fallback : String(tone);
  }

  concept_prompt(competency_id: string): string {
    const table = (this.data["concept_prompts"] ?? {}) as Record<string, unknown>;
    const value = table[competency_id];
    return value === undefined || value === null ? "" : String(value);
  }
}

let cachedCoachConfig: CoachConfig | null = null;

/** 对应 Python `load_coach_config` 的 lru_cache —— 构建产物只有 v0（同 lab 的约定） */
export function loadCoachConfig(version = 0): CoachConfig {
  if (version !== 0) {
    throw new Error(`coach 配置只构建了 v0（请求了 v${version}）`);
  }
  if (cachedCoachConfig === null) {
    cachedCoachConfig = new CoachConfig(
      (generatedConfig as Record<string, unknown>)["coach"] as Record<string, unknown>,
    );
  }
  return cachedCoachConfig;
}
