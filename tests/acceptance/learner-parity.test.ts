/**
 * learner 对拍 —— TS 的 applyAttempt / applyAttempts vs Python 的黄金语料。
 *
 * `tests/oracle/fixtures/learner_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py learner` 产出。
 *
 * learner 要钉的是**状态组装**（信号怎么算是 proficiency 段的事）：
 * 六类账本、错误认知的新建/累积、窗口截断、seq 排序。
 * 每条 sequence 逐步 dump 完整状态快照 —— 快照里任何一个账本记错都会红。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AlgorithmConfig, loadConfig } from "@/src/engine/config";
import { applyAttempt, applyAttempts } from "@/src/engine/learner";
import type { Attempt } from "@/src/engine/types";
import { loadBundle } from "@/src/content/loader";
import {
  learnerAttemptFromDesc,
  learnerStateFromDesc,
} from "../helpers/engine-probes";
import type { LearnerAttemptDesc, LearnerStateDesc } from "../helpers/engine-probes";
import type { ErrorRule, Item } from "@/src/content/types";

interface LearnerSequence {
  id: string;
  note: string;
  config: "v0" | "window3";
  initial: LearnerStateDesc;
  attempts: LearnerAttemptDesc[];
  steps: Record<string, unknown>[];
}

interface LearnerItemDesc {
  code: string;
  answer: unknown;
  error_rules: ErrorRule[];
}

interface Fixture {
  config_version: number;
  recent_attempt_window: number;
  items: LearnerItemDesc[];
  sequences: LearnerSequence[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/learner_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const cfg = loadConfig(fixture.config_version);
const bundle = loadBundle();

/** 与 Python 侧 dump_learner 同构：把 fixture 声明的定制 item 注入 bundle */
for (const desc of fixture.items) {
  const item: Item = {
    code: desc.code,
    competency_id: "make_ten",
    pattern_id: "direct_compute",
    difficulty: 3,
    scaffold_level: "direct",
    interaction_type: "number_pad",
    estimated_seconds: 6,
    problem: {},
    answer: desc.answer,
    steps: [],
    hint_chain: [],
    error_rules: desc.error_rules,
    steps_style: "guide",
  };
  bundle.items.set(desc.code, item);
}

/** 窗口变体：与 Python 侧 dump 时的 deepcopy(raw) + window=3 同源 */
const windowCfg = (() => {
  const raw = structuredClone(cfg.raw) as Record<string, unknown>;
  const history = { ...((raw["history"] as Record<string, unknown>) ?? {}) };
  history["recent_attempt_window"] = 3;
  raw["history"] = history;
  return new AlgorithmConfig(raw);
})();

function cfgFor(name: LearnerSequence["config"]): AlgorithmConfig {
  if (name === "v0") return cfg;
  if (name === "window3") return windowCfg;
  throw new Error(`fixture 里有未知的配置名：${name}`);
}

/** TS 侧状态快照 —— 与 Python `_learner_state_snapshot` 逐字段同构 */
function snapshot(state: ReturnType<typeof applyAttempt>): Record<string, unknown> {
  return {
    attempts_seen: state.attempts_seen,
    assessment_attempts: state.assessment_attempts,
    competencies: Object.fromEntries(
      [...state.competencies.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(
        ([code, s]) => [code, s.toDict()],
      ),
    ),
    patterns: Object.fromEntries(
      [...state.patterns.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(
        ([key, s]) => [key, s.toDict()],
      ),
    ),
    misconceptions: Object.fromEntries(
      [...state.misconceptions.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(
        ([code, m]) => [
          code,
          {
            hit_count: m.hit_count,
            last_seq: m.last_seq,
            resolved: m.resolved,
            remediation_competency: m.remediation_competency,
          },
        ],
      ),
    ),
    recent_attempt_ids: state.recent_attempts.map((a) => a.attempt_id),
    first_scaffold: Object.fromEntries(
      [...state.first_scaffold.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    last_touched_seq: Object.fromEntries(
      [...state.last_touched_seq.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };
}

// ══════════════════════════════════════════════════════════
describe("learner 对拍：前置一致性", () => {
  it("fixture 的 config_version 与本地配置一致", () => {
    expect(fixture.config_version).toBe(cfg.version);
  });

  it("真实配置的窗口大小（变体窗口只在 window3 序列里生效）", () => {
    expect(fixture.recent_attempt_window).toBe(cfg.recent_attempt_window);
  });

  it("注入的 item 进了 bundle，规则指向真实存在的错误认知", () => {
    for (const desc of fixture.items) {
      expect(bundle.items.get(desc.code), desc.code).toBeDefined();
      for (const rule of desc.error_rules) {
        expect(
          bundle.misconceptions.get(rule.code),
          `${rule.code} 不在内容定义里 —— remediation 取不到，fixture 就钉不住那条路`,
        ).toBeDefined();
      }
    }
  });
});

// ══════════════════════════════════════════════════════════
describe("learner 对拍：fixture 自证", () => {
  it("窗口截断序列真的用了变体配置，且最后只剩 3 条", () => {
    const seq = fixture.sequences.find((s) => s.id === "window_truncates")!;
    expect(seq.config).toBe("window3");
    expect(seq.attempts).toHaveLength(5);
    const last = seq.steps.at(-1) as { recent_attempt_ids: string[] };
    expect(last.recent_attempt_ids).toEqual(["a3", "a4", "a5"]);
  });

  it("错误认知累积：hit_count=2、last_seq 覆盖到第 2 条、remediation 来自内容定义", () => {
    const seq = fixture.sequences.find((s) => s.id === "misconception_created_then_accumulated")!;
    const last = seq.steps.at(-1) as {
      misconceptions: Record<string, { hit_count: number; last_seq: number; remediation_competency: string | null }>;
    };
    const misc = last.misconceptions["counting_dependency"]!;
    expect(misc.hit_count).toBe(2);
    expect(misc.last_seq).toBe(2);
    // 这个值不是 learner 写死的 —— 它来自 content/misconceptions/base.yaml
    expect(misc.remediation_competency).toBe("make_ten");
  });

  it("答对**不清除**错误认知（learner 只记不判，判定是 fallback 的事）", () => {
    const seq = fixture.sequences.find((s) => s.id === "misconception_created_then_accumulated")!;
    expect(seq.attempts.at(-1)!.correct).toBe(true);
    const last = seq.steps.at(-1) as { misconceptions: Record<string, unknown> };
    expect(Object.keys(last.misconceptions)).toContain("counting_dependency");
  });

  it("乱序序列的输入真的是乱序（[3,1,2]）—— 排序行为才有证人", () => {
    const seq = fixture.sequences.find((s) => s.id === "out_of_order_apply")!;
    expect(seq.attempts.map((a) => a.seq)).toEqual([3, 1, 2]);
  });

  it("probe 序列真的混了探测题与正式题（assessment=2）", () => {
    const seq = fixture.sequences.find((s) => s.id === "assessment_counts_and_weights")!;
    const last = seq.steps.at(-1) as { assessment_attempts: number; attempts_seen: number };
    expect(last.assessment_attempts).toBe(2);
    expect(last.attempts_seen).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════
describe("learner 对拍：逐条比较", () => {
  for (const seq of fixture.sequences) {
    it(`${seq.id}：${seq.note}`, () => {
      const state = learnerStateFromDesc(seq.initial ?? {}, new Map<string, Attempt>());
      const attempts = seq.attempts.map(learnerAttemptFromDesc);
      if (seq.id === "out_of_order_apply") {
        // 与 Python 同一条路径：整批乱序传入，内部按 seq 排
        const final = applyAttempts(state, attempts, bundle, cfgFor(seq.config));
        expect(snapshot(final), `${seq.id} 的最终快照`).toStrictEqual(seq.steps[0]);
      } else {
        expect(seq.steps.length).toBe(attempts.length);
        let current = state;
        attempts.forEach((attempt, i) => {
          current = applyAttempt(current, attempt, bundle, cfgFor(seq.config));
          expect(snapshot(current), `${seq.id} 第 ${i + 1} 步`).toStrictEqual(seq.steps[i]);
        });
      }
    });
  }

  it("applyAttempts 的排序语义：乱序整批 == 按 seq 逐条（两条路径必须同结果）", () => {
    const seq = fixture.sequences.find((s) => s.id === "out_of_order_apply")!;
    const attempts = seq.attempts.map(learnerAttemptFromDesc);
    const viaBatch = applyAttempts(
      learnerStateFromDesc({}, new Map<string, Attempt>()),
      attempts,
      bundle,
      cfg,
    );
    const viaSorted = attempts
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .reduce(
        (current, attempt) => applyAttempt(current, attempt, bundle, cfg),
        learnerStateFromDesc({}, new Map<string, Attempt>()),
      );
    expect(snapshot(viaBatch)).toStrictEqual(snapshot(viaSorted));
  });
});
