/**
 * planner 对拍 —— TS 的 buildDailyPlan / renderPlan vs Python 的黄金语料。
 *
 * `tests/oracle/fixtures/planner_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py planner` 产出。
 *
 * 覆盖：预算夹取、段落比例重分配、故事段（fx_story 三拍三种命运：
 * 正常落题 / 候选池为空 / 挂不上 slot）、复习占热身容量（不溢出段落）、
 * 复习槽位写死别的 pattern → 宁可跳过、无故事的两档 note、
 * 今日发现的三档文案。notes 是逐字对拍重灾区
 * （Python str(None)="None"、str(list)="['a', 'b']"）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "@/src/engine/config";
import { CompetencyGraph } from "@/src/engine/graph";
import { buildDailyPlan, intentToDict, renderPlan } from "@/src/engine/planner";
import {
  buildPlannerBundle,
  intentStateFromDesc,
  reviewItemFromDesc,
} from "../helpers/planning-probes";
import type {
  IntentStateDesc,
  PlannerCaseDesc,
  PlannerItemDesc,
  PlannerReviewDesc,
  PlannerSlotDesc,
  PlannerStoryDesc,
} from "../helpers/planning-probes";

interface PlanSegmentExpect {
  type: string;
  budget_s: number;
  intents: Array<Record<string, unknown>>;
  items: string[];
  slot_code: string | null;
  scaffold_level: string | null;
  note: string;
  story_code: string | null;
  beats: Array<{ beat_code: string; slot_code: string; item_code: string }>;
}

interface PlannerCase extends PlannerCaseDesc {
  initial: IntentStateDesc;
  plan: {
    child_id: string;
    budget_minutes: number;
    segments: PlanSegmentExpect[];
    intents: Array<Record<string, unknown>>;
    discovery: string;
    notes: string[];
  };
  render: string;
}

interface Fixture {
  config_version: number;
  items: PlannerItemDesc[];
  slots: PlannerSlotDesc[];
  story: PlannerStoryDesc;
  reviews: PlannerReviewDesc[];
  cases: PlannerCase[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/planner_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const cfg = loadConfig(fixture.config_version);

function runCase(c: PlannerCase) {
  const bundle = buildPlannerBundle(fixture.items, fixture.slots, fixture.story, c);
  const graph = new CompetencyGraph(bundle);
  const state = intentStateFromDesc(c.initial);
  const due = (c.due_reviews ?? []).map((key) => {
    const row = fixture.reviews.find((r) => r.key === key);
    if (row === undefined) throw new Error(`case ${c.id} 引用了不存在的 review ${key}`);
    return reviewItemFromDesc(row);
  });
  const plan = buildDailyPlan(
    state,
    graph,
    bundle,
    cfg,
    c.budget_minutes ?? undefined,
    due.length > 0 ? due : undefined,
  );
  return { plan, render: renderPlan(plan, graph, cfg) };
}

// ══════════════════════════════════════════════════════════
describe("planner 对拍：前置一致性", () => {
  it("fixture 的 config_version 与本地配置一致", () => {
    expect(fixture.config_version).toBe(cfg.version);
  });

  it("注入的 fx_ 实体描述齐备", () => {
    expect(fixture.items.length).toBe(2);
    expect(fixture.slots.length).toBe(3);
    expect(fixture.story.beats.length).toBe(5);
    expect(fixture.reviews.length).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════
describe("planner 对拍：build_daily_plan 全量", () => {
  for (const c of fixture.cases) {
    it(`${c.id}：${c.note}`, () => {
      const { plan } = runCase(c);
      expect(plan.child_id, `${c.id} child_id`).toBe(c.plan.child_id);
      expect(plan.budget_minutes, `${c.id} budget`).toBe(c.plan.budget_minutes);
      expect(
        plan.segments.map((s) => ({
          type: s.type,
          budget_s: s.budget_s,
          intents: s.intents.map(intentToDict),
          items: s.items.map((i) => i.code),
          slot_code: s.slot_code,
          scaffold_level: s.scaffold_level,
          note: s.note,
          story_code: s.story_code,
          beats: s.beats.map((b) => ({
            beat_code: b.beat_code,
            slot_code: b.slot_code,
            item_code: b.item_code,
          })),
        })),
        `${c.id} segments`,
      ).toStrictEqual(c.plan.segments);
      expect(
        plan.intents.map(intentToDict),
        `${c.id} intents`,
      ).toStrictEqual(c.plan.intents);
      expect(plan.discovery, `${c.id} discovery`).toBe(c.plan.discovery);
      expect(plan.notes, `${c.id} notes`).toStrictEqual(c.plan.notes);
    });
  }
});

// ══════════════════════════════════════════════════════════
describe("planner 对拍：render_plan 文本", () => {
  for (const c of fixture.cases) {
    it(`${c.id} 的渲染文本逐字一致`, () => {
      const { render } = runCase(c);
      expect(render).toBe(c.render);
    });
  }
});

// ══════════════════════════════════════════════════════════
describe("planner 对拍：关键分支自证", () => {
  it("故事段三拍三种命运都被踩中", () => {
    const c = fixture.cases.find((x) => x.id === "mid_progress_with_story")!;
    const story = c.plan.segments.find((s) => s.type === "story")!;
    expect(story.story_code).toBe("fx_story");
    expect(story.beats.length).toBe(1);
    expect(c.plan.notes).toContain("故事 fx_story 节拍 fx_story__b3 的 slot fx_story_slot_b 候选池为空");
    expect(c.plan.notes).toContain("故事 fx_story 的挑战节拍 fx_story__b4 没有可用的 slot");
  });

  it("复习溢出时常规热身整段消失，复习项全部保留（超出容量的也留在 warmup 段）", () => {
    const c = fixture.cases.find((x) => x.id === "reviews_overflow")!;
    const warmup = c.plan.segments.find((s) => s.type === "warmup")!;
    // Python: len(review_intents) >= capacity → return list(review_intents)
    // 溢出的复习不新开段落，也不丢弃 —— 全部挤在 warmup 段里
    expect(warmup.intents.every((i) => i.kind === "review")).toBe(true);
    expect(warmup.intents.length).toBe(3);
    expect(warmup.items.length).toBe(3);
    expect(c.plan.intents.filter((i) => i.kind === "review").length).toBe(3);
  });

  it("repair 触发时 core 段没有 teach 意图（修复期间不推进新内容）", () => {
    const intentCase = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, "../oracle/fixtures/intent_parity.json"),
        "utf8",
      ),
    ) as { cases: Array<{ id: string; intents: Array<{ kind: string }> }> };
    const repair = intentCase.cases.find((x) => x.id === "repair_after_consecutive_wrong")!;
    expect(repair.intents.map((i) => i.kind)).not.toContain("teach");
  });

  it("今日发现三档文案各有 case", () => {
    const discoveries = fixture.cases.map((c) => c.plan.discovery);
    expect(discoveries.some((d) => d.includes("第一次还要"))).toBe(true);
    expect(discoveries.some((d) => d.includes("越来越顺"))).toBe(true);
    expect(discoveries.some((d) => d.includes("不止一种算法"))).toBe(true);
  });
});

