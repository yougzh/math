"use client";

import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { markActivity } from "@/lib/telemetry/tracker";
import { DraggablePiece, DropZone, useTapGuard } from "./dnd";
import { AnswerDisplay, InstructionBubble, NumberKeypad, TenRod, UnitBlock } from "./parts";
import type { InteractionProps } from "./types";

/**
 * carry_exchange —— 进位交换。
 *
 * 27 + 15：个位 7 + 5 = 12，满十了。孩子把 10 个「一」拖进捆扎区，
 * 换成一捆「十」飞到十位上；剩下的 2 个留在个位。然后写出一共多少。
 *
 * 捆扎是**自动完成**的：凑满 10 个立刻捆好（并给一句提示），
 * 不要求孩子理解「先放满再点按钮」，减少操作负担。
 */
export function CarryExchange({ item, disabled, onSubmitAnswer, onStageChange }: InteractionProps) {
  const problem = item.problem ?? {};
  const a = typeof problem.a === "number" ? problem.a : 27;
  const b = typeof problem.b === "number" ? problem.b : 15;

  const aTens = Math.floor(a / 10);
  const aOnes = a % 10;
  const bTens = Math.floor(b / 10);
  const bOnes = b % 10;

  const onesTotal = aOnes + bOnes;
  const [bundles, setBundles] = useState(0); // 已经捆好的「十」
  const [inBundle, setInBundle] = useState(0); // 捆扎区里现有的「一」
  const [value, setValue] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  const bundledOnes = bundles * 10;
  const loose = Math.max(0, onesTotal - bundledOnes - inBundle);
  const tensNow = aTens + bTens + bundles;
  const onesNow = onesTotal - bundledOnes;
  const guard = useTapGuard();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
  );

  /** 把一个「一」放进捆扎区；满 10 个立刻捆成一捆「十」 */
  const putOne = () => {
    markActivity();
    if (disabled || loose <= 0) return;
    const next = inBundle + 1;
    if (next >= 10) {
      setInBundle(0);
      setBundles((n) => n + 1);
      setFlash("十个一凑齐，捆成一捆十！它飞到十位上了。");
    } else {
      setInBundle(next);
      setFlash(null);
    }
  };

  const takeOneBack = () => {
    markActivity();
    if (disabled || inBundle <= 0) return;
    setInBundle((n) => n - 1);
    setFlash(null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    guard.noteDrop();
    if (e.over?.id === "bundle-zone") putOne();
  };

  const submit = () => {
    if (!value) return;
    onStageChange?.("submitting");
    onSubmitAnswer(Number(value), { method_used: "make_ten" });
  };

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd} onDragStart={() => guard.noteDrop()}>
      <div className="flex flex-col items-center gap-5">
        <InstructionBubble tone={bundles > 0 ? "good" : "calm"}>
          {flash ?? `个位加起来是 ${onesTotal}，比 10 大了。把 10 个「一」拖进中间的捆扎区，换成一捆「十」。`}
        </InstructionBubble>

        <div className="flex flex-wrap items-end justify-center gap-4">
          {/* 十位 */}
          <div className="flex min-w-[150px] flex-col items-center gap-2 rounded-kid bg-white p-3 shadow-kid-sm">
            <p className="text-kid-lg font-bold">十位</p>
            <div className="flex min-h-[56px] flex-wrap items-center justify-center gap-1">
              {Array.from({ length: aTens + bTens }).map((_, i) => (
                <TenRod key={i} small />
              ))}
              {Array.from({ length: bundles }).map((_, i) => (
                <span key={`b${i}`} className="animate-popin">
                  <TenRod small />
                </span>
              ))}
            </div>
            <p className="text-base text-world-soft tabular-nums">
              {aTens} + {bTens}
              {bundles > 0 ? ` + ${bundles}` : ""} = {tensNow} 个十
            </p>
          </div>

          {/* 捆扎区 */}
          <DropZone id="bundle-zone" label="捆扎区" className="min-h-[140px] min-w-[150px]">
            <p className="mb-1 text-center text-base text-world-soft">捆扎区</p>
            <div
              className="flex min-h-[64px] flex-wrap items-center justify-center gap-1.5 rounded-xl bg-[#fff8ea] p-2"
              onClick={takeOneBack}
              role="presentation"
            >
              {inBundle === 0 ? (
                <span className="px-2 text-center text-base text-[#b9ab93]">
                  把「一」拖到这里
                </span>
              ) : (
                Array.from({ length: inBundle }).map((_, i) => <UnitBlock key={i} small tone="moved" />)
              )}
            </div>
            <p className="mt-1 text-center text-base tabular-nums text-world-soft">
              {inBundle} / 10
            </p>
          </DropZone>

          {/* 个位 */}
          <div className="flex min-w-[150px] flex-col items-center gap-2 rounded-kid bg-white p-3 shadow-kid-sm">
            <p className="text-kid-lg font-bold">个位</p>
            <div className="flex min-h-[56px] max-w-[200px] flex-wrap items-center justify-center gap-1.5">
              {Array.from({ length: loose }).map((_, i) => (
                <DraggablePiece
                  key={i}
                  id={`one-${i}`}
                  disabled={disabled}
                  canTap={guard.canTap}
                  onTap={putOne}
                  label={`一个，点一下放进捆扎区`}
                >
                  <UnitBlock small />
                </DraggablePiece>
              ))}
              {loose === 0 ? <span className="text-base text-world-soft">空</span> : null}
            </div>
            <p className="text-base text-world-soft tabular-nums">还剩 {onesNow} 个一</p>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-kid bg-white px-5 py-3 shadow-kid-sm">
          <span className="text-kid-lg tabular-nums">
            {aTens} 个十 {aOnes} 个一 ＋ {bTens} 个十 {bOnes} 个一
          </span>
        </div>

        <div className="flex flex-col items-center gap-3">
          <p className="text-kid-lg font-bold">一共是多少？</p>
          <AnswerDisplay value={value} />
          <div className="w-full max-w-md">
            <NumberKeypad value={value} onChange={setValue} onSubmit={submit} disabled={disabled} />
          </div>
        </div>
      </div>
    </DndContext>
  );
}
