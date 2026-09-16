"use client";

import { KidButton } from "./KidButton";

/**
 * 网络失败时的兜底界面。
 * 对孩子的说法永远是「小状况」，不出现错误码、不出现红色警告。
 */
export function ErrorState({
  message,
  onRetry,
  hint,
}: {
  message: string;
  onRetry?: () => void;
  hint?: string;
}) {
  return (
    <div className="kid-card mx-auto flex max-w-xl flex-col items-center gap-4 text-center">
      <div className="text-5xl" aria-hidden>
        🐻‍❄️
      </div>
      <p className="text-kid-lg font-bold">小熊没找到路</p>
      <p className="text-kid text-world-soft">{message}</p>
      {hint ? <p className="text-base text-world-soft">{hint}</p> : null}
      {onRetry ? (
        <KidButton variant="sun" onClick={onRetry}>
          再试一次
        </KidButton>
      ) : null}
    </div>
  );
}

export function EmptyState({ emoji = "🍃", text }: { emoji?: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-kid bg-white/60 p-8 text-center">
      <span className="text-4xl" aria-hidden>
        {emoji}
      </span>
      <p className="text-kid text-world-soft">{text}</p>
    </div>
  );
}
