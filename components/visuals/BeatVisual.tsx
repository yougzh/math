"use client";

import { motion } from "framer-motion";
import type { BeatVisual } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

/**
 * 故事插画。
 *
 * 约束：**不用任何图片素材**（不生成二进制资源），全部用 CSS / SVG / emoji 拼。
 * `visual.kind` 决定前景内容，`visual.mood` 决定色调。
 */

type Mood = { sky: string; ground: string; decor: string };
type Scene = { main: string[]; caption: string };

// 默认值具名化：noUncheckedIndexedAccess 下 `MOODS.calm` 是 `Mood | undefined`，
// 单独声明才能让 fallback 有确定的类型。
const FALLBACK_MOOD: Mood = { sky: "from-[#dff0ff] to-[#eaf7ea]", ground: "bg-[#d9e8c9]", decor: "☁️" };
const FALLBACK_SCENE: Scene = { main: ["🏠", "🚉", "🪧"], caption: "数字车站" };

const MOODS: Record<string, Mood> = {
  morning: {
    sky: "from-[#ffe9b8] to-[#dff0ff]",
    ground: "bg-[#e8d7a8]",
    decor: "☀️",
  },
  calm: FALLBACK_MOOD,
  happy: { sky: "from-[#fff3c4] to-[#d8f5d0]", ground: "bg-[#c9e8b4]", decor: "🌈" },
  night: { sky: "from-[#2b3a67] to-[#4a5b8c]", ground: "bg-[#3b4a6b]", decor: "🌙" },
};

const KIND_SCENE: Record<string, Scene> = {
  station: FALLBACK_SCENE,
  luggage: { main: ["🧳", "🧳", "📦"], caption: "行李堆" },
  train: { main: ["🚂", "🚃", "🚃"], caption: "小火车" },
  ticket: { main: ["🎫", "🐰", "💰"], caption: "售票窗口" },
  repair: { main: ["🔧", "🪵", "🛠️"], caption: "修一修" },
  box: { main: ["📦", "🍎", "🧺"], caption: "货箱" },
  night: { main: ["🌙", "🚂", "⭐"], caption: "夜里" },
  shop: { main: ["🏪", "🛒", "🍬"], caption: "开心商店" },
  build: { main: ["🏗️", "🧱", "🏠"], caption: "建造工地" },
  detective: { main: ["🦊", "🔍", "📋"], caption: "侦探社" },
  animal: { main: ["🐻", "🐰", "🐦"], caption: "小伙伴" },
};

export function BeatVisual({
  visual,
  className,
  compact,
}: {
  visual: BeatVisual | null | undefined;
  className?: string;
  compact?: boolean;
}) {
  const kind = visual?.kind ?? "station";
  const mood: Mood = MOODS[visual?.mood ?? "calm"] ?? FALLBACK_MOOD;
  const scene: Scene = KIND_SCENE[kind] ?? FALLBACK_SCENE;
  const characters = visual?.characters ?? [];

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-kid shadow-soft",
        compact ? "h-32" : "h-44 sm:h-56",
        className,
      )}
      role="img"
      aria-label={`插画：${scene.caption}`}
    >
      <div className={cn("absolute inset-0 bg-gradient-to-b", mood.sky)} />

      {/* 天空装饰 */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <span className="absolute right-4 top-3 text-3xl opacity-90">{mood.decor}</span>
        <span className="absolute left-6 top-6 text-2xl opacity-70 animate-floaty">☁️</span>
        <span className="absolute left-1/2 top-3 text-xl opacity-50 animate-floaty">☁️</span>
      </div>

      {/* 地面 */}
      <div className={cn("absolute bottom-0 left-0 right-0 h-10", mood.ground)} aria-hidden />

      {/* 前景 */}
      <div className="absolute inset-x-0 bottom-6 flex items-end justify-center gap-2 sm:gap-4">
        {scene.main.map((glyph, i) => (
          <motion.span
            key={`${glyph}-${i}`}
            className={cn("drop-shadow-sm", compact ? "text-3xl" : "text-4xl sm:text-5xl")}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 * i, type: "spring", stiffness: 180, damping: 18 }}
            aria-hidden
          >
            {glyph}
          </motion.span>
        ))}
      </div>

      {/* 出场角色 */}
      {characters.length > 0 ? (
        <ul className="absolute bottom-2 left-3 flex gap-1" aria-label="出场角色">
          {characters.map((c) => (
            <li key={c} className="rounded-pill bg-white/80 px-2 py-0.5 text-sm text-world-soft">
              {CHARACTER_NAME[c] ?? c}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const CHARACTER_NAME: Record<string, string> = {
  xiong: "小熊站长",
  rabbit: "小兔",
  fox: "狐狸侦探",
};
