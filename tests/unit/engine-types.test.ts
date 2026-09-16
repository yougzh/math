/**
 * `src/engine/types.ts` 的**合成数据**单测。
 *
 * 为什么在对拍之外还要这一层
 * --------------------------
 * 后续模块（proficiency / diagnosis / scheduler / state_machine）的对拍会
 * 顺带走过 `Signals` 的不少方法，但它**天然覆盖不到**三类语义：
 *
 * ① **拷贝的深浅**。对拍比的是"更新之后的值"，入参有没有被顺带改掉，
 *    只有"改副本再看原对象"这种断言抓得住。TS 里最顺手的 `{...signals}`
 *    会让 `signal_sample_counts` 共享引用，而 `update_signals` 恰好是
 *    "拷一份、改副本"的写法 —— 改错了照样算出一样的结果，
 *    只是 `replay` 重跑第二遍时状态已经脏了。
 *
 * ② **字段与派生值的边界**。`thinking_time_ms` / `practice_samples` /
 *    `decided` 在 Python 里是 property（不在 `__dict__` 里），
 *    TS 里是 prototype 上的 getter。有人把它们改成普通字段，
 *    序列化输出就会多出键 —— 而对拍用的是 `to_dict()`，看不见这类漂移。
 *
 * ③ **零消费者的方法**。`is_clean_correct()` 与 `Decision.decided` 在
 *    Python 侧当前**没有任何调用点**，所以对拍/覆盖率都碰不到它们，
 *    只能靠这里的用例把语义钉住。
 *
 * 还有一条是纯 JS 陷阱：`submitted_answer` 是 `Optional[Any]`，
 * 构造函数里若写成 `init.submitted_answer ?? null`，那么提交答案 `0`
 * 会被**静默**变成 `null` —— 一个答了 0 的孩子在诊断里被当成"没提交"。
 */
import { describe, expect, it } from "vitest";

import {
  Attempt,
  ChildLearningState,
  Decision,
  LearningIntent,
  MisconceptionState,
  PROBE_STATUS_ESTIMATED,
  PROBE_STATUS_PROBING,
  PROBE_STATUS_STABLE,
  PROBE_STATUS_UNKNOWN,
  QualityBreakdown,
  SIGNAL_NAMES,
  Signals,
  Telemetry,
  patternKey,
  splitPatternKey,
} from "@/src/engine/types";

function telemetry(
  response: number,
  active: number,
  idle = 0,
): Telemetry {
  return new Telemetry({
    response_time_ms: response,
    active_time_ms: active,
    idle_time_ms: idle,
  });
}

function attempt(overrides: Partial<ConstructorParameters<typeof Attempt>[0]> = {}): Attempt {
  return new Attempt({
    attempt_id: "att_1",
    child_id: "c1",
    item_id: "it_1",
    competency_id: "make_ten",
    pattern_id: "decompose",
    correct: true,
    telemetry: telemetry(8000, 3000),
    ...overrides,
  });
}

// ══════════════════════════════════════════════════════════
describe("patternKey / splitPatternKey", () => {
  it("往返一致", () => {
    const key = patternKey("make_ten", "decompose");
    expect(key).toBe("make_ten::decompose");
    expect(splitPatternKey(key)).toEqual(["make_ten", "decompose"]);
  });

  it("只按**第一个** :: 切分（Python 的 str.partition 语义）", () => {
    // 写成 key.split("::") 会给出三个元素，pattern 被切碎
    expect(splitPatternKey("a::b::c")).toEqual(["a", "b::c"]);
    expect(splitPatternKey("a::b::c::d")).toEqual(["a", "b::c::d"]);
  });

  it("没有分隔符时第二段是空串，不是 null（partition 给 ('k', '', '')）", () => {
    expect(splitPatternKey("decompose")).toEqual(["decompose", ""]);
    expect(splitPatternKey("")).toEqual(["", ""]);
    // 以分隔符开头：Python 给 ('', '::', 'b') → pattern_id 是 "b"
    expect(splitPatternKey("::b")).toEqual(["", "b"]);
    // 只有分隔符：Python 给 ('', '::', '') → 两段都空
    expect(splitPatternKey("::")).toEqual(["", ""]);
  });

  it("键里带空段是合法的（不抛错）", () => {
    expect(patternKey("", "decompose")).toBe("::decompose");
    expect(splitPatternKey("::decompose")).toEqual(["", "decompose"]);
  });
});

// ══════════════════════════════════════════════════════════
describe("Telemetry", () => {
  it("idle_time_ms 默认为 0", () => {
    expect(telemetry(5000, 4000).idle_time_ms).toBe(0);
  });

  it("thinkingTimeMs = response - active - idle，负数夹到 0", () => {
    expect(telemetry(10000, 3000, 2000).thinkingTimeMs).toBe(5000);
    // 三者之和超过 response（时钟漂移 / 客户端算错）时给 0 而不是负数
    expect(telemetry(1000, 800, 900).thinkingTimeMs).toBe(0);
    // 恰好相等 → 0（max 的另一侧）
    expect(telemetry(1000, 600, 400).thinkingTimeMs).toBe(0);
  });

  it("idleRatio：response <= 0 时给 0，不做除法", () => {
    expect(telemetry(0, 0, 0).idleRatio()).toBe(0);
    // 负数 response 不能给负比率
    expect(telemetry(-100, 0, 50).idleRatio()).toBe(0);
    // 0.0 与 -0.0 都要认：`<= 0` 对两者都成立
    expect(telemetry(-0, 0, 0).idleRatio()).toBe(0);
  });

  it("idleRatio 是普通浮点除法", () => {
    expect(telemetry(10000, 0, 2500).idleRatio()).toBe(0.25);
    expect(telemetry(3, 0, 1).idleRatio()).toBeCloseTo(1 / 3, 12);
  });

  it("isIdleDominated 是**严格**大于阈值", () => {
    const t = telemetry(10000, 0, 3000); // ratio 0.3
    expect(t.isIdleDominated(0.3)).toBe(false);
    expect(t.isIdleDominated(0.29)).toBe(true);
  });

  it("thinking_time_ms 是派生值，不是字段（序列化时才出现）", () => {
    const t = telemetry(10000, 3000, 1000);
    // Python 的 property 同样不在 __dict__ 里：dataclasses.asdict() 也不含它
    expect(Object.keys(t)).toEqual(["response_time_ms", "active_time_ms", "idle_time_ms"]);
    expect(t.toDict()).toEqual({
      response_time_ms: 10000,
      active_time_ms: 3000,
      idle_time_ms: 1000,
      thinking_time_ms: 6000,
    });
  });
});

// ══════════════════════════════════════════════════════════
describe("Attempt", () => {
  it("默认值逐字段对齐 types.py", () => {
    const a = attempt();
    expect(a.seq).toBe(0);
    expect(a.hints_used).toBe(0);
    expect(a.hint_level_max).toBe(0);
    expect(a.method_used).toBeNull();
    expect(a.scaffold_level).toBe("direct");
    expect(a.interaction_type).toBe("number_pad");
    expect(a.is_assessment).toBe(false);
    expect(a.is_transfer_probe).toBe(false);
    expect(a.misconception_codes).toEqual([]);
    expect(a.submitted_answer).toBeNull();
    expect(a.created_at).toBeNull();
  });

  it("submitted_answer 的 falsy 值不被默认值吞掉（0 / false / \"\"）", () => {
    // `?? null` 会把 0 变成 null —— 答了 0 的孩子在诊断里成了"没提交"
    expect(attempt({ submitted_answer: 0 }).submitted_answer).toBe(0);
    expect(attempt({ submitted_answer: false }).submitted_answer).toBe(false);
    expect(attempt({ submitted_answer: "" }).submitted_answer).toBe("");
    expect(attempt({ submitted_answer: null }).submitted_answer).toBeNull();
    expect(attempt({ submitted_answer: [] }).submitted_answer).toEqual([]);
  });

  it("misconception_codes 每次构造都是新数组", () => {
    const a = attempt();
    const b = attempt();
    a.misconception_codes.push("carry_forgot");
    expect(b.misconception_codes).toEqual([]);
  });

  it("isCleanCorrect：做对且零提示", () => {
    expect(attempt({ correct: true, hints_used: 0 }).isCleanCorrect()).toBe(true);
    expect(attempt({ correct: true, hints_used: 1 }).isCleanCorrect()).toBe(false);
    expect(attempt({ correct: false, hints_used: 0 }).isCleanCorrect()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
describe("Signals", () => {
  it("空构造：六个信号全 null，计数为 0，probe_status 是 unknown", () => {
    const s = new Signals();
    for (const name of SIGNAL_NAMES) {
      expect(s.value(name), name).toBeNull();
      expect(s.isSampled(name), name).toBe(false);
      expect(s.sampleCountFor(name), name).toBe(0);
    }
    expect(s.sample_count).toBe(0);
    expect(s.assessment_samples).toBe(0);
    expect(s.signal_sample_counts.size).toBe(0);
    expect(s.probe_status).toBe(PROBE_STATUS_UNKNOWN);
    expect(s.algorithm_version).toBe(0);
  });

  it("显式传 null 与不传都得到 null（构造时不把 null 当 undefined）", () => {
    expect(new Signals({ mastery: null }).mastery).toBeNull();
    expect(new Signals({ mastery: undefined }).mastery).toBeNull();
    expect(new Signals({ mastery: 0 }).mastery).toBe(0);
  });

  it("practiceSamples = sample_count - assessment_samples，负数夹到 0", () => {
    expect(new Signals({ sample_count: 10, assessment_samples: 3 }).practiceSamples).toBe(7);
    expect(new Signals({ sample_count: 3, assessment_samples: 3 }).practiceSamples).toBe(0);
    // 数据不一致（探测数比总数还大）时给 0 而不是负数
    expect(new Signals({ sample_count: 1, assessment_samples: 5 }).practiceSamples).toBe(0);
  });

  it("sampleCountFor 缺键给 0（Python 的 .get(name, 0)），不是 null", () => {
    const s = new Signals({ signal_sample_counts: new Map([["mastery", 3]]) });
    expect(s.sampleCountFor("mastery")).toBe(3);
    expect(s.sampleCountFor("fluency")).toBe(0);
  });

  it("isSampled 看的是「值不是 None」，与计数无关", () => {
    // 采样数为 0 但值已写：Python 判的是 `getattr(...) is not None`
    const s = new Signals({ mastery: 0, signal_sample_counts: new Map() });
    expect(s.isSampled("mastery")).toBe(true);
    expect(s.sampleCountFor("mastery")).toBe(0);
  });

  it("copy() 深拷 signal_sample_counts —— 改副本不动原对象", () => {
    const original = new Signals({ signal_sample_counts: new Map([["mastery", 2]]) });
    const copy = original.copy();
    copy.signal_sample_counts.set("mastery", 99);
    copy.signal_sample_counts.set("fluency", 1);
    expect(original.sampleCountFor("mastery")).toBe(2);
    expect(original.signal_sample_counts.has("fluency")).toBe(false);

    // 同一个 map 引用就是那个静默 bug
    expect(copy.signal_sample_counts).not.toBe(original.signal_sample_counts);
  });

  it("copy() 逐字段拷贝（含 probe_status 与 algorithm_version）", () => {
    const original = new Signals({
      mastery: 0.5,
      accuracy: 1,
      fluency: null,
      independence: 0.25,
      transfer: null,
      confidence: 0.75,
      sample_count: 6,
      assessment_samples: 1,
      probe_status: PROBE_STATUS_STABLE,
      algorithm_version: 3,
    });
    const copy = original.copy();
    expect(copy).not.toBe(original);
    expect(copy.toDict()).toEqual(original.toDict());
    // 改副本的标量字段也不影响原对象（这是"值拷贝"而非"引用拷贝"）
    copy.mastery = 0.1;
    expect(original.mastery).toBe(0.5);
  });

  it("toDict 的键序 = SIGNAL_NAMES + 6 个字段（Python dict 保插入序）", () => {
    const s = new Signals({ mastery: 0.5, sample_count: 2 });
    expect(Object.keys(s.toDict())).toEqual([
      ...SIGNAL_NAMES,
      "sample_count",
      "assessment_samples",
      "practice_samples",
      "signal_sample_counts",
      "probe_status",
      "algorithm_version",
    ]);
  });

  it("toDict 里的 signal_sample_counts 是 plain object，保插入序", () => {
    const s = new Signals({
      mastery: 1,
      // 刻意让插入序不是字典序：fluency 先于 accuracy
      signal_sample_counts: new Map([
        ["fluency", 1],
        ["accuracy", 2],
        ["mastery", 3],
      ]),
    });
    const dict = s.toDict();
    expect(dict.signal_sample_counts).toEqual({ fluency: 1, accuracy: 2, mastery: 3 });
    expect(Object.keys(dict.signal_sample_counts)).toEqual(["fluency", "accuracy", "mastery"]);
    // 不是 Map 实例 —— 它要能直接进 JSON.stringify
    expect(dict.signal_sample_counts).not.toBeInstanceOf(Map);
  });

  it("toDict 里的 practice_samples 是派生值（不入 to_dict 之外的任何地方）", () => {
    const s = new Signals({ sample_count: 9, assessment_samples: 4 });
    expect(s.toDict().practice_samples).toBe(5);
    expect(Object.keys(s)).not.toContain("practice_samples");
  });
});

// ══════════════════════════════════════════════════════════
describe("MisconceptionState", () => {
  it("默认值", () => {
    const m = new MisconceptionState({ code: "carry_forgot" });
    expect(m.hit_count).toBe(0);
    expect(m.last_seq).toBeNull();
    expect(m.resolved).toBe(false);
    expect(m.remediation_competency).toBeNull();
  });

  it("last_seq 的 0 不被默认值吞掉", () => {
    expect(new MisconceptionState({ code: "x", last_seq: 0 }).last_seq).toBe(0);
  });

  it("copy() 是独立实例", () => {
    const m = new MisconceptionState({
      code: "carry_forgot",
      hit_count: 3,
      last_seq: 7,
      resolved: true,
      remediation_competency: "carry_add",
    });
    const copy = m.copy();
    expect(copy).not.toBe(m);
    expect(copy).toEqual(m);
    copy.hit_count = 99;
    expect(m.hit_count).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════
describe("ChildLearningState", () => {
  it("competency() 惰性建键 —— 有副作用，查一次就落一条", () => {
    const state = new ChildLearningState({ child_id: "c1" });
    expect(state.competencies.size).toBe(0);
    const signals = state.competency("make_ten");
    expect(state.competencies.size).toBe(1);
    // 同一个实例，不是每次新建
    expect(state.competency("make_ten")).toBe(signals);
    // 新建出来的是空 Signals
    expect(signals.sample_count).toBe(0);
    expect(signals.mastery).toBeNull();
  });

  it("pattern() 的键带上能力（ADR-0001 的迁移定义依赖这一点）", () => {
    const state = new ChildLearningState({ child_id: "c1" });
    const a = state.pattern("make_ten", "decompose");
    const b = state.pattern("td_add_nocarry", "decompose");
    expect(state.patterns.size).toBe(2);
    expect(a).not.toBe(b);
    expect([...state.patterns.keys()]).toEqual([
      "make_ten::decompose",
      "td_add_nocarry::decompose",
    ]);
  });

  it("patternSignals() 是**只读**的：查不到给 null 且不建键", () => {
    const state = new ChildLearningState({ child_id: "c1" });
    expect(state.patternSignals("make_ten", "decompose")).toBeNull();
    expect(state.patterns.size).toBe(0);
    state.pattern("make_ten", "decompose");
    expect(state.patternSignals("make_ten", "decompose")).toBeInstanceOf(Signals);
    expect(state.patterns.size).toBe(1);
  });

  it("copy() 深拷信号 Map —— 改副本的 Signals 不动原对象", () => {
    const state = new ChildLearningState({ child_id: "c1" });
    state.competency("make_ten").mastery = 0.5;
    state.pattern("make_ten", "decompose").mastery = 0.25;

    const copy = state.copy();
    copy.competencies.get("make_ten")!.mastery = 0.9;
    copy.patterns.get("make_ten::decompose")!.mastery = 0.9;

    expect(state.competencies.get("make_ten")!.mastery).toBe(0.5);
    expect(state.patterns.get("make_ten::decompose")!.mastery).toBe(0.25);
    // Map 本身也是新对象
    expect(copy.competencies).not.toBe(state.competencies);
    expect(copy.patterns).not.toBe(state.patterns);
  });

  it("copy() 深拷 misconception 值", () => {
    const state = new ChildLearningState({ child_id: "c1" });
    state.misconceptions.set("carry_forgot", new MisconceptionState({ code: "carry_forgot" }));
    const copy = state.copy();
    copy.misconceptions.get("carry_forgot")!.hit_count = 5;
    expect(state.misconceptions.get("carry_forgot")!.hit_count).toBe(0);
    expect(copy.misconceptions.get("carry_forgot")).not.toBe(
      state.misconceptions.get("carry_forgot"),
    );
  });

  it("copy() 对 recent_attempts 是**浅**拷：新数组、元素同引用", () => {
    const a = attempt();
    const state = new ChildLearningState({ child_id: "c1", recent_attempts: [a] });
    const copy = state.copy();
    expect(copy.recent_attempts).not.toBe(state.recent_attempts);
    // Attempt 是不可变的事实记录，不随状态一起拷
    expect(copy.recent_attempts[0]).toBe(a);
    copy.recent_attempts.push(attempt({ attempt_id: "att_2" }));
    expect(state.recent_attempts).toHaveLength(1);
  });

  it("copy() 深拷 first_scaffold / last_touched_seq", () => {
    const state = new ChildLearningState({
      child_id: "c1",
      first_scaffold: new Map([["make_ten", "blocks"]]),
      last_touched_seq: new Map([["make_ten", 3]]),
    });
    const copy = state.copy();
    copy.first_scaffold.set("make_ten", "direct");
    copy.last_touched_seq.set("make_ten", 99);
    expect(state.first_scaffold.get("make_ten")).toBe("blocks");
    expect(state.last_touched_seq.get("make_ten")).toBe(3);
  });

  it("copy() 保留标量字段", () => {
    const state = new ChildLearningState({
      child_id: "c1",
      attempts_seen: 12,
      assessment_attempts: 3,
    });
    const copy = state.copy();
    expect(copy.child_id).toBe("c1");
    expect(copy.attempts_seen).toBe(12);
    expect(copy.assessment_attempts).toBe(3);
  });

  it("默认容器是**每次新建**的（不是共享的模块级常量）", () => {
    const a = new ChildLearningState({ child_id: "c1" });
    const b = new ChildLearningState({ child_id: "c2" });
    a.competencies.set("make_ten", new Signals());
    a.recent_attempts.push(attempt());
    expect(b.competencies.size).toBe(0);
    expect(b.recent_attempts).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════
describe("LearningIntent", () => {
  it("默认值", () => {
    const intent = new LearningIntent({
      kind: "repair",
      competency_id: "make_ten",
      reason: "错得太快",
    });
    expect(intent.pattern_id).toBeNull();
    expect(intent.scaffold_level).toBeNull();
    expect(intent.target_seconds).toBe(60);
    expect(intent.priority).toBe(0);
  });

  it("priority 的 0 与 target_seconds 的 0 不被默认值吞掉", () => {
    const intent = new LearningIntent({
      kind: "probe_transfer",
      competency_id: "make_ten",
      reason: "r",
      priority: 0,
      target_seconds: 0,
    });
    expect(intent.priority).toBe(0);
    expect(intent.target_seconds).toBe(0);
  });

  it("kind 不收窄成联合类型 —— 取值分散在 intent / planner / detective", () => {
    // 编译期能通过就说明是 string；这条测试是"别把它收窄"的哨兵
    const unknownKind: string = "detective_balance";
    expect(new LearningIntent({ kind: unknownKind, competency_id: "c", reason: "r" }).kind).toBe(
      "detective_balance",
    );
  });
});

// ══════════════════════════════════════════════════════════
describe("Decision", () => {
  it("decided 只对 hold 为 false", () => {
    expect(new Decision({ action: "hold", competency_id: "c" }).decided).toBe(false);
    expect(new Decision({ action: "upgrade", competency_id: "c" }).decided).toBe(true);
    expect(new Decision({ action: "fallback", competency_id: "c" }).decided).toBe(true);
  });

  it("默认值：target_competency_id 为 null、reasons 为空数组", () => {
    const d = new Decision({ action: "hold", competency_id: "c" });
    expect(d.target_competency_id).toBeNull();
    expect(d.reasons).toEqual([]);
  });

  it("reasons 每次构造都是新数组", () => {
    const a = new Decision({ action: "hold", competency_id: "c" });
    const b = new Decision({ action: "hold", competency_id: "c" });
    a.reasons.push("没有近期作答");
    expect(b.reasons).toEqual([]);
  });

  it("decided 是派生值（不在字段里）", () => {
    expect(Object.keys(new Decision({ action: "upgrade", competency_id: "c" }))).toEqual([
      "action",
      "competency_id",
      "target_competency_id",
      "reasons",
    ]);
  });
});

// ══════════════════════════════════════════════════════════
describe("QualityBreakdown", () => {
  it("toDict 用 round(x, 4) 的 half-even，不是 toFixed 的「向大取」", () => {
    // 0.03125 = 1/32，double 精确。舍到 4 位恰好落在 0.0312 / 0.0313 的正中，
    // half-even 取末位偶数 → 0.0312；而 (0.03125).toFixed(4) 给 "0.0313"。
    const breakdown = new QualityBreakdown({
      quality: 0.03125,
      accuracy: 1,
      independence: 0.25,
      time_factor: 0.5,
    });
    expect(breakdown.toDict()).toEqual({
      quality: 0.0312,
      accuracy: 1,
      independence: 0.25,
      time_factor: 0.5,
    });
    expect((0.03125).toFixed(4)).toBe("0.0313"); // 记下分歧点本身
  });

  it("toDict 的键序固定", () => {
    const breakdown = new QualityBreakdown({
      quality: 0.5,
      accuracy: 1,
      independence: 0.5,
      time_factor: 0.5,
    });
    expect(Object.keys(breakdown.toDict())).toEqual([
      "quality",
      "accuracy",
      "independence",
      "time_factor",
    ]);
  });

  it("已经是 4 位以内小数的值原样返回", () => {
    const breakdown = new QualityBreakdown({
      quality: 0.1234,
      accuracy: 0,
      independence: 1,
      time_factor: 0.75,
    });
    expect(breakdown.toDict()).toEqual({
      quality: 0.1234,
      accuracy: 0,
      independence: 1,
      time_factor: 0.75,
    });
  });
});

// ══════════════════════════════════════════════════════════
describe("PROBE_STATUS 常量", () => {
  it("四个状态字面量与 Python 侧逐字一致", () => {
    // 值本身是对外契约（`routes_world` 的 payload、DB 的 Text 列），
    // 改动会让存量数据变成"未知状态"
    expect(PROBE_STATUS_UNKNOWN).toBe("unknown");
    expect(PROBE_STATUS_PROBING).toBe("probing");
    expect(PROBE_STATUS_ESTIMATED).toBe("estimated");
    expect(PROBE_STATUS_STABLE).toBe("stable");
  });

  it("四个值互不相同（别把常量写成同一个字面量）", () => {
    const all = [
      PROBE_STATUS_UNKNOWN,
      PROBE_STATUS_PROBING,
      PROBE_STATUS_ESTIMATED,
      PROBE_STATUS_STABLE,
    ];
    expect(new Set(all).size).toBe(4);
  });

  it("空 Signals 的默认状态是 unknown", () => {
    expect(new Signals().probe_status).toBe(PROBE_STATUS_UNKNOWN);
  });
});
