"use client";

import { useState } from "react";
import { markActivity } from "@/lib/telemetry/tracker";
import { cn } from "@/lib/utils/cn";
import { KidButton } from "@/components/ui/KidButton";
import type { InteractionProps } from "./types";

/** 选项可能是字符串，也可能是 {value,label} —— 契约未规定元素结构，这里都接受 */
function normalizeChoices(raw: unknown): Array<{ value: string; label: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "string" || typeof item === "number") {
      return { value: String(item), label: String(item) };
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const value = obj.value ?? obj.code ?? obj.label;
      const label = obj.label ?? obj.text ?? obj.value ?? obj.code;
      return { value: String(value ?? ""), label: String(label ?? "") };
    }
    return { value: "", label: "" };
  });
}

/**
 * choice —— 选项列表。
 * 先选中，再确认；重复点同一个选项等同确认（孩子容易直接连点两下）。
 */
export function ChoiceList({ item, disabled, onSubmitAnswer }: InteractionProps) {
  const choices = normalizeChoices(item.choices);
  const [selected, setSelected] = useState<string | null>(null);

  if (choices.length === 0) {
    return (
      <p className="rounded-kid bg-[#fff4e0] px-4 py-3 text-kid text-[#8a5a00]">
        这道题还没有选项，先跳过吧。
      </p>
    );
  }

  const pick = (value: string) => {
    markActivity();
    if (selected === value) {
      onSubmitAnswer(value);
      return;
    }
    setSelected(value);
  };

  return (
    <div className="flex flex-col gap-4">
      <ul className="grid gap-3 sm:grid-cols-2">
        {choices.map((choice) => {
          const active = selected === choice.value;
          return (
            <li key={choice.value}>
              <button
                type="button"
                onClick={() => pick(choice.value)}
                disabled={disabled}
                aria-pressed={active}
                className={cn(
                  "flex min-h-[68px] w-full items-center justify-center rounded-kid border-4 bg-white text-kid-xl font-extrabold shadow-kid-sm transition active:translate-y-[2px] disabled:opacity-60",
                  active ? "border-world-sea bg-[#eaf6ff]" : "border-[#eee3d0]",
                )}
              >
                {choice.label}
              </button>
            </li>
          );
        })}
      </ul>
      <KidButton
        variant="grass"
        disabled={disabled || !selected}
        onClick={() => selected && onSubmitAnswer(selected)}
      >
        就选它
      </KidButton>
    </div>
  );
}
