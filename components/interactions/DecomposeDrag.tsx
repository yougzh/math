"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { markActivity } from "@/lib/telemetry/tracker";
import { cn } from "@/lib/utils/cn";
import { DraggablePiece, DropZone, useTapGuard } from "./dnd";
import { AnswerDisplay, InstructionBubble, NumberKeypad, UnitBlock } from "./parts";
import type { InteractionProps } from "./types";

/**
 * decompose_drag —— 拆分拖拽。
 *
 * 题面形如 8 + 5：孩子把 5 拆成两块，第一块用来把 8 凑满 10，
 * 第二块留在外面。两块都放好后，界面上会出现「8 + 2 = 10」和「10 + 3 = ?」，
 * 孩子据此写出总数。
 *
 * 这里**不做本地判对错**（答案不下发，见契约 §0）：拆分不理想时只给方向性提示，
 * 真正的判定与服务端反馈走 POST /v1/attempts。
 */
export function DecomposeDrag({ item, disabled, onSubmitAnswer, onStageChange }: InteractionProps) {
  const problem = item.problem ?? {};
  const a = typeof problem.a === "number" ? problem.a : 8;
  const b = typeof problem.b === "number" ? problem.b : 5;
  const target = typeof problem.target === "number" ? problem.target : 10;
  const need = Math.max(0, Math.min(b, target - a));

  const chips = useMemo(() => Array.from({ length: b }, (_, i) => i + 1), [b]);
  const [slot, setSlot] = useState<Record<string, number | null>>({ first: null, second: null });
  const [value, setValue] = useState("");
  const guard = useTapGuard();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
  );

  const placed = Object.values(slot).filter((v): v is number => v !== null);
  const remaining = chips.filter((c) => !placed.includes(c));
  const bothFilled = slot.first !== null && slot.second !== null;
  const sum = (slot.first ?? 0) + (slot.second ?? 0);
  const splitOk = bothFilled && sum === b;
  const makesTen = slot.first === need && need > 0;
  const outside = slot.second ?? 0;

  const putInSlot = (chip: number, which: keyof typeof slot) => {
    markActivity();
    setSlot((prev) => {
      const next = { ...prev };
      // 同一个数字不能被用两次（每个 chip 只有一个）
      for (const key of Object.keys(next) as Array<keyof typeof next>) {
        if (next[key] === chip) next[key] = null;
      }
      next[which] = chip;
      return next;
    });
  };

  const clearSlot = (which: keyof typeof slot) => {
    markActivity();
    setSlot((prev) => ({ ...prev, [which]: null }));
  };

  const onDragEnd = (e: DragEndEvent) => {
    guard.noteDrop();
    const which = e.over?.id === "slot-first" ? "first" : e.over?.id === "slot-second" ? "second" : null;
    if (!which) return;
    const chip = Number(String(e.active.id).replace("chip-", ""));
    if (Number.isFinite(chip)) putInSlot(chip, which);
  };

  const submit = () => {
    if (!value) return;
    onStageChange?.("submitting");
    onSubmitAnswer(Number(value), { method_used: "decompose" });
  };

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd} onDragStart={() => guard.noteDrop()}>
      <div className="flex flex-col items-center gap-5">
        <InstructionBubble tone={makesTen && splitOk ? "good" : "calm"}>
          {!bothFilled
            ? `把 ${b} 拆成两块，拖到下面的方框里（也可以点一下数字）。`
            : makesTen && splitOk
              ? `漂亮！${a} + ${slot.first} = ${target}，外面还剩 ${outside} 个。`
              : `你已经拆成 ${slot.first} 和 ${slot.second}。想想怎么让 ${a} 先凑满 ${target}。`}
        </InstructionBubble>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <NumeralBoard value={a} tone="sun" label={`${a}`} />
          <span className="text-kid-2xl font-extrabold">+</span>
          <NumeralBoard value={b} tone="sea" label={`${b}`} />
          <span className="text-kid-2xl font-extrabold">= ?</span>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <DropZone id="slot-first" label="第一块" className="min-h-[92px] min-w-[120px]">
            <p className="mb-1 text-center text-base text-world-soft">先凑满 {target}</p>
            <div className="flex h-14 items-center justify-center">
              {slot.first === null ? (
                <span className="text-2xl text-[#c9bda8]">?</span>
              ) : (
                <button
                  type="button"
                  onClick={() => clearSlot("first")}
                  disabled={disabled}
                  className="flex h-14 w-14 items-center justify-center rounded-2xl bg-world-grass text-kid-xl font-extrabold"
                  aria-label={`取回第一块的 ${slot.first}`}
                >
                  {slot.first}
                </button>
              )}
            </div>
          </DropZone>

          <span className="text-kid-2xl font-extrabold">+</span>

          <DropZone id="slot-second" label="第二块" className="min-h-[92px] min-w-[120px]">
            <p className="mb-1 text-center text-base text-world-soft">留在外面</p>
            <div className="flex h-14 items-center justify-center">
              {slot.second === null ? (
                <span className="text-2xl text-[#c9bda8]">?</span>
              ) : (
                <button
                  type="button"
                  onClick={() => clearSlot("second")}
                  disabled={disabled}
                  className="flex h-14 w-14 items-center justify-center rounded-2xl bg-world-sun text-kid-xl font-extrabold"
                  aria-label={`取回第二块的 ${slot.second}`}
                >
                  {slot.second}
                </button>
              )}
            </div>
          </DropZone>
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          {remaining.map((chip) => (
            <DraggablePiece
              key={chip}
              id={`chip-${chip}`}
              disabled={disabled}
              canTap={guard.canTap}
              onTap={() => putInSlot(chip, slot.first === null ? "first" : "second")}
              label={`数字块 ${chip}`}
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-kid-xl font-extrabold shadow-kid-sm">
                {chip}
              </span>
            </DraggablePiece>
          ))}
          {remaining.length === 0 ? (
            <span className="text-base text-world-soft">数字块都用上啦</span>
          ) : null}
        </div>

        {bothFilled ? (
          <div className="flex flex-col items-center gap-1 rounded-kid bg-white px-5 py-3 shadow-kid-sm">
            <p className="text-kid-lg tabular-nums">
              {a} + {slot.first} = <b>{a + (slot.first ?? 0)}</b>
            </p>
            <p className="text-kid-lg tabular-nums">
              {a + (slot.first ?? 0)} + {outside} = <b>?</b>
            </p>
          </div>
        ) : null}

        <div className="flex flex-col items-center gap-3">
          <p className="text-kid-lg font-bold">一共是多少个？</p>
          <AnswerDisplay value={value} />
          <div className="w-full max-w-md">
            <NumberKeypad value={value} onChange={setValue} onSubmit={submit} disabled={disabled} />
          </div>
        </div>
      </div>
    </DndContext>
  );
}

function NumeralBoard({
  value,
  label,
  tone,
  className,
}: {
  value: number;
  label: string;
  tone: "sun" | "sea";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-kid px-4 py-3 shadow-kid-sm",
        tone === "sun" ? "bg-world-sun" : "bg-[#dcefff]",
        className,
      )}
      aria-label={`${label}`}
    >
      <span className="text-kid-2xl font-extrabold tabular-nums">{value}</span>
      <span className="flex flex-wrap justify-center gap-1" aria-hidden>
        {Array.from({ length: Math.min(value, 20) }).map((_, i) => (
          <UnitBlock key={i} small tone={tone === "sun" ? "one" : "moved"} />
        ))}
      </span>
    </div>
  );
}
