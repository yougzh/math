"use client";

import { useCallback, useRef, useState } from "react";
import { markActivity } from "@/lib/telemetry/tracker";
import { KidButton } from "@/components/ui/KidButton";
import { InstructionBubble } from "./parts";
import type { InteractionProps } from "./types";

/**
 * number_line —— 数轴。
 *
 * 孩子把小人拖到（或点、或按方向键）正确的格子上，再交答案。
 * 三种输入方式并存：拖拽 / 点击数轴 / 键盘方向键（无障碍要求）。
 */
export function NumberLine({ item, disabled, onSubmitAnswer, onStageChange }: InteractionProps) {
  const problem = item.problem ?? {};
  const min = typeof problem.min === "number" ? problem.min : 0;
  const max = typeof problem.max === "number" ? problem.max : 20;
  const start = typeof problem.a === "number" ? problem.a : min;

  const [value, setValue] = useState(start);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const span = Math.max(1, max - min);
  const W = 700;
  const H = 120;
  const padX = 40;
  const y = 78;
  const xOf = (v: number) => padX + ((v - min) / span) * (W - padX * 2);

  const setFromClientX = useCallback(
    (clientX: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return;
      // 屏幕坐标 → viewBox 坐标 → 数值（按最近的刻度吸附）
      const viewBoxX = ((clientX - rect.left) / rect.width) * W;
      const t = (viewBoxX - padX) / (W - padX * 2);
      const snapped = Math.round(min + t * span);
      markActivity();
      setValue(Math.max(min, Math.min(max, snapped)));
    },
    [max, min, span],
  );

  const nudge = (delta: number) => {
    markActivity();
    setValue((v) => Math.max(min, Math.min(max, v + delta)));
  };

  const ticks = Array.from({ length: span + 1 }, (_, i) => min + i);
  const labelEvery = span > 12 ? 2 : 1;

  return (
    <div className="flex flex-col items-center gap-5">
      <InstructionBubble>
        把小人放到正确的格子上：从 <b>{start}</b> 出发，往右走 <b>{Math.abs(
          (typeof problem.b === "number" ? problem.b : 1),
        )}</b> 步。
      </InstructionBubble>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full max-w-2xl touch-none select-none"
        role="slider"
        tabIndex={0}
        aria-label="数轴"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={(e) => setFromClientX(e.clientX)}
        onPointerMove={(e) => {
          if (e.buttons === 1) setFromClientX(e.clientX);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowRight") {
            e.preventDefault();
            nudge(1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            nudge(-1);
          }
        }}
      >
        {/* 轴线 */}
        <line x1={padX} y1={y} x2={W - padX} y2={y} stroke="#d9cdb8" strokeWidth={6} strokeLinecap="round" />
        {ticks.map((t) => {
          const x = xOf(t);
          const isMajor = t % 5 === 0;
          return (
            <g key={t}>
              <line
                x1={x}
                y1={y - (isMajor ? 14 : 8)}
                x2={x}
                y2={y + (isMajor ? 14 : 8)}
                stroke={isMajor ? "#b9a88c" : "#e0d5c2"}
                strokeWidth={isMajor ? 3 : 2}
              />
              {t % labelEvery === 0 ? (
                <text
                  x={x}
                  y={y + 38}
                  textAnchor="middle"
                  fontSize={t === value ? 22 : 18}
                  fontWeight={t === value ? 800 : 500}
                  fill={t === value ? "#2f2a24" : "#8c8272"}
                >
                  {t}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* 起点标记 */}
        <g>
          <circle cx={xOf(start)} cy={y - 34} r={7} fill="#5aa9e6" />
          <text x={xOf(start)} y={y - 46} textAnchor="middle" fontSize={16} fill="#5aa9e6">
            起点
          </text>
        </g>

        {/* 拖动的小人 */}
        <g transform={`translate(${xOf(value)}, 0)`} className="transition-transform duration-150">
          <circle cx={0} cy={y} r={16} fill="#ffce54" stroke="#e0a800" strokeWidth={3} />
          <text x={0} y={y + 8} textAnchor="middle" fontSize={18} aria-hidden>
            🐰
          </text>
          <text x={0} y={y - 26} textAnchor="middle" fontSize={26} fontWeight={800} fill="#2f2a24">
            {value}
          </text>
        </g>
      </svg>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => nudge(-1)}
          disabled={disabled || value <= min}
          aria-label="往左一格"
          className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-kid-xl font-extrabold shadow-kid-sm disabled:opacity-40"
        >
          ←
        </button>
        <output className="min-w-[110px] text-center text-kid-2xl font-extrabold tabular-nums">
          {value}
        </output>
        <button
          type="button"
          onClick={() => nudge(1)}
          disabled={disabled || value >= max}
          aria-label="往右一格"
          className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-kid-xl font-extrabold shadow-kid-sm disabled:opacity-40"
        >
          →
        </button>
      </div>

      <KidButton
        variant="grass"
        disabled={disabled}
        onClick={() => {
          onStageChange?.("submitting");
          onSubmitAnswer(value, { method_used: "number_line" });
        }}
      >
        就停在这里！
      </KidButton>
    </div>
  );
}
