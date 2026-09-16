/**
 * scheduler 的合成数据单测 —— 专门钉**对拍 fixture 到不了**的那些点。
 *
 * 分三类：
 *
 * ① **fixture 装不下的信息**：`sort_keys=True` 把键序洗掉了，
 *    所以"已存在的键在更新后保持原位置"这条只能在这里断言。
 *
 * ② **真实配置到不了的容错分支**：`_interval_days` 里的 `max(0, ...)`
 *    要 entry 的 `consecutive_correct` 是**负数**才会生效 —— 那是 DB 被写坏的
 *    形态，正常跑永远不会出现。
 *
 * ③ **Python 侧本来就有的不对称**：`update_schedule` 里 `last_correct_day`
 *    存的是 `day` 的**原值**，`due_day` 存的是 `int(day) + N`。day 为小数时
 *    两者不一致 —— 看起来像笔误，实为 Python 原样行为，别"顺手对齐"。
 */
import { describe, expect, it } from "vitest";

import { AlgorithmConfig } from "@/src/engine/config";
import {
  dueReviews,
  newSchedule,
  nextReviewDay,
  pendingReviews,
  releasePressure,
  updateSchedule,
} from "@/src/engine/scheduler";
import type { ReviewSchedule, ScheduleEntry } from "@/src/engine/scheduler";
import { Attempt, ChildLearningState, Signals, Telemetry } from "@/src/engine/types";

/** 一份能跑通 scheduler 全部读配置路径的最小配置（值都是 v0 的） */
function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 0,
    review: { min_mastery: 0.6, max_per_day: 3 },
    review_intervals_days: [1, 3, 7, 14, 30],
    ...overrides,
  };
}

const cfg = new AlgorithmConfig(rawConfig());

function makeAttempt(
  overrides: Partial<ConstructorParameters<typeof Attempt>[0]> = {},
): Attempt {
  return new Attempt({
    attempt_id: "att_1",
    child_id: "c1",
    item_id: "it_1",
    competency_id: "make_ten",
    pattern_id: "decompose",
    correct: true,
    telemetry: new Telemetry({ response_time_ms: 5000, active_time_ms: 1000 }),
    ...overrides,
  });
}

/**
 * 造一张调度表。入参刻意收成 `Partial<ScheduleEntry>` ——
 * "entry 只带部分键"（DB 老数据）是这组测试要覆盖的**正常形态**，
 * 不是需要绕开的类型错误。
 */
function scheduleOf(desc: Record<string, Partial<ScheduleEntry>>): ReviewSchedule {
  return new Map(Object.entries(desc).map(([k, v]) => [k, { ...v } as ScheduleEntry]));
}

function stateWith(masteryByCode: Record<string, number | null>): ChildLearningState {
  const competencies = new Map<string, Signals>();
  for (const [code, mastery] of Object.entries(masteryByCode)) {
    competencies.set(code, new Signals({ mastery }));
  }
  return new ChildLearningState({ child_id: "c1", competencies });
}

// ══════════════════════════════════════════════════════════
describe("updateSchedule —— 键序（fixture 因 sort_keys 钉不住）", () => {
  it("已存在的键**保持原位置**，不因赋值被移到末尾", () => {
    const schedule = scheduleOf({
      "make_ten::number_friends": { interval_index: 0, due_day: 5 },
      "make_ten::decompose": { interval_index: 0, due_day: 5 },
    });
    expect([...schedule.keys()]).toEqual(["make_ten::number_friends", "make_ten::decompose"]);

    const out = updateSchedule(schedule, makeAttempt(), 5, cfg);

    // Python 的 `d[k] = v` 不移动已有键 → decompose 仍在第二位
    expect([...out.keys()]).toEqual(["make_ten::number_friends", "make_ten::decompose"]);
    // 而值确实被更新了（不是"键序对了但根本没写进去"）
    expect(out.get("make_ten::decompose")!.consecutive_correct).toBe(1);
  });

  it("新键**追加到末尾**（不是插到前面，也不是按字典序插入）", () => {
    const schedule = scheduleOf({ "make_ten::decompose": { interval_index: 0, due_day: 5 } });
    const out = updateSchedule(
      schedule,
      makeAttempt({ competency_id: "carry_add", pattern_id: "carry_exchange" }),
      5,
      cfg,
    );
    expect([...out.keys()]).toEqual(["make_ten::decompose", "carry_add::carry_exchange"]);
  });

  it("连续更新同一个键，位置一直不变（不是「第一次不动、第二次动」）", () => {
    let schedule = scheduleOf({
      "a::x": { interval_index: 0, due_day: 1 },
      "b::y": { interval_index: 0, due_day: 1 },
      "c::z": { interval_index: 0, due_day: 1 },
    });
    for (let day = 1; day <= 5; day += 1) {
      schedule = updateSchedule(
        schedule,
        makeAttempt({ competency_id: "b", pattern_id: "y" }),
        day,
        cfg,
      );
      expect([...schedule.keys()], `第 ${day} 天`).toEqual(["a::x", "b::y", "c::z"]);
    }
  });

  it("用 plain object 装这张表会**静默重排整数样式的键** —— 所以必须是 Map", () => {
    // 这条不是测实现，是把"为什么不用 object"钉成可执行的证据
    const asObject: Record<string, number> = {};
    for (const key of ["10", "2", "b"]) asObject[key] = 1;
    expect(Object.keys(asObject)).toEqual(["2", "10", "b"]); // 整数键被提前

    const asMap = new Map<string, number>([["10", 1], ["2", 1], ["b", 1]]);
    expect([...asMap.keys()]).toEqual(["10", "2", "b"]); // 与 Python dict 一致
  });
});

// ══════════════════════════════════════════════════════════
describe("updateSchedule —— 合成数据才到得了的分支", () => {
  it("newSchedule() 是空表（不是 undefined，也不是共享单例）", () => {
    const a = newSchedule();
    const b = newSchedule();
    expect(a.size).toBe(0);
    expect(a).not.toBe(b);
    // 改一份不影响另一份
    a.set("x::y", { interval_index: 0, consecutive_correct: 0, last_correct_day: null, due_day: 1 });
    expect(b.size).toBe(0);
  });

  it("DB 里 consecutive_correct 是**小数**时先截断再加一（Python 的 `int(x) + 1`）", () => {
    // 只可能来自被写坏的历史数据或手改的测试夹具
    const broken = scheduleOf({ "make_ten::decompose": { consecutive_correct: 0.5, due_day: 1 } });
    const out = updateSchedule(broken, makeAttempt(), 7, cfg);
    const entry = out.get("make_ten::decompose")!;
    // int(0.5) + 1 = 1（不是 0.5 + 1 = 1.5）
    expect(entry.consecutive_correct).toBe(1);
    expect(entry.interval_index).toBe(0);
    expect(entry.due_day).toBe(8);
  });

  it("DB 里 consecutive_correct 是**负数**时 interval_index 也跟着负 —— intervalDays 的 max(0,...) 就是给这个兜底的", () => {
    // 只可能来自被写坏的历史数据；正常路径下 streak >= 1
    const broken = scheduleOf({ "make_ten::decompose": { consecutive_correct: -5, due_day: 1 } });
    const out = updateSchedule(broken, makeAttempt(), 10, cfg);
    const entry = out.get("make_ten::decompose")!;

    expect(entry.consecutive_correct).toBe(-4);
    expect(entry.interval_index).toBe(-5); // min(-5, 4) —— 负数原样留下
    // intervalDays 把它夹回第 0 档 → 间隔 1 天，而不是 intervals[-5]（undefined → NaN）
    expect(entry.due_day).toBe(11);
  });

  it("interval_index 超出序列长度时封顶在最后一档（反向越界也兜住）", () => {
    const over = scheduleOf({ "make_ten::decompose": { consecutive_correct: 99, due_day: 1 } });
    const out = updateSchedule(over, makeAttempt(), 10, cfg);
    // streak = 100 → min(99, 4) = 4 → 间隔 30
    expect(out.get("make_ten::decompose")!.interval_index).toBe(4);
    expect(out.get("make_ten::decompose")!.due_day).toBe(40);
  });

  it("day 是小数：due_day 取整数部分相加，last_correct_day 存**原值**（Python 的不对称）", () => {
    const out = updateSchedule(newSchedule(), makeAttempt(), 5.75, cfg);
    const entry = out.get("make_ten::decompose")!;
    expect(entry.last_correct_day, "Python 是 `entry['last_correct_day'] = day`，不取整").toBe(5.75);
    expect(entry.due_day, "Python 是 `int(day) + N`").toBe(6);
  });

  it("day 是负数也一样：due_day 按截断后的天数算", () => {
    const out = updateSchedule(newSchedule(), makeAttempt(), -2.5, cfg);
    const entry = out.get("make_ten::decompose")!;
    expect(entry.last_correct_day).toBe(-2.5);
    // trunc(-2.5) = -2（不是 floor 的 -3），再加第 0 档间隔 1 → -1
    expect(entry.due_day).toBe(-1);
  });

  it("新 entry 的 last_correct_day 初始是 null，而不是今天的日期或 0", () => {
    const wrong = updateSchedule(newSchedule(), makeAttempt({ correct: false }), 7, cfg);
    const entry = wrong.get("make_ten::decompose")!;
    expect(entry.last_correct_day).toBeNull();
    expect(entry.consecutive_correct).toBe(0);
    expect(entry.interval_index).toBe(0);
    expect(entry.due_day).toBe(8);
  });

  it("答错时 last_correct_day 从 null 保持 null（不会被写成 day）", () => {
    const first = updateSchedule(newSchedule(), makeAttempt({ correct: false }), 7, cfg);
    const second = updateSchedule(first, makeAttempt({ correct: false }), 9, cfg);
    expect(second.get("make_ten::decompose")!.last_correct_day).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════
describe("pendingReviews —— 缺键的默认值", () => {
  it("entry 只有 due_day 时，其余三个字段走各自的默认值（0 / 0 / null）", () => {
    const items = pendingReviews(
      scheduleOf({ "make_ten::decompose": { due_day: 3 } }),
      10,
      stateWith({ make_ten: 0.9 }),
      cfg,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.interval_index).toBe(0);
    expect(items[0]!.consecutive_correct).toBe(0);
    expect(items[0]!.last_correct_day).toBeNull();
    expect(items[0]!.overdue_days).toBe(7);
  });

  it("due_day === day 也算到期（是 `>` 不是 `>=`）", () => {
    const state = stateWith({ make_ten: 0.9 });
    const at = (dueDay: number) =>
      pendingReviews(scheduleOf({ "make_ten::decompose": { due_day: dueDay } }), 10, state, cfg);
    expect(at(10), "今天到期").toHaveLength(1);
    expect(at(11), "明天到期").toHaveLength(0);
  });

  it("min_mastery 配成 0 时，「未采样」与「真的考了 0 分」必须分开（合成配置）", () => {
    // 真实配置 min_mastery = 0.6 时这条区分是**不可观测**的：
    //   - mastery = null 走 `null >= 0.6` 为假，去掉 null 守卫也一样；
    //   - mastery = 0 走 `0 >= 0.6` 为假，把 null 判断写成 `!mastery` 也一样。
    // 只有把阈值降到 0 才会露出两处守卫各自的职责 —— 而阈值是配置项，
    // 将来调参踩到这里时，"未采样 ≠ 零分"不能被静默抹平。
    const zeroCfg = new AlgorithmConfig(rawConfig({ review: { min_mastery: 0, max_per_day: 3 } }));
    const state = stateWith({ a: null, b: 0 });
    const items = pendingReviews(
      scheduleOf({ "a::x": { due_day: 1 }, "b::x": { due_day: 1 } }),
      10,
      state,
      zeroCfg,
    );
    // a 没采样 → 不进；b 真考了 0 分 → 进（0 >= 0）
    expect(items.map((r) => r.pattern_key)).toEqual(["b::x"]);
  });

  it("mastery 恰好等于 min_mastery 时进队列（是 `>=`）", () => {
    const day = 10;
    expect(pendingReviews(scheduleOf({ "a::x": { due_day: 1 } }), day, stateWith({ a: 0.6 }), cfg)).toHaveLength(1);
    expect(pendingReviews(scheduleOf({ "a::x": { due_day: 1 } }), day, stateWith({ a: 0.5999 }), cfg)).toHaveLength(0);
  });

  it("`state.competency()` 的惰性建键**不会**被这里触发（不建键 = 只读查询）", () => {
    const state = stateWith({ make_ten: 0.9 });
    pendingReviews(scheduleOf({ "carry_add::increase": { due_day: 1 } }), 10, state, cfg);
    // carry_add 在表里出现过，但 mastery 查不到 → 不该被顺手塞进 competencies
    expect(state.competencies.has("carry_add")).toBe(false);
    expect(state.competencies.size).toBe(1);
  });

  it("entry 里的数是小数时一律**先截断**再用（Python 的 int()）", () => {
    const schedule = scheduleOf({
      "make_ten::decompose": {
        due_day: 10.9, // → 10
        interval_index: 2.9, // → 2
        consecutive_correct: 3.7, // → 3
      },
    });
    const items = pendingReviews(schedule, 12, stateWith({ make_ten: 0.9 }), cfg);
    expect(items[0]!.due_day).toBe(10);
    expect(items[0]!.interval_index).toBe(2);
    expect(items[0]!.consecutive_correct).toBe(3);
    expect(items[0]!.overdue_days).toBe(2);
  });

  it("day 是小数时：`int(day) - int(due_day)` 算逾期，且到不到期用的是截断后的 due_day", () => {
    const state = stateWith({ make_ten: 0.9 });
    // 逾期 = trunc(12.75) - 10 = 2（不是 2.75）
    expect(
      pendingReviews(scheduleOf({ "make_ten::decompose": { due_day: 10 } }), 12.75, state, cfg)[0]!
        .overdue_days,
    ).toBe(2);
    // due 10.9 → 10 <= 10.5 → 到期
    expect(
      pendingReviews(scheduleOf({ "make_ten::decompose": { due_day: 10.9 } }), 10.5, state, cfg),
    ).toHaveLength(1);
    // due 11.5 → 11 > 10.5 → 不到期
    expect(
      pendingReviews(scheduleOf({ "make_ten::decompose": { due_day: 11.5 } }), 10.5, state, cfg),
    ).toHaveLength(0);
  });

  it("pattern_key 只按**第一个** `::` 切（pattern 里再有 `::` 不会切碎）", () => {
    const items = pendingReviews(
      scheduleOf({ "make_ten::a::b": { due_day: 1 } }),
      10,
      stateWith({ make_ten: 0.9 }),
      cfg,
    );
    expect(items[0]!.competency_id).toBe("make_ten");
    expect(items[0]!.pattern_id).toBe("a::b");
  });

  it("没有 `::` 的键：competency 是整个键、pattern 是空串", () => {
    const items = pendingReviews(
      scheduleOf({ "make_ten": { due_day: 1 } }),
      10,
      stateWith({ make_ten: 0.9 }),
      cfg,
    );
    expect(items[0]!.competency_id).toBe("make_ten");
    expect(items[0]!.pattern_id).toBe("");
  });

  it("排序是全序：逾期相同时按 pattern_key，且结果与输入插入序无关", () => {
    const state = stateWith({ a: 0.9, b: 0.9, c: 0.9 });
    const forward = pendingReviews(
      scheduleOf({ "a::x": { due_day: 5 }, "b::x": { due_day: 5 }, "c::x": { due_day: 5 } }),
      10,
      state,
      cfg,
    );
    const backward = pendingReviews(
      scheduleOf({ "c::x": { due_day: 5 }, "b::x": { due_day: 5 }, "a::x": { due_day: 5 } }),
      10,
      state,
      cfg,
    );
    expect(forward.map((r) => r.pattern_key)).toEqual(["a::x", "b::x", "c::x"]);
    expect(backward.map((r) => r.pattern_key)).toEqual(["a::x", "b::x", "c::x"]);
  });
});

// ══════════════════════════════════════════════════════════
describe("releasePressure / dueReviews", () => {
  const items = (n: number) =>
    pendingReviews(
      scheduleOf(
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`make_ten::p${i}`, { due_day: 1 }])),
      ),
      10,
      stateWith({ make_ten: 0.9 }),
      cfg,
    );

  it("上限大于项数时原样全给（slice 越界不报错也不补 null）", () => {
    expect(releasePressure(items(2), cfg)).toHaveLength(2);
    const bigCfg = new AlgorithmConfig(rawConfig({ review: { min_mastery: 0.6, max_per_day: 100 } }));
    expect(releasePressure(items(2), bigCfg)).toHaveLength(2);
  });

  it("上限恰好等于项数时全给（边界不是「少于」）", () => {
    expect(releasePressure(items(3), cfg)).toHaveLength(3);
  });

  it("返回的是**新数组**（元素同引用）：改返回值不影响入参", () => {
    const source = items(3);
    const kept = releasePressure(source, cfg);
    expect(kept).not.toBe(source);
    expect(kept[0]).toBe(source[0]);
    kept.pop();
    expect(source).toHaveLength(3);
  });

  it("dueReviews 等价于「pending 再截断」（不是另走一遍查询）", () => {
    const schedule = scheduleOf({
      "make_ten::a": { due_day: 1 },
      "make_ten::b": { due_day: 2 },
      "make_ten::c": { due_day: 3 },
      "make_ten::d": { due_day: 4 },
    });
    const state = stateWith({ make_ten: 0.9 });
    expect(dueReviews(schedule, 10, state, cfg)).toStrictEqual(
      releasePressure(pendingReviews(schedule, 10, state, cfg), cfg),
    );
    expect(dueReviews(schedule, 10, state, cfg)).toHaveLength(3);
  });

  it("被压下去的项在表里**没被删**（次日以更大逾期重新出现）", () => {
    const schedule = scheduleOf({
      "make_ten::a": { due_day: 1 },
      "make_ten::b": { due_day: 2 },
      "make_ten::c": { due_day: 3 },
      "make_ten::d": { due_day: 4 },
    });
    const state = stateWith({ make_ten: 0.9 });
    const today = dueReviews(schedule, 10, state, cfg).map((r) => r.pattern_key);
    expect(today).not.toContain("make_ten::d");
    expect(schedule.size, "表的大小没变").toBe(4);
    // 次日 d 的逾期天数变大，但因为 a 也在变大，相对顺序不变 —— d 仍排最后
    const tomorrow = dueReviews(schedule, 11, state, cfg).map((r) => r.pattern_key);
    expect(tomorrow).toEqual(today);
    // 直到前三条被移出表，d 才会浮上来
    const pruned = scheduleOf({ "make_ten::d": { due_day: 4 } });
    expect(dueReviews(pruned, 11, state, cfg).map((r) => r.pattern_key)).toEqual(["make_ten::d"]);
  });
});

// ══════════════════════════════════════════════════════════
describe("nextReviewDay", () => {
  it("在表里 → 该 entry 的 due_day；不在表里 → null（不是 0、不是 undefined）", () => {
    const schedule = scheduleOf({ "a::x": { due_day: 17 } });
    expect(nextReviewDay(schedule, "a::x", cfg)).toBe(17);
    expect(nextReviewDay(schedule, "a::y", cfg)).toBeNull();
  });

  it("due_day 是小数时截断（Python 是 `int(...)`）", () => {
    expect(nextReviewDay(scheduleOf({ "a::x": { due_day: 17.9 } }), "a::x", cfg)).toBe(17);
  });

  it("空表 / 空字符串 key 都给 null", () => {
    expect(nextReviewDay(newSchedule(), "a::x", cfg)).toBeNull();
    expect(nextReviewDay(scheduleOf({ "a::x": { due_day: 3 } }), "", cfg)).toBeNull();
  });

  it("**与 pendingReviews 不同**：缺 due_day 给 0，不是给今天", () => {
    const schedule = scheduleOf({ "a::x": { interval_index: 1 } });
    expect(nextReviewDay(schedule, "a::x", cfg)).toBe(0);
    // 同一条 entry 走 pendingReviews：缺 due_day → 就当今天到期
    const state = stateWith({ a: 0.9 });
    expect(pendingReviews(schedule, 42, state, cfg)[0]!.due_day).toBe(42);
  });

  it("不改表、不建键", () => {
    const schedule = scheduleOf({ "a::x": { due_day: 3 } });
    nextReviewDay(schedule, "a::missing", cfg);
    expect(schedule.size).toBe(1);
    expect(schedule.has("a::missing")).toBe(false);
  });
});
