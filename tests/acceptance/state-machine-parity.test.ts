/**
 * state_machine 对拍 —— TS 的状态机 vs Python 的黄金语料。
 *
 * `tests/oracle/fixtures/state_machine_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py state_machine` 产出。
 *
 * ## 三个被验的判定，各自的风险不同
 *
 *   - `derive_level`（等级派生）：风险在「未采样不卡档」被"修好" ——
 *     六信号全 null 派生出 automatic 看起来像 bug，实际是等级/升级分离的设计后果；
 *   - `upgrade`（升级门）：风险在 **reasons 的顺序与文案** —— 那是给家长端的
 *     逐字契约，不是随意的日志；
 *   - `fallback`（回退）：风险在**目标选择** —— 「错误认知指名」与「最弱前置」
 *     是两条不同的路，EWMA 每天波动，走错路孩子等于每天换补习班。
 *
 * fixture 里的 `misconception_points_to_prereq` 特意把指名目标设成
 * `td_add_nocarry`（前置之一、但不是最弱前置会选的 `make_ten`），
 * 让 **target 本身**就能区分两条路 —— 只比 reasons 的话，指向"恰好也是最弱
 * 前置"的目标会掩盖选路逻辑的分歧。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "@/src/engine/config";
import { CompetencyGraph } from "@/src/engine/graph";
import {
  countSuccessfulPatterns,
  deriveLevel,
  fallbackDecision,
  nextCompetency,
  upgradeDecision,
} from "@/src/engine/state-machine";
import type { Decision } from "@/src/engine/types";
import { loadBundle } from "@/src/content/loader";
import { smStateFromDesc } from "../helpers/engine-probes";
import type { EngineSignalsDesc, EngineSmStateDesc } from "../helpers/engine-probes";

interface DeriveCase {
  id: string;
  note: string;
  signals: EngineSignalsDesc;
  expect: string;
}

interface CountCase {
  id: string;
  note: string;
  competency: string;
  patterns: Record<string, EngineSignalsDesc>;
  expect: number;
}

interface DecisionCase {
  id: string;
  note: string;
  competency: string;
  state: EngineSmStateDesc;
  expect: {
    action: string;
    competency_id: string;
    target_competency_id: string | null;
    reasons: string[];
  };
}

interface NextCase {
  id: string;
  note: string;
  state: EngineSmStateDesc;
  expect: string | null;
}

interface FallbackCase extends DecisionCase {
  current: string;
}

interface Fixture {
  config_version: number;
  min_samples_for_level: number;
  min_practice_samples: number;
  level_order: string[];
  derive_level: DeriveCase[];
  count_patterns: CountCase[];
  upgrade: DecisionCase[];
  next_competency: NextCase[];
  fallback: FallbackCase[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/state_machine_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const cfg = loadConfig(fixture.config_version);
const graph = new CompetencyGraph(loadBundle());

function expectDecision(got: Decision, want: DecisionCase["expect"], label: string): void {
  expect(got.action, `${label} 的 action`).toBe(want.action);
  expect(got.competency_id, `${label} 的 competency_id`).toBe(want.competency_id);
  expect(got.target_competency_id, `${label} 的 target`).toStrictEqual(want.target_competency_id);
  // reasons 是逐字契约（家长端直接展示），连顺序都不许变
  expect(got.reasons, `${label} 的 reasons`).toStrictEqual(want.reasons);
}

// ══════════════════════════════════════════════════════════
describe("state_machine 对拍：前置一致性", () => {
  it("fixture 的 config_version 与本地配置一致", () => {
    expect(fixture.config_version).toBe(cfg.version);
  });

  it("两个样本数阈值与本地配置一致（case 的期望值依赖它们）", () => {
    expect(fixture.min_samples_for_level).toBe(cfg.min_samples_for_level);
    expect(fixture.min_practice_samples).toBe(cfg.min_practice_samples);
  });

  it("level_order 与本地配置一致（derive_level 按它逐档爬）", () => {
    expect(fixture.level_order).toEqual([...cfg.level_order]);
  });

  it("所有 case 引用的能力都在图里（写错名字 = 静默比对一个不存在的分支）", () => {
    for (const c of [...fixture.count_patterns, ...fixture.upgrade]) {
      expect(
        graph.competencies.has(c.competency),
        `${c.id} 引用了不存在的能力 ${c.competency}`,
      ).toBe(true);
    }
    for (const c of fixture.fallback) {
      expect(graph.competencies.has(c.current), `${c.id} 引用了不存在的能力`).toBe(true);
    }
  });

  it("count_patterns 的 pattern 键都是合法的 pattern_key（能力::pattern）", () => {
    for (const c of fixture.count_patterns) {
      for (const key of Object.keys(c.patterns)) {
        const competency = key.split("::")[0] ?? "";
        expect(competency, `${c.id} 的键 ${key} 不是完整 pattern_key`).toBe(c.competency);
        expect(graph.competencies.has(competency), `${c.id} 的键 ${key}`).toBe(true);
      }
    }
  });

  it("fallback 的错误认知要么指名图里的能力、要么不指名", () => {
    for (const c of fixture.fallback) {
      for (const misc of c.state.misconceptions ?? []) {
        if (misc.remediation_competency != null) {
          expect(
            graph.competencies.has(misc.remediation_competency),
            `${c.id} 的错误认知指向未知能力 ${misc.remediation_competency}`,
          ).toBe(true);
        }
      }
    }
  });
});

// ══════════════════════════════════════════════════════════
describe("state_machine 对拍：fixture 自证", () => {
  it("**六信号全 null 也派生到 automatic** —— 这条反直觉行为必须留在明处", () => {
    const c = fixture.derive_level.find((x) => x.id === "all_unsampled_reaches_automatic")!;
    // 该 case 的前提：sample_count 够、但六个信号都没采样过
    expect(c.signals.sample_count).toBe(fixture.min_samples_for_level);
    expect(c.signals.mastery).toBeNull();
    expect(c.signals.accuracy).toBeNull();
    expect(c.expect).toBe(fixture.level_order.at(-1));
    // 同一组信号走升级门必然 hold（缺证据）—— 这就是等级/升级分离的意义
    const upgrade = fixture.upgrade.find((x) => x.id === "probe_only")!;
    expect(upgrade.expect.action).toBe("hold");
  });

  it("EPS 的**分界两侧**都有 case（容差内达标 / 容差外不达标）", () => {
    const covered = fixture.derive_level.find(
      (x) => x.id === "eps_covers_near_threshold",
    )!;
    const uncovered = fixture.derive_level.find((x) => x.id === "eps_is_not_infinite")!;
    // 两个 case 的 mastery 与 0.35 的差分别是 4e-10（< EPS）与 2e-9（> EPS）
    const threshold = 0.35;
    expect(threshold - covered.signals.mastery!).toBeLessThan(1e-9);
    expect(threshold - uncovered.signals.mastery!).toBeGreaterThan(1e-9);
    expect(covered.expect).toBe("understanding");
    expect(uncovered.expect).toBe(fixture.level_order[0]);
  });

  it("break 分支在真实配置下可观测：前面全满足、某一档不满足而停在那一档", () => {
    const atProficient = fixture.derive_level.find((x) => x.id === "stops_at_proficient")!;
    const atCanDo = fixture.derive_level.find((x) => x.id === "stops_at_can_do")!;
    expect(atProficient.expect).toBe("proficient");
    expect(atCanDo.expect).toBe("can_do");
    // 它们没有掉回第一档 —— 说明"逐档爬、断了停"而不是"第一个不满足就重置"
    expect(atProficient.expect).not.toBe(fixture.level_order[0]);
    expect(atCanDo.expect).not.toBe(fixture.level_order[0]);
  });

  it("count_patterns 覆盖了 min_patterns=2 的两侧（1 个与 2 个）", () => {
    const one = fixture.count_patterns.find((x) => x.id === "min_accuracy_boundary")!;
    const two = fixture.count_patterns.find((x) => x.id === "both_count")!;
    expect(one.expect).toBe(1);
    expect(two.expect).toBe(2);
  });

  it("upgrade 的 reasons 顺序 case 踩中了全部五类原因", () => {
    const c = fixture.upgrade.find((x) => x.id === "reasons_ordering")!;
    expect(c.expect.reasons[0]).toBe("目前只有探测题，没有正式练习样本");
    expect(c.expect.reasons[1]).toContain("正式练习样本不足");
    expect(c.expect.reasons[2]).toContain("accuracy=");
    expect(c.expect.reasons[3]).toContain("mastery 尚无证据");
  });

  it("「缺证据」与「不达标」两种文案都出现过", () => {
    const allReasons = fixture.upgrade.flatMap((c) => c.expect.reasons);
    expect(allReasons.some((r) => r.includes("尚无证据"))).toBe(true);
    expect(allReasons.some((r) => r.includes("< 0.9"))).toBe(true);
  });

  it("fallback 的指名路与最弱前置路的 **target 不同**（这是两条不同的路）", () => {
    const named = fixture.fallback.find((x) => x.id === "misconception_points_to_prereq")!;
    const weakest = fixture.fallback.find((x) => x.id === "consecutive_wrong_three")!;
    // 指名 → td_add_nocarry；最弱前置 → make_ten。若两者相同，
    // "不再另算最弱前置"的那段逻辑就没有被区分出来
    expect(named.expect.target_competency_id).not.toBe(weakest.expect.target_competency_id);
    expect(named.expect.action).toBe("fallback");
    expect(weakest.expect.action).toBe("fallback");
  });

  it("misconception 的三个『不触发』形态都有 case（resolved / 太老 / 指向闭包外）", () => {
    const ids = fixture.fallback.map((c) => c.id);
    for (const id of [
      "misconception_resolved_ignored",
      "misconception_too_old",
      "misconception_points_outside_prereq",
    ]) {
      expect(ids, `缺少 ${id}`).toContain(id);
    }
    // 三条都不该出现「近期命中错误认知」—— 只走最弱前置
    for (const id of [
      "misconception_resolved_ignored",
      "misconception_too_old",
      "misconception_points_outside_prereq",
    ]) {
      const c = fixture.fallback.find((x) => x.id === id)!;
      expect(c.expect.reasons.some((r) => r.includes("近期命中错误认知")), id).toBe(false);
    }
  });

  it("触发但无前置 → hold（不是 fallback 到 null）", () => {
    const c = fixture.fallback.find((x) => x.id === "no_prerequisite_to_fall_back")!;
    expect(c.expect.action).toBe("hold");
    expect(c.expect.target_competency_id).toBeNull();
    expect(c.expect.reasons.at(-1)).toBe("该能力没有前置能力可回退");
  });

  it("next_competency 的排序键覆盖了 seq 优先与 code 决胜", () => {
    const tie = fixture.next_competency.find((x) => x.id === "same_seq_tie_breaks_on_code")!;
    const seq = fixture.next_competency.find((x) => x.id === "larger_seq_wins")!;
    expect(tie.expect).toBe("borrow_sub"); // borrow_sub < carry_add
    expect(seq.expect).toBe("carry_add"); // seq 9 > 5
  });
});

// ══════════════════════════════════════════════════════════
describe("state_machine 对拍：逐条比较", () => {
  for (const c of fixture.derive_level) {
    it(`deriveLevel：${c.id}`, () => {
      // 经 smStateFromDesc 构造，与 Python 侧 _sm_state_from 同一条路径
      const signals = smStateFromDesc({ competencies: { x: c.signals } }).competencies.get("x")!;
      expect(deriveLevel(signals, cfg), `${c.id}：${c.note}`).toBe(c.expect);
    });
  }

  for (const c of fixture.count_patterns) {
    it(`countSuccessfulPatterns：${c.id}`, () => {
      const state = smStateFromDesc({ patterns: c.patterns });
      expect(
        countSuccessfulPatterns(state, c.competency, graph, cfg),
        `${c.id}：${c.note}`,
      ).toBe(c.expect);
    });
  }

  for (const c of fixture.upgrade) {
    it(`upgradeDecision：${c.id}`, () => {
      const state = smStateFromDesc(c.state);
      expectDecision(
        upgradeDecision(state, c.competency, graph, cfg),
        c.expect,
        `${c.id}：${c.note}`,
      );
    });
  }

  for (const c of fixture.next_competency) {
    it(`nextCompetency：${c.id}`, () => {
      const state = smStateFromDesc(c.state);
      expect(nextCompetency(state, graph, cfg), `${c.id}：${c.note}`).toBe(c.expect);
    });
  }

  for (const c of fixture.fallback) {
    it(`fallbackDecision：${c.id}`, () => {
      const state = smStateFromDesc(c.state);
      expectDecision(
        fallbackDecision(state, c.current, graph, cfg),
        c.expect,
        `${c.id}：${c.note}`,
      );
    });
  }
});
