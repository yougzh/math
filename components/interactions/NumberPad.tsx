"use client";

import { useCallback, useEffect, useState } from "react";
import { markActivity } from "@/lib/telemetry/tracker";
import { AnswerDisplay, NumberKeypad } from "./parts";
import type { InteractionProps } from "./types";

/**
 * number_pad —— 数字键盘输入。
 * 大按钮（≥56px）、大显示框，适合儿童手指；同时支持实体键盘数字 + 回车。
 */
export function NumberPad({ disabled, onSubmitAnswer }: InteractionProps) {
  const [value, setValue] = useState("");

  const submit = useCallback(() => {
    if (!value) return;
    onSubmitAnswer(Number(value));
    setValue("");
  }, [onSubmitAnswer, value]);

  // 实体键盘：数字 / 退格 / 回车。聚焦在输入类元素上时不接管。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (disabled) return;
      const el = document.activeElement;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (/^[0-9]$/.test(e.key)) {
        markActivity();
        setValue((v) => (v.length >= 3 ? v : v === "0" ? e.key : v + e.key));
      } else if (e.key === "Backspace") {
        markActivity();
        setValue((v) => v.slice(0, -1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [disabled, submit]);

  return (
    <div className="flex flex-col items-center gap-5">
      <AnswerDisplay value={value} />
      <div className="w-full max-w-md">
        <NumberKeypad value={value} onChange={setValue} onSubmit={submit} disabled={disabled} />
      </div>
      <p className="text-base text-world-soft">也可以用键盘打数字，再按回车。</p>
    </div>
  );
}
