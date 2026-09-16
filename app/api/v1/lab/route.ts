import { handle, intParam, methodNotAllowed } from "@/src/api/http";
import { getCfg, loadChild, resolveBundle } from "@/src/api/deps";
import { getDb } from "@/src/db/client";
import { labPayload } from "@/src/service/growth";
import { loadState } from "@/src/service/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const childId = intParam(url.searchParams.get("child_id"), "query.child_id");
    const child = await loadChild(childId);
    const b = await resolveBundle();
    const cfg = getCfg();
    const state = await loadState(getDb(), child.id, b, cfg);
    return labPayload(state, cfg);
  });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
