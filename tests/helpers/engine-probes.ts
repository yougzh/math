/**
 * engine 画像对拍的**输入解释器**。
 *
 * 与 `scripts/oracle/dump_fixtures.py` 的 `_engine_attempt_from` /
 * `_engine_signals_from` 是同一份约定的两侧实现 —— 改一侧必须改另一侧。
 *
 * 为什么不让 fixture 直接存"构造好的对象"：fixture 只能装 JSON，
 * 而 `Attempt` / `Signals` 是带方法与深拷语义的类。所以 fixture 存的是
 * **声明式描述**，两侧各自解释。这里唯一容易出错的地方是"默认值补得不一样"：
 * Python 那边 `Attempt(**)` 靠 dataclass 的默认值，TS 这边靠构造函数里
 * `?? 默认值`。两边都照抄 `types.py`，但描述里没写的字段（`seq` /
 * `hint_level_max` / `method_used` …）在两侧必须落到同一个值 ——
 * 好在这些字段 `update_signals` 一个都不读，真的补错了也不会静默影响结果。
 */
import type { ErrorRule, Item } from "@/src/content/types";
import type { ReviewSchedule, ScheduleEntry } from "@/src/engine/scheduler";
import {
  Attempt,
  ChildLearningState,
  MisconceptionState,
  PROBE_STATUS_ESTIMATED,
  PROBE_STATUS_PROBING,
  PROBE_STATUS_STABLE,
  PROBE_STATUS_UNKNOWN,
  Signals,
  Telemetry,
} from "@/src/engine/types";
import type { ProbeStatus } from "@/src/engine/types";

export interface EngineAttemptDesc {
  id: string;
  competency: string;
  pattern: string;
  interaction: string;
  scaffold: string;
  correct: boolean;
  hints: number;
  response_ms: number;
  active_ms: number;
  idle_ms: number;
  is_assessment: boolean;
  is_transfer_probe: boolean;
}

export interface EngineSignalsDesc {
  mastery: number | null;
  accuracy: number | null;
  fluency: number | null;
  independence: number | null;
  transfer: number | null;
  confidence: number | null;
  sample_count: number;
  assessment_samples: number;
  signal_sample_counts: Record<string, number>;
  probe_status: string;
  algorithm_version: number;
}

const KNOWN_PROBE_STATUSES: readonly string[] = [
  PROBE_STATUS_UNKNOWN,
  PROBE_STATUS_PROBING,
  PROBE_STATUS_ESTIMATED,
  PROBE_STATUS_STABLE,
];

/**
 * fixture 里的 probe_status 是自由字符串（JSON 不认联合类型），
 * 进 TS 前必须收窄 —— 未知值要**炸**，不能静默当成 unknown：
 * 那会让一条写错的 fixture 变成"两侧都比 unknown，全绿"。
 */
export function asProbeStatus(value: string): ProbeStatus {
  if (!KNOWN_PROBE_STATUSES.includes(value)) {
    throw new Error(`fixture 里有未知的 probe_status：${JSON.stringify(value)}`);
  }
  return value as ProbeStatus;
}

export function attemptFromDesc(desc: EngineAttemptDesc): Attempt {
  return new Attempt({
    attempt_id: desc.id,
    child_id: "child_probe",
    item_id: `item_${desc.id}`,
    competency_id: desc.competency,
    pattern_id: desc.pattern,
    correct: desc.correct,
    telemetry: new Telemetry({
      response_time_ms: desc.response_ms,
      active_time_ms: desc.active_ms,
      idle_time_ms: desc.idle_ms,
    }),
    hints_used: desc.hints,
    scaffold_level: desc.scaffold,
    interaction_type: desc.interaction,
    is_assessment: desc.is_assessment,
    is_transfer_probe: desc.is_transfer_probe,
  });
}

export function signalsFromDesc(desc: EngineSignalsDesc): Signals {
  return new Signals({
    mastery: desc.mastery,
    accuracy: desc.accuracy,
    fluency: desc.fluency,
    independence: desc.independence,
    transfer: desc.transfer,
    confidence: desc.confidence,
    sample_count: desc.sample_count,
    assessment_samples: desc.assessment_samples,
    // 按 fixture 里的键序插入（Python 侧 dump 时是 sort_keys=True 排过序的），
    // 两侧因此拿到同一个 Map 键序
    signal_sample_counts: new Map(Object.entries(desc.signal_sample_counts)),
    probe_status: asProbeStatus(desc.probe_status),
    algorithm_version: desc.algorithm_version,
  });
}

/** 把 fixture 的 attempt 表编成 id → Attempt 的查表 */
export function attemptsById(descs: readonly EngineAttemptDesc[]): Map<string, Attempt> {
  const out = new Map<string, Attempt>();
  for (const desc of descs) {
    if (out.has(desc.id)) {
      throw new Error(`fixture 里有重复的 attempt id：${desc.id}`);
    }
    out.set(desc.id, attemptFromDesc(desc));
  }
  return out;
}

export interface EngineItemDesc {
  answer: unknown;
  error_rules: ErrorRule[];
}

/**
 * 只补 `diagnose` 真正读的两个字段（`answer` 与 `error_rules`），
 * 其余给一组固定的合法值 —— 它们不参与诊断，写死能避免 fixture 里
 * 塞一堆与对拍无关的字段。Python 侧的 `Item(...)` 构造点同源。
 */
export function itemFromDesc(desc: EngineItemDesc): Item {
  return {
    code: "item",
    competency_id: "make_ten",
    pattern_id: "direct_compute",
    difficulty: 3,
    scaffold_level: "direct",
    interaction_type: "number_pad",
    estimated_seconds: 6,
    problem: {},
    answer: desc.answer,
    steps: [],
    hint_chain: [],
    error_rules: desc.error_rules,
    steps_style: "guide",
  };
}

/** `diagnose` 的输入：正确性 + 提交答案 + 调用方挂的 codes + item（可为 null） */
export interface EngineDiagnoseDesc {
  id: string;
  note: string;
  correct: boolean;
  submitted: unknown;
  misconception_codes: string[];
  item: EngineItemDesc | null;
  expect: string[];
}

/** 用诊断描述造一个 Attempt —— 只有这四个字段影响 `diagnose` */
export function diagnoseAttemptFromDesc(desc: EngineDiagnoseDesc): Attempt {
  return new Attempt({
    attempt_id: `a_${desc.id}`,
    child_id: "child_probe",
    item_id: "item",
    competency_id: "make_ten",
    pattern_id: "direct_compute",
    correct: desc.correct,
    telemetry: new Telemetry({ response_time_ms: 5000, active_time_ms: 1000 }),
    submitted_answer: desc.submitted,
    misconception_codes: [...desc.misconception_codes],
  });
}

// ── scheduler ──────────────────────────────────────────────

/**
 * fixture 里的调度表 → `ReviewSchedule`（Map）。
 *
 * fixture 是 `sort_keys=True` 写的，所以**键序已经被排过**，不是 Python
 * 运行时的插入序 —— 于是 `existing_key_keeps_position` 那条想钉的"键位置"
 * 在 fixture 里已经丢失。键序语义改由 `tests/unit/engine-scheduler.test.ts`
 * 的直接单测钉（见那里的注释）。这里照 fixture 顺序装入，值比较不看键序。
 */
export function scheduleFromDesc(desc: Record<string, Record<string, unknown>>): ReviewSchedule {
  // `as unknown as` 是必要的：fixture 里的 entry **故意**可能是残缺的
  // （`partial_entry_from_db` 那条就是"DB 老数据少了几个键"的形态），
  // 而 `ScheduleEntry` 的字段声明是必填 —— 直接 `as` 会因"结构不重叠"被拒。
  // 残缺 entry 的读取路径由实现里的 `pyGet(entry, k, default)` 兜住。
  return new Map(
    Object.entries(desc).map(([key, entry]) => [key, entry as unknown as ScheduleEntry]),
  );
}

/**
 * fixture 的 `competencies` → `ChildLearningState`。
 *
 * 两种"不复习"的形态必须能被区分（Python 侧 `_engine_state_from` 同源）：
 *   - 键**不在**字典里 → 没有 Signals（`state.competencies.get()` 给 undefined）
 *   - 值为 `null`      → 有 Signals 但 mastery 未采样
 * 两者都返回 False，但走 `isReviewable` 里两个不同的分支 ——
 * 合并成一种写法（例如统一 `mastery ?? 0`）会让其中一条分支失去覆盖。
 */
export function stateFromCompetencies(desc: Record<string, number | null>): ChildLearningState {
  const competencies = new Map<string, Signals>();
  for (const [code, mastery] of Object.entries(desc)) {
    competencies.set(code, new Signals({ mastery }));
  }
  return new ChildLearningState({ child_id: "child_sched", competencies });
}

// ── state_machine ──────────────────────────────────────────

export interface EngineMiscDesc {
  code: string;
  hit_count?: number;
  last_seq?: number | null;
  resolved?: boolean;
  remediation_competency?: string | null;
}

/** fallback 只读 correct / hints_used / seq（+ competency 落在 Attempt 上） */
export interface EngineSmAttemptDesc {
  correct: boolean;
  seq?: number;
  hints_used?: number;
  competency?: string;
}

export interface EngineSmStateDesc {
  competencies?: Record<string, Partial<EngineSignalsDesc>>;
  patterns?: Record<string, Partial<EngineSignalsDesc>>;
  misconceptions?: EngineMiscDesc[];
  recent_attempts?: EngineSmAttemptDesc[];
  last_touched_seq?: Record<string, number>;
}

/**
 * state_machine 的声明式状态 → `ChildLearningState`。
 *
 * 与 Python 侧 `_sm_state_from` 同源。signals 描述允许**只写关心的字段**
 * —— fixture 里存的就是残缺描述（如 `{"sample_count": 3}`），缺的键按
 * `_signals_desc` 的同一套约定在这里补齐（缺省表必须与 Python 逐键一致：
 * 六信号 null、两个样本数 0、counts 空、probe unknown、version 0）。
 */
const SIGNALS_DESC_DEFAULTS = {
  mastery: null,
  accuracy: null,
  fluency: null,
  independence: null,
  transfer: null,
  confidence: null,
  sample_count: 0,
  assessment_samples: 0,
  signal_sample_counts: {},
  probe_status: "unknown",
  algorithm_version: 0,
} as const;

/** 残缺描述 → 完整描述（smStateFromDesc / learnerStateFromDesc 共用） */
function fullSignalsDesc(partial: Partial<EngineSignalsDesc>): EngineSignalsDesc {
  return { ...SIGNALS_DESC_DEFAULTS, ...partial };
}

export function smStateFromDesc(desc: EngineSmStateDesc): ChildLearningState {
  const state = new ChildLearningState({ child_id: "child_sm" });
  for (const [code, signals] of Object.entries(desc.competencies ?? {})) {
    state.competencies.set(code, signalsFromDesc(fullSignalsDesc(signals)));
  }
  for (const [key, signals] of Object.entries(desc.patterns ?? {})) {
    state.patterns.set(key, signalsFromDesc(fullSignalsDesc(signals)));
  }
  for (const misc of desc.misconceptions ?? []) {
    state.misconceptions.set(
      misc.code,
      new MisconceptionState({
        code: misc.code,
        hit_count: misc.hit_count ?? 0,
        last_seq: misc.last_seq === undefined ? null : misc.last_seq,
        resolved: misc.resolved ?? false,
        remediation_competency:
          misc.remediation_competency === undefined ? null : misc.remediation_competency,
      }),
    );
  }
  for (const row of desc.recent_attempts ?? []) {
    state.recent_attempts.push(
      new Attempt({
        attempt_id: `att_${row.seq ?? 0}`,
        child_id: "child_sm",
        item_id: "item",
        competency_id: row.competency ?? "make_ten",
        pattern_id: "direct_compute",
        correct: row.correct,
        telemetry: new Telemetry({ response_time_ms: 5000, active_time_ms: 1000 }),
        seq: row.seq ?? 0,
        hints_used: row.hints_used ?? 0,
      }),
    );
  }
  for (const [code, seq] of Object.entries(desc.last_touched_seq ?? {})) {
    state.last_touched_seq.set(code, seq);
  }
  return state;
}

// ── learner ────────────────────────────────────────────────

/** learner 段的 attempt 描述：在 engine 段之上加 seq / submitted / item_code */
export interface LearnerAttemptDesc {
  id: string;
  seq: number;
  competency?: string;
  pattern?: string;
  interaction?: string;
  scaffold?: string;
  correct?: boolean;
  hints?: number;
  response_ms?: number;
  active_ms?: number;
  idle_ms?: number;
  is_assessment?: boolean;
  is_transfer_probe?: boolean;
  submitted?: unknown;
  misconception_codes?: string[];
  item_code?: string;
}

/** 缺省值与 Python 侧 `_learner_attempt_from`（ENGINE_ATTEMPT_DEFAULTS）逐字段同源 */
export function learnerAttemptFromDesc(desc: LearnerAttemptDesc): Attempt {
  return new Attempt({
    attempt_id: desc.id,
    child_id: "child_learner",
    item_id: desc.item_code ?? "none",
    competency_id: desc.competency ?? "make_ten",
    pattern_id: desc.pattern ?? "decompose",
    correct: desc.correct ?? true,
    telemetry: new Telemetry({
      response_time_ms: desc.response_ms ?? 6000,
      active_time_ms: desc.active_ms ?? 1000,
      idle_time_ms: desc.idle_ms ?? 0,
    }),
    seq: desc.seq,
    hints_used: desc.hints ?? 0,
    scaffold_level: desc.scaffold ?? "direct",
    interaction_type: desc.interaction ?? "number_pad",
    is_assessment: desc.is_assessment ?? false,
    is_transfer_probe: desc.is_transfer_probe ?? false,
    submitted_answer: desc.submitted,
    misconception_codes: [...(desc.misconception_codes ?? [])],
  });
}

/** learner 段的初态描述：比 state_machine 的多四个账本（计数器 / first_scaffold 等） */
export interface LearnerStateDesc {
  competencies?: Record<string, Partial<EngineSignalsDesc>>;
  patterns?: Record<string, Partial<EngineSignalsDesc>>;
  misconceptions?: EngineMiscDesc[];
  attempts_seen?: number;
  assessment_attempts?: number;
  recent_attempt_ids?: string[];
  first_scaffold?: Record<string, string>;
  last_touched_seq?: Record<string, number>;
}

export function learnerStateFromDesc(
  desc: LearnerStateDesc,
  recentAttemptsById: Map<string, Attempt>,
): ChildLearningState {
  const state = new ChildLearningState({ child_id: "child_learner" });
  for (const [code, signals] of Object.entries(desc.competencies ?? {})) {
    state.competencies.set(code, signalsFromDesc(fullSignalsDesc(signals)));
  }
  for (const [key, signals] of Object.entries(desc.patterns ?? {})) {
    state.patterns.set(key, signalsFromDesc(fullSignalsDesc(signals)));
  }
  for (const misc of desc.misconceptions ?? []) {
    state.misconceptions.set(
      misc.code,
      new MisconceptionState({
        code: misc.code,
        hit_count: misc.hit_count ?? 0,
        last_seq: misc.last_seq === undefined ? null : misc.last_seq,
        resolved: misc.resolved ?? false,
        remediation_competency:
          misc.remediation_competency === undefined ? null : misc.remediation_competency,
      }),
    );
  }
  state.attempts_seen = desc.attempts_seen ?? 0;
  state.assessment_attempts = desc.assessment_attempts ?? 0;
  for (const id of desc.recent_attempt_ids ?? []) {
    const attempt = recentAttemptsById.get(id);
    if (attempt === undefined) {
      throw new Error(`初态引用了不存在的 recent attempt：${id}`);
    }
    state.recent_attempts.push(attempt);
  }
  for (const [code, scaffold] of Object.entries(desc.first_scaffold ?? {})) {
    state.first_scaffold.set(code, scaffold);
  }
  for (const [code, seq] of Object.entries(desc.last_touched_seq ?? {})) {
    state.last_touched_seq.set(code, seq);
  }
  return state;
}
