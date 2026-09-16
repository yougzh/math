"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { markActivity } from "@/lib/telemetry/tracker";
import { KidButton } from "@/components/ui/KidButton";
import { TenRod, UnitBlock, InstructionBubble } from "@/components/interactions/parts";

/**
 * 数学实验室 · 数字积木
 *
 * 自由探索：23 = 2 个十 + 3 个一，孩子可以随便加减，看数字怎么变。
 * **不判定、不记录、不计入熟练度**（契约 §7：实验室不计入熟练度状态）。
 */
export function LabBlocks() {
  const [rods, setRods] = useState(2);
  const [units, setUnits] = useState(3);
  const total = rods * 10 + units;

  const step = (kind: "rods" | "units", delta: number) => {
    markActivity();
    if (kind === "rods") setRods((v) => Math.max(0, Math.min(9, v + delta)));
    else setUnits((v) => Math.max(0, Math.min(9, v + delta)));
  };

  const surprise = () => {
    markActivity();
    const n = Math.floor(Math.random() * 90) + 10;
    setRods(Math.floor(n / 10));
    setUnits(n % 10);
  };

  return (
    <div className="flex flex-col gap-5">
      <InstructionBubble>
        随便玩：加一捆「十」或者加一个「一」，看看数字怎么变。
      </InstructionBubble>

      <div className="flex flex-wrap items-start justify-center gap-5">
        <LabColumn
          title="十"
          hint={`${rods} 个十 = ${rods * 10}`}
          onMinus={() => step("rods", -1)}
          onPlus={() => step("rods", 1)}
          visual={
            <div className="flex max-w-[260px] flex-wrap gap-1.5">
              {Array.from({ length: rods }).map((_, i) => (
                <TenRod key={i} />
              ))}
              {rods === 0 ? <span className="text-base text-world-soft">还没有十</span> : null}
            </div>
          }
        />
        <LabColumn
          title="一"
          hint={`${units} 个一`}
          onMinus={() => step("units", -1)}
          onPlus={() => step("units", 1)}
          visual={
            <div className="flex max-w-[260px] flex-wrap gap-1.5">
              {Array.from({ length: units }).map((_, i) => (
                <UnitBlock key={i} />
              ))}
              {units === 0 ? <span className="text-base text-world-soft">还没有一</span> : null}
            </div>
          }
        />
      </div>

      <motion.div
        key={total}
        initial={{ scale: 0.96 }}
        animate={{ scale: 1 }}
        className="flex flex-col items-center gap-1 rounded-kid bg-white px-6 py-4 shadow-kid-sm"
      >
        <p className="text-kid-xl font-extrabold tabular-nums">
          {rods} 个十 和 {units} 个一
        </p>
        <p className="text-kid-2xl font-extrabold tabular-nums text-world-sea">= {total}</p>
        <p className="text-base text-world-soft">
          十位上是 {rods}，个位上是 {units}
        </p>
      </motion.div>

      <div className="flex justify-center">
        <KidButton variant="sun" onClick={surprise}>
          🎲 随便给我一个数
        </KidButton>
      </div>
    </div>
  );
}

function LabColumn({
  title,
  hint,
  visual,
  onMinus,
  onPlus,
}: {
  title: string;
  hint: string;
  visual: React.ReactNode;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <div className="flex min-w-[240px] flex-1 flex-col items-center gap-3 rounded-kid bg-white p-4 shadow-kid-sm">
      <p className="text-kid-lg font-bold">{title}</p>
      <div className="flex min-h-[64px] items-center justify-center">{visual}</div>
      <p className="text-base text-world-soft tabular-nums">{hint}</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onMinus}
          aria-label={`减少一${title}`}
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#f6ece0] text-kid-xl font-extrabold shadow-kid-sm active:translate-y-[2px]"
        >
          −
        </button>
        <button
          type="button"
          onClick={onPlus}
          aria-label={`增加一${title}`}
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-world-sun text-kid-xl font-extrabold shadow-kid-sm active:translate-y-[2px]"
        >
          ＋
        </button>
      </div>
    </div>
  );
}
