"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { createSession, endSession, getStory } from "@/lib/api/endpoints";
import type { Reward } from "@/lib/api/types";
import { useApiResource } from "@/lib/hooks/useApiResource";
import { useAppStore } from "@/lib/store/useAppStore";
import { KidButton } from "@/components/ui/KidButton";
import { ErrorState, EmptyState } from "@/components/ui/StateViews";
import { Loading } from "@/components/ui/Loading";
import { MATERIAL_META } from "@/components/ui/MaterialBar";
import { cn } from "@/lib/utils/cn";
import { ChallengeBeat } from "./ChallengeBeat";
import { RewardBurst } from "./FeedbackCard";
import { NarrationBeat } from "./NarrationBeat";

/**
 * 故事播放器：按 beat.index 顺序播放。
 *
 * 会话（契约 §2）：进入故事时 POST /v1/sessions，正常看完 POST .../end {completed}；
 * 点返回键离开时上报 child_quit。**这里刻意不做「离开页面自动上报」**：
 * 浏览器返回 / 刷新 / 切后台都不是孩子的明确意图，宁可少报一次也不要误报。
 */
export function StoryPlayer({ code, onBack }: { code: string; onBack?: () => void }) {
  const childId = useAppStore((s) => s.childId);
  const sessionId = useAppStore((s) => s.sessionId);
  const setSessionId = useAppStore((s) => s.setSessionId);

  const { data: story, error, loading, reload } = useApiResource(
    () => getStory(code, childId),
    [code, childId],
  );

  const [index, setIndex] = useState(0);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionRequested = useRef(false);
  const completed = useRef(false);

  // 进入故事 → 开一个学习会话（失败不阻塞孩子玩）
  useEffect(() => {
    if (sessionRequested.current || sessionId !== null) return;
    sessionRequested.current = true;
    createSession({ child_id: childId, planned_minutes: 12, device: "web" })
      .then((res) => setSessionId(res.session_id))
      .catch(() => setSessionError("这次的记录暂时没连上，你照样可以玩。"));
  }, [childId, sessionId, setSessionId]);

  const finish = useCallback(() => {
    completed.current = true;
    if (sessionId !== null) {
      void endSession(sessionId, { quit_reason: "completed" }).catch(() => {});
    }
  }, [sessionId]);

  const handleBack = useCallback(() => {
    if (!completed.current && sessionId !== null) {
      void endSession(sessionId, { quit_reason: "child_quit" }).catch(() => {});
    }
    onBack?.();
  }, [onBack, sessionId]);

  const beats = story?.beats ? [...story.beats].sort((a, b) => a.index - b.index) : [];
  const current = beats[index];
  const done = index >= beats.length;

  const next = useCallback(() => setIndex((i) => i + 1), []);

  // 全部 beat 播完 → 正常结束会话（放在 effect 里，渲染期不做副作用）
  useEffect(() => {
    if (done && !completed.current) finish();
  }, [done, finish]);

  const collectReward = useCallback(
    (reward: Reward | null) => {
      // 真实后端的故事 reward beat 通常不带 reward（奖励由 attempt 事务下发，契约 §4），
      // 所以这里必须无条件前进 —— 只有「有奖励」时才累加展示。
      if (reward) setRewards((prev) => [...prev, reward]);
      next();
    },
    [next],
  );

  if (loading) return <Loading label="正在打开故事…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!story) return <EmptyState text="没有找到这个故事。" />;

  const progress = beats.length > 0 ? Math.min(index, beats.length) / beats.length : 0;

  return (
    <div className="flex flex-col gap-5">
      {/* 进度点：只显示「走到哪儿了」，没有倒计时、没有催促 */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleBack}
          aria-label="回到数学世界"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-2xl shadow-kid-sm"
        >
          <span aria-hidden>←</span>
        </button>
        <div className="flex-1">
          <p className="text-base text-world-soft">{story.title}</p>
          <div className="mt-1 h-2.5 w-full overflow-hidden rounded-pill bg-[#efe7da]">
            <div
              className="h-full rounded-pill bg-world-sea transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
            />
          </div>
        </div>
        <ol className="hidden gap-1.5 sm:flex" aria-label="故事进度">
          {beats.map((b, i) => (
            <li
              key={b.index}
              className={cn(
                "h-2.5 w-2.5 rounded-full",
                i < index ? "bg-world-grass" : i === index ? "bg-world-sun" : "bg-[#e0d5c2]",
              )}
            />
          ))}
        </ol>
      </div>

      {sessionError ? (
        <p className="rounded-kid bg-[#fff8e3] px-4 py-2 text-base text-[#8a5a00]">{sessionError}</p>
      ) : null}

      {!done && current ? (
        <div key={current.index}>
          {current.type === "narration" ? (
            <NarrationBeat beat={current} onNext={next} isLast={index === beats.length - 1} />
          ) : null}

          {current.type === "challenge" ? (
            <ChallengeBeat
              beat={current}
              onSolved={next}
              onReward={(r) => setRewards((prev) => [...prev, r])}
            />
          ) : null}

          {current.type === "reward" ? (
            <RewardBeatView beat={current} onCollect={() => collectReward(current.reward)} />
          ) : null}
        </div>
      ) : null}

      {done ? (
        <motion.section
          className="kid-card flex flex-col items-center gap-4 text-center"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
        >
          <span className="text-5xl" aria-hidden>
            🎊
          </span>
          <h2 className="text-kid-2xl font-extrabold">这个故事玩完啦！</h2>
          <RewardSummary rewards={rewards} />
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/">
              <KidButton variant="primary">回数学世界</KidButton>
            </Link>
            <KidButton variant="ghost" onClick={() => { setIndex(0); setRewards([]); completed.current = false; }}>
              再玩一次
            </KidButton>
            <Link href="/growth">
              <KidButton variant="sun">看我的成长</KidButton>
            </Link>
          </div>
          <p className="text-base text-world-soft">
            今天的故事到这里，明天小熊还在车站等你。
          </p>
        </motion.section>
      ) : null}
    </div>
  );
}

function RewardBeatView({
  beat,
  onCollect,
}: {
  beat: { narration: string | null; reward: Reward | null };
  onCollect: () => void;
}) {
  const reward = beat.reward;
  return (
    <motion.section
      className="flex flex-col gap-4"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      {reward ? <RewardBurst reward={reward} /> : null}
      <div className="kid-card flex flex-col items-center gap-4 text-center">
        <motion.span
          className="text-6xl"
          animate={{ scale: [1, 1.12, 1], rotate: [0, -6, 6, 0] }}
          transition={{ duration: 1.4, repeat: Infinity }}
          aria-hidden
        >
          🎁
        </motion.span>
        <p className="text-kid-lg font-bold">{beat.narration}</p>
        <RewardSummary rewards={reward ? [reward] : []} />
        <KidButton variant="grass" onClick={onCollect}>
          收下啦
        </KidButton>
      </div>
    </motion.section>
  );
}

function RewardSummary({ rewards }: { rewards: Reward[] }) {
  const totals = new Map<string, number>();
  let coins = 0;
  for (const r of rewards) {
    for (const m of r.materials) totals.set(m.code, (totals.get(m.code) ?? 0) + m.count);
    coins += r.coins;
  }
  const entries = [...totals.entries()].filter(([, n]) => n > 0);
  if (entries.length === 0 && coins === 0) return null;

  return (
    <ul className="flex flex-wrap justify-center gap-2">
      {entries.map(([code, count]) => {
        const meta = MATERIAL_META[code] ?? { emoji: "🎁", name: code };
        return (
          <li key={code} className="flex items-center gap-1.5 rounded-pill bg-white px-3 py-1.5 shadow-kid-sm">
            <span aria-hidden>{meta.emoji}</span>
            <span className="font-bold">
              {meta.name} +{count}
            </span>
          </li>
        );
      })}
      {coins > 0 ? (
        <li className="flex items-center gap-1.5 rounded-pill bg-white px-3 py-1.5 shadow-kid-sm">
          <span aria-hidden>🪙</span>
          <span className="font-bold">金币 +{coins}</span>
        </li>
      ) : null}
    </ul>
  );
}
