import type { Item, MethodUsed } from "@/lib/api/types";

/** 交互组件统一回调：value 是原始作答值，交给服务端判定 */
export type InteractionAnswer = number | string;

export interface InteractionProps {
  item: Item;
  /** 反馈播放期间禁止再次提交 */
  disabled?: boolean;
  onSubmitAnswer: (value: InteractionAnswer, meta?: { method_used?: MethodUsed }) => void;
  /** 阶段变化（如「摆积木」→「写答案」），用于调试面板观察交互轨迹 */
  onStageChange?: (stage: string) => void;
}

/** 从 problem 里安全地取数字，避免任何组件因字段缺失而崩 */
export function readNumber(
  problem: Item["problem"] | null | undefined,
  key: string,
  fallback: number,
): number {
  const raw = problem?.[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
