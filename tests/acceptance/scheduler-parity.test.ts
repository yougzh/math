/**
 * scheduler 对拍 —— TS 的间隔复习调度 vs Python 的黄金语料。
 *
 * `tests/oracle/fixtures/engine_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py engine` 产出（scheduler 段）。
 *
 * ## 与 proficiency / diagnosis 对拍的区别：比的是整张表
 *
 * 复习状态是一张普通 dict（要落进 `review_schedule` 表），所以这里不是比
 * "某个对象的字段"，而是比**整张表的序列化**：每条序列的每一步都把
 * `updateSchedule` 返回的整张表转成 plain object 再比。这样"忘了返回新表、
 * 改到入参"这种错误在第一步就会红（见下面的"不修改入参"断言）。
 *
 * ## fixture 装不下"键序"
 *
 * `dump_fixtures.py` 的 `_write` 用 `json.dump(..., sort_keys=True)`，
 * 所以 `existing_key_keeps_position` 那条想钉的"已存在的键保持原位置"
 * **在 fixture 里已经丢失**（写出去时被字典序重排了）。
 * 这条语义改由两张直接单测钉：
 *   1. `tests/unit/engine-scheduler.test.ts` 里对 `updateSchedule` 的直接断言；
 *   2. 本文件"fixture 自证"段里对 fixture **自己**的键序断言 ——
 *      证明它确实是排过序的，从而说明为什么不能靠它钉键序。
 *
 * ## 第二段（自证）比第三段（逐条）更要紧
 *
 * 沿用 S1-2c 的教训：如果 fixture 恰好只覆盖"一切正常"的路径，
 * 逐条对拍全绿而实现里 `min(streak-1, ...)` 的封顶被删掉也不会有人发现。
 * 所以自证段专钉：封顶、答错保留 `last_correct_day`、缺键的两个**不同**默认值、
 * mastery 的分界（0.59 / 0.60）、`max_per_day` 的截断。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AlgorithmConfig, loadConfig } from "@/src/engine/config";
import {
  dueReviews,
  newSchedule,
  nextReviewDay,
  pendingReviews,
  releasePressure,
  updateSchedule,
} from "@/src/engine/scheduler";
import type { ReviewItem, ReviewSchedule, ScheduleEntry } from "@/src/engine/scheduler";
import type { Attempt } from "@/src/engine/types";
import {
  attemptsById,
  scheduleFromDesc,
  stateFromCompetencies,
} from "../helpers/engine-probes";
import type { EngineAttemptDesc } from "../helpers/engine-probes";

type ScheduleDesc = Record<string, Record<string, unknown>>;

interface ScheduleStep {
  attempt: string;
  day: number;
}

interface ScheduleSequence {
  id: string;
  note: string;
  /** 初始调度表（可能是"老数据"形态：entry 只带部分键） */
  initial: ScheduleDesc;
  /** 输入步：每次作答用哪条 attempt、算第几天 */
  steps: ScheduleStep[];
  /** 结果表：跑完第 i 步之后的整张 schedule */
  results: ScheduleDesc[];
}

interface PendingCase {
  id: string;
  note: string;
  day: number;
  competencies: Record<string, number | null>;
  schedule: ScheduleDesc;
  expect: Record<string, unknown>[];
  kept: Record<string, unknown>[];
  due: Record<string, unknown>[];
}

interface NextReviewCase {
  id: string;
  schedule: ScheduleDesc;
  key: string;
  expect: number | null;
  actual: number | null;
}

interface SchedulerFixture {
  sequences: ScheduleSequence[];
  pending: PendingCase[];
  next_review_day: NextReviewCase[];
  max_per_day: number;
  min_mastery: number;
  intervals: number[];
}

interface Fixture {
  config_version: number;
  attempts: EngineAttemptDesc[];
  scheduler: SchedulerFixture;
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/engine_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const cfg = loadConfig(fixture.config_version);
const attempts = attemptsById(fixture.attempts);
const sched = fixture.scheduler;

/** 调度表 → 可比较的 plain object（值比较，不含键序信息） */
function plainSchedule(schedule: ReviewSchedule): Record<string, ScheduleEntry> {
  return Object.fromEntries(schedule);
}

/** fixture 里的 entry 是 `Record<string, unknown>`，转成可比较的形态 */
function plainEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return { ...entry };
}

function plainRows(rows: readonly ReviewItem[]): Record<string, unknown>[] {
  return rows.map((row) => ({ ...row }));
}

/** 缺某些键的 fixture 表（`partial_entry_from_db` 的老数据形态） */
function scheduleOf(desc: ScheduleDesc): ReviewSchedule {
  return scheduleFromDesc(desc);
}

function attemptOf(id: string): Attempt {
  const attempt = attempts.get(id);
  if (attempt === undefined) throw new Error(`fixture 里没有 attempt：${id}`);
  return attempt;
}

/**
 * 在真实配置上改一处、造一份变体。
 *
 * **不能**用 `{...cfg, raw}` 造变体：`AlgorithmConfig` 的取值面是原型上的
 * getter（`review_intervals_days` 等），展开只复制自身字段，getter 会全丢 ——
 * 于是变体在读到第一个阈值时就炸成 `undefined`，而测试看上去"通过了"。
 * 必须用 `new AlgorithmConfig(raw)` 重建。
 */
function variantConfig(mutate: (raw: Record<string, unknown>) => void): AlgorithmConfig {
  const raw = structuredClone(cfg.raw) as Record<string, unknown>;
  mutate(raw);
  return new AlgorithmConfig(raw);
}

// ══════════════════════════════════════════════════════════
describe("scheduler 对拍：前置一致性", () => {
  it("fixture 的 config_version 与本地配置一致", () => {
    expect(fixture.config_version).toBe(cfg.version);
  });

  it("三条配置常量与本地配置一致（阈值不是硬编码在 fixture 里的）", () => {
    expect(sched.intervals).toEqual([...cfg.review_intervals_days]);
    expect(sched.max_per_day).toBe(Math.trunc(Number(cfg.get(["review", "max_per_day"]))));
    expect(sched.min_mastery).toBe(Number(cfg.get(["review", "min_mastery"])));
  });

  it("每条序列引用的 attempt 都在表里，且 steps 与 results 严格等长", () => {
    for (const seq of sched.sequences) {
      for (const step of seq.steps) {
        expect(attempts.has(step.attempt), `${seq.id} 引用了不存在的 attempt ${step.attempt}`).toBe(
          true,
        );
      }
      // 少一条 results = 少对拍一步；多一条 = 结果表错位
      expect(seq.results.length, `${seq.id} 的 steps/results 不等长`).toBe(seq.steps.length);
    }
  });

  it("序列的 id 都不重复（重复会把其中一条的结果当另一条的基准）", () => {
    const ids = sched.sequences.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("三条 pending 输出都非空（漏一条 = 一个函数完全没对拍）", () => {
    for (const c of sched.pending) {
      expect(Array.isArray(c.expect), `${c.id} 的 expect`).toBe(true);
      expect(Array.isArray(c.kept), `${c.id} 的 kept`).toBe(true);
      expect(Array.isArray(c.due), `${c.id} 的 due`).toBe(true);
    }
  });

  it("next_review_day 的 Python 侧自记录 actual 与 expect 一致（dump 没抄错）", () => {
    for (const c of sched.next_review_day) {
      expect(c.actual, c.id).toStrictEqual(c.expect);
    }
  });
});

// ══════════════════════════════════════════════════════════
describe("scheduler 对拍：fixture 自证", () => {
  const byId = (id: string): ScheduleSequence => {
    const found = sched.sequences.find((s) => s.id === id);
    if (found === undefined) throw new Error(`fixture 里没有序列：${id}`);
    return found;
  };

  it("连对跑满全部五档间隔后**封顶**在最后一档", () => {
    const steps = byId("streak_through_all_intervals").results;
    const indexes = steps.map((s) => s["make_ten::decompose"]!["interval_index"]);
    // 前五步 0,1,2,3,4；第六七步仍是 4
    expect(indexes).toEqual([0, 1, 2, 3, 4, 4, 4]);
    const streaks = steps.map((s) => s["make_ten::decompose"]!["consecutive_correct"]);
    expect(streaks).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 间隔取自 [1,3,7,14,30]；第 5~7 步都该加 30
    const dues = steps.map((s) => s["make_ten::decompose"]!["due_day"]);
    expect(dues).toEqual([2, 5, 12, 26, 56, 86, 116]);
    // 「封顶」必须真的发生过 —— 否则 min(streak-1, len-1) 的 min 是死代码
    const intervals = sched.intervals;
    expect(intervals.length).toBe(5);
    expect(indexes.filter((i) => i === intervals.length - 1).length).toBeGreaterThanOrEqual(2);
  });

  it("答错退回起点，但 last_correct_day 保留在最后一次答对那天", () => {
    const steps = byId("wrong_resets_but_keeps_last_correct_day").results;
    const wrong = steps[3]!["make_ten::decompose"]!;
    expect(wrong["consecutive_correct"]).toBe(0);
    expect(wrong["interval_index"]).toBe(0);
    expect(wrong["last_correct_day"], "答错不该抹掉「上次做对是哪天」").toBe(5);
    // 第 4 步：day 9 + 第 1 档间隔 1 = 10
    expect(wrong["due_day"]).toBe(10);
    // 第 5 步再答对：streak 从 0 重新数 → 1
    const again = steps[4]!["make_ten::decompose"]!;
    expect(again["consecutive_correct"]).toBe(1);
    expect(again["last_correct_day"]).toBe(10);
  });

  it("多 pattern 交错时每次只动自己那条", () => {
    const seq = byId("multi_pattern_interleaved");
    const results = seq.results;
    // 第 1 步（day 1）之后只有一条；第 2 步追加第二条；第 3 步追加第三条
    expect(Object.keys(results[0]!)).toEqual(["make_ten::decompose"]);
    expect(Object.keys(results[1]!).sort()).toEqual([
      "make_ten::decompose",
      "make_ten::number_friends",
    ]);
    expect(Object.keys(results[2]!).sort()).toEqual([
      "carry_add::carry_exchange",
      "make_ten::decompose",
      "make_ten::number_friends",
    ]);
    // 第 4 步（day 3）：decompose 累到 2，另两条不动（各自 1）
    const step4 = results[3]!;
    expect(step4["make_ten::decompose"]!["consecutive_correct"]).toBe(2);
    expect(step4["make_ten::number_friends"]!["consecutive_correct"]).toBe(1);
    expect(step4["carry_add::carry_exchange"]!["consecutive_correct"]).toBe(1);
    // 第 5 步是 number_friends 答错；第 6 步又碰 carry_add
    expect(results[4]!["make_ten::number_friends"]!["consecutive_correct"]).toBe(0);
    expect(results[4]!["make_ten::number_friends"]!["due_day"], "答错后退回第 1 档").toBe(5);
    const last = results[5]!;
    expect(last["make_ten::number_friends"]!["consecutive_correct"], "第 6 步没碰它").toBe(0);
    expect(last["carry_add::carry_exchange"]!["consecutive_correct"]).toBe(2);
    // 三条各自独立：第 4 步的 decompose=2 与第 6 步的 carry_add=2 是两回事
    expect(last["make_ten::decompose"]!["consecutive_correct"]).toBe(2);
  });

  it("初始 entry 缺键时走 `.get(k, default)`：缺的键被补、没碰的键原样", () => {
    const seq = byId("partial_entry_from_db");
    // 老数据形态：decompose 缺 consecutive_correct / last_correct_day
    expect(Object.keys(seq.initial["make_ten::decompose"]!).sort()).toEqual([
      "due_day",
      "interval_index",
    ]);
    const step0 = seq.results[0]!;
    // 缺 consecutive_correct → streak = 0 + 1 = 1（不是 NaN）
    expect(step0["make_ten::decompose"]!["consecutive_correct"]).toBe(1);
    expect(step0["make_ten::decompose"]!["last_correct_day"]).toBe(10);
    // interval_index 从 2 被覆盖成 streak - 1 = 0（答对一定重算档位）
    expect(step0["make_ten::decompose"]!["interval_index"]).toBe(0);
    // 第 1 步没碰 number_friends —— 结果表里它应该**逐字节**等于初始值
    expect(step0["make_ten::number_friends"]).toStrictEqual(seq.initial["make_ten::number_friends"]);
    // 第 2 步碰到 number_friends：consecutive_correct 从 4 → 5，档位封顶在 4
    const step1 = seq.results[1]!;
    expect(step1["make_ten::number_friends"]!["consecutive_correct"]).toBe(5);
    expect(step1["make_ten::number_friends"]!["interval_index"]).toBe(4);
    expect(step1["make_ten::number_friends"]!["due_day"]).toBe(31 + 30);
  });

  it("fixture 的字典键是**排过序**的 —— 所以它钉不住「键位置」", () => {
    const seq = byId("existing_key_keeps_position");

    // ① entry **内部**的键：fixture 里是字典序……
    expect(Object.keys(seq.results[0]!["make_ten::decompose"]!)).toEqual([
      "consecutive_correct",
      "due_day",
      "interval_index",
      "last_correct_day",
    ]);
    // ……而实现里新建 entry 的插入序是另一回事（与 Python 的 dict 字面量同源）
    const fresh = updateSchedule(newSchedule(), attemptOf("practice_clean"), 5, cfg);
    expect(Object.keys(fresh.get("make_ten::decompose")!)).toEqual([
      "interval_index",
      "consecutive_correct",
      "last_correct_day",
      "due_day",
    ]);

    // ② 表的键同样被重排：dump 脚本的字面量里 number_friends 在 decompose 之前
    //    （见 ENGINE_SCHEDULE_SEQUENCES 的 initial），fixture 里两个位置都成了字典序
    expect(Object.keys(seq.initial)).toEqual(["make_ten::decompose", "make_ten::number_friends"]);
    expect(Object.keys(seq.results[0]!)).toEqual([
      "make_ten::decompose",
      "make_ten::number_friends",
    ]);

    // 结论：键序语义只能靠 tests/unit/engine-scheduler.test.ts 的直接断言钉住。
    // 本断言存在的意义是把这件事钉在明处，免得后来者以为 fixture 覆盖了键序。
  });

  it("pending 的三种排序/过滤分支都出现过", () => {
    const byCaseId = new Map(sched.pending.map((c) => [c.id, c]));
    // ① 逾期降序：12 / 5 / 0
    expect(byCaseId.get("due_today_sorted_by_overdue")!.expect.map((r) => r["overdue_days"])).toEqual([
      12, 5, 0,
    ]);
    // ② 未来项被排除：只剩 due_day = 10 那条
    expect(byCaseId.get("future_not_due")!.expect).toHaveLength(1);
    // ③ 同逾期按 pattern_key 升序
    expect(byCaseId.get("tie_breaks_on_pattern_key")!.expect.map((r) => r["pattern_key"])).toEqual([
      "carry_add::increase",
      "make_ten::decompose",
      "make_ten::number_friends",
    ]);
  });

  it("mastery 的 0.60 分界：0.59 不进、0.60 进", () => {
    const c = sched.pending.find((x) => x.id === "mastery_below_threshold")!;
    expect(c.expect.map((r) => r["pattern_key"])).toEqual(["carry_add::increase"]);
    expect(sched.min_mastery).toBe(0.6);
  });

  it("「没有 Signals」与「mastery 未采样」都不进，但 fixture 里确实备了两种输入", () => {
    const c = sched.pending.find((x) => x.id === "missing_signals_vs_unsampled_mastery")!;
    // make_ten -> null（有 Signals、未采样）；td_add_nocarry -> 不在字典里
    expect(c.competencies["make_ten"]).toBeNull();
    expect(Object.hasOwn(c.competencies, "td_add_nocarry")).toBe(false);
    // 三条输入只有一条活下来
    expect(Object.keys(c.schedule).sort()).toEqual([
      "carry_add::increase",
      "make_ten::decompose",
      "td_add_nocarry::decompose",
    ]);
    expect(c.expect.map((r) => r["pattern_key"])).toEqual(["carry_add::increase"]);
  });

  it("缺 due_day 的两个**不同**默认值都出现了", () => {
    // pending 侧：缺 due_day → 就当今天到期（day = 42）
    const c = sched.pending.find((x) => x.id === "entry_missing_due_day_uses_today")!;
    expect(Object.hasOwn(c.schedule["make_ten::decompose"]!, "due_day")).toBe(false);
    expect(c.expect).toHaveLength(1);
    expect(c.expect[0]!["due_day"]).toBe(42);
    expect(c.expect[0]!["overdue_days"]).toBe(0);
    // next_review_day 侧：缺 due_day → 0
    const n = sched.next_review_day.find((x) => x.id === "missing_due_day_gives_zero")!;
    expect(n.expect).toBe(0);
  });

  it("release_pressure 的 max_per_day 截断真的发生了一次（kept 比 expect 短）", () => {
    const c = sched.pending.find((x) => x.id === "over_max_per_day_truncates")!;
    expect(sched.max_per_day).toBe(3);
    expect(c.expect).toHaveLength(4);
    expect(c.kept).toHaveLength(3);
    // 砍的是**尾部**（逾期最少的那条），保留最该复习的前三条
    expect(c.kept.map((r) => r["pattern_key"])).toEqual(c.expect.slice(0, 3).map((r) => r["pattern_key"]));
    expect(c.due).toStrictEqual(c.kept);
  });

  it("pending 与 due 至少有一条 case 上不一致（否则 dueReviews 的对拍是恒等的）", () => {
    const differing = sched.pending.filter(
      (c) => JSON.stringify(c.expect) !== JSON.stringify(c.due),
    );
    expect(differing.map((c) => c.id)).toEqual(["over_max_per_day_truncates"]);
  });

  it("pattern_key 的拆分（`::` 之前是能力、之后是 pattern）在每个 case 上都成立", () => {
    for (const c of sched.pending) {
      for (const row of c.expect) {
        const [competency, pattern] = String(row["pattern_key"]).split("::");
        expect(row["competency_id"], `${c.id} 的 competency_id 拆错了`).toBe(competency);
        expect(row["pattern_id"], `${c.id} 的 pattern_id 拆错了`).toBe(pattern);
      }
    }
  });

  it("empty_schedule 的所有输出都是空表（空输入的退化路径）", () => {
    const c = sched.pending.find((x) => x.id === "empty_schedule")!;
    expect(c.expect).toEqual([]);
    expect(c.kept).toEqual([]);
    expect(c.due).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════
describe("scheduler 对拍：updateSchedule 逐序列逐步", () => {
  for (const seq of sched.sequences) {
    it(`${seq.id} —— ${seq.note}`, () => {
      let schedule = scheduleOf(seq.initial);

      seq.steps.forEach((step, index) => {
        const label = `${seq.id} 第 ${index + 1} 步（${step.attempt} @ day ${step.day}）`;
        // 入参快照：取整张表 + 每条 entry 的引用，跑完要逐条验"没被动过"
        const beforeTable = plainSchedule(schedule);
        const beforeRefs = new Map(schedule);
        const beforeJson = JSON.stringify(beforeTable);

        const out = updateSchedule(schedule, attemptOf(step.attempt), step.day, cfg);

        // ① 结果表与该步的黄金值一致
        expect(plainSchedule(out), label).toStrictEqual(seq.results[index]);

        // ② 纯函数：入参那张表逐字节没变（共用内层 entry 的 bug 会在这里红）
        expect(JSON.stringify(plainSchedule(schedule)), `${label} 改到了入参表`).toBe(beforeJson);
        // ③ 入参表里的 entry 对象也没被就地改过（比 ② 更严：值相同但对象被换也算改）
        for (const [key, entry] of beforeRefs) {
          expect(schedule.get(key), `${label} 换掉了入参的 entry 对象 ${key}`).toBe(entry);
        }
        // ④ 出参是**新表**，且没和入参共享任何 entry 对象
        expect(out, `${label} 返回了入参那张表`).not.toBe(schedule);
        for (const [key, entry] of out) {
          if (beforeRefs.has(key)) {
            expect(entry, `${label} 出参与入参共享了 entry ${key}`).not.toBe(beforeRefs.get(key));
          }
        }

        schedule = out;
      });

      // ⑤ 初始表里的键一个都没跑丢（只增不减）
      for (const key of Object.keys(seq.initial)) {
        expect(schedule.has(key), `${seq.id} 跑丢了初始键 ${key}`).toBe(true);
      }
    });
  }

  it("updateSchedule 不修改入参（逐条比 entry 的字段）", () => {
    const initial = scheduleOf({ "make_ten::decompose": { interval_index: 0, due_day: 5 } });
    const entryRef = initial.get("make_ten::decompose")!;
    const snapshot = { ...entryRef };

    const out = updateSchedule(initial, attemptOf("practice_clean"), 5, cfg);

    // 入参的 entry 对象还是原样（不是"内容相等"，是"没被就地改过"）
    expect(initial.get("make_ten::decompose")).toStrictEqual(snapshot);
    // 出参里的 entry 是另一个对象
    expect(out.get("make_ten::decompose")).not.toBe(entryRef);
  });

  it("空间隔序列（长度 0）→ 原样返回，连键都不建", () => {
    const emptyCfg = variantConfig((raw) => {
      (raw["review_intervals_days"] as unknown[]).length = 0;
    });
    expect(emptyCfg.review_intervals_days).toStrictEqual([]);

    const before = scheduleOf({ "make_ten::decompose": { due_day: 5 } });
    const out = updateSchedule(before, attemptOf("practice_clean"), 5, emptyCfg);
    expect(plainSchedule(out)).toStrictEqual(plainSchedule(before));

    // "连键都不建"：一条从没出现过的 pattern 也不会被加进去（真实配置下会加）
    const empty = updateSchedule(new Map(), attemptOf("other_pattern_clean"), 5, emptyCfg);
    expect(empty.size).toBe(0);
    const real = updateSchedule(new Map(), attemptOf("other_pattern_clean"), 5, cfg);
    expect(real.size, "对照：真实配置下同一调用会建键").toBe(1);
  });
});

// ══════════════════════════════════════════════════════════
describe("scheduler 对拍：pendingReviews / releasePressure / dueReviews", () => {
  for (const c of sched.pending) {
    it(`${c.id} —— ${c.note}`, () => {
      const schedule = scheduleOf(c.schedule);
      const state = stateFromCompetencies(c.competencies);

      const pending = pendingReviews(schedule, c.day, state, cfg);
      expect(plainRows(pending), `${c.id} pendingReviews`).toStrictEqual(c.expect);

      const kept = releasePressure(pending, cfg);
      expect(plainRows(kept), `${c.id} releasePressure`).toStrictEqual(c.kept);

      // dueReviews = pending 再截断；fixture 里的三条 case 都没到上限，
      // 所以这里只断言"等于 pending 的前 max_per_day 条"这层关系
      const due = dueReviews(schedule, c.day, state, cfg);
      expect(plainRows(due), `${c.id} dueReviews`).toStrictEqual(c.due);
      expect(plainRows(due)).toStrictEqual(c.expect.slice(0, sched.max_per_day));

      // 入参表没被动过（pendingReviews 不改表）
      expect(plainSchedule(schedule)).toStrictEqual(c.schedule);
    });
  }

  it("releasePressure 的截断：超过 max_per_day 时只留最该复习的前 N 条", () => {
    // fixture 里没有超过上限的 case，这里显式构造 4 条（> max_per_day=3）
    const schedule = scheduleOf({
      "make_ten::a": { due_day: 1 },
      "make_ten::b": { due_day: 2 },
      "make_ten::c": { due_day: 3 },
      "make_ten::d": { due_day: 4 },
    });
    const state = stateFromCompetencies({ make_ten: 0.9 });

    const pending = pendingReviews(schedule, 10, state, cfg);
    expect(pending.map((r) => r.pattern_key)).toEqual([
      "make_ten::a",
      "make_ten::b",
      "make_ten::c",
      "make_ten::d",
    ]);

    const kept = releasePressure(pending, cfg);
    expect(kept.map((r) => r.pattern_key)).toEqual(["make_ten::a", "make_ten::b", "make_ten::c"]);
    // 被压下去的项仍在表里（不是删掉，是顺延）
    expect(schedule.size).toBe(4);
  });

  it("releasePressure：max_per_day <= 0 → 空表（不是「无限放行」）", () => {
    const items = pendingReviews(
      scheduleOf({ "make_ten::a": { due_day: 1 } }),
      10,
      stateFromCompetencies({ make_ten: 0.9 }),
      cfg,
    );
    expect(items).toHaveLength(1);

    for (const bad of [0, -1]) {
      const zeroCfg = variantConfig((raw) => {
        (raw["review"] as Record<string, unknown>)["max_per_day"] = bad;
      });
      expect(releasePressure(items, zeroCfg), `max_per_day=${bad}`).toHaveLength(0);
    }
  });

  it("pendingReviews 的返回值是新对象（改它不影响下一次调用）", () => {
    const schedule = scheduleOf({ "make_ten::a": { due_day: 1 } });
    const state = stateFromCompetencies({ make_ten: 0.9 });
    const first = pendingReviews(schedule, 10, state, cfg);
    first[0]!.overdue_days = 999;
    const second = pendingReviews(schedule, 10, state, cfg);
    expect(second[0]!.overdue_days).toBe(9);
  });
});

// ══════════════════════════════════════════════════════════
describe("scheduler 对拍：nextReviewDay", () => {
  for (const c of sched.next_review_day) {
    it(`${c.id} —— key=${JSON.stringify(c.key)}`, () => {
      const out = nextReviewDay(scheduleOf(c.schedule), c.key, cfg);
      expect(out).toStrictEqual(c.expect);
    });
  }

  it("缺 due_day 给 0、不在表里给 null —— 两者不能混淆", () => {
    expect(nextReviewDay(scheduleOf({ "a::b": { interval_index: 1 } }), "a::b", cfg)).toBe(0);
    expect(nextReviewDay(scheduleOf({ "a::b": { due_day: 3 } }), "a::c", cfg)).toBeNull();
  });
});
