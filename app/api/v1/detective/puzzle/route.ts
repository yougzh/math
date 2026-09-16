import { handle, intParam, methodNotAllowed } from "@/src/api/http";
import { loadChild } from "@/src/api/deps";
import { getDb } from "@/src/db/client";
import { attempt } from "@/src/db/schema";
import { count, eq } from "drizzle-orm";
import {
  generatePuzzle,
  makePuzzleId,
  ValueErrorDetective,
} from "@/src/engine/detective";
import { badRequest } from "@/src/service/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const childId = intParam(url.searchParams.get("child_id"), "query.child_id");
    const child = await loadChild(childId);
    const db = getDb();
    const countRows = await db
      .select({ value: count() })
      .from(attempt)
      .where(eq(attempt.childId, child.id));
    const puzzleId = makePuzzleId(child.id * 1000 + Number(countRows[0]?.value ?? 0));
    let puzzle;
    try {
      puzzle = generatePuzzle(puzzleId);
    } catch (err) {
      if (err instanceof ValueErrorDetective) {
        throw badRequest(err.message, "PUZZLE_INVALID");
      }
      throw err;
    }
    return puzzle.toDict();
  });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
