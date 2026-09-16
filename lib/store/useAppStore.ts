"use client";

/**
 * 客户端状态（Zustand）。
 *
 * 【铁律】这里只放「游戏侧」会话状态与**服务端返回值的缓存**。
 * 任何学习状态（mastery / level / scaffold）都不得由前端计算或改写 ——
 * 见 ADR-0004：Attempt 是学习系统唯一事实入口。
 * 本 store 里的 materials / lastAttempt 都只是把服务端响应渲染出来而已。
 */

import { create } from "zustand";
import { DEFAULT_CHILD_ID } from "@/lib/config";
import type { AttemptResponse, Materials } from "@/lib/api/types";
import type { LocalTelemetry } from "@/lib/telemetry/tracker";

interface AppState {
  childId: number;
  /** POST /v1/sessions 返回；没有会话时仍可作答（契约允许 session_id 为 null） */
  sessionId: number | null;
  /** 材料只来自服务端响应（attempts / growth / build） */
  materials: Materials | null;
  /** 最近一次作答响应，供调试面板与奖励动画使用 */
  lastAttempt: AttemptResponse | null;
  /** 最近一次作答的三项时间，调试面板用它验证 ADR-0003 是否生效 */
  lastTelemetry: LocalTelemetry | null;

  setSessionId: (id: number | null) => void;
  setMaterials: (m: Materials | null) => void;
  recordAttempt: (attempt: AttemptResponse, telemetry: LocalTelemetry) => void;
}

export const useAppStore = create<AppState>((set) => ({
  childId: DEFAULT_CHILD_ID,
  sessionId: null,
  materials: null,
  lastAttempt: null,
  lastTelemetry: null,

  setSessionId: (id) => set({ sessionId: id }),
  setMaterials: (materials) => set({ materials }),
  recordAttempt: (lastAttempt, lastTelemetry) => set({ lastAttempt, lastTelemetry }),
}));
