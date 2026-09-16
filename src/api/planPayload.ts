/**
 * 今日计划的响应投影 —— `backend/api/routes_learning.py` 的 `plan_payload`。
 *
 * 注意这是**路由层的裁剪投影**，不是 planner 的 toDict：
 *   - intents 只留 kind / competency（改名！）/ reason 三个字段；
 *   - segments.items 是完整 itemPayload（含 prompt），不是 toDict 的 code 列表。
 */
import type { ContentBundle } from "@/src/content/types";
import type { DailyPlan } from "@/src/engine/planner";
import { itemPayload } from "@/src/service/content";

export function planPayload(plan: DailyPlan, _bundle: ContentBundle): Record<string, unknown> {
  return {
    child_id: Math.trunc(Number(plan.child_id)),
    budget_minutes: plan.budget_minutes,
    intents: plan.intents.map((intent) => ({
      kind: intent.kind,
      competency: intent.competency_id,
      reason: intent.reason,
    })),
    segments: plan.segments.map((segment) => ({
      type: segment.type,
      budget_s: segment.budget_s,
      intent_kinds: segment.intents.map((intent) => intent.kind),
      slot_code: segment.slot_code,
      scaffold_level: segment.scaffold_level,
      story_code: segment.story_code,
      beats: segment.beats.map((beat) => ({
        beat_code: beat.beat_code,
        slot_code: beat.slot_code,
        item_code: beat.item_code,
      })),
      items: segment.items.map((item) => itemPayload(item)),
      note: segment.note,
    })),
    discovery: plan.discovery,
    notes: [...plan.notes],
  };
}
