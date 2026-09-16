/**
 * 引擎领域类型 —— `backend/engine/types.py` 的 TypeScript 移植。
 *
 * 纯数据对象，不依赖数据库、不依赖框架。Replay 的确定性要求它们保持
 * 可比较、可序列化。
 *
 * ══ 三处**刻意的**设计决策，改之前先看理由 ══════════════════
 *
 * ① **用 class 而不是 interface**。
 *    这一层的 Python dataclass **带方法**（`copy()` / `to_dict()` / `value()`），
 *    而且 `Signals.copy()` 的深拷语义是**静默失败**的典型现场：
 *    TS 里最顺手的 `{...signals}` 会让副本与原对象共享同一个
 *    `signal_sample_counts`，于是"先拷后改"的调用点（`update_signals`）会
 *    悄悄改到入参 —— replay 的确定性就是这么丢的，而且不报任何错。
 *    内容层（`src/content/types.ts`）用 interface 是因为那边是纯字段容器，没有方法。
 *
 * ② **dict 一律用 `Map`**，不用 plain object。
 *    Python dict 的迭代顺序 = 插入顺序，而 JS 对象会**把整数样式的键提到最前**
 *    （`Object.keys({b:1, "2":1, "10":1})` 给 `["2","10","b"]`，Python 给
 *    `["10","2","b"]`）—— 这个坑已经在 S1-2c 的 lint 变异里踩过一次。
 *    Map 与 dict 的插入序语义逐字一致，且 `.get()` 的"缺键"与 Python 的
 *    "键不存在"一一对应。
 *
 * ③ **字段名一律 snake_case，方法名转 camelCase**。
 *    字段名要与 Python 逐字段对拍（`to_dict()` 的输出就是 snake_case 键），
 *    改名会让"字段对不上"和"移植漏了字段"混在一起。方法名不参与序列化，
 *    跟着项目其余 TS 代码走（`itemsFor` / `minPatternsFromConfig`）。
 *
 * ══ 已知差异（当前不可观测，S3 必须处理）══════════════════
 * `QualityBreakdown.toDict()` 用 `round(x, 4)`，Python 那侧返回的是 **float**，
 * `json.dumps` 会把 `2.0` 写成 `"2.0"`；TS 这侧 `pyRound` 返回 `2`，写出 `"2"`。
 * 数值相等、文本不同 —— fixture 走 JSON 时两边读进来都是 `2`，所以对拍无碍；
 * 但 S3 的 `_state_fingerprint` 比的是 `json.dumps(..., sort_keys=True)` 的**文本**，
 * 那里需要 pyjson 带上"这是不是一个整数值的 float"。见 `pyround.ts` 的模块头。
 */
import { pyRound } from "@/src/py/pyround";

// ── 信号 ──────────────────────────────────────────────────

/**
 * 五个原始信号 + confidence（长期趋势）。等级由它们派生（ADR-0002）。
 *
 * **顺序是算法的一部分**：`update_signals` 按这个顺序更新，
 * `signal_sample_counts` 的键因此按这个顺序插入 dict —— 序列化后可见。
 */
export const SIGNAL_NAMES = [
  "mastery",
  "accuracy",
  "fluency",
  "independence",
  "transfer",
  "confidence",
] as const;
export type SignalName = (typeof SIGNAL_NAMES)[number];

export const PROBE_STATUS_UNKNOWN = "unknown";
export const PROBE_STATUS_PROBING = "probing";
export const PROBE_STATUS_ESTIMATED = "estimated";
export const PROBE_STATUS_STABLE = "stable";

/**
 * 值域是**封闭**的（只在这四个常量之间流转，没有从 DB 读进来的自由字符串）。
 * 用联合类型而不是 `string`，这样 `"stabel"` 这类错字编译期就炸。
 */
export type ProbeStatus =
  | typeof PROBE_STATUS_UNKNOWN
  | typeof PROBE_STATUS_PROBING
  | typeof PROBE_STATUS_ESTIMATED
  | typeof PROBE_STATUS_STABLE;

// ── pattern 键 ────────────────────────────────────────────

/**
 * pattern 状态的键必须带上能力。
 *
 * `decompose` 用在 make_ten 上和用在 td_add_nocarry 上不是同一个技能；
 * 而"迁移"的定义恰恰是"同一能力、不同 pattern"。
 * 因此 pattern_state 的唯一键是 (child, competency, pattern)，不是 pattern 单独。
 */
export function patternKey(competencyId: string, patternId: string): string {
  return `${competencyId}::${patternId}`;
}

/**
 * `patternKey` 的逆运算 —— **只按第一个 `::` 切**。
 *
 * ⚠️ 不能写成 `key.split("::")`：Python 的 `str.partition` 只认第一个分隔符，
 * 而 competency / pattern 的 code 里理论上不含 `::`，真要是含了，
 * `split` 会把 pattern 切碎、`partition` 不会。行为差在"恶意或写错的内容"上，
 * 而那正是最不该静默吞掉的情形。
 *
 * 找不到分隔符时 Python 的 `partition` 给 `(key, "", "")`，
 * 于是 `pattern_id` 是**空串**而不是 None —— 照抄。
 */
export function splitPatternKey(key: string): [string, string] {
  const at = key.indexOf("::");
  if (at < 0) return [key, ""];
  return [key.slice(0, at), key.slice(at + 2)];
}

// ── 时间语义（ADR-0003，冻结）─────────────────────────────

export interface TelemetryInit {
  response_time_ms: number;
  active_time_ms: number;
  idle_time_ms?: number;
}

/**
 * 一次作答的时间分解。
 *
 * response  = 题目出现 → 提交答案
 * active    = 实际鼠标 / 触摸 / 键盘操作时间
 * idle      = 被判定为"疑似离开"的分段之和（> uncertain_max_ms 的停顿）
 * thinking  = response - active - idle
 *
 * 思考时间不是无效时间：短暂停顿属于 thinking，不剔除。
 */
export class Telemetry {
  response_time_ms: number;
  active_time_ms: number;
  idle_time_ms: number;

  constructor(init: TelemetryInit) {
    this.response_time_ms = init.response_time_ms;
    this.active_time_ms = init.active_time_ms;
    this.idle_time_ms = init.idle_time_ms ?? 0;
  }

  /**
   * 派生值，不是字段 —— 所以挂在 prototype 上（getter）。
   *
   * 这一点有实际后果：`{...telemetry}` 不会带上它，
   * `JSON.stringify(telemetry)` 也不会 —— 与 Python 的
   * `dataclasses.asdict()` 不给 property 的行为一致。
   * 要进序列化就显式走 `toDict()`。
   */
  get thinkingTimeMs(): number {
    return Math.max(0, this.response_time_ms - this.active_time_ms - this.idle_time_ms);
  }

  idleRatio(): number {
    if (this.response_time_ms <= 0) return 0.0;
    return this.idle_time_ms / this.response_time_ms;
  }

  isIdleDominated(ratioThreshold: number): boolean {
    return this.idleRatio() > ratioThreshold;
  }

  toDict(): {
    response_time_ms: number;
    active_time_ms: number;
    idle_time_ms: number;
    thinking_time_ms: number;
  } {
    return {
      response_time_ms: this.response_time_ms,
      active_time_ms: this.active_time_ms,
      idle_time_ms: this.idle_time_ms,
      thinking_time_ms: this.thinkingTimeMs,
    };
  }
}

// ── 事实入口 ──────────────────────────────────────────────

export interface AttemptInit {
  attempt_id: string;
  child_id: string;
  item_id: string;
  competency_id: string;
  pattern_id: string;
  correct: boolean;
  telemetry: Telemetry;
  seq?: number;
  hints_used?: number;
  hint_level_max?: number;
  method_used?: string | null;
  scaffold_level?: string;
  interaction_type?: string;
  is_assessment?: boolean;
  is_transfer_probe?: boolean;
  misconception_codes?: string[];
  submitted_answer?: unknown;
  created_at?: string | null;
}

/**
 * 学习系统唯一事实入口（ADR-0004）。
 *
 * `is_assessment`：冷启动 probe（D5），权重打折且不参与升级判定。
 * `is_transfer_probe`：由 Planner 标记的迁移测试，用于给 transfer 信号采样。
 *
 * `scaffold_level` 声明成 `string` 而不是内容层的 `ScaffoldLevel`：
 * Python 的 `types.py` 刻意**不 import** `content.loader`（引擎不该反向依赖内容），
 * 这里保持同样的边界，否则 S4 的运行时索引层要跟着卷进来。
 */
export class Attempt {
  attempt_id: string;
  child_id: string;
  item_id: string;
  competency_id: string;
  pattern_id: string;
  correct: boolean;
  telemetry: Telemetry;
  seq: number;
  hints_used: number;
  hint_level_max: number;
  method_used: string | null;
  scaffold_level: string;
  interaction_type: string;
  is_assessment: boolean;
  is_transfer_probe: boolean;
  misconception_codes: string[];
  /**
   * `Optional[Any]` —— 提交的答案形状随 interaction_type 变（数字 / 选项 / 数组）。
   * 用 `unknown` 而不是 `any`：消费点（diagnosis 的规则匹配）必须先收窄再用，
   * 而 `any` 会让"忘了收窄"静默通过。
   */
  submitted_answer: unknown;
  created_at: string | null;

  constructor(init: AttemptInit) {
    this.attempt_id = init.attempt_id;
    this.child_id = init.child_id;
    this.item_id = init.item_id;
    this.competency_id = init.competency_id;
    this.pattern_id = init.pattern_id;
    this.correct = init.correct;
    this.telemetry = init.telemetry;
    this.seq = init.seq ?? 0;
    this.hints_used = init.hints_used ?? 0;
    this.hint_level_max = init.hint_level_max ?? 0;
    this.method_used = init.method_used === undefined ? null : init.method_used;
    this.scaffold_level = init.scaffold_level ?? "direct";
    this.interaction_type = init.interaction_type ?? "number_pad";
    this.is_assessment = init.is_assessment ?? false;
    this.is_transfer_probe = init.is_transfer_probe ?? false;
    // 每次构造都给新数组 —— Python 的 default_factory 是逐次求值的，
    // 写成参数默认值 `init.misconception_codes ?? []` 也安全，
    // 但绝不能把 `[]` 提到模块级常量，那会让所有 Attempt 共享一个数组。
    this.misconception_codes = init.misconception_codes ?? [];
    this.submitted_answer =
      init.submitted_answer === undefined ? null : init.submitted_answer;
    this.created_at = init.created_at === undefined ? null : init.created_at;
  }

  isCleanCorrect(): boolean {
    return this.correct && this.hints_used === 0;
  }
}

// ── 熟练度状态 ────────────────────────────────────────────

export interface SignalsInit {
  mastery?: number | null;
  accuracy?: number | null;
  fluency?: number | null;
  independence?: number | null;
  transfer?: number | null;
  confidence?: number | null;
  sample_count?: number;
  assessment_samples?: number;
  signal_sample_counts?: Map<string, number>;
  probe_status?: ProbeStatus;
  algorithm_version?: number;
}

/** `Signals.toDict()` 的形状 —— 键序 = SIGNAL_NAMES 顺序 + 6 个字段 */
export interface SignalsDict {
  mastery: number | null;
  accuracy: number | null;
  fluency: number | null;
  independence: number | null;
  transfer: number | null;
  confidence: number | null;
  sample_count: number;
  assessment_samples: number;
  practice_samples: number;
  signal_sample_counts: Record<string, number>;
  probe_status: ProbeStatus;
  algorithm_version: number;
}

/**
 * 一个（孩子 × 能力）或（孩子 × pattern）的信号集合。
 *
 * 未采样过的信号保持 `null` —— 这是"不知道该信号"的显式表达，
 * 等级派生时该条件直接跳过，避免"没测过"被误当成"不达标"。
 *
 * ⚠️ 这个类**是可变的**（照抄 Python dataclass，没有 frozen）：
 * `update_signals` 会 `setattr`。但它的调用契约是"先 `copy()` 再改副本"，
 * 入参永远不被修改 —— 见 `proficiency.ts`。
 */
export class Signals {
  mastery: number | null;
  accuracy: number | null;
  fluency: number | null;
  independence: number | null;
  transfer: number | null;
  confidence: number | null;
  sample_count: number;
  assessment_samples: number;
  signal_sample_counts: Map<string, number>;
  probe_status: ProbeStatus;
  algorithm_version: number;

  constructor(init: SignalsInit = {}) {
    this.mastery = init.mastery === undefined ? null : init.mastery;
    this.accuracy = init.accuracy === undefined ? null : init.accuracy;
    this.fluency = init.fluency === undefined ? null : init.fluency;
    this.independence = init.independence === undefined ? null : init.independence;
    this.transfer = init.transfer === undefined ? null : init.transfer;
    this.confidence = init.confidence === undefined ? null : init.confidence;
    this.sample_count = init.sample_count ?? 0;
    this.assessment_samples = init.assessment_samples ?? 0;
    this.signal_sample_counts =
      init.signal_sample_counts === undefined ? new Map() : init.signal_sample_counts;
    this.probe_status = init.probe_status ?? PROBE_STATUS_UNKNOWN;
    this.algorithm_version = init.algorithm_version ?? 0;
  }

  /**
   * 正式练习样本数（不含冷启动 probe）。
   *
   * 升级判定只看 practice_samples —— 探测题可以估计初始状态，
   * 但不能直接产生"连续答对所以升级"。
   */
  get practiceSamples(): number {
    return Math.max(0, this.sample_count - this.assessment_samples);
  }

  /**
   * `getattr(self, name)` 的等价物。
   *
   * 参数收窄成 `SignalName` 而不是 `string`（Python 是 `str`）：所有调用点
   * 都在 `for name in SIGNAL_NAMES` 里或传字面量，收窄不损失任何表达力，
   * 却能把 `value("flueny")` 挡在编译期 —— 在 Python 那侧这是个
   * `getattr` 直接抛 AttributeError 的运行时错。
   */
  value(name: SignalName): number | null {
    return this[name];
  }

  isSampled(name: SignalName): boolean {
    return this[name] !== null;
  }

  sampleCountFor(name: SignalName): number {
    // Python 是 `.get(name, 0)` —— 缺键给 0，不是"未采样"
    return this.signal_sample_counts.get(name) ?? 0;
  }

  copy(): Signals {
    return new Signals({
      mastery: this.mastery,
      accuracy: this.accuracy,
      fluency: this.fluency,
      independence: this.independence,
      transfer: this.transfer,
      confidence: this.confidence,
      sample_count: this.sample_count,
      assessment_samples: this.assessment_samples,
      // `new Map(map)` 是逐条插入的浅拷 —— 键值是数字，等价于深拷。
      // 写成 `this.signal_sample_counts` 就是那个静默 bug（见模块头 ①）。
      signal_sample_counts: new Map(this.signal_sample_counts),
      probe_status: this.probe_status,
      algorithm_version: this.algorithm_version,
    });
  }

  /**
   * 键序 = `SIGNAL_NAMES` 顺序 + 6 个字段（Python dict 保插入序）。
   *
   * `_state_fingerprint` 那边用 `json.dumps(..., sort_keys=True)` 会重排键，
   * 所以键序**当前**不影响对拍；但 `routes_world` 的 payload 与
   * `tools/simulate.py` 的 JSON 输出都不排序，键序会出现在最终文本里。
   *
   * 六个信号写成显式字段而不是 `for (const name of SIGNAL_NAMES)` 循环：
   * 循环版要构造 `Record<string, unknown>` 再强转回 `SignalsDict`，
   * 而显式版让"少写一个字段"变成编译错误 —— 代价只是这里的顺序
   * 要与 `SIGNAL_NAMES` 手工对齐（`types` 单测钉住这一条）。
   */
  toDict(): SignalsDict {
    return {
      mastery: this.mastery,
      accuracy: this.accuracy,
      fluency: this.fluency,
      independence: this.independence,
      transfer: this.transfer,
      confidence: this.confidence,
      sample_count: this.sample_count,
      assessment_samples: this.assessment_samples,
      practice_samples: this.practiceSamples,
      // 转成 plain object 进 JSON。键是信号名（非整数样式），
      // 所以 Object.fromEntries 不会触发"整数键提前"那条 JS 规则。
      signal_sample_counts: Object.fromEntries(this.signal_sample_counts),
      probe_status: this.probe_status,
      algorithm_version: this.algorithm_version,
    };
  }
}

export interface MisconceptionStateInit {
  code: string;
  hit_count?: number;
  last_seq?: number | null;
  resolved?: boolean;
  remediation_competency?: string | null;
}

export class MisconceptionState {
  code: string;
  hit_count: number;
  last_seq: number | null;
  resolved: boolean;
  remediation_competency: string | null;

  constructor(init: MisconceptionStateInit) {
    this.code = init.code;
    this.hit_count = init.hit_count ?? 0;
    this.last_seq = init.last_seq === undefined ? null : init.last_seq;
    this.resolved = init.resolved ?? false;
    this.remediation_competency =
      init.remediation_competency === undefined ? null : init.remediation_competency;
  }

  copy(): MisconceptionState {
    return new MisconceptionState({
      code: this.code,
      hit_count: this.hit_count,
      last_seq: this.last_seq,
      resolved: this.resolved,
      remediation_competency: this.remediation_competency,
    });
  }
}

export interface ChildLearningStateInit {
  child_id: string;
  competencies?: Map<string, Signals>;
  patterns?: Map<string, Signals>;
  misconceptions?: Map<string, MisconceptionState>;
  attempts_seen?: number;
  assessment_attempts?: number;
  recent_attempts?: Attempt[];
  first_scaffold?: Map<string, string>;
  last_touched_seq?: Map<string, number>;
}

/**
 * 孩子的完整学习状态。
 *
 * 游戏状态不在这里 —— 游戏状态与学习状态分离，两者通过 attempt 连接。
 */
export class ChildLearningState {
  child_id: string;
  competencies: Map<string, Signals>;
  patterns: Map<string, Signals>;
  misconceptions: Map<string, MisconceptionState>;
  attempts_seen: number;
  assessment_attempts: number;
  recent_attempts: Attempt[];
  first_scaffold: Map<string, string>;
  last_touched_seq: Map<string, number>;

  constructor(init: ChildLearningStateInit) {
    this.child_id = init.child_id;
    this.competencies = init.competencies ?? new Map();
    this.patterns = init.patterns ?? new Map();
    this.misconceptions = init.misconceptions ?? new Map();
    this.attempts_seen = init.attempts_seen ?? 0;
    this.assessment_attempts = init.assessment_attempts ?? 0;
    this.recent_attempts = init.recent_attempts ?? [];
    this.first_scaffold = init.first_scaffold ?? new Map();
    this.last_touched_seq = init.last_touched_seq ?? new Map();
  }

  /**
   * ⚠️ **有副作用的"读"** —— 键不存在时会建一个空 Signals 塞进去。
   *
   * 这是 Python 的原样行为（`types.py:209-212`）。看起来像个查询，
   * 实际上会改 `this.competencies`：任何"只读地看一眼状态"的调用点
   * （例如渲染报表）用了它，就会给状态添上一条 `sample_count=0` 的记录，
   * 进而让 `_state_fingerprint` 多出一个键。
   *
   * 需要只读版本时用 `competencies.get(code) ?? new Signals()`（不落库），
   * 或者 `patternSignals()`。**别顺手把这个方法改成只读的** ——
   * `learner.py` 依赖"先建键再更新"。
   */
  competency(code: string): Signals {
    const existing = this.competencies.get(code);
    if (existing !== undefined) return existing;
    const created = new Signals();
    this.competencies.set(code, created);
    return created;
  }

  /** 同 `competency()`：有副作用，键按 `patternKey(competency, pattern)` 建 */
  pattern(competencyId: string, patternId: string): Signals {
    const key = patternKey(competencyId, patternId);
    const existing = this.patterns.get(key);
    if (existing !== undefined) return existing;
    const created = new Signals();
    this.patterns.set(key, created);
    return created;
  }

  /** 只读版：查不到给 `null`（Python 的 `.get(key)` 给 None），不建键 */
  patternSignals(competencyId: string, patternId: string): Signals | null {
    return this.patterns.get(patternKey(competencyId, patternId)) ?? null;
  }

  copy(): ChildLearningState {
    return new ChildLearningState({
      child_id: this.child_id,
      competencies: copySignalsMap(this.competencies),
      patterns: copySignalsMap(this.patterns),
      misconceptions: new Map(
        [...this.misconceptions].map(([code, misc]) => [code, misc.copy()] as const),
      ),
      attempts_seen: this.attempts_seen,
      assessment_attempts: this.assessment_attempts,
      // 浅拷列表：Attempt 是不可变的事实记录，不随状态一起拷
      recent_attempts: [...this.recent_attempts],
      first_scaffold: new Map(this.first_scaffold),
      last_touched_seq: new Map(this.last_touched_seq),
    });
  }
}

/** `{k: v.copy() for k, v in m.items()}` —— 值逐个 `copy()`，不是 `new Map(m)` */
function copySignalsMap(source: Map<string, Signals>): Map<string, Signals> {
  return new Map([...source].map(([key, signals]) => [key, signals.copy()] as const));
}

// ── 决策对象 ──────────────────────────────────────────────

export interface LearningIntentInit {
  kind: string;
  competency_id: string;
  reason: string;
  pattern_id?: string | null;
  scaffold_level?: string | null;
  target_seconds?: number;
  priority?: number;
}

/**
 * 学习意图 —— Planner 的输入单位，不是题目。
 *
 * `kind` 保持 `string` 而**不收窄成联合类型**：取值分散在 `intent.py`（warmup /
 * repair / probe_transfer / strengthen_fluency / teach）、`planner.py`（review /
 * story）与 `detective.py`（三个 KIND_* 常量，S3 才移植）四个模块里，
 * 是**开放**集合。收窄会让每次新增一种意图都要回来改这个文件，
 * 而改错的方向恰恰是"忘了加"—— 联合类型在开放集合上只会制造返工。
 */
export class LearningIntent {
  kind: string;
  competency_id: string;
  reason: string;
  pattern_id: string | null;
  scaffold_level: string | null;
  target_seconds: number;
  priority: number;

  constructor(init: LearningIntentInit) {
    this.kind = init.kind;
    this.competency_id = init.competency_id;
    this.reason = init.reason;
    this.pattern_id = init.pattern_id === undefined ? null : init.pattern_id;
    this.scaffold_level = init.scaffold_level === undefined ? null : init.scaffold_level;
    this.target_seconds = init.target_seconds ?? 60;
    this.priority = init.priority ?? 0;
  }
}

/** 值域**封闭**（只在 state_machine.py 里构造），所以收窄成联合类型 */
export type DecisionAction = "hold" | "upgrade" | "fallback";

export interface DecisionInit {
  action: DecisionAction;
  competency_id: string;
  target_competency_id?: string | null;
  reasons?: string[];
}

/** 升级 / 回退判定的结果，附带可解释的 reasons。 */
export class Decision {
  action: DecisionAction;
  competency_id: string;
  target_competency_id: string | null;
  reasons: string[];

  constructor(init: DecisionInit) {
    this.action = init.action;
    this.competency_id = init.competency_id;
    this.target_competency_id =
      init.target_competency_id === undefined ? null : init.target_competency_id;
    this.reasons = init.reasons ?? [];
  }

  get decided(): boolean {
    return this.action !== "hold";
  }
}

export interface QualityBreakdownInit {
  quality: number;
  accuracy: number;
  independence: number;
  time_factor: number;
}

/**
 * 单次作答的"证据质量"。
 *
 * 设计说明（与产品方案 §50 的一处有意偏离）：
 *   方案原式是 quality = accuracy × independence × time_factor × transfer_factor。
 *   实现时**去掉了 transfer_factor**，理由是：transfer 尚未被证明时该因子小于 1，
 *   会系统性地拖慢"最需要进步的那些孩子"的成长速度 —— 形成负反馈。
 *   transfer 因此作为独立信号单独采样（只在 transfer probe 上更新），
 *   不作为乘数惩罚常规练习。
 *
 * time_factor 使用 thinking_time（ADR-0003），不是 response_time。
 */
export class QualityBreakdown {
  quality: number;
  accuracy: number;
  independence: number;
  time_factor: number;

  constructor(init: QualityBreakdownInit) {
    this.quality = init.quality;
    this.accuracy = init.accuracy;
    this.independence = init.independence;
    this.time_factor = init.time_factor;
  }

  /**
   * `round(x, 4)` 是 Python 的 half-even，用 `pyRound` 而不是 `toFixed(4)`。
   *
   * `independence` 这类值直接来自配置的等距打分表（0.25 / 0.5 / 0.75 …），
   * 落在 half-way 上是常态，用 `toFixed` 会逐位偏大。
   */
  toDict(): {
    quality: number;
    accuracy: number;
    independence: number;
    time_factor: number;
  } {
    return {
      quality: pyRound(this.quality, 4),
      accuracy: pyRound(this.accuracy, 4),
      independence: pyRound(this.independence, 4),
      time_factor: pyRound(this.time_factor, 4),
    };
  }
}
