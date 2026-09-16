import { handle, methodNotAllowed, readJsonBody } from "@/src/api/http";
import { getCoach, getGraph, loadChild, resolveBundle } from "@/src/api/deps";
import { parseHintIn } from "@/src/api/schemas";
import { itemMissing } from "@/src/service/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = parseHintIn(await readJsonBody(request));
    await loadChild(body.child_id);
    const b = await resolveBundle();
    const coach = getCoach(b);
    const item = b.items.get(body.item_code);
    if (item === undefined) {
      throw itemMissing(body.item_code);
    }
    // CoachMessage.to_hint_dict() 即契约 §5 的响应形状
    return (await coach.hint(item, body.hints_used)).toHintDict();
  });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
