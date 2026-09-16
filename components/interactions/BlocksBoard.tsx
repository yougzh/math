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
import { KidButton } from "@/components/ui/KidButton";
import { cn } from "@/lib/utils/cn";
import { DraggablePiece, DropZone, useTapGuard } from "./dnd";
import { AnswerDisplay, InstructionBubble, NumberKeypad, TenFrame, TenRod, UnitBlock } from "./parts";
import type { InteractionProps } from "./types";

type Zone = "pool" | "frame" | "outside";
/** 内容侧用 problem.op 区分加法 / 减法（真实内容里减法题是 "sub"） */
type Op = "add" | "sub";

/**
 * blocks —— 十格框 + 可拖拽积木。
 *
 * 两种场景共用同一个组件（都来自 `interaction_type: "blocks"`）：
 * 1) 加减法场景（problem 带 a / b）：从积木堆里拿积木，把十格框补满，
 *    再看外面剩几个，最后写出得数。problem.op === "sub" 时是「拿走」的减法。
 * 2) 位值场景（problem 只带 target，例如 23）：用「十」长条和「一」方块摆出这个数。
 *
 * 拖拽用 dnd-kit；同时支持「点一下」把积木送去下一个区域 —— 触屏上拖不准的孩子也能玩。
 */
export function BlocksBoard({ item, disabled, onSubmitAnswer, onStageChange }: InteractionProps) {
  const problem = item.problem ?? {};
  const a = typeof problem.a === "number" ? problem.a : null;
  const b = typeof problem.b === "number" ? problem.b : null;
  const target = typeof problem.target === "number" ? problem.target : 10;
  const op: Op = problem.op === "sub" ? "sub" : "add";

  if (a !== null && b !== null) {
    return (
      <ManipulativeBlocks
        a={a}
        b={b}
        op={op}
        capacity={target}
        disabled={disabled}
        onSubmitAnswer={onSubmitAnswer}
        onStageChange={onStageChange}
      />
    );
  }

  return (
    <PlaceValueBlocks
      target={typeof problem.target === "number" ? problem.target : 10}
      disabled={disabled}
      onSubmitAnswer={onSubmitAnswer}
      onStageChange={onStageChange}
    />
  );
}

// ─────────────────────────────────────────────
// 场景 1：十格框（加法补满 / 减法拿走）
// ─────────────────────────────────────────────

function ManipulativeBlocks({
  a,
  b,
  op,
  capacity,
  disabled,
  onSubmitAnswer,
  onStageChange,
}: {
  a: number;
  b: number;
  op: Op;
  capacity: number;
  disabled?: boolean;
  onSubmitAnswer: InteractionProps["onSubmitAnswer"];
  onStageChange?: InteractionProps["onStageChange"];
}) {
  const total = op === "sub" ? a : a + b;
  const ids = useMemo(() => Array.from({ length: total }, (_, i) => `u${i}`), [total]);
  // 减法：一开始就把被减数摆进框里，孩子把要拿走的拖出去
  const [place, setPlace] = useState<Record<string, Zone>>(() => {
    const init: Record<string, Zone> = {};
    ids.forEach((id, i) => (init[id] = op === "sub" && i < capacity ? "frame" : "pool"));
    return init;
  });
  const [value, setValue] = useState("");
  const guard = useTapGuard();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
  );

  const inZone = (zone: Zone) => ids.filter((id) => place[id] === zone);
  const frameIds = inZone("frame").slice(0, capacity);
  const frameCount = frameIds.length;
  const frameFull = frameCount >= capacity;
  const takenAway = inZone("outside").length;

  const move = (id: string, zone: Zone) => {
    markActivity();
    setPlace((prev) => (prev[id] === zone ? prev : { ...prev, [id]: zone }));
  };

  /** 点一下：pool → frame → outside → pool */
  const cycle = (id: string) => {
    const order: Zone[] = ["pool", "frame", "outside"];
    const current = place[id] ?? "pool";
    if (current === "pool" && frameIds.length >= capacity) {
      // 框满了就不再往里塞，避免视觉上「塞不进去」让孩子困惑
      move(id, "outside");
      return;
    }
    const next = order[(order.indexOf(current) + 1) % order.length];
    // 不可达：order 非空且取模保证下标在界内。仅为满足 noUncheckedIndexedAccess 收窄。
    if (next === undefined) return;
    move(id, next);
  };

  const onDragEnd = (e: DragEndEvent) => {
    guard.noteDrop();
    const zone = e.over?.id as Zone | undefined;
    if (!zone) return;
    if (zone === "frame" && frameIds.length >= capacity && place[String(e.active.id)] !== "frame") {
      move(String(e.active.id), "outside");
      return;
    }
    move(String(e.active.id), zone);
  };

  const submit = () => {
    if (!value) return;
    onStageChange?.("submitting");
    onSubmitAnswer(Number(value), { method_used: "visual_blocks" });
  };

  const instruction =
    op === "sub"
      ? frameFull || takenAway > 0
        ? `框里原本有 ${a} 个。拿走 ${b} 个放到右边的框里，再数一数还剩几个。`
        : `框里有 ${a} 个积木。把 ${b} 个拖到右边「拿走的」，看看还剩几个。`
      : frameFull
        ? `十格框满啦！一个满框就是 ${capacity}，再看看外面还剩几个。`
        : `把积木拖进十格框（也可以点一下积木）。先摆出 ${a} 个，再摆出 ${b} 个。`;

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd} onDragStart={() => guard.noteDrop()}>
      <div className="flex flex-col items-center gap-5">
        <InstructionBubble tone={op === "sub" ? (takenAway >= b ? "good" : "calm") : frameFull ? "good" : "calm"}>
          {instruction}
        </InstructionBubble>

        <div className="flex w-full flex-col items-center gap-4 lg:flex-row lg:items-start lg:justify-center">
          <DropZone id="frame" label="十格框" className="shrink-0">
            <TenFrame
              highlightFull={frameFull}
              capacity={capacity}
              cells={frameIds.map((id) => (
                <DraggablePiece
                  key={id}
                  id={id}
                  disabled={disabled}
                  canTap={guard.canTap}
                  onTap={() => cycle(id)}
                  label={`${id}，点一下移动`}
                >
                  <UnitBlock tone="moved" />
                </DraggablePiece>
              ))}
            />
            <p className="mt-2 text-center text-base text-world-soft">
              十格框里：<b className="tabular-nums">{frameCount}</b> 个
            </p>
          </DropZone>

          <div className="flex flex-col gap-3">
            <DropZone id="outside" label={op === "sub" ? "拿走的" : "框外"} className="min-h-[96px] min-w-[180px]">
              <p className="mb-1 text-base text-world-soft">{op === "sub" ? "拿走的" : "框外"}</p>
              <div className="flex flex-wrap gap-1.5">
                {inZone("outside").map((id) => (
                  <DraggablePiece
                    key={id}
                    id={id}
                    disabled={disabled}
                    canTap={guard.canTap}
                    onTap={() => cycle(id)}
                    label={`${id}，点一下移动`}
                  >
                    <UnitBlock tone={op === "sub" ? "moved" : "one"} />
                  </DraggablePiece>
                ))}
              </div>
            </DropZone>

            <DropZone id="pool" label={op === "sub" ? "还没拿的" : "积木堆"} className="min-h-[96px] min-w-[180px]">
              <p className="mb-1 text-base text-world-soft">{op === "sub" ? "还没拿的" : "积木堆"}</p>
              <div className="flex flex-wrap gap-1.5">
                {inZone("pool").map((id) => (
                  <DraggablePiece
                    key={id}
                    id={id}
                    disabled={disabled}
                    canTap={guard.canTap}
                    onTap={() => cycle(id)}
                    label={`${id}，点一下移动`}
                  >
                    <UnitBlock tone="one" />
                  </DraggablePiece>
                ))}
              </div>
            </DropZone>
          </div>
        </div>

        <div className="flex flex-col items-center gap-3">
          <p className="text-kid-lg font-bold">{op === "sub" ? "还剩几个？" : "一共是多少个？"}</p>
          {op === "sub" ? (
            <p className="text-base text-world-soft">
              拿走 <b className="tabular-nums">{takenAway}</b> 个了
              {takenAway === b ? "，就是这些，数数框里还剩几个。" : `，要拿走 ${b} 个。`}
            </p>
          ) : null}
          <AnswerDisplay value={value} />
          <div className="w-full max-w-md">
            <NumberKeypad value={value} onChange={setValue} onSubmit={submit} disabled={disabled} />
          </div>
        </div>
      </div>
    </DndContext>
  );
}

// ─────────────────────────────────────────────
// 场景 2：用十和摆出一个数（位值表征）
// ─────────────────────────────────────────────

function PlaceValueBlocks({
  target,
  disabled,
  onSubmitAnswer,
  onStageChange,
}: {
  target: number;
  disabled?: boolean;
  onSubmitAnswer: InteractionProps["onSubmitAnswer"];
  onStageChange?: InteractionProps["onStageChange"];
}) {
  const [rods, setRods] = useState(0);
  const [units, setUnits] = useState(0);
  const total = rods * 10 + units;
  const maxRods = Math.max(9, Math.floor(target / 10) + 2);

  const step = (kind: "rods" | "units", delta: number) => {
    markActivity();
    if (kind === "rods") setRods((v) => Math.max(0, Math.min(maxRods, v + delta)));
    else setUnits((v) => Math.max(0, Math.min(9, v + delta)));
  };

  return (
    <div className="flex flex-col items-center gap-5">
      <InstructionBubble>
        摆出 <b>{target}</b>：一捆十等于 10 个一。用下面的 ＋ 和 − 调整。
      </InstructionBubble>

      <div className="flex flex-wrap items-start justify-center gap-5">
        <AdjustColumn
          label="十"
          hint={`${rods} 个十 = ${rods * 10}`}
          disabled={disabled}
          onMinus={() => step("rods", -1)}
          onPlus={() => step("rods", 1)}
          visual={<TenRod count={Math.min(rods, 9)} small />}
        />
        <AdjustColumn
          label="一"
          hint={`${units} 个一`}
          disabled={disabled}
          onMinus={() => step("units", -1)}
          onPlus={() => step("units", 1)}
          visual={
            <span className="flex max-w-[220px] flex-wrap gap-1">
              {Array.from({ length: units }).map((_, i) => (
                <UnitBlock key={i} small />
              ))}
            </span>
          }
        />
      </div>

      <div className="flex items-center gap-3 rounded-kid bg-white px-5 py-3 shadow-kid-sm">
        <span className="text-kid-lg">
          {rods} 个十 + {units} 个一 =
        </span>
        <b className="text-kid-2xl tabular-nums">{total}</b>
      </div>
      {total === target ? (
        <p className="text-kid text-[#1f5c14]">摆对啦！可以交答案了。</p>
      ) : null}

      <KidButton
        variant="grass"
        disabled={disabled}
        onClick={() => {
          onStageChange?.("submitting");
          onSubmitAnswer(total, { method_used: "visual_blocks" });
        }}
      >
        就是这个数！
      </KidButton>
    </div>
  );
}

function AdjustColumn({
  label,
  hint,
  visual,
  onMinus,
  onPlus,
  disabled,
}: {
  label: string;
  hint: string;
  visual: React.ReactNode;
  onMinus: () => void;
  onPlus: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-[220px] flex-col items-center gap-2 rounded-kid bg-white p-4 shadow-kid-sm">
      <p className="text-kid-lg font-bold">{label}</p>
      <div className="flex min-h-[44px] items-center justify-center">{visual}</div>
      <p className="text-base text-world-soft tabular-nums">{hint}</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onMinus}
          disabled={disabled}
          aria-label={`减少一个${label}`}
          className={cn("flex h-14 w-14 items-center justify-center rounded-2xl bg-[#f6ece0] text-kid-xl font-extrabold shadow-kid-sm active:translate-y-[2px]")}
        >
          −
        </button>
        <button
          type="button"
          onClick={onPlus}
          disabled={disabled}
          aria-label={`增加一个${label}`}
          className={cn("flex h-14 w-14 items-center justify-center rounded-2xl bg-world-sun text-kid-xl font-extrabold shadow-kid-sm active:translate-y-[2px]")}
        >
          ＋
        </button>
      </div>
    </div>
  );
}
