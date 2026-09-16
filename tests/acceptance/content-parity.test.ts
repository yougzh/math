/**
 * 内容对拍 —— TS 构建产物 vs Python 的黄金语料。
 *
 * 这是整条迁移里**唯一一条"错了就没有第二个实现能兜住"的防线**：
 * Python 会被删除（S6），`tests/oracle/fixtures/content_parity.json` 是
 * 删除之后"内容长什么样才算对"的唯一权威描述。
 *
 * 所以这个测试刻意用**逐字段深比较**，不用 toMatchSnapshot：
 *   - 快照可以被人 `-u` 一键刷新，"内容悄悄变了一点"就被吃掉了；
 *   - fixture 是源码，改它必须是一次显式的、可 review 的提交。
 *
 * 断言三件事：
 *   ① 产物 content.json 与 fixture 的 dump 部分逐字段一致（含数组顺序）；
 *   ② 产物的 load_order / competency_terms 与 fixture 一致；
 *   ③ 运行时 contentBundle() 重建出的 Map 与产物一致，且**迭代顺序 = load_order**。
 *      ③ 是必要的：content.json 是按 code 排序的，直接 new Map 会静默变成字典序，
 *      而 Python 运行时的 dict 顺序是文件加载顺序 —— 这一层没人测就会悄悄错。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { contentBundle } from "@/src/content/bundle";
import { sourceFingerprint } from "@/src/content/fingerprint";
import { canonical } from "../helpers/canonical";
import type { ContentDump, ContentIndex } from "@/src/content/types";

function readJson<T>(file: string, hint: string): T {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch (error) {
    throw new Error(`${hint}\n  路径：${file}\n  原因：${String(error)}`);
  }
}

const GENERATED_DIR = path.resolve(import.meta.dirname, "../../src/generated");
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURE = path.resolve(import.meta.dirname, "../oracle/fixtures/content_parity.json");

const REGENERATE =
  "产物缺失或不可读。先跑 `npm run build:content`（它由 next build 的 prebuild 钩子自动触发）。";

const fixture = readJson<ContentDump & ContentIndex>(FIXTURE, "对拍基准 fixture 读不到");
const generated = readJson<ContentDump>(
  path.join(GENERATED_DIR, "content.json"),
  REGENERATE,
);
const generatedIndex = readJson<ContentIndex>(
  path.join(GENERATED_DIR, "content.index.json"),
  REGENERATE,
);

/**
 * 规范化序列化：对象键排序，数组顺序原样保留。
 *
 * 为什么必须排序对象键：fixture 是 `json.dump(sort_keys=True)` 的规范形式，
 * 而 content.json 保留 cmd_dump 里字典字面量的插入顺序。两者语义相同、
 * 键序不同 —— 直接 JSON.stringify 比较会把"键序不同"误报成内容不一致。
 *
 * 为什么数组不能排序：数组顺序正是要断言的东西（items/slots/stories 的排序、
 * story beats 的 sequence 顺序）。排序数组 = 把对拍里最该守的那条扔掉。
 */
/**
 * 找出两个数组的第一处分歧，返回人话描述（没有分歧返回空串）。
 *
 * 1373 道题整体 toEqual 失败时，vitest 的 diff 会淹没在无关内容里；
 * 这里直接点出"第几项、哪个 code、哪个字段" —— 对拍失败要能一眼定位。
 */
function firstDivergence<T>(expected: readonly T[], actual: readonly T[]): string {
  const limit = Math.min(expected.length, actual.length);
  for (let i = 0; i < limit; i++) {
    const a = canonical(expected[i]);
    const b = canonical(actual[i]);
    if (a === b) continue;
    const row: unknown = expected[i];
    const code =
      typeof row === "object" && row !== null && "code" in row
        ? `（code=${String((row as { code: unknown }).code)}）`
        : "";
    // 逐字段定位到第一个不同的键，避免贴出整条 JSON
    const field = firstDifferingField(expected[i], actual[i]);
    return [
      `第 ${i} 项不同${code}${field ? `，字段 \`${field}\`` : ""}`,
      `  基准: ${a}`,
      `  产物: ${b}`,
    ].join("\n");
  }
  if (expected.length !== actual.length) {
    return `长度不同：基准 ${expected.length}，产物 ${actual.length}`;
  }
  return "";
}

function firstDifferingField(a: unknown, b: unknown): string {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return "";
  const ka = Object.keys(a);
  const kb = new Set(Object.keys(b));
  for (const key of ka) {
    if (!kb.has(key)) return `${key}（产物里没有）`;
    if (canonical((a as Record<string, unknown>)[key]) !== canonical((b as Record<string, unknown>)[key])) {
      return key;
    }
  }
  for (const key of kb) {
    if (!ka.includes(key)) return `${key}（产物里多出）`;
  }
  return "";
}

function expectSameList<T>(name: string, expected: readonly T[], actual: readonly T[]): void {
  expect(firstDivergence(expected, actual), `${name} 与基准不一致`).toBe("");
}

describe("content_parity：构建产物 vs Python 黄金语料", () => {
  // 这条放在最前面：产物过期时后面所有断言都不可信，必须先拦住。
  // 刻意**不**在测试里自动重新构建 —— 那样产物过期就永远测不出来了。
  it("产物不过期：source_fingerprint 与当前 content/ config/ 一致", () => {
    const current = sourceFingerprint(REPO_ROOT);
    expect(
      generatedIndex.source_fingerprint,
      "src/generated/ 与当前内容不一致 —— 改了 content/ 或 config/ 但没重新构建。\n" +
        "跑 `npm run build:content` 后重试。（自动重新构建会让这条断言永远成立，" +
        "所以这里刻意不自动做。）",
    ).toBe(current);
  });

  it("counts 一致", () => {
    expect(generated.counts).toEqual(fixture.counts);
  });

  it("content_version 一致", () => {
    expect(generated.content_version).toBe(fixture.content_version);
  });

  // 逐类对拍。数组顺序也是断言的一部分：Python 的排序键写在 cmd_dump 里，
  // 顺序变了说明移植时"顺手改好"了某个 sorted 的键。
  it("competencies 逐字段一致（含 stage, code 排序）", () => {
    expectSameList("competencies", fixture.competencies, generated.competencies);
  });

  it("patterns 逐字段一致（含 applicable_competencies 的并集 + 排序）", () => {
    expectSameList("patterns", fixture.patterns, generated.patterns);
  });

  it("misconceptions 逐字段一致", () => {
    expectSameList("misconceptions", fixture.misconceptions, generated.misconceptions);
  });

  it("items 逐字段一致（1373 道，含 code 排序、answer、error_rules）", () => {
    expectSameList("items", fixture.items, generated.items);
  });

  it("stories 逐字段一致（含 beats 的 sequence 顺序与 slot_code 回填）", () => {
    expectSameList("stories", fixture.stories, generated.stories);
  });

  it("slots 逐字段一致（含 story_beat_id 与两个 policy 字典）", () => {
    expectSameList("slots", fixture.slots, generated.slots);
  });

  // ── 运行时索引 ────────────────────────────────────────
  // 这两项不在 cmd_dump 的产物里，但它们同样是"Python 行为的一部分"：
  // load_order 是 Python 运行时的 dict 迭代顺序，competency_terms 是教练护栏的输入。

  it("load_order 与 Python 的 dict 迭代顺序逐项一致", () => {
    expectSameList(
      "load_order.competencies",
      fixture.load_order.competencies,
      generatedIndex.load_order.competencies,
    );
    expectSameList(
      "load_order.patterns",
      fixture.load_order.patterns,
      generatedIndex.load_order.patterns,
    );
    expectSameList(
      "load_order.misconceptions",
      fixture.load_order.misconceptions,
      generatedIndex.load_order.misconceptions,
    );
    expectSameList("load_order.items", fixture.load_order.items, generatedIndex.load_order.items);
    expectSameList("load_order.slots", fixture.load_order.slots, generatedIndex.load_order.slots);
    expectSameList(
      "load_order.stories",
      fixture.load_order.stories,
      generatedIndex.load_order.stories,
    );
  });

  it("competency_terms 一致（AI 教练「不超纲」护栏的输入）", () => {
    expect(generatedIndex.competency_terms).toEqual(fixture.competency_terms);
  });

  it("load_order 覆盖了全部内容，没有漏项也没有多余项", () => {
    const kinds = [
      ["competencies", generated.competencies],
      ["patterns", generated.patterns],
      ["misconceptions", generated.misconceptions],
      ["items", generated.items],
      ["stories", generated.stories],
      ["slots", generated.slots],
    ] as const;
    for (const [kind, rows] of kinds) {
      const ordered = generatedIndex.load_order[kind];
      expect(ordered.length, `load_order.${kind} 长度对不上`).toBe(rows.length);
      expect([...ordered].sort(), `load_order.${kind} 的集合对不上`).toEqual(
        rows.map((r) => r.code).sort(),
      );
    }
  });

  // ── 运行时重建 ────────────────────────────────────────

  describe("contentBundle() 运行时重建", () => {
    const bundle = contentBundle();

    it("各类实体数量与产物一致", () => {
      expect(bundle.competencies.size).toBe(generated.competencies.length);
      expect(bundle.patterns.size).toBe(generated.patterns.length);
      expect(bundle.misconceptions.size).toBe(generated.misconceptions.length);
      expect(bundle.items.size).toBe(generated.items.length);
      expect(bundle.stories.size).toBe(generated.stories.length);
      expect(bundle.slots.size).toBe(generated.slots.length);
    });

    it("Map 迭代顺序 = load_order（不是字典序）", () => {
      // 这条断言的意义：如果 content.json 与 content.index.json 的排序恰好相同，
      // 那"按 load_order 重建"这件事就测不出来 —— 所以顺带断言两者**确实不同**，
      // 否则这个测试会在未来的某次内容变化后悄悄失去约束力。
      expect([...bundle.items.keys()]).toEqual(generatedIndex.load_order.items);
      expect([...bundle.competencies.keys()]).toEqual(generatedIndex.load_order.competencies);
      expect([...bundle.slots.keys()]).toEqual(generatedIndex.load_order.slots);
      expect([...bundle.stories.keys()]).toEqual(generatedIndex.load_order.stories);

      const sortedByCode = [...generatedIndex.load_order.items].sort();
      expect(
        generatedIndex.load_order.items,
        "当前 items 的加载顺序恰好等于字典序 —— 「按 load_order 重建」这条约束退化成了空断言，" +
          "需要换一个能区分两者的实体来断言",
      ).not.toEqual(sortedByCode);
    });

    it("items 的 code 与产物一一对应（含 answer / error_rules 未丢失）", () => {
      const byCode = new Map(generated.items.map((row) => [row.code, row]));
      for (const [code, item] of bundle.items) {
        const expected = byCode.get(code);
        expect(expected, `产物里没有 item ${code}`).toBeDefined();
        expect(item.competency_id).toBe(expected!.competency);
        expect(item.pattern_id).toBe(expected!.pattern);
        expect(item.difficulty).toBe(expected!.difficulty);
        expect(item.answer).toEqual(expected!.answer);
        expect(item.error_rules).toEqual(expected!.error_rules);
      }
    });

    it("stories 的 beats 补回了 story_code，且顺序是 sequence 顺序", () => {
      for (const story of bundle.stories.values()) {
        const expected = generated.stories.find((s) => s.code === story.code)!;
        expect(story.beats.map((b) => b.code)).toEqual(expected.beats.map((b) => b.code));
        for (const beat of story.beats) {
          expect(beat.story_code).toBe(story.code);
          expect(beat.code.startsWith(`${story.code}__`)).toBe(true);
        }
      }
    });

    it("competencies 的 terms 从索引文件回填（dump 里没有这个字段）", () => {
      for (const competency of bundle.competencies.values()) {
        expect(competency.terms, `competency ${competency.code} 的 terms 丢了`).toEqual(
          generatedIndex.competency_terms[competency.code],
        );
      }
      // 至少有一个 terms 非空，否则这条断言证明不了什么
      const nonEmpty = [...bundle.competencies.values()].filter((c) => c.terms.length > 0);
      expect(nonEmpty.length).toBeGreaterThan(0);
    });

    it("多次调用返回同一个实例（进程内缓存）", () => {
      expect(contentBundle()).toBe(bundle);
    });
  });
});
