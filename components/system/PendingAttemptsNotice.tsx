"use client";

import { useState } from "react";
import { retryPendingAttempts, usePendingAttempts } from "@/lib/offline/usePendingAttempts";

/**
 * 断网补交通知。
 *
 * 语气刻意温和：孩子不需要为网络问题负责，也不该看到「提交失败」这种字眼。
 * 幂等键（client_attempt_id）保证重放不会重复计数，所以这里可以放心自动重试。
 */
export function PendingAttemptsNotice() {
  const pending = usePendingAttempts();
  const [retrying, setRetrying] = useState(false);

  if (pending.length === 0) return null;

  return (
    <div className="fixed bottom-3 right-3 z-40 max-w-[86vw] rounded-kid border-2 border-[#f0cf74] bg-[#fff8e3] px-4 py-3 shadow-soft">
      <p className="text-base">
        🐻 有 {pending.length} 道题先被小熊收好了，网络好了会自动送出去。
      </p>
      <button
        type="button"
        className="mt-2 rounded-pill bg-white px-3 py-1 text-base shadow-kid-sm"
        onClick={async () => {
          setRetrying(true);
          await retryPendingAttempts();
          setRetrying(false);
        }}
        disabled={retrying}
      >
        {retrying ? "正在送…" : "现在就送"}
      </button>
    </div>
  );
}
