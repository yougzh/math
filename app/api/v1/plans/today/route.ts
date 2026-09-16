import { handle, intParam, methodNotAllowed } from "@/src/api/http";
import { getCfg, getGraph, loadChild, resolveBundle } from "@/src/api/deps";
import { getDb } from "@/src/db/client";
import { learningSession } from "@/src/db/schema";
import { eq } from "drizzle-orm";
import { buildDailyPlan } from "@/src/engine/planner";
import { loadState } from "@/src/service/learning";
import { planPayload } from "@/src/api/planPayload";
import { sessionMissing } from "@/src/service/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const childId = intParam(url.searchParams.get("child_id"), "query.child_id");
    const sessionId = intParam(url.searchParams.get("session_id"), "query.session_id");
    const db = getDb();
    const child = await loadChild(childId);
    const b = await resolveBundle();
    const cfg = getCfg();
    let budget: number | null = null;
    if (sessionId !== null) {
      const rows = await db
        .select({ plannedMinutes: learningSession.plannedMinutes })
        .from(learningSession)
        .where(eq(learningSession.id, sessionId))
        .limit(1);
      if (rows.length === 0) {
        throw sessionMissing(sessionId);
      }
      budget = rows[0]!.plannedMinutes;
    }
    const state = await loadState(db, child.id, b, cfg);
    const plan = buildDailyPlan(state, getGraph(), b, cfg, budget);
    return planPayload(plan, b);
  });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
