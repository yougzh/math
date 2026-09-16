import { handle, methodNotAllowed, readJsonBody } from "@/src/api/http";
import { loadChild } from "@/src/api/deps";
import { parseDetectiveAnswerIn } from "@/src/api/schemas";
import {
  generatePuzzle,
  judge,
  revealAfterAttempt,
  ValueErrorDetective,
} from "@/src/engine/detective";
import { badRequest } from "@/src/service/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = parseDetectiveAnswerIn(await readJsonBody(request));
    await loadChild(body.child_id);
    let puzzle;
    try {
      puzzle = generatePuzzle(body.puzzle_id);
    } catch (err) {
      if (err instanceof ValueErrorDetective) {
        throw badRequest(err.message, "PUZZLE_INVALID");
      }
      throw err;
    }
    const correct = judge(puzzle, body.answer);
    const revealed = revealAfterAttempt(puzzle, correct);
    const feedback = correct
      ? {
          tone: "praise",
          text: "推理得真漂亮，线索全被你用上了！",
          character: "小助手",
        }
      : {
          tone: "repair",
          text: "再想想，还有线索没有用上哦。",
          character: "小助手",
        };
    // 侦探答题不写学习状态：不进 attempt/熟练度/复习调度（ADR-0005）。
    // 契约 §7 的实验室同款语义 —— 不是所有答题都是 attempt。
    return {
      correct,
      feedback,
      revealed_clues: revealed,
      reward: { materials: [], coins: 0, unlocks: [] },
    };
  });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
