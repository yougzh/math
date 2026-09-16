/**
 * 算法配置 —— `backend/engine/config.py` 的 TypeScript 移植。
 *
 * ADR-0002 配套约束：
 *   - 阈值、权重、时间语义全部来自 config/algorithm/v{N}.yaml
 *   - 代码里禁止出现阈值字面量
 *   - 状态必须 pin 住自己是用哪个 version 算出来的
 *
 * ⚠️ 配置的读取面分成两半，别搞混：
 *   - **构建期**读 YAML（`scripts/build-content.ts` 用 `readYamlFile`），
 *     产物写进 `src/generated/config.json`；
 *   - **运行时**只读那份 JSON（本文件的 `loadConfig`）。
 *   运行时读 YAML 在 serverless 上会因 cwd/文件追踪问题静默失败。
 *
 * `AlgorithmConfig` 是**访问器不是字段容器**：Python 侧刻意不把 YAML 结构复制成
 * 一堆 dataclass 字段（配置演进速度远快于代码，硬编字段会让每次调参都要改代码）。
 * 移植时不要"顺手"改成 interface + 常量对象 —— 那会把这条设计反掉，
 * 而且 `get()` 的缺键语义（抛错 / 取默认）是有行为契约的。
 */
import type { ScaffoldLevel } from "@/src/content/types";
import { pyGet } from "@/src/py/pyvalue";
import generatedConfig from "../generated/config.json";

/** 派生等级的固定顺序（ADR-0002：等级是派生值，顺序本身是算法的一部分） */
const LEVEL_ORDER = ["encountering", "understanding", "can_do", "proficient", "automatic"] as const;
export type Level = (typeof LEVEL_ORDER)[number];

const LEVEL_LABELS: Record<string, string> = {
  encountering: "🌱 接触",
  understanding: "🌿 理解",
  can_do: "🌳 会做",
  proficient: "⭐ 熟练",
  automatic: "🔥 自动化",
};

export const SCAFFOLD_LEVELS: readonly ScaffoldLevel[] = ["blocks", "decompose", "direct"];

export type RawConfig = Record<string, unknown>;

/**
 * 配置路径取不到时的报错。
 *
 * Python 是 `raise KeyError("配置缺失: {}".format(".".join(path)))` ——
 * 这是一条**刻意保持**的行为：配置缺失必须炸，不能静默取 undefined，
 * 否则阈值会变成 NaN 并一路传播到熟练度里，最后只看到"等级算出来不对"。
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export class AlgorithmConfig {
  readonly raw: RawConfig;
  readonly version: number;

  constructor(raw: RawConfig) {
    this.raw = raw;
    const version = raw["version"];
    this.version =
      typeof version === "number" ? Math.trunc(version) : Number.parseInt(String(version), 10);
  }

  /** 逐层取值；任一层缺失即抛错（`section` 在 Python 里同样不吞缺键） */
  section(...path: string[]): unknown {
    let node: unknown = this.raw;
    for (const key of path) {
      node = (node as RawConfig)[key];
    }
    return node;
  }

  /**
   * Python 的 `get(*path, default=...)`。
   *
   * 语义要点（照抄）：
   *   - **没传 default** → 缺键抛错。这是默认行为，"取不到就用 0"是 bug 温床。
   *   - **传了 default**（哪怕是显式 `null`）→ 缺键返回它。
   *     所以判断"调用方给没给默认值"要看**参数个数**，不是看值是不是 undefined。
   *
   * 与 Python 的一处差异：Python 在路径中途撞到非 dict 时行为不一
   * （撞到 str 是子串判断，撞到 int 直接 TypeError）。这里统一按"缺失"处理 ——
   * 那种情况只可能来自配置结构本身写错，而写错时"抛配置缺失"比 TypeError 更好定位。
   */
  get(path: readonly string[], hasDefault = false, fallback?: unknown): unknown {
    let node: unknown = this.raw;
    for (const key of path) {
      if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
        if (hasDefault) return fallback;
        throw new ConfigError(`配置缺失: ${path.join(".")}`);
      }
      node = (node as RawConfig)[key];
    }
    return node;
  }

  /** 取不到就用默认值（等价 Python 的 `get(..., default=x)`） */
  getOr(path: readonly string[], fallback: unknown): unknown {
    return this.get(path, true, fallback);
  }

  // ── 平滑 ────────────────────────────────────────────
  get ewma_alpha(): number {
    return Number(this.get(["smoothing", "ewma_alpha"]));
  }

  get min_samples_for_level(): number {
    return Math.trunc(Number(this.get(["smoothing", "min_samples_for_level"])));
  }

  /** probe attempt 的权重折扣（D5：冷启动不影响正式判定） */
  alphaFor(isAssessment: boolean): number {
    let alpha = this.ewma_alpha;
    const weight = this.get(["assessment", "weight"], true, null);
    if (isAssessment && weight) {
      alpha *= Number(weight);
    }
    return alpha;
  }

  get assessment_blocks_upgrade(): boolean {
    return Boolean(this.get(["assessment", "blocks_upgrade"], true, true));
  }

  // ── 等级派生 ────────────────────────────────────────
  /** 顺序是权威，来自代码而不是配置：加一档要动的是算法，不是参数 */
  get level_order(): readonly string[] {
    return LEVEL_ORDER;
  }

  levelLabel(level: string): string {
    return LEVEL_LABELS[level] ?? level;
  }

  levelThresholds(level: string): Record<string, number> {
    return { ...(this.get(["level_thresholds", level], true, {}) as Record<string, number>) };
  }

  // ── 采样规则 ────────────────────────────────────────
  masterySample(correct: boolean, hintsUsed: number): number {
    if (!correct) return Number(this.get(["mastery_sampling", "incorrect"]));
    if (hintsUsed > 0) return Number(this.get(["mastery_sampling", "correct_with_hint"]));
    return Number(this.get(["mastery_sampling", "correct_without_hint"]));
  }

  independenceSample(hintsUsed: number): number {
    const penalty = Number(this.get(["independence_sampling", "hint_penalty"]));
    const floor = Number(this.get(["independence_sampling", "min_sample"]));
    return Math.max(floor, 1.0 - penalty * Math.max(0, hintsUsed));
  }

  fluencyScoreForRatio(ratio: number): number {
    const bands = this.get(["fluency_sampling", "ratio_scores"]) as Array<Record<string, unknown>>;
    for (const band of bands) {
      if (ratio <= Number(band["max_ratio"])) return Number(band["score"]);
    }
    return 0.0;
  }

  confidenceSample(correct: boolean): number {
    return Number(this.get(["confidence_sampling", correct ? "correct" : "incorrect"]));
  }

  get confidence_alpha(): number {
    return Number(this.get(["confidence_sampling", "alpha"]));
  }

  // ── 升级 / 回退 ─────────────────────────────────────
  upgradeRequires(): RawConfig {
    return { ...(this.get(["upgrade_requires"]) as RawConfig) };
  }

  /** 升级只认正式练习样本；probe attempt 不计入（D5） */
  get min_practice_samples(): number {
    const requires = this.get(["upgrade_requires"]) as RawConfig;
    return Math.trunc(
      Number(pyGet(requires, "min_practice_samples", pyGet(requires, "min_samples", 0))),
    );
  }

  newPatternSuccessRule(): RawConfig {
    return { ...(this.get(["upgrade_requires", "new_pattern_success"], true, {}) as RawConfig) };
  }

  fallbackTriggers(): RawConfig {
    return { ...(this.get(["fallback_triggers"]) as RawConfig) };
  }

  // ── 脚手架递退 ──────────────────────────────────────
  scaffoldForMastery(mastery: number | null): ScaffoldLevel {
    if (mastery === null) return SCAFFOLD_LEVELS[0]!;
    if (mastery < Number(this.get(["scaffold_fading", "blocks_below_mastery"]))) return "blocks";
    if (mastery < Number(this.get(["scaffold_fading", "decompose_below_mastery"]))) return "decompose";
    return "direct";
  }

  // ── 题目选择（ADR-0001：Selector 只决定"具体做哪一道"） ──
  /** 槽位没有显式声明 avoid_recent 时的缺省避重窗口 */
  defaultAvoidRecent(): number {
    return Math.trunc(Number(this.get(["selection", "default_avoid_recent"])));
  }

  /**
   * 避重窗口的下限（跨天不重复的硬约束）。
   *
   * 一天的计划是整批生成的：窗口只数"最近 N 次作答"，而当天最后几次作答
   * 会把整个窗口占满，核心训练槽昨天做的题根本不在窗口里 —— 这就是
   * "每天出同一道题"的机制。下限保证窗口至少覆盖一整天。
   */
  minAvoidRecent(): number {
    return Math.trunc(Number(this.get(["selection", "min_avoid_recent"])));
  }

  /** 相邻两次作答允许的难度上升档数上限（防止跳级） */
  maxDifficultyStepUp(): number {
    return Math.trunc(Number(this.get(["selection", "max_difficulty_step_up"])));
  }

  /**
   * 把熟练度映射成 slot 难度区间内的目标难度。
   *
   * mastery 为 null 表示"这个能力还没采到证据"，用配置里的 unknown_position
   * —— 默认贴着区间下限：没有证据时从最简单的开始。
   * slot 的 difficulty_min / difficulty_max 是权威边界，返回值保证落在这个闭区间内。
   *
   * 返回值不必是整数：Selector 取"离目标最近"的那道题即可，
   * 所以这里不做分档，也就不会出现跨级的难度跳变。
   */
  targetDifficulty(mastery: number | null, difficultyMin: number, difficultyMax: number): number {
    const low = Math.trunc(difficultyMin);
    const high = Math.trunc(difficultyMax);
    if (high <= low) return low;

    const conf = this.get(["selection", "difficulty_target"]) as RawConfig;
    let position: number;
    if (mastery === null) {
      position = Number(pyGet(conf, "unknown_position", 0.0));
    } else {
      const floor = Number(pyGet(conf, "mastery_floor", 0.0));
      const ceiling = Number(pyGet(conf, "mastery_ceiling", 1.0));
      if (ceiling <= floor) {
        position = mastery >= ceiling ? 1.0 : 0.0;
      } else {
        position = (mastery - floor) / (ceiling - floor);
      }
    }
    position = Math.max(0.0, Math.min(1.0, position));
    return low + position * (high - low);
  }

  // ── 时间语义（ADR-0003） ────────────────────────────
  get thinking_normal_max_ms(): number {
    return Math.trunc(Number(this.get(["time_semantics", "thinking_normal_max_ms"])));
  }

  get uncertain_max_ms(): number {
    return Math.trunc(Number(this.get(["time_semantics", "uncertain_max_ms"])));
  }

  get idle_dominated_ratio(): number {
    return Number(this.get(["time_semantics", "idle_dominated_ratio"], true, 0.5));
  }

  /** fluency 阈值必须按 (pattern, interaction_type) 区分 */
  fluencyThresholdMs(patternId: string, interactionType: string): number {
    const byPattern = this.get(["fluency_thresholds"], true, {}) as Record<string, RawConfig>;
    const row = pyGet(byPattern, patternId, {}) as RawConfig;
    // Python: `seconds = by_pattern.get(interaction_type)`；只有 None 才回退，
    // 所以这里要判 null/undefined 而不是用 pyGet（配了 0 秒也是有效值）
    let seconds: unknown = pyGet(row, interactionType, undefined);
    if (seconds === undefined || seconds === null) {
      const def = this.get(["fluency_thresholds", "default"], true, {}) as RawConfig;
      seconds = pyGet(def, interactionType, 20);
    }
    return Math.trunc(Number(seconds) * 1000);
  }

  // ── 复习间隔 ────────────────────────────────────────
  get review_intervals_days(): number[] {
    return [...(this.get(["review_intervals_days"]) as number[])];
  }

  // ── 每日计划 ────────────────────────────────────────
  dailyPlan(): RawConfig {
    return { ...(this.get(["daily_plan"]) as RawConfig) };
  }

  // ── 学习意图 ────────────────────────────────────────
  intentConfig(): RawConfig {
    return { ...(this.get(["intent"]) as RawConfig) };
  }

  // ── 历史窗口 ────────────────────────────────────────
  get recent_attempt_window(): number {
    return Math.trunc(Number(this.get(["history", "recent_attempt_window"], true, 20)));
  }

  // ── 通用错误规则（内容层未命中时的兜底诊断） ─────────
  genericErrorRules(): RawConfig[] {
    return [...(this.get(["generic_error_rules"], true, []) as RawConfig[])];
  }
}

// ── 载入 ───────────────────────────────────────────────────

const cache = new Map<number, AlgorithmConfig>();

/**
 * 取算法配置（进程内缓存）。
 *
 * 运行时读的是构建产物 `src/generated/config.json`，不是 `config/**\/*.yaml`。
 * serverless 上 cwd 与文件追踪都不可靠，读 YAML 会变成"本地能跑线上 500"。
 */
export function loadConfig(version = 0): AlgorithmConfig {
  const hit = cache.get(version);
  if (hit !== undefined) return hit;

  const bundle = generatedConfig as unknown as Record<string, RawConfig>;
  if (version !== 0) {
    // 产物里目前只有 v0（构建脚本按 CONFIG_VERSION 固定产出）。
    // 多版本配置进来时，产物结构要跟着改 —— 与其届时静默取错版本，不如现在炸。
    throw new Error(
      `src/generated/config.json 里没有算法配置 v${version}（只有 v0）—— ` +
        `要支持多版本得先改 scripts/build-content.ts 的产物结构`,
    );
  }
  const algorithm = bundle["algorithm"];
  if (algorithm === undefined) {
    throw new Error("src/generated/config.json 缺少 algorithm 段，请重跑 npm run build:content");
  }
  const config = new AlgorithmConfig(algorithm);
  cache.set(version, config);
  return config;
}

/** 仅供测试使用（对齐 Python 的 clear_cache） */
export function clearConfigCache(): void {
  cache.clear();
}

/**
 * 升级要求"至少几个不同 pattern 成功过"。
 *
 * 与 state_machine 判升级读**同一个**入口 —— 阈值因此不可能在两处各自漂移。
 * 配置里没写这个键时返回 null，由调用方跳过该检查，而不是退回硬编码值。
 *
 * 对应 `loader.py:430 _load_min_patterns`。Python 那边是函数内惰性 import
 * （backend.engine 反向依赖 backend.content，顶部 import 会埋循环导入地雷）；
 * ESM 的模块图没有这个问题，但这里仍然保留"只读一个键"的窄接口。
 */
export function minPatternsFromConfig(config: AlgorithmConfig): number | null {
  const value = config.newPatternSuccessRule()["min_patterns"];
  return value === undefined || value === null ? null : Math.trunc(Number(value));
}
