import { handle, intParam, methodNotAllowed, readJsonBody } from "@/src/api/http";
import { parseSessionEndIn } from "@/src/api/schemas";
import { getDb } from "@/src/db/client";
import { learningSession } from "@/src/db/schema";
import { eq } from "drizzle-orm";
import { sessionMissing } from "@/src/service/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ session_id: string }> },
) {
  return handle(async () => {
    const { session_id: sessionIdRaw } = await ctx.params;
    const sessionId = intParam(sessionIdRaw, "path.session_id") as number;
    const body = parseSessionEndIn(await readJsonBody(request));
    const db = getDb();
    const rows = await db
      .select()
      .from(learningSession)
      .where(eq(learningSession.id, sessionId))
      .limit(1);
    if (rows.length === 0) {
      throw sessionMissing(sessionId);
    }
    const row = rows[0]!;
    const now = new Date();
    const durationMs =
      row.startedAt !== null ? Math.max(0, now.getTime() - row.startedAt.getTime()) : null;
    await db
      .update(learningSession)
      .set({ endedAt: now, durationMs, quitReason: body.quit_reason })
      .where(eq(learningSession.id, sessionId));
    return { ok: true };
  });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
