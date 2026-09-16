/**
 * 间隔复习调度（P3）—— `backend/engine/scheduler.py` 的 TypeScript 移植。
 *
 * 复习的粒度是 **pattern_key**（`"{competency}::{pattern}"`，见 `types.patternKey`），
 * 不是"某一道题"：孩子需要重新激活的是一种**问题结构**，不是某个具体数字。
 *
 * 间隔序列来自 config/algorithm/v0.yaml 的 `review_intervals_days`（[1, 3, 7, 14, 30]）：
 *
 *   - 第 n 次连续答对 → 进入第 n+1 档间隔（第 1 次答对 → 1 天后见，第 2 次 → 3 天后见…）
 *   - 答错 → 退回第 1 档（明天再来）
 *
 * "错一次就退回起点"是刻意设计的：目标人群是基础偏弱的孩子，遗忘曲线更陡，
 * 宁可多复习一次，也不要让孩子在已经松动的结构上"以为会了"。
 *
 * **只有"会了"的东西才值得复习**：能力 mastery 低于 `review.min_mastery` 的 pattern
 * 不进复习队列 —— 还没学会的东西属于教学，不属于复习。
 *
 * 所有阈值来自 AlgorithmConfig（ADR-0002），本模块不出现阈值字面量。
 * 本模块是纯函数：不读数据库、不写日志、不依赖当前时间（"今天是第几天"由调用方给）。
 *
 * ══ 三处**刻意的**表示法决策 ══════════════════════════════
 *
 * ① 调度表用 `Map<string, ScheduleEntry>` 而不是 plain object。
 *    Python 那边是 `Dict[str, Dict[str, Any]]`，要落进 review_schedule 表。
 *    Map 与 dict 的两条关键语义一致：迭代序 = 插入序；
 *    `map.set(已有键, v)` **保持原位置**（不是移到末尾）—— 后者在
 *    序列化时可见（`json.dumps` 会按插入序输出）。
 *    `Object.keys` 那套还会把整数样式的键提前，这里虽然不会撞上，但没必要冒险。
 *
 * ② `ScheduleEntry` 的字段声明成必填，**但读的时候一律走 `pyGet` 带默认值**。
 *    因为这张表是从 DB 读回来的，Python 侧对每个字段都有 `.get(k, default)` ——
 *    "DB 里存的老数据缺了一个键"在 Python 里是静默走默认值，在 TS 里如果直接
 *    `entry.due_day` 就会变成 `undefined` 并一路 NaN 下去。
 *
 * ③ `pendingReviews` 与 `nextReviewDay` 对"缺 due_day"的默认值**不一样**：
 *    前者用 `day`（就当今天到期），后者用 `0`。这是 Python 的原样行为 ——
 *    看起来像抄错了，其实两处语义不同：前者在"排序候选"语境下不该因为
 *    缺字段就丢掉一项，后者在"下一个复习日"语境下给 0 表示"很久以前"。
 *    别统一。
 */
import type { AlgorithmConfig } from "@/src/engine/config";
import { patternKey, splitPatternKey } from "@/src/engine/types";
import type { Attempt, ChildLearningState } from "@/src/engine/types";
import { pyGet } from "@/src/py/pyvalue";

export interface ScheduleEntry {
  interval_index: number;
  consecutive_correct: number;
  last_correct_day: number | null;
  due_day: number;
}

/** 调度表：`pattern_key -> 该结构的复习状态`（可直接 JSON 序列化） */
export type ReviewSchedule = Map<string, ScheduleEntry>;

export interface ReviewItemInit {
  pattern_key: string;
  competency_id: string;
  pattern_id: string;
  due_day: number;
  interval_index: number;
  last_correct_day: number | null;
  consecutive_correct: number;
  overdue_days: number;
}

/** 一条到期复习项 —— 描述"哪个问题结构该复习了"，不描述"该做哪一道题"。 */
export class ReviewItem {
  pattern_key: string;
  competency_id: string;
  pattern_id: string;
  due_day: number;
  interval_index: number;
  last_correct_day: number | null;
  consecutive_correct: number;
  overdue_days: number;

  constructor(init: ReviewItemInit) {
    this.pattern_key = init.pattern_key;
    this.competency_id = init.competency_id;
    this.pattern_id = init.pattern_id;
    this.due_day = init.due_day;
    this.interval_index = init.interval_index;
    this.last_correct_day = init.last_correct_day;
    this.consecutive_correct = init.consecutive_correct;
    this.overdue_days = init.overdue_days;
  }
}

// ── 调度状态 ───────────────────────────────────────────────

/** 空调度表 */
export function newSchedule(): ReviewSchedule {
  return new Map();
}

/**
 * 浅拷外层 + 逐条拷内层 —— Python 的 `{key: dict(entry) for ...}`。
 *
 * 内层必须是真的新对象：`updateSchedule` 会就地改它（`entry.consecutive_correct += 1`），
 * 共享内层就等于修改了入参 —— 而整个引擎的契约是"纯函数，返回新状态"。
 */
function copySchedule(schedule: ReviewSchedule): ReviewSchedule {
  return new Map([...schedule].map(([key, entry]) => [key, { ...entry }] as const));
}

/**
 * 第 intervalIndex 档的间隔天数；超出序列长度则封顶在最后一档。
 *
 * ⚠️ 三个夹取里只有**一个**是活跃的（突变测试逐个替换验证过）：
 *   - `Math.max(0, ...)` —— **活跃**。entry 的 `consecutive_correct` 是负数时
 *     （只可能来自被写坏的 DB 数据），`updateSchedule` 算出的 interval_index
 *     也是负数，没有它就会取到 `intervals[-5]` → NaN 一路传进 due_day。
 *   - `Math.min(..., len - 1)` —— 不可达。唯一调用方 `updateSchedule` 自己
 *     就用 `min(streak - 1, len - 1)` 算 interval_index 了。
 *   - `Math.trunc(intervalIndex)` —— 不可观测。interval_index 只可能由
 *     `updateSchedule` 的两个分支写出来，而两处写进去的都已经是整数。
 *   留着两个冗余夹取是照抄 Python（`_interval_days` 一字不差），
 *   也防将来出现第二个调用方。别"顺手清理"成 Python 没有的形状。
 */
function intervalDays(intervalIndex: number, cfg: AlgorithmConfig): number {
  const intervals = cfg.review_intervals_days;
  const index = Math.max(0, Math.min(Math.trunc(intervalIndex), intervals.length - 1));
  // 上游 `updateSchedule` 已经挡掉了空列表，这里的下标一定有效
  return Math.trunc(intervals[index]!);
}

/**
 * 一次作答后推进调度（纯函数：返回新 Map，不修改入参）。
 *
 * 只按 `patternKey` 记账，与"具体做了哪道题"无关 —— 同一结构的另一道题
 * 同样是这个结构的证据。
 *
 * 约定：
 *   - 答对：连续答对 +1，进入下一档间隔（封顶在最后一档）
 *   - 答错：连续答对清零、退回第 1 档，明天再来
 *   - `last_correct_day` 只在答对时更新（答错时保留"上次做对是哪天"，
 *     对"到底忘了多久"这类诊断有用）
 */
export function updateSchedule(
  schedule: ReviewSchedule,
  attempt: Attempt,
  day: number,
  cfg: AlgorithmConfig,
): ReviewSchedule {
  const intervals = cfg.review_intervals_days;
  // 空间隔序列 = 复习功能没配置 → 原样返回（连键都不建）
  if (intervals.length === 0) return copySchedule(schedule);

  const updated = copySchedule(schedule);
  const key = patternKey(attempt.competency_id, attempt.pattern_id);
  let entry = updated.get(key);
  if (entry === undefined) {
    entry = {
      interval_index: 0,
      consecutive_correct: 0,
      last_correct_day: null,
      due_day: day,
    };
  }

  if (attempt.correct) {
    const streak = Math.trunc(Number(pyGet(entry, "consecutive_correct", 0))) + 1;
    entry.consecutive_correct = streak;
    // 连续答对 n 次 → 第 n+1 档；跑完全部档位后封顶在最后一档。
    // 这里**没有** max(0, ...)：streak 至少是 1，所以减一后至少是 0。
    entry.interval_index = Math.min(streak - 1, intervals.length - 1);
    entry.last_correct_day = day;
  } else {
    entry.consecutive_correct = 0;
    entry.interval_index = 0;
  }

  entry.due_day = Math.trunc(day) + intervalDays(entry.interval_index, cfg);
  // 键已存在时 set 保持原位置（与 Python dict 的 `d[k] = v` 一致）；
  // 新键追加到末尾
  updated.set(key, entry);
  return updated;
}

// ── 到期查询 ───────────────────────────────────────────────

/** 只有"会了"的东西才值得复习 */
function isReviewable(competencyId: string, state: ChildLearningState, cfg: AlgorithmConfig): boolean {
  const signals = state.competencies.get(competencyId);
  if (signals === undefined || signals.mastery === null) return false;
  return signals.mastery >= Number(cfg.get(["review", "min_mastery"]));
}

/**
 * 当天全部到期复习项（**未**做每日上限截断），按"最该复习"排序。
 *
 * 排序键：逾期天数降序（逾期越久越该复习），同逾期按 `pattern_key` 稳定排序
 * —— 排序必须确定，否则同一天两次调用会给出不同的计划。
 *
 * 这里逐字段复刻 Python 的 `items.sort(key=lambda row: (-row.overdue_days, row.pattern_key))`：
 * 升序排序 + 对 overdue 取负 = 降序；`pattern_key` 在 `schedule` 里是唯一键，
 * 所以整体是全序，`Array.prototype.sort` 的稳定性在这里用不上（但它是稳定的）。
 */
export function pendingReviews(
  schedule: ReviewSchedule,
  day: number,
  state: ChildLearningState,
  cfg: AlgorithmConfig,
): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const [key, entry] of schedule) {
    // 缺 due_day 时用**今天**（见模块头 ③）
    const dueDay = Math.trunc(Number(pyGet(entry, "due_day", day)));
    if (dueDay > day) continue;
    const [competencyId, patternId] = splitPatternKey(key);
    if (!isReviewable(competencyId, state, cfg)) continue;
    const lastCorrectDay = pyGet(entry, "last_correct_day", null);
    items.push(
      new ReviewItem({
        pattern_key: key,
        competency_id: competencyId,
        pattern_id: patternId,
        due_day: dueDay,
        interval_index: Math.trunc(Number(pyGet(entry, "interval_index", 0))),
        last_correct_day: lastCorrectDay === null ? null : Number(lastCorrectDay),
        consecutive_correct: Math.trunc(Number(pyGet(entry, "consecutive_correct", 0))),
        overdue_days: Math.trunc(day) - dueDay,
      }),
    );
  }
  items.sort((a, b) => {
    const byOverdue = b.overdue_days - a.overdue_days; // 降序
    if (byOverdue !== 0) return byOverdue;
    if (a.pattern_key < b.pattern_key) return -1;
    if (a.pattern_key > b.pattern_key) return 1;
    return 0;
  });
  return items;
}

/**
 * 复习洪峰控制：只保留"最该复习"的前 N 项（N = `review.max_per_day`）。
 *
 * 这里不"删除"任何东西 —— 被压下去的项仍留在 schedule 里，due_day 不变，
 * 次日以更大的逾期天数重新参与排序（自然顺延），不会丢。
 */
export function releasePressure(items: readonly ReviewItem[], cfg: AlgorithmConfig): ReviewItem[] {
  const maxPerDay = Math.trunc(Number(cfg.get(["review", "max_per_day"])));
  if (maxPerDay <= 0) return [];
  // `slice` 返回新数组（元素同引用），对应 Python 的 `list(items[:N])`
  return items.slice(0, maxPerDay);
}

/**
 * 今天该复习哪些（已做每日上限截断，按逾期天数降序）。
 *
 * 这是 Planner 的输入：复习必须能挤进当天计划，而不是"明天再说"。
 */
export function dueReviews(
  schedule: ReviewSchedule,
  day: number,
  state: ChildLearningState,
  cfg: AlgorithmConfig,
): ReviewItem[] {
  return releasePressure(pendingReviews(schedule, day, state, cfg), cfg);
}

/**
 * 某个问题结构的下一档复习日期；不在调度表里则返回 `null`。
 *
 * ⚠️ 与 `pendingReviews` 的缺省值**不同**：这里缺 `due_day` 给 **0**
 * （"很久以前"），那边给 `day`（"就当今天到期"）。见模块头 ③。
 *
 * `cfg` 参数当前不用，但保留 —— Python 侧同样保留（`_ = cfg`），
 * 目的是签名与其余接口一致，将来若支持"按配置换算档位"不必改所有调用方。
 */
export function nextReviewDay(
  schedule: ReviewSchedule,
  patternKeyValue: string,
  _cfg: AlgorithmConfig,
): number | null {
  const entry = schedule.get(patternKeyValue);
  if (entry === undefined) return null;
  return Math.trunc(Number(pyGet(entry, "due_day", 0)));
}
