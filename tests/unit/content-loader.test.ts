/**
 * `src/content/loader.ts` 的单测。
 *
 * 为什么不能只靠 content-parity
 * -----------------------------
 * content-parity 比的是"现有内容下的产物"，它只能证明**现有内容走过的分支**是对的。
 * 而 loader 是整个迁移里对拍风险最高的文件（文件遍历顺序、YAML 语义、默认值、
 * 浅拷贝），偏偏现有内容把这些分支走得很"平"：单 stage、没有 YAML 1.1 专有字面量、
 * 每道题的 difficulty/scaffold_level 都写全了（**默认值一个都没走到**）。
 * 这些语义现在不测，等真踩上就只剩"内容莫名其妙不对"。
 *
 * 用临时目录 + chdir 而不是给 loader 加"测试专用 baseDir 参数"：
 * 后者测的就不是生产路径了。loader 的目录常量是相对路径（与 backend/paths.py
 * 的绝对路径不同），"相对 cwd 解析"本身就是一条要钉住的行为。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadCompetencies,
  loadItems,
  loadSlots,
  loadStories,
  parseYamlDoc,
  readYamlDir,
} from "@/src/content/loader";

// ── YAML 解析语义 ────────────────────────────────────────
// 这一组是"loadBundle 的输出与 PyYAML 一致"的地基：解析器语义不同，
// 下游再怎么逐行照抄也没用。

describe("parseYamlDoc：与 PyYAML 的语义对齐", () => {
  it("按 YAML 1.1 解析 on/off/yes/no（PyYAML 是 1.1，yaml 包默认 1.2）", () => {
    const doc = parseYamlDoc("a: yes\nb: no\nc: on\nd: off\ne: true\nf: false\n");
    expect(doc["a"]).toBe(true);
    expect(doc["b"]).toBe(false);
    expect(doc["c"]).toBe(true);
    expect(doc["d"]).toBe(false);
    expect(doc["e"]).toBe(true);
    expect(doc["f"]).toBe(false);
  });

  it("按 YAML 1.1 解析下划线分隔的数字字面量（1_000 是数字不是字符串）", () => {
    const doc = parseYamlDoc("a: 1_000\nb: 1_0\n");
    expect(doc["a"]).toBe(1000);
    expect(doc["b"]).toBe(10);
  });

  it("空文档（只有注释）得到空对象，而不是 null/undefined", () => {
    expect(parseYamlDoc("# 只有注释\n")).toEqual({});
    expect(parseYamlDoc("")).toEqual({});
  });

  it("同一个锚点被大量引用时也能解析", () => {
    // 关闭 maxAliasCount 的理由见 loader.ts 的注释：PyYAML 没有这个限制，
    // 而 yaml 包默认上限 100（判据是「单锚点被引用次数 × 子树内锚点数」）。
    // 这条断言就是那个决定的说明书 —— 一旦有人把 maxAliasCount 加回来，这里立刻红。
    const lines = ["items:", "  - code: a", "    error_rules: &shared",
      "      - code: misc", "        match: {answer_equals: 1}"];
    for (let i = 0; i < 300; i++) {
      lines.push(`  - code: c${i}`, "    error_rules: *shared");
    }
    const items = parseYamlDoc(lines.join("\n"))["items"] as Array<{ error_rules: unknown[] }>;
    expect(items).toHaveLength(301);
    expect(items[300]!["error_rules"]).toHaveLength(1);
  });

  it("别名共享同一对象引用（与 PyYAML 一致；序列化时才展开成副本）", () => {
    const doc = parseYamlDoc(
      ["items:", "  - code: a", "    rules: &r", "      - code: m",
       "  - code: b", "    rules: *r"].join("\n"),
    );
    const items = doc["items"] as Array<{ rules: unknown }>;
    expect(items[0]!["rules"]).toBe(items[1]!["rules"]);
  });

  it("中文不会被转义或丢失", () => {
    expect(parseYamlDoc("name: 凑十法\n")["name"]).toBe("凑十法");
  });
});

// ── 临时内容树 ───────────────────────────────────────────

let originalCwd = "";
let workdir = "";

beforeEach(() => {
  originalCwd = process.cwd();
});

afterEach(() => {
  // chdir 是进程级副作用 —— 无论测试怎么挂，都要先把 cwd 还回去
  if (originalCwd) process.chdir(originalCwd);
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = "";
});

/** 在临时目录里造一棵树并 chdir 过去（key 是相对临时目录的路径） */
function makeTree(files: Record<string, string>, options: { chdir?: boolean } = {}): string {
  workdir = mkdtempSync(path.join(tmpdir(), "mw-loader-"));
  for (const [relative, body] of Object.entries(files)) {
    const full = path.join(workdir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, "utf-8");
  }
  if (options.chdir !== false) process.chdir(workdir);
  return workdir;
}

/** 造一个只有 content/items/ 的内容树（loadItems 的输入目录） */
function makeItems(files: Record<string, string>): void {
  const prefixed: Record<string, string> = {};
  for (const [name, body] of Object.entries(files)) prefixed[`content/items/${name}`] = body;
  makeTree(prefixed);
}

// ── 文件遍历顺序 ─────────────────────────────────────────
// load_order 的地基：Python 是 sorted(glob(dir/**/*.yaml, recursive=True))，
// 排的是**完整路径字符串**。顺序决定 Map 的插入顺序，进而决定"取第一个匹配"的行为。

describe("readYamlDir：文件遍历顺序", () => {
  it("按归一化完整路径排序，且递归下钻子目录（'generated/' < 'make_ten'）", () => {
    const root = makeTree(
      { "make_ten.yaml": "items:\n  - code: from_root\n",
        "generated/core.yaml": "items:\n  - code: from_sub\n" },
      { chdir: false },
    );
    expect(readYamlDir(root).map((d) => d["__file__"])).toEqual([
      "generated/core.yaml",
      "make_ten.yaml",
    ]);
  });

  it("只收 *.yaml，跳过其他扩展名", () => {
    const root = makeTree(
      { "a.yaml": "items: []\n", "b.yml": "items: []\n",
        "c.txt": "items: []\n", "d.yaml": "items: []\n" },
      { chdir: false },
    );
    expect(readYamlDir(root).map((d) => d["__file__"])).toEqual(["a.yaml", "d.yaml"]);
  });

  it("__file__ 是相对目录的 POSIX 路径（Windows 分隔符不能漏进产物）", () => {
    const root = makeTree({ "sub/deep/a.yaml": "items: []\n" }, { chdir: false });
    const file = readYamlDir(root)[0]!["__file__"] as string;
    expect(file).toBe("sub/deep/a.yaml");
    expect(file).not.toContain("\\");
  });

  it("目录不存在时返回空数组，不抛异常（对齐 glob 的行为）", () => {
    expect(readYamlDir(path.join(tmpdir(), "mw-绝对不存在的目录-xyz"))).toEqual([]);
  });
});

// ── 加载语义 ─────────────────────────────────────────────

describe("加载语义：默认值、code 重复、stage 取值", () => {
  it("putUnique 记录重复而不是静默覆盖（「写了内容却不在系统里」的防线）", () => {
    makeItems({
      "a.yaml": [
        "items:",
        "  - code: same",
        "    competency: c",
        "    pattern: p",
        "    answer: 1",
        "  - code: same",
        "    competency: c",
        "    pattern: p",
        "    answer: 2",
      ].join("\n"),
    });
    const problems: string[] = [];
    const items = loadItems(problems);
    expect(items.size).toBe(1);
    // 先到先得：留下的是第一条，不是最后一条
    expect(items.get("same")!.answer).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("item code 重复：same");
    expect(problems[0]).toContain("后出现的那条会覆盖前一条");
  });

  it("problems 传 null 时不报错，只是不收集（检查器与构建器共用同一套加载）", () => {
    makeItems({
      "a.yaml": ["items:", "  - code: same", "    competency: c", "    pattern: p",
        "  - code: same", "    competency: c", "    pattern: p"].join("\n"),
    });
    expect(() => loadItems(null)).not.toThrow();
    expect(loadItems(null).size).toBe(1);
  });

  it("item 的默认值逐项对齐 loader.py（difficulty 1 / direct / number_pad / 15s / guide）", () => {
    makeItems({
      "a.yaml": ["items:", "  - code: bare", "    competency: c", "    pattern: p"].join("\n"),
    });
    const bare = loadItems().get("bare")!;
    expect(bare.difficulty).toBe(1);
    expect(bare.scaffold_level).toBe("direct");
    expect(bare.interaction_type).toBe("number_pad");
    expect(bare.estimated_seconds).toBe(15);
    expect(bare.steps_style).toBe("guide");
    expect(bare.answer).toBeNull();
    expect(bare.steps).toEqual([]);
    expect(bare.hint_chain).toEqual([]);
    expect(bare.error_rules).toEqual([]);
    expect(bare.problem).toEqual({});
  });

  it("字符串数字也能转成 int（等价 Python 的 int(row.get(...))）", () => {
    makeItems({
      "a.yaml": ["items:", "  - code: s", "    competency: c", "    pattern: p",
        '    difficulty: "3"', '    estimated_seconds: "25"'].join("\n"),
    });
    const item = loadItems().get("s")!;
    expect(item.difficulty).toBe(3);
    expect(item.estimated_seconds).toBe(25);
  });

  it("competency 的 stage 取自文档级，不是行级（照抄 loader.py:256）", () => {
    makeTree({
      "content/competencies/stage_2.yaml": [
        "stage: 2",
        "competencies:",
        "  - code: later",
        "    stage: 99",
      ].join("\n"),
    });
    const compet = loadCompetencies().get("later")!;
    expect(compet.stage).toBe(2); // 文档级覆盖行级的 99
    expect(compet.name).toBe("later"); // name 缺省回退到 code
  });

  it("slot 默认值：difficulty 1..5 / auto / practice / 20s，pattern 与 beat 为 null", () => {
    makeTree({
      "content/slots/a.yaml": ["slots:", "  - code: s", "    competency: c"].join("\n"),
    });
    const slot = loadSlots().get("s")!;
    expect(slot.difficulty_min).toBe(1);
    expect(slot.difficulty_max).toBe(5);
    expect(slot.purpose).toBe("practice");
    expect(slot.scaffold_level).toBe("auto");
    expect(slot.estimated_seconds).toBe(20);
    expect(slot.pattern_id).toBeNull();
    expect(slot.story_beat_id).toBeNull();
    expect(slot.selection_policy).toEqual({});
    expect(slot.review_policy).toEqual({});
  });

  it("story beat 的 code 拼成 {story}__{local}，sequence 缺省按声明序号递增", () => {
    makeTree({
      "content/stories/s1.yaml": [
        "story:",
        "  code: s1",
        "  title: 标题缺失时回退到 code",
        "beats:",
        "  - code: b1",
        "    text: 第一句",
        "  - code: b2",
        "    type: challenge",
        "    text: 第二句",
      ].join("\n"),
    });
    const story = loadStories().get("s1")!;
    expect(story.beats.map((b) => b.code)).toEqual(["s1__b1", "s1__b2"]);
    expect(story.beats.map((b) => b.sequence)).toEqual([1, 2]);
    expect(story.beats[0]!.beat_type).toBe("narration"); // 缺省 narration
    expect(story.beats[1]!.beat_type).toBe("challenge");
    expect(story.beats[0]!.slot_code).toBeNull(); // 回填由 linkSlotsToBeats 负责
    expect(story.beats[0]!.story_code).toBe("s1");
    expect(story.duration_min).toBe(8); // 缺省 8 分钟
  });

  it("story 没有 code 时整篇跳过，不产生空壳故事", () => {
    makeTree({ "content/stories/x.yaml": "story:\n  title: 没有 code\n" });
    expect(loadStories().size).toBe(0);
  });
});
