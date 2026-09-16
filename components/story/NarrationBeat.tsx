"use client";

import { motion } from "framer-motion";
import { useTypewriter } from "@/lib/hooks/useTypewriter";
import { KidButton } from "@/components/ui/KidButton";
import { BeatVisual } from "@/components/visuals/BeatVisual";
import type { StoryBeat } from "@/lib/api/types";

/** 讲故事的一段：插画 + 打字机旁白 + 一个「继续」 */
export function NarrationBeat({
  beat,
  onNext,
  isLast,
}: {
  beat: StoryBeat;
  onNext: () => void;
  isLast: boolean;
}) {
  const text = beat.narration ?? "";
  const { shown, done, finish } = useTypewriter(text);

  return (
    <motion.section
      className="flex flex-col gap-4"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <BeatVisual visual={beat.visual} />

      <button
        type="button"
        onClick={finish}
        className="kid-card text-left"
        aria-label={done ? "旁白" : "点一下看完整句话"}
      >
        <p className="min-h-[3.5rem] text-kid-lg leading-relaxed">
          {shown}
          {!done ? <span className="ml-0.5 inline-block animate-pulse">▌</span> : null}
        </p>
      </button>

      <div className="flex justify-end">
        <KidButton
          variant={isLast ? "grass" : "primary"}
          onClick={() => {
            if (!done) {
              finish();
              return;
            }
            onNext();
          }}
        >
          {done ? (isLast ? "看完啦" : "然后呢？") : "快点说完"}
        </KidButton>
      </div>
    </motion.section>
  );
}
