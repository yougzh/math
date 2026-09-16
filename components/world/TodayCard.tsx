"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import type { TodayAdventure } from "@/lib/api/types";

/** 今日冒险：首页最大的那颗按钮，点它就能开始今天的故事 */
export function TodayCard({ today }: { today: TodayAdventure }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      <Link
        href={`/stories/${today.story_code}`}
        className="block rounded-kid bg-gradient-to-br from-[#ffe6a8] to-[#ffd1dc] p-5 shadow-soft transition active:translate-y-[2px]"
      >
        <div className="flex items-center gap-4">
          <motion.span
            className="text-6xl"
            animate={{ y: [0, -6, 0] }}
            transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
            aria-hidden
          >
            🎯
          </motion.span>
          <div className="min-w-0 flex-1">
            <p className="text-base font-bold text-[#8a5a00]">今天的冒险</p>
            <h2 className="truncate text-kid-2xl font-extrabold">{today.headline}</h2>
            <p className="mt-1 text-kid text-world-soft">{today.subtitle}</p>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-base text-[#8a5a00]">
              <span className="rounded-pill bg-white/80 px-3 py-1">约 {today.estimated_minutes} 分钟</span>
              {today.completed ? (
                <span className="rounded-pill bg-white/80 px-3 py-1">✅ 今天玩过了</span>
              ) : (
                <span className="rounded-pill bg-white/80 px-3 py-1">点这里出发 →</span>
              )}
            </p>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
