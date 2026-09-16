"use client";

import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getDetectivePuzzle, postDetectiveAnswer } from "@/lib/api/endpoints";
import { newClientAttemptId } from "@/lib/api/id";
import { describeError } from "@/lib/api/errors";
import { useApiResource } from "@/lib/hooks/useApiResource";
import { useAppStore } from "@/lib/store/useAppStore";
import { KidButton } from "@/components/ui/KidButton";
import { ErrorState } from "@/components/ui/StateViews";
import { Loading, InlineLoading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { AnswerDisplay, NumberKeypad, InstructionBubble } from "@/components/interactions/parts";
import { MATERIAL_META } from "@/components/ui/MaterialBar";
import type { DetectiveAnswerResponse, DetectivePuzzle } from "@/lib/api/types";

/**
 * 数学侦探。
 *
 * 猜错了不要紧：服务端会揭示一条新线索，候选范围跟着收窄（契约 §8）。
 * 这里同样是「错误也是剧情的一部分」——提示语是狐狸侦探在说话，不是系统在报错。
 */
export default function DetectivePage() {
  const childId = useAppStore((s) => s.childId);
  const { data, error, loading, reload } = useApiResource(
    () => getDetectivePuzzle(childId),
    [childId],
  );

  if (loading) return <Loading label="狐狸侦探正在翻档案…" />;
  if (error) {
    return (
      <div className="p-5">
        <ErrorState message={error} onRetry={reload} />
      </div>
    );
  }
  if (!data) return null;

  return (
    <PageShell title="数学侦探" emoji="🦊">
      <DetectiveBoard key={data.puzzle_id} puzzle={data} onNext={reload} />
    </PageShell>
  );
}

function DetectiveBoard({ puzzle, onNext }: { puzzle: DetectivePuzzle; onNext: () => void }) {
  const childId = useAppStore((s) => s.childId);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DetectiveAnswerResponse | null>(null);
  const [extraClues, setExtraClues] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<number[]>([]);
  const [errorNote, setErrorNote] = useState<string | null>(null);

  const clues = useMemo(
    () => puzzle.clues.map((c) => (extraClues.includes(c.text) ? { ...c, revealed: true } : c)),
    [extraClues, puzzle.clues],
  );
  const candidates = puzzle.candidates.filter((c) => !excluded.includes(c));
  const solved = result?.correct ?? false;

  const submit = useCallback(
    async (raw: string) => {
      if (!raw || pending || solved) return;
      const guess = Number(raw);
      setPending(true);
      setErrorNote(null);
      try {
        const res = await postDetectiveAnswer({
          child_id: childId,
          puzzle_id: puzzle.puzzle_id,
          answer: guess,
          client_attempt_id: newClientAttemptId(),
        });
        setResult(res);
        if (!res.correct) {
          setExcluded((prev) => [...prev, guess]);
          setExtraClues((prev) => [...prev, ...res.revealed_clues]);
        }
        setValue("");
      } catch (e) {
        setErrorNote(describeError(e));
      } finally {
        setPending(false);
      }
    },
    [childId, pending, puzzle.puzzle_id, solved],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="relative overflow-hidden rounded-kid bg-gradient-to-b from-[#dfe6ff] to-[#f4ecff] p-5 shadow-soft">
        <span className="absolute right-4 top-3 text-4xl animate-floaty" aria-hidden>
          🔍
        </span>
        <p className="text-kid-xl font-extrabold">🦊 {puzzle.prompt}</p>
        <p className="mt-1 text-base text-world-soft">
          还剩 {clues.filter((c) => !c.revealed).length} 条线索没揭开
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-kid-lg font-extrabold">线索</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {clues.map((clue) => (
            <li
              key={clue.text}
              className={`flex min-h-[52px] items-center gap-3 rounded-2xl px-4 py-2 ${
                clue.revealed ? "bg-white shadow-kid-sm" : "bg-[#efe9df] text-world-soft"
              }`}
            >
              <span aria-hidden>{clue.revealed ? "🔎" : "❓"}</span>
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={clue.revealed ? "on" : "off"}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="font-bold"
                >
                  {clue.revealed ? clue.text : "?"}
                </motion.span>
              </AnimatePresence>
            </li>
          ))}
        </ul>
      </section>

      {candidates.length > 0 ? (
        <section>
          <h2 className="mb-2 text-kid-lg font-extrabold">可能是这些数</h2>
          <ul className="flex flex-wrap gap-2">
            {candidates.map((c) => (
              <li key={c}>
                <button
                  type="button"
                  onClick={() => setValue(String(c))}
                  className="flex min-h-[52px] min-w-[64px] items-center justify-center rounded-2xl bg-white text-kid-lg font-extrabold shadow-kid-sm"
                >
                  {c}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <InstructionBubble tone="warn">
          候选都被排除了，狐狸侦探说得换一个案子。
        </InstructionBubble>
      )}

      <InstructionBubble>把你的答案写在下面，或者点上面的数字。</InstructionBubble>

      <div className="flex flex-col items-center gap-4">
        <AnswerDisplay value={value} />
        <div className="w-full max-w-md">
          <NumberKeypad
            value={value}
            onChange={setValue}
            onSubmit={() => void submit(value)}
            disabled={pending || solved}
            submitLabel="就是它！"
          />
        </div>
        {pending ? <InlineLoading label="狐狸侦探正在核对…" /> : null}
        {errorNote ? <p className="text-base text-[#8a5a00]">{errorNote}</p> : null}
      </div>

      {result ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className={`rounded-kid border-4 p-5 ${
            result.correct ? "border-[#8fd07a] bg-[#eaf9e6]" : "border-[#f0cf74] bg-[#fff8e3]"
          }`}
        >
          <p className="text-kid-lg font-bold">
            {result.correct ? "🎉 " : "🦊 "}
            {result.feedback.text}
          </p>

          {result.revealed_clues.length > 0 ? (
            <p className="mt-2 text-kid">新线索：{result.revealed_clues.join("、")}</p>
          ) : null}

          {result.correct ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {result.reward.coins > 0 ? (
                <span className="rounded-pill bg-white px-3 py-1.5 text-kid">🪙 金币 +{result.reward.coins}</span>
              ) : null}
              {result.reward.materials
                .filter((m) => m.count > 0)
                .map((m) => (
                  <span key={m.code} className="rounded-pill bg-white px-3 py-1.5 text-kid">
                    {MATERIAL_META[m.code]?.emoji ?? "🎁"} {MATERIAL_META[m.code]?.name ?? m.code} +{m.count}
                  </span>
                ))}
              <KidButton variant="grass" onClick={onNext}>
                下一个案子
              </KidButton>
            </div>
          ) : (
            <p className="mt-2 text-base text-world-soft">
              候选又少了一个，再试试别的数。
            </p>
          )}
        </motion.div>
      ) : null}
    </div>
  );
}
