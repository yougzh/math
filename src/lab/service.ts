/**
 * 数学实验室 —— `backend/lab/service.py` 的 TypeScript 移植。
 *
 * 三条设计约束（照抄 Python 模块头）：
 *   1. **不计入熟练度**。返回结构里没有 answer，也没有 attempt ——
 *      实验室故意不产生学习事件。孩子在这里"玩"，不在"考"。
 *   2. **前几个实验没有门槛**。unlock 为 null 的实验对所有孩子开放。
 *   3. **解锁靠能力等级，不靠年级/天数**（ADR-0002 的延伸）。
 *
 * 配置读取与 Python 不同源：Python 运行时读 `config/lab/v{N}.yaml`，
 * TS 运行时只读构建产物 `src/generated/config.json` 的 `lab` 段
 * （serverless 上运行时读 YAML 会因 cwd/文件追踪问题静默失败，
 * 见 `src/engine/config.ts` 模块头的同一决策）。build-content.ts
 * 已经把 `config/lab/*.yaml` 编进产物，两边内容逐字一致。
 */
import generatedConfig from "../generated/config.json";

/** YAML/JSON 解析后的实验配置条目（键全部可选，与 Python 的 dict.get 语义对齐） */
export interface LabExperimentConfig {
  code?: string | null;
  name?: string | null;
  emoji?: string | null;
  description?: string | null;
  component?: string | null;
  unlock?: { competency?: string | null; min_level?: string | null } | null;
}

/** `level_of(competency_code) -> level 字符串`（由调用方用 deriveLevel 提供） */
export type LevelLookup = (competencyCode: string) => string;

export class LabConfig {
  readonly data: Record<string, unknown>;
  readonly version: number;

  constructor(data: Record<string, unknown>) {
    this.data = data;
    const version = data["version"];
    this.version = typeof version === "number" ? Math.trunc(version) : 0;
  }

  get experiments(): LabExperimentConfig[] {
    const value = this.data["experiments"];
    return Array.isArray(value) ? (value as LabExperimentConfig[]) : [];
  }
}

let cachedLabConfig: LabConfig | null = null;

/**
 * 对应 Python `load_lab_config(version=0)` 的 lru_cache —— 模块级缓存。
 * 构建产物只有一份 lab 配置（v0），请求其他版本是配置缺失，必须炸
 * （Python 侧是 FileNotFoundError，同样不静默）。
 */
export function loadLabConfig(version = 0): LabConfig {
  if (version !== 0) {
    throw new Error(`lab 配置只构建了 v0（请求了 v${version}）`);
  }
  if (cachedLabConfig === null) {
    cachedLabConfig = new LabConfig((generatedConfig as Record<string, unknown>)["lab"] as Record<string, unknown>);
  }
  return cachedLabConfig;
}

/**
 * `_meets`：等级达标判定。**等级名写错时宁可开着** —— 不要因为配置笔误
 * 把孩子锁在门外（Python 注释原话）。
 */
function meetsLevel(level: string, minLevel: string, levelOrder: string[]): boolean {
  if (!levelOrder.includes(level) || !levelOrder.includes(minLevel)) {
    return true;
  }
  return levelOrder.indexOf(level) >= levelOrder.indexOf(minLevel);
}

export function isUnlocked(
  experiment: LabExperimentConfig,
  levelOf: LevelLookup,
  levelOrder: string[],
): boolean {
  const unlock = experiment.unlock;
  // Python `if not unlock`：None / 空 dict 都算没有门槛
  if (!unlock || Object.keys(unlock).length === 0) {
    return true;
  }
  const competency = unlock.competency;
  if (!competency) {
    return true;
  }
  return meetsLevel(levelOf(competency), unlock.min_level ?? "understanding", levelOrder);
}

/** 返回契约 §7 里 `experiments` 的数组。 */
export function listExperiments(
  levelOf: LevelLookup,
  levelOrder: string[],
  config?: LabConfig,
): Record<string, unknown>[] {
  const labConfig = config ?? loadLabConfig(0);
  const out: Record<string, unknown>[] = [];
  for (const experiment of labConfig.experiments) {
    // Python `.get("name", .get("code"))`：键存在但值为 None 时返回 None
    // （而不是回落到 code）—— 照抄这个"键存在"语义。
    const name = (experiment.name !== undefined ? experiment.name : experiment.code) ?? null;
    out.push({
      code: experiment.code ?? null,
      name,
      emoji: experiment.emoji !== undefined ? experiment.emoji : "🧩",
      description: experiment.description !== undefined ? experiment.description : "",
      component: experiment.component !== undefined ? experiment.component : "",
      unlocked: isUnlocked(experiment, levelOf, levelOrder),
    });
  }
  return out;
}
