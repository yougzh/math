"use client";

import Link from "next/link";
import { useState } from "react";
import { motion } from "framer-motion";
import type { Universe } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

/**
 * 一个宇宙的入口卡。
 *
 * 未解锁 → 灰掉、不可点、显示 🔒 与一句温柔的说明（不是「你不能玩」）。
 * 已解锁 → 展开故事列表；侦探社直接进侦探页。
 */
export function UniverseCard({ universe }: { universe: Universe }) {
  const [open, setOpen] = useState(false);
  const locked = !universe.unlocked;
  const isDetective = universe.code === "detective";
  const percent = Math.round((universe.progress ?? 0) * 100);

  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={cn(
        "rounded-kid bg-white p-4 shadow-kid-sm",
        locked && "opacity-60 grayscale",
      )}
    >
      <div className="flex items-center gap-3">
        <span className={cn("text-4xl", locked && "opacity-70")} aria-hidden>
          {universe.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-kid-lg font-extrabold">
            {universe.name}
            {locked ? <span className="text-base font-normal text-world-soft">🔒 还没开放</span> : null}
          </h3>
          {locked ? (
            <p className="text-base text-world-soft">再练一练，这里就会亮起来。</p>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-2 w-28 overflow-hidden rounded-pill bg-[#efe7da]">
                <div className="h-full rounded-pill bg-world-grass" style={{ width: `${percent}%` }} />
              </div>
              <span className="text-base text-world-soft">走到 {percent}%</span>
            </div>
          )}
        </div>

        {!locked ? (
          isDetective ? (
            <Link
              href="/detective"
              className="kid-btn min-h-[48px] bg-world-sea px-5 text-kid shadow-kid-sm"
            >
              去破案
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="kid-btn min-h-[48px] bg-world-sun px-5 text-kid shadow-kid-sm"
            >
              {open ? "收起" : "出发"}
            </button>
          )
        ) : (
          <span className="rounded-pill bg-[#f1ece2] px-4 py-2 text-base text-world-soft">锁住了</span>
        )}
      </div>

      {open && !locked && !isDetective ? (
        <ul className="mt-3 space-y-2">
          {universe.stories.map((story) => (
            <li key={story.code}>
              {story.unlocked ? (
                <Link
                  href={`/stories/${story.code}`}
                  className="flex min-h-[52px] items-center gap-3 rounded-2xl bg-[#f8f3e9] px-4 py-2 transition active:translate-y-[1px]"
                >
                  <span aria-hidden>{story.completed ? "✅" : "📖"}</span>
                  <span className="font-bold">{story.title}</span>
                  <span className="ml-auto text-base text-world-soft">
                    {story.completed ? "玩过了" : "去玩"}
                  </span>
                </Link>
              ) : (
                <span className="flex min-h-[52px] items-center gap-3 rounded-2xl bg-[#f4efe6] px-4 py-2 text-world-soft">
                  <span aria-hidden>🔒</span>
                  {story.title}
                </span>
              )}
            </li>
          ))}
          {universe.stories.length === 0 ? (
            <li className="rounded-2xl bg-[#f8f3e9] px-4 py-3 text-base text-world-soft">
              这里的故事还在写，很快就有啦。
            </li>
          ) : null}
        </ul>
      ) : null}
    </motion.li>
  );
}
