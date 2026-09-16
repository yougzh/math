import { handle, intParam, methodNotAllowed } from "@/src/api/http";
import { getCfg, loadChild, resolveBundle } from "@/src/api/deps";
import { getDb } from "@/src/db/client";
import { storyMissing } from "@/src/service/errors";
import { storyPayload } from "@/src/service/content";
import { loadState } from "@/src/service/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ story_code: string }> },
) {
  return handle(async () => {
    const { story_code: storyCode } = await ctx.params;
    const url = new URL(request.url);
    const childId = intParam(url.searchParams.get("child_id"), "query.child_id");
    const child = await loadChild(childId);
    const b = await resolveBundle();
    const cfg = getCfg();
    const state = await loadState(getDb(), child.id, b, cfg);
    const payload = await storyPayload(storyCode, state, cfg);
    if (payload === null) {
      throw storyMissing(storyCode);
    }
    return payload;
  });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
