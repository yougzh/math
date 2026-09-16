/**
 * intent 对拍 —— TS 的 deriveIntents / describeIntents vs Python 的黄金语料。
 *
 * `tests/oracle/fixtures/intent_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py intent` 产出。
 *
 * 覆盖五类意图的触发条件与并存关系：
 *   warmup（召回已会未自动化，排除当前 target）
 *   repair（fallback 触发时优先，且抑制 teach）
 *   probe_transfer（熟练度过线 + 有未试结构 + transfer 无证据）
 *   strengthen_fluency（会做但慢，与 teach 并存）
 *   teach（默认推进）
 * 排序按 (priority, kind)，describe 的编号文案逐字对拍。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadBundle } from "@/src/content/loader";
import { loadConfig } from "@/src/engine/config";
import { CompetencyGraph } from "@/src/engine/graph";
import { deriveIntents, describeIntents } from "@/src/engine/intent";
import { intentToDict } from "@/src/engine/planner";
import { intentStateFromDesc } from "../helpers/planning-probes";
import type { IntentStateDesc } from "../helpers/planning-probes";

interface IntentCase {
  id: string;
  note: string;
  initial: IntentStateDesc;
  intents: Array<Record<string, unknown>>;
  described: string[];
}

interface Fixture {
  config_version: number;
  cases: IntentCase[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/intent_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const cfg = loadConfig(fixture.config_version);
const bundle = loadBundle();
const graph = new CompetencyGraph(bundle);

// ══════════════════════════════════════════════════════════
describe("intent 对拍：前置一致性", () => {
  it("fixture 的 config_version 与本地配置一致", () => {
    expect(fixture.config_version).toBe(cfg.version);
  });
});

// ══════════════════════════════════════════════════════════
describe("intent 对拍：derive_intents 全量", () => {
  for (const c of fixture.cases) {
    it(`${c.id}：${c.note}`, () => {
      const state = intentStateFromDesc(c.initial);
      const intents = deriveIntents(state, graph, bundle, cfg);
      expect(intents.map(intentToDict), c.id).toStrictEqual(c.intents);
    });
  }
});

// ══════════════════════════════════════════════════════════
describe("intent 对拍：describe_intents 文案", () => {
  for (const c of fixture.cases) {
    it(`${c.id} 的编号清单逐字一致`, () => {
      const state = intentStateFromDesc(c.initial);
      const intents = deriveIntents(state, graph, bundle, cfg);
      expect(describeIntents(intents), c.id).toStrictEqual(c.described);
    });
  }

  it("fixture 自证：五类意图都有 case 踩中", () => {
    const kinds = new Set(fixture.cases.flatMap((c) => c.intents.map((i) => i.kind)));
    for (const kind of ["warmup", "repair", "probe_transfer", "strengthen_fluency", "teach"]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });
});
