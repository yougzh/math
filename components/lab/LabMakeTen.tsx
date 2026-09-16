"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { markActivity } from "@/lib/telemetry/tracker";
import { TenFrame, UnitBlock, InstructionBubble } from "@/components/interactions/parts";

/**
 * 数学实验室 · 凑十
 *
 * 8 + 5 → 8 + 2 + 3 → 13：孩子亲手把「5」里的 2 个搬进十格框，
 * 让 8 变成 10，剩下的 3 就留在外面。数字可以随便换，随便试。
 * 实验室自由探索，**不计入熟练度**。
 */
export function LabMakeTen() {
  const [a, setA] = useState(8);
  const [b, setB] = useState(5);
  const [moved, setMoved] = useState(0);

  useEffect(() => {
    setMoved(0);
  }, [a, b]);

  const target = 10;
  const need = Math.max(0, Math.min(b, target - a));
  const inFrameA = Math.min(a, target);
  const frameCount = inFrameA + moved;
  const full = frameCount >= target;
  const outside = Math.max(0, b - moved);

  const moveOne = () => {
    markActivity();
    setMoved((m) => Math.min(need, m + 1));
  };

  const reset = () => {
    markActivity();
    setMoved(0);
  };

  return (
    <div className="flex flex-col gap-5">
      <InstructionBubble tone={full ? "good" : "calm"}>
        {full
          ? `十格框满啦：${a} + ${moved} = ${target}，外面还剩 ${outside} 个，所以一共是 ${target + outside}。`
          : `${a} 还差 ${Math.max(0, target - a)} 个就满十格框。点「外面」的方块，把它搬进框里。`}
      </InstructionBubble>

      <div className="flex flex-wrap items-start justify-center gap-6">
        <TenFrame
          capacity={10}
          highlightFull={full}
          cells={Array.from({ length: frameCount }, (_, i) => (
            <UnitBlock key={i} small tone={i < inFrameA ? "one" : "moved"} />
          ))}
        />

        <div className="flex flex-col items-center gap-2 rounded-kid bg-white p-4 shadow-kid-sm">
          <p className="text-kid-lg font-bold">外面</p>
          <div className="flex min-h-[56px] min-w-[132px] flex-wrap items-center justify-center gap-1.5">
            {Array.from({ length: outside }).map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={moveOne}
                aria-label="把一个方块搬进十格框"
                className="rounded-lg transition active:translate-y-[2px]"
              >
                <UnitBlock small tone="one" />
              </button>
            ))}
            {outside === 0 ? <span className="text-base text-world-soft">空啦</span> : null}
          </div>
          <p className="text-base text-world-soft tabular-nums">还剩 {outside} 个</p>
          {outside > 0 ? (
            <button
              type="button"
              onClick={moveOne}
              className="rounded-pill bg-world-sun px-4 py-2 text-base font-bold shadow-kid-sm"
            >
              搬一个过去
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col items-center gap-2 rounded-kid bg-white px-5 py-4 shadow-kid-sm">
        <p className="text-kid-xl font-extrabold tabular-nums">
          {a} + {b}
          <span className="text-world-soft"> = </span>
          {a} + <span className="text-world-grass">{moved}</span> +{" "}
          <span className="text-world-sun">{outside}</span>
        </p>
        <motion.p
          key={`${a}-${b}-${moved}`}
          initial={{ opacity: 0.4 }}
          animate={{ opacity: 1 }}
          className="text-kid-lg tabular-nums"
        >
          {full ? (
            <>
              {target} + {outside} = <b>{target + outside}</b>
            </>
          ) : (
            <span className="text-world-soft">先把十格框填满试试</span>
          )}
        </motion.p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <NumberStepper label={`第一个数 ${a}`} onChange={(d) => setA((v) => Math.max(5, Math.min(9, v + d)))} />
        <NumberStepper label={`第二个数 ${b}`} onChange={(d) => setB((v) => Math.max(2, Math.min(9, v + d)))} />
        <button
          type="button"
          onClick={reset}
          className="rounded-pill bg-white px-4 py-2 text-base shadow-kid-sm"
        >
          重来一次
        </button>
      </div>
    </div>
  );
}

function NumberStepper({ label, onChange }: { label: string; onChange: (delta: number) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-pill bg-white px-3 py-1.5 shadow-kid-sm">
      <span className="text-base">{label}</span>
      <button
        type="button"
        onClick={() => onChange(-1)}
        aria-label={`${label} 减一`}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-[#f6ece0] text-kid-lg font-extrabold"
      >
        −
      </button>
      <button
        type="button"
        onClick={() => onChange(1)}
        aria-label={`${label} 加一`}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-world-sun text-kid-lg font-extrabold"
      >
        ＋
      </button>
    </div>
  );
}
