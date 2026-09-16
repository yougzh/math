"use client";

import { AnimatePresence, motion } from "framer-motion";
import { MATERIAL_META } from "@/components/ui/MaterialBar";
import type { Feedback, Reward } from "@/lib/api/types";

/**
 * 反馈卡。
 *
 * 三种语气对应三种完全不同的表现（契约 §4 / 开发计划 §34）：
 * - praise   ：庆祝，但不喧闹
 * - encourage：对了但费劲 —— 明确肯定「你做到了」，不暗示慢是缺点
 * - repair   ：**把错误演成剧情事件**。没有红叉、没有「错误」二字、
 *              没有失败音效，只有「糟糕，小熊把十藏起来了」这样的剧情。
 */
export function FeedbackCard({
  feedback,
  reward,
  onRetry,
  onContinue,
  pending,
}: {
  feedback: Feedback;
  reward: Reward | null;
  onRetry?: () => void;
  onContinue?: () => void;
  pending?: boolean;
}) {
  const tone = feedback.tone;
  const palette = {
    praise: "bg-[#eaf9e6] border-[#8fd07a]",
    encourage: "bg-[#fff8e3] border-[#f0cf74]",
    repair: "bg-[#fff1e3] border-[#f0b071]",
  }[tone];

  const emoji = { praise: "🎉", encourage: "🌟", repair: "🐻" }[tone];

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 220, damping: 20 }}
      className={`rounded-kid border-4 p-5 shadow-soft ${palette}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <motion.span
          className="text-4xl"
          animate={tone === "praise" ? { rotate: [0, -8, 8, 0], scale: [1, 1.15, 1] } : { y: [0, -4, 0] }}
          transition={{ duration: tone === "praise" ? 0.8 : 1.6, repeat: tone === "praise" ? 2 : Infinity }}
          aria-hidden
        >
          {emoji}
        </motion.span>
        <p className="text-kid-lg font-bold leading-relaxed">{feedback.text}</p>
      </div>

      {reward && (reward.materials.length > 0 || reward.coins > 0) ? (
        <ul className="mt-4 flex flex-wrap items-center gap-2">
          {reward.materials.map((m) => {
            const meta = MATERIAL_META[m.code] ?? { emoji: "❔", name: m.code };
            return (
              <li
                key={m.code}
                className="flex items-center gap-1.5 rounded-pill bg-white/80 px-3 py-1 text-kid"
              >
                <span aria-hidden>{meta.emoji}</span>
                <span>
                  {meta.name} +{m.count}
                </span>
              </li>
            );
          })}
          {reward.coins > 0 ? (
            <li className="flex items-center gap-1.5 rounded-pill bg-white/80 px-3 py-1 text-kid">
              <span aria-hidden>🪙</span>
              <span>金币 +{reward.coins}</span>
            </li>
          ) : null}
        </ul>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-3">
        {tone === "repair" && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="kid-btn bg-white text-world-ink shadow-kid-sm"
          >
            再试一次
          </button>
        ) : null}
        {onContinue ? (
          <button
            type="button"
            onClick={onContinue}
            disabled={pending}
            className="kid-btn bg-world-grass text-[#123d0a] shadow-kid disabled:opacity-60"
          >
            继续故事
          </button>
        ) : null}
      </div>
    </motion.div>
  );
}

/** 材料掉落动画（reward beat 用） */
export function RewardBurst({ reward }: { reward: Reward }) {
  const pieces = reward.materials.flatMap((m) =>
    Array.from({ length: Math.min(m.count, 6) }, () => MATERIAL_META[m.code]?.emoji ?? "🎁"),
  );

  return (
    <div className="pointer-events-none fixed inset-0 z-30 overflow-hidden" aria-hidden>
      <AnimatePresence>
        {pieces.map((emoji, i) => (
          <motion.span
            key={`${emoji}-${i}`}
            className="absolute text-4xl"
            style={{ left: `${8 + ((i * 13) % 84)}%` }}
            initial={{ y: -60, opacity: 0, rotate: -20 }}
            animate={{ y: "105vh", opacity: [0, 1, 1, 0.9], rotate: 15 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 2.6, delay: i * 0.16, ease: "easeIn" }}
          >
            {emoji}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}
