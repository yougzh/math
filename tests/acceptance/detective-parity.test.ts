/**
 * detective 对拍 —— TS 的谜题生成/判分 vs Python 的黄金语料。
 *
 * `tests/oracle/fixtures/detective_parity.json` 由
 * `python3 scripts/oracle/dump_fixtures.py detective` 产出。
 *
 * 纯函数 + MT19937 种子：同一 puzzle_id 两侧必须重建出同一道题。
 * 三层对拍：
 *   1. 生成的谜题逐字（toDict 全量 + solve/weak_clues + answer）；
 *   2. judge 的输入变体（Python int(str) 的接受域就是判分的接受域，
 *      "36.0" 与 "036" 的分别对待就活在这一层）；
 *   3. 穷举扫描 0..1999 × {auto, 3 kind}：validate/is_trivial 的任何分叉
 *      都会体现在顺延 offset 序列上。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALL_KINDS,
  generatePuzzle,
  judge,
  makePuzzleId,
  parsePuzzleId,
  revealAfterAttempt,
  KIND_BALANCE,
} from "@/src/engine/detective";
import type { Puzzle } from "@/src/engine/detective";
import { PyRandom } from "@/src/py/pyrandom";
import { GENERATORS } from "@/src/engine/detective";

interface DetectiveCase {
  puzzle_id: string;
  kind: string | null;
  /** reveal_count 变体（缺省 = 引擎默认 2）：1=下限；99=上界夹取 */
  reveal_count?: number;
  to_dict: Record<string, unknown>;

  answer: number;
  solve: number[];
  validate: string[];
  weak_clues: string[];
}

interface Fixture {
  seeds: number[];
  fixed_kind_seeds: number[];
  scan_range: number;
  cases: DetectiveCase[];
  judge_cases: Array<{ input: unknown; expect: boolean }>;
  reveal_cases: Array<{
    puzzle_id: string;
    kind: string | null;
    wrong_reveals: string[];
    right_reveals: string[];
    clues_remaining: number;
  }>;
  parse_cases: Array<{ puzzle_id: string; expect: number | null }>;
  scan: Array<{ kind: string | null; offsets: number[] }>;
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../oracle/fixtures/detective_parity.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

// ══════════════════════════════════════════════════════════
describe("detective 对拍：生成的谜题逐字一致", () => {
  for (const c of fixture.cases) {
    it(
      `${c.puzzle_id}${c.kind ? ` (${c.kind})` : ""}${c.reveal_count != null ? ` reveal=${c.reveal_count}` : ""}`,
      () => {
      const puzzle = generatePuzzle(
        c.puzzle_id,
        c.kind ?? undefined,
        c.reveal_count ?? undefined,
      );
      expect(puzzle.toDict()).toStrictEqual(c.to_dict);
      expect(puzzle.answer).toBe(c.answer);
      // 独立求解：不信任 answer 字段
      expect(puzzle.solve(), `${c.puzzle_id} solve`).toStrictEqual(c.solve);
      expect(puzzle.solve()).toStrictEqual([c.answer]);
        expect(puzzle.validate(), `${c.puzzle_id} validate`).toStrictEqual(c.validate);
        expect(puzzle.weak_clues(), `${c.puzzle_id} weak_clues`).toStrictEqual(c.weak_clues);
      },
    );
  }
});

// ══════════════════════════════════════════════════════════
describe("detective 对拍：judge 的接受域", () => {
  const probe = generatePuzzle("det_0042");

  for (const jc of fixture.judge_cases) {
    it(`judge(${JSON.stringify(jc.input)}) = ${jc.expect}`, () => {
      expect(judge(probe, jc.input)).toBe(jc.expect);
    });
  }
});

// ══════════════════════════════════════════════════════════
describe("detective 对拍：答错揭示 / 答对不揭", () => {
  for (const rc of fixture.reveal_cases) {
    it(`${rc.puzzle_id}${rc.kind ? ` (${rc.kind})` : ""}`, () => {
      const puzzle = generatePuzzle(rc.puzzle_id, rc.kind ?? undefined);
      const wrong: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        wrong.push(...revealAfterAttempt(puzzle, false));
      }
      expect(wrong).toStrictEqual(rc.wrong_reveals);
      expect(revealAfterAttempt(puzzle, true)).toStrictEqual(rc.right_reveals);
      expect(puzzle.clues_remaining).toBe(rc.clues_remaining);
    });
  }
});

// ══════════════════════════════════════════════════════════
describe("detective 对拍：puzzle_id 解析", () => {
  for (const pc of fixture.parse_cases) {
    it(`parsePuzzleId(${JSON.stringify(pc.puzzle_id)})`, () => {
      expect(parsePuzzleId(pc.puzzle_id)).toBe(pc.expect);
    });
  }
});

// ══════════════════════════════════════════════════════════
describe("detective 对拍：穷举扫描（顺延 offset 序列）", () => {
  it(
    "0..1999 × 4 种 kind 的顺延序列与 Python 逐项一致",
    () => {
      expect(fixture.scan.length).toBe(4);
      for (const entry of fixture.scan) {
        const offsets = scanOffsets(entry.kind, fixture.scan_range);
        expect(offsets, `kind=${entry.kind}`).toStrictEqual(entry.offsets);
      }
    },
    120_000,
  );

  it("fixture 自证：balance 的顺延确实发生过（不是平凡的恒零）", () => {
    const balance = fixture.scan.find((s) => s.kind === KIND_BALANCE)!;
    expect(balance.offsets.some((o) => o > 0)).toBe(true);
  });

  it("不变量自证：全部 case 的全部线索解恰好是 [answer]", () => {
    for (const c of fixture.cases) {
      expect(c.solve, c.puzzle_id).toStrictEqual([c.answer]);
      expect(c.validate, c.puzzle_id).toStrictEqual([]);
    }
  });
});

/** 与 Python dump_detective 的扫描同构：重放 generatePuzzle 的顺延搜索 */
function scanOffsets(kind: string | null, range: number): number[] {
  const offsets: number[] = [];
  for (let seed = 0; seed < range; seed += 1) {
    let offset = -1;
    for (let off = 0; off < 40; off += 1) {
      const s = seed + off;
      const rng = new PyRandom(s * 7919 + 13);
      const chosen = kind || ALL_KINDS[s % ALL_KINDS.length]!;
      const generator = GENERATORS[chosen]!;
      const puzzle: Puzzle = generator(rng, makePuzzleId(s));
      if (puzzle.validate().length === 0) {
        const reveal = Math.max(1, Math.min(2, puzzle.clues.length - 1));
        if (!puzzle.is_trivial(reveal)) {
          offset = off;
          break;
        }
      }
    }
    offsets.push(offset);
  }
  return offsets;
}
