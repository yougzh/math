"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { getLab } from "@/lib/api/endpoints";
import { useApiResource } from "@/lib/hooks/useApiResource";
import { useAppStore } from "@/lib/store/useAppStore";
import { ErrorState } from "@/components/ui/StateViews";
import { Loading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { KidButton } from "@/components/ui/KidButton";
import { LabBlocks } from "@/components/lab/LabBlocks";
import { LabMakeTen } from "@/components/lab/LabMakeTen";
import type { LabExperiment } from "@/lib/api/types";

/**
 * 数学实验室。
 *
 * 自由探索：**不判定对错、不产生 attempt、不计入熟练度**（契约 §7）。
 * 所以这里全部是本地状态，不碰任何学习接口。
 */
export default function LabPage() {
  const childId = useAppStore((s) => s.childId);
  const { data, error, loading, reload } = useApiResource(() => getLab(childId), [childId]);
  const [active, setActive] = useState<LabExperiment | null>(null);

  if (loading) return <Loading label="正在开实验室的门…" />;
  if (error) {
    return (
      <div className="p-5">
        <ErrorState message={error} onRetry={reload} />
      </div>
    );
  }

  if (active) {
    return (
      <PageShell title={active.name} emoji={active.emoji} backHref="/">
        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={() => setActive(null)}
            className="self-start rounded-pill bg-white px-4 py-2 text-base shadow-kid-sm"
          >
            ← 换一个实验
          </button>
          {active.code === "blocks" ? <LabBlocks /> : null}
          {active.code === "make_ten" ? <LabMakeTen /> : null}
          {active.code !== "blocks" && active.code !== "make_ten" ? (
            <LabPlaceholder experiment={active} />
          ) : null}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="数学实验室" emoji="🧪">
      <p className="mb-4 rounded-kid bg-white/70 px-4 py-3 text-kid text-world-soft">
        这里不算分、不记录。想怎么试就怎么试，试坏了也没关系。
      </p>

      <ul className="grid gap-3 sm:grid-cols-2">
        {(data?.experiments ?? []).map((exp) => (
          <motion.li
            key={exp.code}
            whileHover={exp.unlocked ? { y: -2 } : undefined}
            className={`rounded-kid bg-white p-4 shadow-kid-sm ${exp.unlocked ? "" : "opacity-60"}`}
          >
            <button
              type="button"
              disabled={!exp.unlocked}
              onClick={() => setActive(exp)}
              className="flex w-full items-center gap-3 text-left disabled:cursor-not-allowed"
            >
              <span className="text-4xl" aria-hidden>
                {exp.emoji}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-kid-lg font-extrabold">
                  {exp.name}
                  {!exp.unlocked ? (
                    <span className="text-base font-normal text-world-soft">🔒</span>
                  ) : null}
                </span>
                <span className="block text-base text-world-soft">{exp.description}</span>
              </span>
              {exp.unlocked ? (
                <span className="text-world-soft" aria-hidden>
                  →
                </span>
              ) : null}
            </button>
          </motion.li>
        ))}
      </ul>

      <div className="mt-6 text-center">
        <KidButton variant="ghost" onClick={reload}>
          重新看看有哪些实验
        </KidButton>
      </div>
    </PageShell>
  );
}

function LabPlaceholder({ experiment }: { experiment: LabExperiment }) {
  return (
    <div className="kid-card flex flex-col items-center gap-3 text-center">
      <span className="text-5xl" aria-hidden>
        {experiment.emoji}
      </span>
      <p className="text-kid-lg font-bold">{experiment.name} 还在搭建中</p>
      <p className="text-kid text-world-soft">
        {experiment.description} —— 这个小实验很快就会开门。
      </p>
      <p className="text-base text-world-soft">
        先玩玩「数字积木」和「凑十」吧，那两个已经能玩啦。
      </p>
    </div>
  );
}
