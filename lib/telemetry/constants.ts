/**
 * ============================================================================
 * 时间语义常量 —— 改动前必读 ADR-0003《思考时间不是无效时间》
 * ============================================================================
 *
 * 【本文件顶部必须写明的规则与原因】
 *
 * 规则：**绝对禁止**把「超过 N 秒没有操作」直接判定为无效、清零或剔除。
 *
 * 原因：这款产品的目标就是培养思考。孩子盯着题目不动，很可能正在心里拆分数字、
 *      在脑子里补十格框 —— 这是最珍贵的学习行为。如果系统把「停顿」一律当作划水，
 *      就会越认真地想、越被判成没在学，从底层把学习方向带歪。
 *
 * 落到代码上的三条：
 *   1. 只有「页面切到后台 / 离开」且离开时长 > IDLE_SUSPECT_MIN_MS 的那一段
 *      才计入 idle_time_ms（它的含义是「疑似离开」，不是「想得久」）。
 *   2. 5s～30s 的停顿既不算 idle 也不算 active —— 它落在 thinking 里，
 *      由服务端用 response − active − idle 得到，是 fluency 的合法输入。
 *   3. 任何地方都不允许出现 `if (elapsed > X) elapsed = 0` 这类写法。
 *
 * 服务端还会把 retry_delay + correctness + hint_usage + interaction_trace
 * 联合作证据，时间只是其中之一（ADR-0003 第 3 条）。
 * ============================================================================
 */

/** ADR 分段阈值下限：< 5s 属正常思考（前端不据此做任何剔除，仅用于展示与调试） */
export const THINKING_NORMAL_MAX_MS = 5_000;

/**
 * ADR 分段阈值上限：> 30s 的「离开」才疑似离开 / 中断。
 * 注意阈值语义：这是**离开时长**的门槛，不是「无操作」的门槛。
 */
export const IDLE_SUSPECT_MIN_MS = 30_000;

/** 采样间隔：active_time 的累积粒度 */
export const ACTIVITY_TICK_MS = 500;

/**
 * 活动余量：一次操作之后的这段时间仍算「在操作」。
 * 取 3s 是为了让「点一下、想两秒、再点一下」连续算作活动，
 * 而不是把两次点击之间的思考算成操作时间。
 */
export const ACTIVITY_TAIL_MS = 3_000;

/** 判定「有操作」的事件类型（鼠标 / 触摸 / 键盘 / 拖拽 / 滚轮） */
export const ACTIVITY_DOM_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "keydown",
  "wheel",
  "touchstart",
  "touchmove",
  "dragstart",
] as const;

/** 三次时间上报字段名（契约 §0），集中一处避免拼错 */
export const TELEMETRY_FIELDS = {
  response: "response_time_ms",
  active: "active_time_ms",
  idle: "idle_time_ms",
} as const;

/** localStorage 里暂存的未提交作答（断网重放） */
export const PENDING_ATTEMPTS_STORAGE_KEY = "math_world.pending_attempts.v1";
