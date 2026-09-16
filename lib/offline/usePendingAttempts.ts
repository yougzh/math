"use client";

import { useEffect, useState } from "react";
import {
  flushPendingAttempts,
  getPendingAttempts,
  initPendingAttemptFlush,
  subscribePendingAttempts,
} from "./attemptQueue";
import type { PendingAttempt } from "./attemptQueue";

/** 订阅待补交队列（用于「有 2 条记录稍后自动补交」这类温和提示） */
export function usePendingAttempts(): PendingAttempt[] {
  const [pending, setPending] = useState<PendingAttempt[]>([]);

  useEffect(() => {
    setPending(getPendingAttempts());
    const unsubscribe = subscribePendingAttempts(setPending);
    const stopListening = initPendingAttemptFlush();
    return () => {
      unsubscribe();
      stopListening();
    };
  }, []);

  return pending;
}

/** 手动触发一次重放（家长/调试用） */
export async function retryPendingAttempts() {
  return flushPendingAttempts();
}
