/**
 * 一次作答的时间采集器（ADR-0003）。
 *
 * 采集三项：
 *   response_time_ms  题目出现 → 提交答案（不剔除任何东西，全程计时）
 *   active_time_ms    实际鼠标 / 触摸 / 键盘操作时间（按 ACTIVITY_TICK_MS 累积）
 *   idle_time_ms      被判定为「疑似离开」的分段之和（单段 > IDLE_SUSPECT_MIN_MS）
 *
 * 明确不做的事：
 *   - 不把「长时间没操作」算作无效（见 constants.ts 顶部说明）
 *   - 不在页面隐藏期间累积 active
 *   - 不上报 thinking_time（服务端算）
 *
 * 另外本地保留 idle_segments 分段与 interaction_trace 计数：
 * ADR-0003 要求「分段记录，不是单一数值」，契约只上报总和，
 * 分段留给调试面板，不上报、不参与判定。
 */

import {
  ACTIVITY_DOM_EVENTS,
  ACTIVITY_TAIL_MS,
  ACTIVITY_TICK_MS,
  IDLE_SUSPECT_MIN_MS,
} from "./constants";

/** 契约 §0 的三项上报时间 */
export interface TelemetrySnapshot {
  response_time_ms: number;
  active_time_ms: number;
  idle_time_ms: number;
}

/** 本地保留的疑似离开分段（不上报） */
export interface IdleSegment {
  /** 相对题目出现的起始毫秒 */
  started_at_ms: number;
  duration_ms: number;
}

export interface LocalTelemetry extends TelemetrySnapshot {
  idle_segments: IdleSegment[];
  /** 本地交互次数（pointer/keyboard 事件计数，供调试面板展示，不上报） */
  interaction_count: number;
  /** 完整的单调时钟耗时，用于自检 */
  wall_time_ms: number;
}

export const EMPTY_TELEMETRY: TelemetrySnapshot = {
  response_time_ms: 0,
  active_time_ms: 0,
  idle_time_ms: 0,
};

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

class AttemptTelemetryTracker {
  private running = false;
  private startedAt = 0;
  private activeMs = 0;
  private idleMs = 0;
  private idleSegments: IdleSegment[] = [];
  private interactions = 0;

  /** 最近一次用户操作时间（单调时钟） */
  private lastActivityAt = Number.NEGATIVE_INFINITY;
  /** 上一次结算 active 的时间点 */
  private lastTickAt = 0;
  /** 页面隐藏的开始时间；null 表示当前可见 */
  private hiddenAt: number | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (typeof window === "undefined") return;
    this.detach();
    this.running = true;
    this.startedAt = now();
    this.activeMs = 0;
    this.idleMs = 0;
    this.idleSegments = [];
    this.interactions = 0;
    this.lastActivityAt = Number.NEGATIVE_INFINITY;
    this.lastTickAt = this.startedAt;
    this.hiddenAt = document.visibilityState === "hidden" ? this.startedAt : null;
    this.attach();
  }

  markActivity(): void {
    if (!this.running) return;
    this.lastActivityAt = now();
    this.interactions += 1;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 取快照但继续计时（用于实时展示） */
  peek(): LocalTelemetry {
    return this.build();
  }

  /** 结束一次采集，返回最终快照 */
  stop(): LocalTelemetry {
    if (!this.running) {
      return { ...EMPTY_TELEMETRY, idle_segments: [], interaction_count: 0, wall_time_ms: 0 };
    }
    this.settle();
    const result = this.build();
    this.detach();
    this.running = false;
    return result;
  }

  // ── 内部 ────────────────────────────────────

  private attach(): void {
    if (typeof document === "undefined") return;
    // ⚠️ visibilitychange 事件派发在 document 上且**不冒泡**，
    //    监听在 window 上永远不会触发（踩过一次，别改回去）。
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    for (const type of ACTIVITY_DOM_EVENTS) {
      window.addEventListener(type, this.onActivity, { passive: true, capture: true });
    }
    this.timer = setInterval(this.onTick, ACTIVITY_TICK_MS);
  }

  private detach(): void {
    if (typeof window === "undefined") return;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    for (const type of ACTIVITY_DOM_EVENTS) {
      window.removeEventListener(type, this.onActivity, { capture: true } as EventListenerOptions);
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private onActivity = (): void => {
    this.markActivity();
  };

  private onVisibilityChange = (): void => {
    if (!this.running) return;
    if (document.visibilityState === "hidden") {
      // 先结算一次，避免把隐藏前的活动尾巴丢掉
      this.settle();
      this.hiddenAt = now();
      return;
    }
    this.onVisible();
  };

  private onVisible(): void {
    const t = now();
    if (this.hiddenAt !== null) {
      const gap = t - this.hiddenAt;
      // 只有「离开时长 > 30s」才计入 idle。
      // 30s 以内的这段什么都不做：它既不是操作时间，也不是疑似离开，
      // 它会自然落到 thinking_time 里 —— 这正是我们想要的。
      if (gap > IDLE_SUSPECT_MIN_MS) {
        this.idleMs += gap;
        this.idleSegments.push({ started_at_ms: this.hiddenAt - this.startedAt, duration_ms: gap });
      }
      this.hiddenAt = null;
    }
    // 重新可见后从当前时刻开始重新累积，隐藏期间绝不折算成 active
    this.lastTickAt = t;
    this.lastActivityAt = Number.NEGATIVE_INFINITY;
  }

  /** 把 [lastTickAt, now] 这段按「是否处于活动状态」结算 */
  private settle(): void {
    const t = now();
    if (this.hiddenAt !== null) {
      // 当前就处于隐藏状态：这一整段既不是 active 也不立刻判 idle（等回来时按 >30s 判定）
      this.lastTickAt = t;
      return;
    }
    const delta = t - this.lastTickAt;
    if (delta > 0 && t - this.lastActivityAt <= ACTIVITY_TAIL_MS) {
      this.activeMs += delta;
    }
    this.lastTickAt = t;
  }

  private onTick = (): void => {
    if (!this.running) return;
    if (document.visibilityState === "hidden") {
      // 隐藏期间不累积 active；hiddenAt 已记录，回来时统一处理
      this.lastTickAt = now();
      return;
    }
    this.settle();
  };

  private build(): LocalTelemetry {
    const t = now();
    const wall = t - this.startedAt;
    let idle = this.idleMs;
    // 提交时仍处于隐藏态（例如用快捷键切走再提交）：把这一段按同一门槛结算
    if (this.hiddenAt !== null) {
      const gap = t - this.hiddenAt;
      if (gap > IDLE_SUSPECT_MIN_MS) idle += gap;
    }

    const response = Math.round(clamp(wall, 0, Number.MAX_SAFE_INTEGER));
    const active = Math.round(clamp(this.activeMs, 0, response));
    // active 与 idle 不允许超过总时长；超出部分从 idle 里裁掉（idle 是派生估计值）
    const idleClamped = Math.round(clamp(idle, 0, Math.max(0, response - active)));

    return {
      response_time_ms: response,
      active_time_ms: active,
      idle_time_ms: idleClamped,
      idle_segments: [...this.idleSegments],
      interaction_count: this.interactions,
      wall_time_ms: Math.round(wall),
    };
  }
}

/** 全局单例：同一时刻只会有一道题在被作答 */
export const telemetryTracker = new AttemptTelemetryTracker();

/** 供交互组件调用：告诉采集器「孩子动了」 */
export function markActivity(): void {
  telemetryTracker.markActivity();
}

export function startTelemetry(): void {
  telemetryTracker.start();
}

export function stopTelemetry(): LocalTelemetry {
  return telemetryTracker.stop();
}

/** 只取契约 §0 的三项，其它本地字段一律不带出去 */
export function toWireTelemetry(snapshot: LocalTelemetry): TelemetrySnapshot {
  return {
    response_time_ms: snapshot.response_time_ms,
    active_time_ms: snapshot.active_time_ms,
    idle_time_ms: snapshot.idle_time_ms,
  };
}
