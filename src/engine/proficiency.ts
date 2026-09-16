/**
 * 熟练度纯函数 —— `backend/engine/proficiency.py` 的 TypeScript 移植。
 *
 * 约束（照抄 Python 的模块 docstring）：
 *   - 本模块是纯函数，不读数据库、不写日志、不依赖时间
 *   - 所有阈值来自 AlgorithmConfig（ADR-0002）
 *   - 时间使用 thinking_time（ADR-0003）
 *
 * ══ 三处**顺序敏感**，改动前先读这里 ══════════════════════════
 *
 * ① `updateSignals` 按 `SIGNAL_NAMES` 的**固定顺序**更新。
 *    这个顺序不只是遍历顺序：`signal_sample_counts` 的键按它插入，
 *    而 `Signals.toDict()` 会把它序列化成 JSON —— 键序会出现在
 *    `simulate.py` 的输出与 `routes_world` 的 payload 里。
 *    更要紧的是 `confidence` 走的是**另一条分支**，靠 `name === "confidence"`
 *    判断，所以"把 confidence 挪到别的信号前面"会改变哪些样本参与 EWMA。
 *
 * ② `confidence` 用**独立**的 alpha（`cfg.confidence_alpha`），
 *    不是 `cfg.alphaFor(is_assessment)`。这是刻意的：confidence 是长期趋势，
 *    不该被 probe 折扣影响，也不该跟掌握度一样快地响应单次作答。
 *    顺手"统一"成同一个 alpha 会让冷启动阶段的信心曲线整个变形。
 *
 * ③ probe 状态推进是**三段**，前两段互斥、第三段独立：
 *      - probe attempt → 按 `probe_items` 决定 probing / estimated
 *      - 非 probe 且当前是 unknown/probing → 样本够了就升 estimated
 *      - **无条件**：样本够了且还不是 stable → stable
 *    第三段的存在意味着一个 probe 刚把它设成 probing 的信号，
 *    如果 `sample_count` 已达标，会**在同一行里**立刻变成 stable。
 *    看起来像 bug，其实是 D5 的原样行为 —— 别合并这两段。
 *
 *    ⚠️ 由此推出一条**反直觉但已验证**的事实：第二段（`else if`）里的
 *    `estimated` 赋值是**不可观测的死代码**。理由：第二段的条件
 *    （`probe_status ∈ {unknown, probing}` **且** `sample_count >= min_samples_for_level`）
 *    整体蕴含第三段的条件（`sample_count >= min_samples_for_level` 且
 *    `probe_status != stable` —— 前半个 `∈ {unknown, probing}` 已经保证了不是 stable）。
 *    所以赋值成立的同一行里，第三段必然把 `estimated` 改写成 `stable`。
 *    穷举扫描（`min_samples_for_level ∈ {0,1,6,100}` × `sample_count ∈ {0,1,2}` ×
 *    四种 probe_status）确认两版输出恒等。
 *    照抄它，因为 S6 之后 fixture 是唯一权威；**但不要以为删掉它有影响** ——
 *    突变测试里那两条"存活"的变异就是这个事实的记录，
 *    它们不是断言漏洞，是这一段本来就观察不到。
 *
 *    （`elif` 里 `|| probe_status === PROBING` 那一半同理：它能区分的输入
 *    不存在，因为一旦条件成立，结果一定被第三段抹平。）
 */
import type { AlgorithmConfig } from "@/src/engine/config";
import {
  PROBE_STATUS_ESTIMATED,
  PROBE_STATUS_PROBING,
  PROBE_STATUS_STABLE,
  PROBE_STATUS_UNKNOWN,
  QualityBreakdown,
  SIGNAL_NAMES,
} from "@/src/engine/types";
import type { Attempt, SignalName, Signals } from "@/src/engine/types";
import { pyFormatFixed } from "@/src/py/pyvalue";

/**
 * 把 thinking_time 映射成 0~1 的流畅度因子。
 *
 * fluency 阈值按 (pattern, interaction_type) 区分 —— direct 题是秒级，
 * blocks 类操作题可以到几十秒，不能用一个标准套所有题型。
 *
 * 阈值 <= 0 时给 1.0（配置里写 0 等于"这道题不考流畅度"），
 * 而不是让除法炸成 Infinity 再被 `fluencyScoreForRatio` 的波段表吞掉。
 */
export function timeFactor(attempt: Attempt, cfg: AlgorithmConfig): number {
  const thresholdMs = cfg.fluencyThresholdMs(attempt.pattern_id, attempt.interaction_type);
  const thinking = attempt.telemetry.thinkingTimeMs;
  if (thresholdMs <= 0) return 1.0;
  return cfg.fluencyScoreForRatio(thinking / thresholdMs);
}

/**
 * 单次作答的证据质量。
 *
 * 注意 `quality` 是三个因子的**连乘**（accurate × independent × fast），
 * 任一项为 0 则 quality 为 0 —— 本函数没有消费者，它是给
 * `QualityBreakdown` 这个类型提供生产者的，也用于人工核对权重表。
 */
export function attemptQuality(attempt: Attempt, cfg: AlgorithmConfig): QualityBreakdown {
  const accuracy = attempt.correct ? 1.0 : 0.0;
  const independence = cfg.independenceSample(attempt.hints_used);
  const factor = timeFactor(attempt, cfg);
  return new QualityBreakdown({
    quality: accuracy * independence * factor,
    accuracy,
    independence,
    time_factor: factor,
  });
}

/**
 * 由一次作答生成各信号的单次采样值。
 *
 * 返回 `null` 表示"该信号本次不采样"，而不是"采样为 0"。
 * 这个区分很重要：没测过 ≠ 做得差。
 *
 * 返回 Map 而不是 plain object：这里的键序将来可能进序列化
 * （`simulate.py:981` 就在遍历它），Map 的插入序与 Python dict 一致。
 */
export function samplesForAttempt(
  attempt: Attempt,
  cfg: AlgorithmConfig,
): Map<SignalName, number | null> {
  const samples = new Map<SignalName, number | null>();

  // mastery：靠提示做对不算真正理解
  samples.set("mastery", cfg.masterySample(attempt.correct, attempt.hints_used));

  // accuracy：只看对错
  samples.set("accuracy", attempt.correct ? 1.0 : 0.0);

  // independence：只看提示使用量，与对错无关
  samples.set("independence", cfg.independenceSample(attempt.hints_used));

  // fluency：只有做对了才谈得上"流畅"；做错时的速度不是流畅度
  samples.set("fluency", attempt.correct ? timeFactor(attempt, cfg) : null);

  // transfer：只在 Planner 标记的迁移测试上采样
  samples.set(
    "transfer",
    attempt.is_transfer_probe ? (attempt.correct ? 1.0 : 0.0) : null,
  );

  // confidence：长期信心趋势（答错但仍在尝试本身是正向信号）
  samples.set("confidence", cfg.confidenceSample(attempt.correct));

  return samples;
}

/**
 * 首条证据直接作为初值，之后走 EWMA。
 *
 * 若首条证据也按 current=0 平滑，孩子的第一个正确答案只能得 0.25，
 * 会让冷启动阶段的状态严重低估。
 *
 * ⚠️ 判的是 `current === null`（"不知道该信号"），**不是** `current === 0`。
 * 一个已经被采样为 0 的信号（连续做错）必须继续走 EWMA ——
 * 用 `!current` 或 `?? sample` 都会让"一直做错"永远停在初值上。
 */
export function ewma(current: number | null, sample: number, alpha: number): number {
  if (current === null) return sample;
  return current + alpha * (sample - current);
}

/**
 * 返回更新后的 Signals（**不修改入参**，保证 replay 可重现）。
 *
 * "先 copy 再改"是这个函数的全部安全性所在：`Signals.copy()` 会深拷
 * `signal_sample_counts`，所以下面那个 `.set()` 改的是副本的 Map。
 * TS 里若改成 `{...signals}` 展开，`signal_sample_counts` 就是同一个引用，
 * 于是 `updateSignals` 会顺带改掉调用方的状态 —— 单测里有一条专门钉这个。
 */
export function updateSignals(
  signals: Signals,
  attempt: Attempt,
  cfg: AlgorithmConfig,
): Signals {
  const updated = signals.copy();
  updated.algorithm_version = cfg.version;

  const alpha = cfg.alphaFor(attempt.is_assessment);
  const samples = samplesForAttempt(attempt, cfg);

  for (const name of SIGNAL_NAMES) {
    const sample = samples.get(name);
    // Map 的 `.get()` 缺键给 undefined，Python 的 `.get()` 给 None —— 两者都跳过
    if (sample === null || sample === undefined) continue;

    if (name === "confidence") {
      // confidence 是长期趋势，用更慢的系数（见模块头 ②）
      const current = updated.confidence;
      updated.confidence =
        current === null ? sample : current + cfg.confidence_alpha * (sample - current);
    } else {
      // 这里不能写 `updated.value(name)`：`value()` 的入参类型含 confidence，
      // 于是 TS 无法排除"confidence 走 else 分支"的可能。下标访问是精确的，
      // 而且它天然跟着 `name` 的类型收窄走。
      updated[name] = ewma(updated[name], sample, alpha);
    }
    updated.signal_sample_counts.set(name, updated.sampleCountFor(name) + 1);
  }

  updated.sample_count += 1;
  if (attempt.is_assessment) {
    updated.assessment_samples += 1;
  }

  // 冷启动 probe 状态推进（D5）—— 三段，见模块头 ③
  if (attempt.is_assessment) {
    // 这个键只在 probe 分支里读：配置缺 `probe_items` 时，
    // 非 probe 的作答不该因此抛错（Python 的 `cfg.get` 无默认值会抛 KeyError）
    const probeItems = Math.trunc(Number(cfg.get(["assessment", "probe_items"])));
    updated.probe_status =
      updated.sample_count >= probeItems ? PROBE_STATUS_ESTIMATED : PROBE_STATUS_PROBING;
  } else if (
    updated.probe_status === PROBE_STATUS_UNKNOWN ||
    updated.probe_status === PROBE_STATUS_PROBING
  ) {
    if (updated.sample_count >= cfg.min_samples_for_level) {
      updated.probe_status = PROBE_STATUS_ESTIMATED;
    }
  }
  if (updated.sample_count >= cfg.min_samples_for_level && updated.probe_status !== PROBE_STATUS_STABLE) {
    updated.probe_status = PROBE_STATUS_STABLE;
  }

  return updated;
}

/**
 * 一行信号摘要，给诊断脚本与 demo 用。
 *
 * `—`（em dash）是"未采样"的显示形式，与 `0.00` 严格区分 ——
 * 报表里把"没测过"显示成 0 会让"还没学过"看起来像"学得很差"。
 */
export function signalSummary(signals: Signals): string {
  const parts: string[] = [];
  for (const name of SIGNAL_NAMES) {
    const value = signals.value(name);
    parts.push(`${name}=${value === null ? "—" : pyFormatFixed(value, 2)}`);
  }
  return parts.join(" ");
}
