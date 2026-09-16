import { handle, methodNotAllowed, readJsonBody } from "@/src/api/http";
import { loadChild } from "@/src/api/deps";
import { parseSessionCreateIn } from "@/src/api/schemas";
import { getDb } from "@/src/db/client";
import { learningSession } from "@/src/db/schema";
import { isoUtc } from "@/src/service/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = parseSessionCreateIn(await readJsonBody(request));
    const child = await loadChild(body.child_id);
    const db = getDb();
    const rows = await db
      .insert(learningSession)
      .values({
        childId: child.id,
        startedAt: new Date(),
        plannedMinutes: body.planned_minutes,
        device: body.device,
      })
      .returning({ id: learningSession.id, startedAt: learningSession.startedAt });
    return { session_id: rows[0]!.id, started_at: isoUtc(rows[0]!.startedAt) };
  });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
