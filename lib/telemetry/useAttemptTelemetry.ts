"use client";

/**
 * React 侧的时间埋点入口。
 *
 * 用法（交互组件不需要关心，由 ChallengeBeat 统一负责）：
 *   const telemetry = useAttemptTelemetry(item.code);   // 题目出现 → 自动开始
 *   const local = telemetry.stop();                     // 提交这一刻取快照
 *   const wire = toWireTelemetry(local);                // 只有契约 §0 的三项
 *
 * 注意：这就是「一次作答的时间窗口」，重试会重新 start()，因此
 * 每一次提交（每一个 client_attempt_id）都对应一段独立的时间。
 * thinking_time 不在这里产生，由服务端算。
 */

import { useCallback, useEffect, useMemo } from "react";
import type { LocalTelemetry } from "./tracker";
import { telemetryTracker, toWireTelemetry } from "./tracker";

export interface UseAttemptTelemetryResult {
  /** 开始一段计时（题目出现时调用） */
  start: () => void;
  /** 结束计时，返回本地快照（含分段与交互计数，调试用） */
  stop: () => LocalTelemetry;
  /** 当前是否正在计时 */
  isRunning: () => boolean;
}

export function useAttemptTelemetry(
  autoStartKey?: string | number | null,
): UseAttemptTelemetryResult {
  // 题目切换 / 重试 → 重新开一段
  useEffect(() => {
    if (autoStartKey === undefined || autoStartKey === null) return;
    telemetryTracker.start();
    return () => {
      telemetryTracker.stop();
    };
  }, [autoStartKey]);

  const start = useCallback(() => telemetryTracker.start(), []);
  const stop = useCallback(() => telemetryTracker.stop(), []);
  const isRunning = useCallback(() => telemetryTracker.isRunning(), []);

  return useMemo(() => ({ start, stop, isRunning }), [start, stop, isRunning]);
}

export { toWireTelemetry };
export type { LocalTelemetry, TelemetrySnapshot } from "./tracker";
