import { ensureRange, handle, intParam, methodNotAllowed } from "@/src/api/http";
import { getCfg, getGraph, loadChild, resolveBundle } from "@/src/api/deps";
import { getDb } from "@/src/db/client";
import { reportPayload } from "@/src/service/report";
import { loadState } from "@/src/service/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const childId = intParam(url.searchParams.get("child_id"), "query.child_id");
    const daysRaw = intParam(url.searchParams.get("days"), "query.days");
    const days = ensureRange(daysRaw ?? 7, "query.days", { ge: 1, le: 90 });
    const child = await loadChild(childId);
    const b = await resolveBundle();
    const cfg = getCfg();
    const state = await loadState(getDb(), child.id, b, cfg);
    return reportPayload(getDb(), child, state, cfg, b, getGraph(), days);
  });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
