"use client";

import { motion } from "framer-motion";

/** 友好的加载态：不用转圈圈，用一列慢慢开过来的小火车 */
export function Loading({ label = "小火车正在进站…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16" role="status">
      <motion.div
        className="text-5xl"
        animate={{ x: [-40, 0, 40, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        aria-hidden
      >
        🚂
      </motion.div>
      <p className="text-kid text-world-soft">{label}</p>
    </div>
  );
}

export function InlineLoading({ label = "等一等…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-world-soft" role="status">
      <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-world-sea" />
      <span>{label}</span>
    </div>
  );
}
