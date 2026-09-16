"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { markActivity } from "@/lib/telemetry/tracker";

/** 引导气泡：一次只说一句话，不催促 */
export function InstructionBubble({
  children,
  tone = "calm",
  className,
}: {
  children: ReactNode;
  tone?: "calm" | "warn" | "good";
  className?: string;
}) {
  const tones = {
    calm: "bg-white text-world-ink",
    warn: "bg-[#fff4e0] text-[#8a5a00]",
    good: "bg-[#eaf9e6] text-[#1f5c14]",
  } as const;
  return (
    <p
      className={cn(
        "rounded-kid px-4 py-3 text-kid shadow-kid-sm",
        tones[tone],
        className,
      )}
      role="note"
    >
      {children}
    </p>
  );
}

/** 一与十的可视化积木 */
export function UnitBlock({
  className,
  small,
  tone = "one",
}: {
  className?: string;
  small?: boolean;
  tone?: "one" | "moved" | "ten";
}) {
  const tones = {
    one: "bg-world-sun border-[#e0a800]",
    moved: "bg-world-grass border-[#4f9c3f]",
    ten: "bg-world-wood border-[#a06a3c]",
  } as const;
  return (
    <span
      className={cn(
        "inline-block rounded-[6px] border-2",
        small ? "h-5 w-5" : "h-7 w-7",
        tones[tone],
        className,
      )}
      aria-hidden
    />
  );
}

/** 1 个「十」= 一根长条 */
export function TenRod({ count = 1, small }: { count?: number; small?: boolean }) {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "relative inline-block rounded-[6px] border-2 border-[#a06a3c] bg-world-wood",
            small ? "h-5 w-12" : "h-7 w-20",
          )}
        >
          <span className="absolute inset-0 flex items-center justify-between px-[3px]">
            {Array.from({ length: 9 }).map((__, k) => (
              <span key={k} className="h-full w-[1.5px] bg-[#a06a3c]/50" />
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * 十格框：5 + 5 两排，满十高亮。
 * `cells` 长度固定为 capacity，元素为空表示空格。
 */
export function TenFrame({
  cells,
  capacity = 10,
  highlightFull,
  className,
}: {
  cells: (ReactNode | null)[];
  capacity?: number;
  highlightFull?: boolean;
  className?: string;
}) {
  const padded = [...cells];
  while (padded.length < capacity) padded.push(null);

  return (
    <div
      className={cn(
        "inline-block rounded-2xl border-4 p-2 transition-colors",
        highlightFull ? "border-world-grass bg-[#f2fbef]" : "border-[#d9cdb8] bg-white",
        className,
      )}
      role="group"
      aria-label={`十格框，已放入 ${cells.filter(Boolean).length} 个`}
    >
      <div className="grid grid-cols-5 gap-1.5">
        {padded.slice(0, 5).map((cell, i) => (
          <FrameCell key={i}>{cell}</FrameCell>
        ))}
      </div>
      <div className="my-1.5 h-[3px] rounded bg-[#e7dcc8]" />
      <div className="grid grid-cols-5 gap-1.5">
        {padded.slice(5, 10).map((cell, i) => (
          <FrameCell key={i + 5}>{cell}</FrameCell>
        ))}
      </div>
    </div>
  );
}

function FrameCell({ children }: { children: ReactNode | null }) {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#f7f1e6] sm:h-10 sm:w-10">
      {children}
    </div>
  );
}

/**
 * 数字键盘（大按钮，≥48px，触屏与键盘都可用）。
 * 被 number_pad 与积木/拆分/进位等组件共用。
 */
export function NumberKeypad({
  value,
  onChange,
  onSubmit,
  disabled,
  submitLabel = "就是这个数！",
  compact,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  submitLabel?: string;
  compact?: boolean;
}) {
  const press = (digit: string) => {
    markActivity();
    if (digit === "del") {
      onChange(value.slice(0, -1));
      return;
    }
    if (value.length >= 3) return;
    onChange(value === "0" ? digit : value + digit);
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "del"];

  return (
    <div className="flex w-full flex-col gap-3">
      <div
        className={cn("grid gap-2", compact ? "grid-cols-6" : "grid-cols-3 sm:grid-cols-6")}
        role="group"
        aria-label="数字键盘"
      >
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            disabled={disabled}
            aria-label={k === "del" ? "删掉一个数字" : `数字 ${k}`}
            className={cn(
              "flex min-h-[56px] select-none items-center justify-center rounded-2xl bg-white text-kid-xl font-extrabold shadow-kid-sm transition active:translate-y-[2px] disabled:opacity-50",
              k === "del" && "bg-[#f6ece0] text-world-soft",
            )}
          >
            {k === "del" ? "⌫" : k}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          markActivity();
          onSubmit();
        }}
        disabled={disabled || value.length === 0}
        className="kid-btn w-full bg-world-grass text-[#123d0a] shadow-kid disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </div>
  );
}

/** 大号答案显示框 */
export function AnswerDisplay({
  value,
  placeholder = "?",
  className,
}: {
  value: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <output
      className={cn(
        "flex min-h-[76px] min-w-[140px] items-center justify-center rounded-2xl border-4 border-dashed border-[#d9cdb8] bg-white px-6 text-[2.5rem] font-extrabold tabular-nums",
        value ? "border-solid border-world-sea text-world-ink" : "text-[#c9bda8]",
        className,
      )}
      aria-live="polite"
    >
      {value || placeholder}
    </output>
  );
}
