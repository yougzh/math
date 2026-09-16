/**
 * 熟练度状态机 —— `backend/engine/state_machine.py` 的 TypeScript 移植。
 *
 * ## 两个概念必须分开（本模块最重要的设计）
 *
 *   1. **等级（level）** —— 描述"孩子现在处于什么状态"，是**派生值**（ADR-0002）。
 *      未采样过的信号不参与判定，不因为"没测过"而卡住等级。
 *   2. **升级（upgrade）** —— 一个**严格门**：必须集齐全部证据才允许推进到
 *      下一个能力。缺任何一项都不升级。等级到了 ⭐ 也不等于自动升级。
 *
 * 混淆两者的后果：孩子被过早推向下一个知识点。
 *
 * ## 对拍要点（tests/acceptance/state-machine-parity.test.ts）
 *
 * `Decision.reasons` 是**逐字比对的契约**，不是给人随便看的日志：
 * Planner 要把它展示给家长端，对拍时顺序差一条就是红。所以这里
 * 每处 `reasons.push` 的先后都照抄 Python —— 连"同一次调用里可能同时
 * 出现哪几条"都由这个顺序决定。
 */

import type { AlgorithmConfig } from "@/src/engine/config";
import type { CompetencyGraph } from "@/src/engine/graph";
import { pyFormatFixed, pyGet } from "@/src/py/pyvalue";
import type { Attempt, ChildLearningState, SignalName } from "@/src/engine/types";
import { Decision, SIGNAL_NAMES } from "@/src/engine/types";
import type { Signals } from "@/src/engine/types";
import { patternKey } from "@/src/engine/types";

/** `level_thresholds` / `upgrade_requires` 里允许出现的信号名 */
const SIGNAL_NAME_SET = new Set<string>(SIGNAL_NAMES);

/**
 * 浮点比较容差：`value + EPS < threshold` 等价于「value 达到 threshold - EPS
 * 就算达标」。没有它，`accuracy = 0.90` 对阈值 `0.90` 会因为浮点表示
 * （0.9 实际是 0.90000000000000002…）判成不达标，看起来就像 bug。
 *
 * 加在 **value 侧**不是加在 threshold 侧：数学上 `v + e < t` 与
 * `v < t - e` 等价，但浮点下不完全一样 —— 照抄 Python 的形状，
 * 别"顺手等价变换"。
 */
const EPS = 1e-9;

/** `upgrade_requires` 里被检查的信号，**顺序就是 reasons 的出现顺序**（照抄 Python） */
const UPGRADE_SIGNAL_ORDER = ["accuracy", "mastery", "independence", "transfer", "fluency"] as const;

// ── 等级派生 ───────────────────────────────────────────────

function thresholdsSatisfied(signals: Signals, thresholds: Record<string, number>): boolean {
  for (const [name, threshold] of Object.entries(thresholds)) {
    // 配置里出现六个信号之外的键名时，Python 是 `getattr(self, name)` 直接
    // AttributeError —— 这里同样炸，不静默跳过：配置写错必须可见。
    if (!SIGNAL_NAME_SET.has(name)) {
      throw new Error(`level_thresholds 里有未知的信号名：${name}`);
    }
    const signalName = name as SignalName;
    if (!signals.isSampled(signalName)) {
      // 从未采样 → 该条件不参与判定（"没测过"不等于"不达标"）
      continue;
    }
    const value = signals.value(signalName);
    // isSampled 已保证不是 null；显式判一次是类型收窄，不是第二套语义
    if (value === null) continue;
    if (value + EPS < Number(threshold)) return false;
  }
  return true;
}

/**
 * 派生当前等级。
 *
 * ⚠️ 逐档往上试，**第一个不满足的就 break** —— Python 原样
 * （注释说"等级阈值是累积的"）。严格说这只是"从低到高找到第一个不满足的档"，
 * 并不要求各档阈值真的单调：哪怕配置把 `can_do` 配得比 `understanding` 松，
 * 行为也是"在 can_do 停下"。照抄，别改成 `取最后一个满足的档`。
 */
export function deriveLevel(signals: Signals, cfg: AlgorithmConfig): string {
  if (signals.sample_count < cfg.min_samples_for_level) {
    return cfg.level_order[0]!;
  }

  let best = cfg.level_order[0]!;
  for (const level of cfg.level_order.slice(1)) {
    if (thresholdsSatisfied(signals, cfg.levelThresholds(level))) {
      best = level;
    } else {
      break; // 等级阈值是累积的，一旦不满足就停止升级
    }
  }
  return best;
}

export function levelLabel(level: string, cfg: AlgorithmConfig): string {
  return cfg.levelLabel(level);
}

// ── 升级判定 ───────────────────────────────────────────────

export function countSuccessfulPatterns(
  state: ChildLearningState,
  competencyCode: string,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): number {
  const rule = cfg.newPatternSuccessRule();
  const minAccuracy = Number(pyGet(rule, "min_accuracy", 0.5));
  let count = 0;
  for (const pattern of graph.patternsFor(competencyCode)) {
    const signals = state.patterns.get(patternKey(competencyCode, pattern.code));
    if (signals === undefined || signals.sample_count < 1) continue;
    const accuracy = signals.accuracy;
    if (accuracy !== null && accuracy >= minAccuracy) count += 1;
  }
  return count;
}

export function isMastered(
  state: ChildLearningState,
  competencyCode: string,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): boolean {
  return upgradeDecision(state, competencyCode, graph, cfg).action === "upgrade";
}

/**
 * 严格门：全部条件 AND。任一项不满足都 hold，并给出可读原因。
 *
 * reasons 的**生成顺序**（照抄 Python，逐字对拍）：
 *   1. 只有探测题、没有正式练习样本（`assessment.blocks_upgrade` 开时）
 *   2. 正式练习样本不足
 *   3. 五个信号按 accuracy → mastery → independence → transfer → fluency
 *      （缺证据与不达标是**两种**原因文案）
 *   4. 前置能力未达标（按图里的 prerequisites 顺序，递归调用本函数）
 *   5. 成功过的 pattern 数不足
 */
export function upgradeDecision(
  state: ChildLearningState,
  competencyCode: string,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): Decision {
  const requires = cfg.upgradeRequires();
  const signals = state.competencies.get(competencyCode);
  const reasons: string[] = [];

  if (signals === undefined) {
    return new Decision({
      action: "hold",
      competency_id: competencyCode,
      reasons: ["还没有任何作答记录"],
    });
  }

  if (cfg.assessment_blocks_upgrade && signals.practiceSamples <= 0) {
    reasons.push("目前只有探测题，没有正式练习样本");
  }

  if (signals.practiceSamples < cfg.min_practice_samples) {
    reasons.push(
      `正式练习样本不足：${signals.practiceSamples} < ${cfg.min_practice_samples}`,
    );
  }

  for (const name of UPGRADE_SIGNAL_ORDER) {
    if (!Object.hasOwn(requires, name)) continue;
    const threshold = Number(requires[name]);
    const value = signals.value(name);
    if (value === null) {
      reasons.push(`${name} 尚无证据（需要专门采样）`);
    } else if (value + EPS < threshold) {
      reasons.push(`${name}=${pyFormatFixed(value, 4)} < ${pyFormatFixed(threshold, 4)}`);
    }
  }

  if (Boolean(pyGet(requires, "require_prerequisites", true))) {
    for (const prereq of graph.prerequisites(competencyCode)) {
      if (!isMastered(state, prereq, graph, cfg)) {
        reasons.push(`前置能力未达标：${prereq}`);
      }
    }
  }

  if (Boolean(pyGet(requires, "require_new_pattern_success", true))) {
    const rule = cfg.newPatternSuccessRule();
    const need = Math.trunc(Number(pyGet(rule, "min_patterns", 2)));
    const got = countSuccessfulPatterns(state, competencyCode, graph, cfg);
    if (got < need) {
      reasons.push(`成功过的 pattern 数不足：${got} < ${need}`);
    }
  }

  if (reasons.length > 0) {
    return new Decision({ action: "hold", competency_id: competencyCode, reasons });
  }
  return new Decision({
    action: "upgrade",
    competency_id: competencyCode,
    reasons: ["全部升级条件满足"],
  });
}

/**
 * 当前应该聚焦的能力。
 *
 * 优先返回"孩子最近落脚、且尚未达标"的能力 —— 否则冷启动时会把焦点放到
 * 孩子完全没接触过的能力上（例如明明在练 make_ten，却被指向 place_value）。
 *
 * 没有任何作答历史时，退回能力图入口（P3 会改由冷启动 Probe 定位入口）。
 *
 * 排序键 `(-seq, code)`：最近碰过的在前，同 seq 按 code 升序。
 * `last_touched_seq` 里有、但 `competencies` 里没有的 code 被跳过 ——
 * 理论上不该发生，防的是老数据。
 */
export function nextCompetency(
  state: ChildLearningState,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): string | null {
  const touched: Array<[number, string]> = [];
  for (const [code, seq] of state.last_touched_seq) {
    if (state.competencies.get(code) !== undefined) touched.push([seq, code]);
  }
  touched.sort((a, b) => {
    const bySeq = b[0] - a[0]; // -row[0] 升序 = seq 降序
    if (bySeq !== 0) return bySeq;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });

  for (const [, code] of touched) {
    if (!isMastered(state, code, graph, cfg)) return code;
  }

  return graph.nextUnmastered((code) => isMastered(state, code, graph, cfg));
}

// ── 回退判定 ───────────────────────────────────────────────

/** `recent_attempts` 尾部连续答错的长度（从最新往回数，遇到答对就停） */
function trailingWrongRun(attempts: readonly Attempt[]): number {
  let run = 0;
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    if (attempts[i]!.correct) break;
    run += 1;
  }
  return run;
}

function masteryScore(state: ChildLearningState): (code: string) => number {
  return (code: string) => {
    const signals = state.competencies.get(code);
    if (signals === undefined || signals.mastery === null) return 0.0;
    return signals.mastery;
  };
}

/**
 * 判断是否需要回退到前置能力。不需要回退时返回 action='hold'。
 *
 * 三个触发器（reasons 顺序照抄 Python）：
 *   1. 连续答错 ≥ `consecutive_wrong`
 *   2. 提示使用突增 ≥ `hint_spike_delta`（比较**最后两条**）
 *   3. 未解决的错误认知、且 remediation 指向**前置闭包**内的能力
 *      （还要求它足够"新"：`last_seq >= 最后一条作答的 seq - 1`）
 *
 * 回退目标的选择（这里有个刻意的不对称）：
 *   - 错误认知指名道姓（`remediation_competency`）→ 直接用它，**不再另算**
 *     最弱前置。熟练度是 EWMA、每天都在波动，另算出来的目标也每天在换
 *     （模拟实测：同一个孩子第 4 天退到不进位减法、第 5 天退到位值、
 *     第 6 天退到凑十、第 7 天退到 10 以内加法 —— 孩子等于每天换一个
 *     补习班，哪一个都学不下去）。
 *   - 没有错误认知指名 → 最弱前置（`graph.weakestPrerequisite`）。
 *   - 连前置都没有 → **hold**（"无可回退"），不是 fallback 到 null。
 */
export function fallbackDecision(
  state: ChildLearningState,
  currentCompetency: string,
  graph: CompetencyGraph,
  cfg: AlgorithmConfig,
): Decision {
  const triggers = cfg.fallbackTriggers();
  const reasons: string[] = [];
  const recent = [...state.recent_attempts];

  if (recent.length === 0) {
    return new Decision({
      action: "hold",
      competency_id: currentCompetency,
      reasons: ["没有近期作答"],
    });
  }

  const consecutiveWrong = Math.trunc(Number(pyGet(triggers, "consecutive_wrong", 3)));
  const run = trailingWrongRun(recent);
  if (run >= consecutiveWrong) {
    reasons.push(`连续答错 ${run} 次`);
  }

  const hintDelta = Math.trunc(Number(pyGet(triggers, "hint_spike_delta", 2)));
  if (recent.length >= 2) {
    const last = recent[recent.length - 1]!;
    const prev = recent[recent.length - 2]!;
    if (last.hints_used - prev.hints_used >= hintDelta) {
      reasons.push(`提示使用突然增加：${prev.hints_used} → ${last.hints_used}`);
    }
  }

  let misconceptionTarget: string | null = null;
  if (Boolean(pyGet(triggers, "misconception_prerequisite_trigger", true))) {
    const prereqClosure = new Set(graph.prerequisites(currentCompetency, true));
    for (const misc of state.misconceptions.values()) {
      if (misc.resolved || misc.last_seq === null) continue;
      if (misc.last_seq < recent[recent.length - 1]!.seq - 1) continue;
      // 只在错误认知指向前置能力时触发回退（None 指不了任何能力）
      if (misc.remediation_competency !== null && prereqClosure.has(misc.remediation_competency)) {
        misconceptionTarget = misc.remediation_competency;
        reasons.push(
          `近期命中错误认知：${misc.code}（指向前置能力 ${misc.remediation_competency}）`,
        );
        break;
      }
    }
  }

  if (reasons.length === 0) {
    return new Decision({
      action: "hold",
      competency_id: currentCompetency,
      reasons: ["未触发回退条件"],
    });
  }

  if (misconceptionTarget !== null) {
    return new Decision({
      action: "fallback",
      competency_id: currentCompetency,
      target_competency_id: misconceptionTarget,
      reasons: [...reasons, `回退目标：${misconceptionTarget}（错误认知指名的补习对象）`],
    });
  }

  const target = graph.weakestPrerequisite(currentCompetency, masteryScore(state));
  if (target === null) {
    return new Decision({
      action: "hold",
      competency_id: currentCompetency,
      reasons: [...reasons, "该能力没有前置能力可回退"],
    });
  }

  return new Decision({
    action: "fallback",
    competency_id: currentCompetency,
    target_competency_id: target,
    reasons: [...reasons, `回退目标：${target}（前置能力中最薄弱）`],
  });
}
