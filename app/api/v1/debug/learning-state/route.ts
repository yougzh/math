import { handle, intParam, methodNotAllowed } from "@/src/api/http";
import { getCfg, loadChild, resolveBundle } from "@/src/api/deps";
import { getDb } from "@/src/db/client";
import { sortedStrings } from "@/src/py/pysort";
import { deriveLevel } from "@/src/engine/state-machine";
import { splitPatternKey, type Signals } from "@/src/engine/types";
import type { AlgorithmConfig } from "@/src/engine/config";
import { loadState } from "@/src/service/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── 调试透视窗（仅开发环境） ───────────────────────────────

function signalsPayload(signals: Signals, cfg: AlgorithmConfig): Record<string, unknown> {
  const level = deriveLevel(signals, cfg);
  return {
    level,
    level_label: cfg.levelLabel(level),
    scaffold_level: cfg.scaffoldForMastery(signals.mastery),
    mastery: signals.mastery,
    accuracy: signals.accuracy,
    fluency: signals.fluency,
    independence: signals.independence,
    transfer: signals.transfer,
    confidence: signals.confidence,
    sample_count: signals.sample_count,
    assessment_samples: signals.assessment_samples,
    signal_sample_counts: Object.fromEntries(signals.signal_sample_counts),
    probe_status: signals.probe_status,
    algorithm_version: signals.algorithm_version,
  };
}

export async function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const childId = intParam(url.searchParams.get("child_id"), "query.child_id");
    const child = await loadChild(childId);
    const b = await resolveBundle();
    const cfg = getCfg();
    const state = await loadState(getDb(), child.id, b, cfg);

    const recent = state.recent_attempts.slice(-10).map((attempt) => ({
      attempt_id: attempt.attempt_id,
      seq: attempt.seq,
      item_code: attempt.item_id,
      competency: attempt.competency_id,
      pattern: attempt.pattern_id,
      correct: attempt.correct,
      hints_used: attempt.hints_used,
      thinking_time_ms: attempt.telemetry.thinkingTimeMs,
      scaffold_level: attempt.scaffold_level,
      created_at: attempt.created_at,
    }));

    return {
      child_id: child.id,
      child_name: child.name,
      algorithm_version: cfg.version,
      attempts_seen: state.attempts_seen,
      assessment_attempts: state.assessment_attempts,
      competencies: Object.fromEntries(
        sortedStrings([...state.competencies.keys()]).map((code) => [
          code,
          signalsPayload(state.competencies.get(code)!, cfg),
        ]),
      ),
      patterns: Object.fromEntries(
        sortedStrings([...state.patterns.keys()]).map((key) => {
          const [competency, pattern] = splitPatternKey(key);
          return [
            key,
            { ...signalsPayload(state.patterns.get(key)!, cfg), competency, pattern },
          ];
        }),
      ),
      misconceptions: sortedStrings([...state.misconceptions.keys()]).map((code) => {
        const misc = state.misconceptions.get(code)!;
        return {
          code,
          hit_count: misc.hit_count,
          last_seq: misc.last_seq,
          resolved: misc.resolved,
          remediation_competency: misc.remediation_competency,
        };
      }),
      recent_attempts: recent,
      first_scaffold: Object.fromEntries(state.first_scaffold),
      last_touched_seq: Object.fromEntries(state.last_touched_seq),
    };
  });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
