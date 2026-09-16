"use client";

import { useCallback, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { postHints } from "@/lib/api/endpoints";
import { newClientAttemptId } from "@/lib/api/id";
import { describeError } from "@/lib/api/errors";
import { submitAttempt } from "@/lib/offline/attemptQueue";
import { useAppStore } from "@/lib/store/useAppStore";
import { useAttemptTelemetry, toWireTelemetry } from "@/lib/telemetry/useAttemptTelemetry";
import type {
  AttemptRequest,
  AttemptResponse,
  MethodUsed,
  Reward,
  StoryBeat,
} from "@/lib/api/types";
import { InteractionRenderer } from "@/components/interactions";
import type { InteractionAnswer } from "@/components/interactions/types";
import { KidButton } from "@/components/ui/KidButton";
import { InlineLoading } from "@/components/ui/Loading";
import { BeatVisual } from "@/components/visuals/BeatVisual";
import { FeedbackCard } from "./FeedbackCard";

type Phase = "answering" | "checking" | "feedback" | "queued";

/**
 * 一个 challenge beat 的完整交互：
 * 渲染题目 → 采集三项时间 → POST /v1/attempts → 播放服务端返回的反馈。
 *
 * 三条硬约束：
 * 1. 前端**不判定对错**（题目载荷不含答案，契约 §0）→ client_correct 恒为 null；
 * 2. 学习状态**只读**：progress 只用于调试面板，儿童界面不显示数值（ADR-0004）；
 * 3. 提交失败不丢弃：走 lib/offline 的本地暂存 + 幂等重放。
 */
export function ChallengeBeat({
  beat,
  onSolved,
  onReward,
}: {
  beat: StoryBeat;
  onSolved: () => void;
  /** 服务端在 attempt 事务里一起写下的奖励，用它驱动动画与统计 */
  onReward?: (reward: Reward) => void;
}) {
  const challenge = beat.challenge;
  const item = challenge?.item ?? null;
  const childId = useAppStore((s) => s.childId);
  const sessionId = useAppStore((s) => s.sessionId);
  const recordAttempt = useAppStore((s) => s.recordAttempt);

  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<Phase>("answering");
  const [result, setResult] = useState<AttemptResponse | null>(null);
  const [offlineNote, setOfflineNote] = useState<string | null>(null);
  const [errorNote, setErrorNote] = useState<string | null>(null);
  const [lastAnswer, setLastAnswer] = useState<InteractionAnswer | null>(null);

  const [hintsUsed, setHintsUsed] = useState(0);
  const [hintLevelMax, setHintLevelMax] = useState(0);
  const [hintText, setHintText] = useState<string | null>(null);
  const [hintsExhausted, setHintsExhausted] = useState(false);

  // 题目出现 → 开始计时；重试（round 变化）→ 重新开一段
  const telemetry = useAttemptTelemetry(item ? `${item.code}#${round}` : null);

  const visual = beat.visual;

  /** 提示走服务端（契约 §5），前端不自己造提示文案 */
  const askHint = useCallback(async () => {
    if (!item || hintsExhausted) return;
    try {
      const res = await postHints({
        child_id: childId,
        item_code: item.code,
        hints_used: hintsUsed,
        last_answer: lastAnswer,
      });
      setHintText(res.hint_text);
      if (res.exhausted) {
        setHintsExhausted(true);
      } else {
        setHintsUsed(res.hint_level);
        setHintLevelMax((v) => Math.max(v, res.hint_level));
      }
    } catch (e) {
      setHintText(describeError(e));
    }
  }, [childId, hintsExhausted, hintsUsed, item, lastAnswer]);

  const handleSubmit = useCallback(
    async (value: InteractionAnswer, meta?: { method_used?: MethodUsed }) => {
      if (!item || phase !== "answering") return;
      setErrorNote(null);
      setLastAnswer(value);

      // ⚠️ 三项时间必须在提交这一刻取快照；thinking_time 不由此处上报（服务端算）
      const local = telemetry.stop();
      const snapshot = toWireTelemetry(local);
      const body: AttemptRequest = {
        client_attempt_id: newClientAttemptId(),
        child_id: childId,
        session_id: sessionId,
        item_code: item.code,
        slot_code: challenge?.slot_code ?? null,
        answer: value,
        // 题目不下发答案 → 前端无法判定；契约 §0 允许留空
        client_correct: null,
        hints_used: hintsUsed,
        hint_level_max: hintLevelMax,
        method_used: meta?.method_used ?? null,
        // 契约没有向故事下发「这道题是不是迁移探测」的标记，故恒为 false
        is_transfer_probe: false,
        telemetry: snapshot,
      };

      setPhase("checking");
      const outcome = await submitAttempt(body);

      if (outcome.status === "sent") {
        recordAttempt(outcome.response, local);
        setResult(outcome.response);
        setPhase("feedback");
        if (outcome.response.reward) onReward?.(outcome.response.reward);
        return;
      }

      if (outcome.status === "queued") {
        // 断网：孩子的作答已经存下来了，等网络恢复会自动补交（幂等键保证不会重复）
        setOfflineNote("网络好像走开了。你的答案先被小熊收好了，等会儿会自动送出去。");
        setPhase("queued");
        return;
      }

      setErrorNote(describeError(outcome.error));
      setPhase("answering");
      telemetry.start();
    },
    [
      challenge?.slot_code,
      childId,
      hintLevelMax,
      hintsUsed,
      item,
      onReward,
      phase,
      recordAttempt,
      sessionId,
      telemetry,
    ],
  );

  const retry = useCallback(() => {
    setResult(null);
    setHintText(null);
    setPhase("answering");
    setRound((r) => r + 1); // 重新开始一段计时
  }, []);

  const promptText = useMemo(() => item?.prompt ?? beat.narration ?? "", [beat.narration, item?.prompt]);

  if (!item) {
    return (
      <div className="kid-card">
        <p className="text-kid-lg">这一段暂时没有题目。</p>
        <KidButton className="mt-4" onClick={onSolved}>
          继续
        </KidButton>
      </div>
    );
  }

  const correct = result?.correct ?? false;

  return (
    <motion.section
      className="flex flex-col gap-4"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <BeatVisual visual={visual} compact />

      {beat.narration ? (
        <p className="rounded-kid bg-white/70 px-4 py-3 text-kid text-world-soft">
          {beat.narration}
        </p>
      ) : null}

      <div className="kid-card">
        <p className="text-kid-xl font-extrabold leading-snug">{promptText}</p>
      </div>

      <InteractionRenderer
        key={`${item.code}-${round}`}
        item={item}
        disabled={phase !== "answering"}
        onSubmitAnswer={handleSubmit}
      />

      {/* 提示区：一次只说一个动作 + 一句鼓励 */}
      <div className="flex flex-col gap-3">
        {hintText ? (
          <motion.p
            className="rounded-kid bg-[#eaf6ff] px-4 py-3 text-kid text-[#12496f]"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
          >
            💡 {hintText}
          </motion.p>
        ) : null}

        {item.hints_available > 0 && !hintsExhausted ? (
          <div className="flex items-center gap-3">
            <KidButton variant="ghost" size="md" onClick={askHint} disabled={phase !== "answering"}>
              💡 给点提示（还能用 {Math.max(0, item.hints_available - hintsUsed)} 次）
            </KidButton>
            <span className="text-base text-world-soft">想不出来也没关系，先用提示也行。</span>
          </div>
        ) : null}
      </div>

      {phase === "checking" ? (
        <div className="kid-card">
          <InlineLoading label="小熊正在看你的答案…" />
        </div>
      ) : null}

      {errorNote ? (
        <p className="rounded-kid bg-[#fff4e0] px-4 py-3 text-base text-[#8a5a00]">
          {errorNote} 可以再交一次。
        </p>
      ) : null}

      {phase === "feedback" && result ? (
        <FeedbackCard
          feedback={result.feedback}
          reward={result.reward}
          onRetry={correct ? undefined : retry}
          onContinue={onSolved}
        />
      ) : null}

      {phase === "queued" ? (
        <div className="kid-card flex flex-col gap-3">
          <p className="text-kid">🐻 {offlineNote}</p>
          <div className="flex gap-3">
            <KidButton variant="ghost" onClick={retry}>
              再交一次
            </KidButton>
            <KidButton variant="grass" onClick={onSolved}>
              先往下走
            </KidButton>
          </div>
        </div>
      ) : null}
    </motion.section>
  );
}
