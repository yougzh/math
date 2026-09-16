/**
 * selector 对拍 —— TS 的选题器 vs Python 的黄金语料。
 *
 * `tests/oracle/fixtures/selector_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py selector` 产出。
 *
 * 覆盖：pattern 契约②步（难度阶梯让步）、放宽 pattern、避重窗口（含
 * 显式 0 与下限夹取）、staleness 宁重复不降级、prefer_untried_pattern、
 * 脚手架放宽、select_items 组内排除、跨槽位 exclude_codes。
 * 函数级 probe 把私有函数逐个钉住 —— 端到端分不清"哪一步分叉"时用它定位。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "@/src/engine/config";
import { CompetencyGraph } from "@/src/engine/graph";
import {
  avoidRecentWindow,
  difficultyStep,
  effectiveScaffold,
  lastDifficulty,
  pickPattern,
  recentCodes,
  scaffoldOrder,
  selectItem,
  selectItems,
  staleness,
  targetDifficulty,
  triedPatterns,
  zone,
} from "@/src/engine/selector";
import {
  buildSelectorBundle,
  selectorStateFromDesc,
} from "../helpers/planning-probes";
import type { SelectorCaseShape, SelectorFixtureShape } from "../helpers/planning-probes";

interface Fixture extends SelectorFixtureShape {}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/selector_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const cfg = loadConfig(fixture.config_version);
const bundle = buildSelectorBundle(fixture);
const graph = new CompetencyGraph(bundle);

function runCase(c: SelectorCaseShape): string[] | null {
  const state = selectorStateFromDesc(c.initial);
  const slot = bundle.slots.get(c.slot);
  if (slot === undefined) throw new Error(`case ${c.id} 的 slot ${c.slot} 不存在`);
  if (c.count === 1) {
    const picked = selectItem(slot, state, bundle, cfg, c.exclude_codes);
    return picked === null ? null : [picked.code];
  }
  return selectItems(slot, state, bundle, cfg, c.count, c.exclude_codes).map((i) => i.code);
}

// ══════════════════════════════════════════════════════════
describe("selector 对拍：前置一致性", () => {
  it("fixture 的 config_version 与本地配置一致", () => {
    expect(fixture.config_version).toBe(cfg.version);
  });

  it("定制 bundle 与 Python 侧实体数一致", () => {
    expect(bundle.competencies.size).toBe(fixture.competencies.length);
    expect(bundle.patterns.size).toBe(fixture.patterns.length);
    expect(bundle.items.size).toBe(fixture.items.length);
    expect(bundle.slots.size).toBe(fixture.slots.length);
  });

  it("fixture 自证：每条 case 都有 picked 记录", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(16);
    for (const c of fixture.cases) {
      expect(Array.isArray(c.picked) || c.picked === null, c.id).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════
describe("selector 对拍：端到端 select_item / select_items", () => {
  for (const c of fixture.cases) {
    it(`${c.id}：${c.note}`, () => {
      expect(runCase(c), c.id).toStrictEqual(c.picked);
    });
  }
});

// ══════════════════════════════════════════════════════════
describe("selector 对拍：函数级 probe", () => {
  // 与 Python dump_selector 的 probe_state 同源
  const probeState = selectorStateFromDesc({
    competencies: { c_a: { mastery: 0.5, sample_count: 6 } },
    patterns: { "c_a::p1": { mastery: 0.4, sample_count: 3 } },
    recent_attempts: [
      { item: "fx_i_d3", seq: 1 },
      { item: "fx_i_d1", seq: 2 },
    ],
  });
  const emptyState = selectorStateFromDesc({});
  const history = probeState.recent_attempts.map((a) => a.item_id);
  const slotMain = bundle.slots.get("fx_slot_main")!;
  const slotP2 = bundle.slots.get("fx_slot_p2")!;
  const slotTight = bundle.slots.get("fx_slot_tight")!;
  const slotAvoid0 = bundle.slots.get("fx_slot_avoid0")!;
  const slotAvoid1 = bundle.slots.get("fx_slot_avoid1")!;
  const slotUntried = bundle.slots.get("fx_slot_untried")!;

  const computed: Record<string, unknown> = {
    recent_codes_w2: recentCodes(probeState, 2),
    recent_codes_w0: recentCodes(probeState, 0),
    staleness_hit: staleness(bundle.items.get("fx_i_d1")!, history),
    staleness_miss: staleness(bundle.items.get("fx_i_b1")!, history),
    avoid_default: avoidRecentWindow(slotMain, cfg),
    avoid_zero_explicit: avoidRecentWindow(slotAvoid0, cfg),
    avoid_one_clamped: avoidRecentWindow(slotAvoid1, cfg),
    last_difficulty_hit: lastDifficulty(probeState, bundle, "c_a"),
    last_difficulty_unknown_item: lastDifficulty(
      selectorStateFromDesc({
        recent_attempts: [
          { item: "ghost_item", seq: 1, competency: "c_a" },
          { item: "fx_i_d3", seq: 2 },
        ],
      }),
      bundle,
      "c_a",
    ),
    last_difficulty_none: lastDifficulty(emptyState, bundle, "c_a"),
    step_no_last: difficultyStep(slotMain, null, cfg),
    step_from_3: difficultyStep(slotMain, 3, cfg),
    step_clamped: difficultyStep(slotTight, 4, cfg),
    zone_in: zone(2, 1, 3),
    zone_below: zone(0, 1, 3),
    zone_above: zone(4, 1, 3),
    target_difficulty_null: targetDifficulty(slotMain, emptyState, cfg),
    target_difficulty_low: targetDifficulty(
      slotMain,
      selectorStateFromDesc({ competencies: { c_a: { mastery: 0.25, sample_count: 6 } } }),
      cfg,
    ),
    target_difficulty_mid: targetDifficulty(
      slotMain,
      selectorStateFromDesc({ competencies: { c_a: { mastery: 0.75, sample_count: 6 } } }),
      cfg,
    ),
    target_difficulty_high: targetDifficulty(
      slotMain,
      selectorStateFromDesc({ competencies: { c_a: { mastery: 1.0, sample_count: 6 } } }),
      cfg,
    ),
    scaffold_order_blocks: scaffoldOrder("blocks"),
    scaffold_order_unknown: scaffoldOrder("auto"),
    tried_patterns: [...triedPatterns(probeState, "c_a")].sort(),
    pick_pattern_unconstrained: pickPattern(slotMain, probeState, bundle, "direct"),
    pick_pattern_slot_fixed: pickPattern(slotP2, probeState, bundle, "direct"),
    pick_pattern_untried: pickPattern(slotUntried, probeState, bundle, "direct"),
  };

  for (const probe of fixture.probes) {
    it(`${probe.id}：${probe.note}`, () => {
      expect(computed[probe.id], probe.id).toStrictEqual(probe.result);
    });
  }

  it("fixture 自证：effectiveScaffold 的三档映射在端到端 case 里都被踩过", () => {
    const scaffolds = new Set(
      fixture.cases.map((c) =>
        effectiveScaffold(
          bundle.slots.get(c.slot)!,
          selectorStateFromDesc(c.initial),
          cfg,
        ),
      ),
    );
    expect(scaffolds.has("blocks")).toBe(true);
    expect(scaffolds.has("direct")).toBe(true);
  });
});
