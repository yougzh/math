import { handle, methodNotAllowed, readJsonBody } from "@/src/api/http";
import { getCoach, getCfg, getGraph, resolveBundle } from "@/src/api/deps";
import { parseAttemptIn } from "@/src/api/schemas";
import { Telemetry } from "@/src/engine/types";
import {
  submitAttempt,
  type AttemptSubmission,
} from "@/src/service/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = parseAttemptIn(await readJsonBody(request));
    const b = await resolveBundle();
    const cfg = getCfg();
    const coach = getCoach(b);
    const submission: AttemptSubmission = {
      client_attempt_id: body.client_attempt_id,
      child_id: body.child_id,
      item_code: body.item_code,
      answer: body.answer,
      telemetry: new Telemetry({
        response_time_ms: body.telemetry.response_time_ms,
        active_time_ms: body.telemetry.active_time_ms,
        idle_time_ms: body.telemetry.idle_time_ms,
      }),
      session_id: body.session_id,
      slot_code: body.slot_code,
      client_correct: body.client_correct,
      hints_used: body.hints_used,
      hint_level_max: body.hint_level_max,
      method_used: body.method_used,
      is_transfer_probe: body.is_transfer_probe,
      is_assessment: body.is_assessment,
    };
    return submitAttempt(b, cfg, coach, submission);
  });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
