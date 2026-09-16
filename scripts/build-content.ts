/**
 * 内容构建期打包 —— 把 content/**.yaml 与 config/**.yaml 编译成 src/generated/ 下的 JSON。
 *
 *   npm run build:content
 *
 * 产物（src/generated/ 在 .gitignore 里：构建期生成，不入库）：
 *   content.json        内容全集，形状 = `python3 -m tools.content_cli dump` 的输出
 *   content.index.json  运行时索引（load_order / competency_terms / source_fingerprint）
 *   config.json         算法 / 教练 / 实验配置
 *
 * 为什么产物是 JSON 而不是生成的 .ts 常量：
 *   1,373 道题写成 .ts 会让 TS 对每个对象做字面量类型推断，编译时间与内存都会爆掉
 *   （每道题的 problem 载荷结构还各不相同）。JSON 只走一次结构化类型检查，代价低得多。
 *
 * 门禁顺序（前一道不过就不必跑后一道）：
 *   加载 → 排序键 ASCII → 小数标量 → 非 ASCII 数字 → validateBundle → 落盘
 * 前四道是"产物形状"层（保证 TS 与 Python 的**语义**在同一条起跑线上），
 * validateBundle 才是内容本身对不对。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { validateBundle } from "../src/content/compiler";
import { buildContentIndex, toContentDump } from "../src/content/dump";
import { sourceFingerprint } from "../src/content/fingerprint";
import {
  COMPETENCY_DIR,
  ITEM_DIR,
  MISCONCEPTION_DIR,
  PATTERN_DIR,
  SLOT_DIR,
  STORY_DIR,
  collectYamlPaths,
  loadBundle,
  parseYamlDocWithIntsAsBigInt,
  readConfigSection,
} from "../src/content/loader";
import type { ContentBundle } from "../src/content/types";
import { minPatternsFromRaw } from "../src/content/validate";

// 仓库根 = scripts/ 的上一级。
// 这里用 __dirname 是因为 tsx 以 CJS 跑 .ts（package.json 没有 "type": "module"）；
// loader 的目录常量是相对路径，靠下面这次 chdir 固定，不依赖调用方的 cwd。
const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const OUT_DIR = path.join("src", "generated");
const CONTENT_VERSION = process.env["CONTENT_VERSION"] ?? "v0.1.0";

/** 全部内容 YAML 的根目录（顺序无关，只为遍历） */
const CONTENT_YAML_DIRS = [
  COMPETENCY_DIR,
  PATTERN_DIR,
  ITEM_DIR,
  MISCONCEPTION_DIR,
  SLOT_DIR,
  STORY_DIR,
];

/** 对齐 Python `json.dump(..., ensure_ascii=False, indent=2, sort_keys=False)` 的排版 */
function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

// ── 形状断言 ───────────────────────────────────────────────
//
// 下面四条断的是**产物形状**，不是内容质量：它们拦的情况都有一个共同点 ——
// TS 与 Python 会给出不同答案，而且**分叉在解析后的对象上不可观测**。
// 与其在半年后对着一个"两边都跑过、结果不一样"的现象排查，不如现在让构建炸。

/**
 * 排序键必须是 ASCII。
 *
 * `src/content/dump.ts` 的字符串比较走 UTF-16 code unit，与 Python 的
 * code point 比较只在 BMP 内等价。真要出现非 ASCII 的 code，
 * 得先把比较改成按 code point 迭代 —— 与其那时静默排错，不如现在拦住。
 */
const ASCII_ONLY = /^[\x20-\x7e]+$/;

function assertSortKeysAscii(rows: ReadonlyArray<{ code: string }>, kind: string): void {
  for (const row of rows) {
    if (!ASCII_ONLY.test(row.code)) {
      throw new Error(
        `${kind} code 含非 ASCII 字符：${JSON.stringify(row.code)}\n` +
          `排序假设被打破（见 src/py/pysort.ts）。\n` +
          `修法：把两处比较改成按 code point 迭代，再重跑构建。`,
      );
    }
  }
}

/**
 * 内容里不许出现**小数**（`answer: 3.0`、`difficulty: 2.5`）。
 *
 * JSON 里 `3.0` 与 `3` 不可区分，所以解析之后 `Number.isInteger(3.0)` 为真，
 * 而 Python 的 `isinstance(3.0, int)` 为假 —— 两边的 `hintLeaksAnswer` 与 `int()`
 * 语义会分叉，且这个分叉**在解析后的对象上完全不可观测**。既然 JSON 表达不了
 * 这个区别，就在 YAML 原文上把它拦掉。
 *
 * 实现用 `intAsBigInt` 再解析一遍：整数变 BigInt、小数仍是 number，
 * 于是"值是 number"精确等价于"原文写的是小数形式" —— 不用写正则去猜原文，
 * 也就不会把 `prompt: "走了 3.5 米"` 这种字符串误报成小数标量。
 */
function assertNoDecimalScalars(): void {
  const offenders: string[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown, where: string): void => {
    if (typeof value === "number") {
      offenders.push(`${where} = ${String(value)}`);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${where}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${where}.${key}`);
  };

  for (const directory of CONTENT_YAML_DIRS) {
    for (const file of collectYamlPaths(directory)) {
      const doc = parseYamlDocWithIntsAsBigInt(readFileSync(file, "utf-8"));
      visit(doc, path.relative(ROOT, file).split(path.sep).join("/"));
    }
  }

  if (offenders.length > 0) {
    const shown = offenders.slice(0, 20);
    throw new Error(
      `内容里有 ${offenders.length} 处小数 —— 请改成整数写法：\n` +
        shown.map((row) => `  • ${row}`).join("\n") +
        (offenders.length > shown.length
          ? `\n  … 还有 ${offenders.length - shown.length} 处`
          : "") +
        `\n原因：JSON 分不清 3.0 与 3，而 Python 的 int() / isinstance(x, int) 分得清。`,
    );
  }
}

const UNICODE_DECIMAL = /\p{Nd}/u;

/** 找一个「是 Unicode 十进制数字但不是 ASCII 0-9」的字符 */
function firstNonAsciiDigit(text: string): string | null {
  for (const char of text) {
    if (char >= "0" && char <= "9") continue;
    if (UNICODE_DECIMAL.test(char)) return char;
  }
  return null;
}

/**
 * 内容里不许出现非 ASCII 十进制数字（全角 ３、阿拉伯 ٣、天城文 ३ …）。
 *
 * `src/py/pyre.ts` 与 `src/py/pyint.ts` 一律写成 `[0-9]`（JS 的 `\d` 只认 ASCII），
 * 而 Python 的 `\d` / `int()` 认所有 Unicode 十进制数字 ——
 * 实测 `_hint_leaks_answer("这里有 ３ 个", 3)` 在 Python 侧为 **True**。
 * 内容里一旦出现全角数字，两边会对同一句话给出不同结论，
 * 而"少报一条问题"在内容层是**静默**的：构建照过，孩子看到的提示里带着答案。
 */
function assertAsciiDigits(bundle: ContentBundle): void {
  const offenders: string[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown, where: string): void => {
    if (typeof value === "string") {
      const hit = firstNonAsciiDigit(value);
      if (hit !== null) {
        const codePoint = hit.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
        offenders.push(`${where}：${JSON.stringify(hit)}（U+${codePoint}）`);
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${where}[${index}]`));
      return;
    }
    if (value instanceof Map) {
      for (const [key, child] of value) visit(child, `${where}[${String(key)}]`);
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${where}.${key}`);
  };

  const collections = [
    ["competency", bundle.competencies],
    ["pattern", bundle.patterns],
    ["item", bundle.items],
    ["misconception", bundle.misconceptions],
    ["slot", bundle.slots],
    ["story", bundle.stories],
  ] as const;
  for (const [kind, collection] of collections) visit(collection, kind);

  if (offenders.length > 0) {
    const shown = offenders.slice(0, 20);
    throw new Error(
      `内容里有 ${offenders.length} 处非 ASCII 十进制数字：\n` +
        shown.map((row) => `  • ${row}`).join("\n") +
        (offenders.length > shown.length
          ? `\n  … 还有 ${offenders.length - shown.length} 处`
          : "") +
        `\n原因：Python 的 \\d 认全角数字，JS 的 [0-9] 不认，两边会对同一句话给出不同结论。`,
    );
  }
}

// ── 主流程 ─────────────────────────────────────────────────

function main(): void {
  if (!existsSync("content")) {
    throw new Error(`chdir 到仓库根后仍找不到 content/（当前 ${process.cwd()}）`);
  }

  // ── 加载 ────────────────────────────────────────────────
  const bundle = loadBundle();

  // 加载期问题一律是致命的：code 重复意味着"内容里明明写了，产物里却没有"，
  // 这种产物一旦被运行时吃进去，排查成本远超一次构建失败。
  if (bundle.load_problems.length > 0) {
    console.error(`❌ 加载期发现 ${bundle.load_problems.length} 个问题，禁止产出：`);
    for (const problem of bundle.load_problems) console.error(`  • ${problem}`);
    process.exitCode = 1;
    return;
  }

  assertSortKeysAscii([...bundle.competencies.values()], "competency");
  assertSortKeysAscii([...bundle.patterns.values()], "pattern");
  assertSortKeysAscii([...bundle.items.values()], "item");
  assertSortKeysAscii([...bundle.misconceptions.values()], "misconception");
  assertSortKeysAscii([...bundle.slots.values()], "slot");
  assertSortKeysAscii(
    [...bundle.stories.values()].flatMap((s) => s.beats.map((b) => ({ code: b.code }))),
    "story_beat",
  );
  assertNoDecimalScalars();
  assertAsciiDigits(bundle);

  // ── 内容校验（不通过就不产出）────────────────────────────
  //
  // 阈值只允许有一个来源（ADR-0002），这里从**刚读出的 YAML** 取而不是
  // loadConfig()：后者读的是构建产物 config.json，而本次构建还没写出它来
  // （首次构建时它根本不存在）。读取语义与 AlgorithmConfig 的那条路径一致，
  // tests/unit/validate.test.ts 有断言守着两边不分叉。
  const algorithm = readConfigSection("algorithm");
  const minPatterns = minPatternsFromRaw(algorithm);

  const problems = validateBundle(bundle, minPatterns);
  if (problems.length > 0) {
    console.error(`❌ 内容校验发现 ${problems.length} 个问题，禁止产出：`);
    for (const problem of problems.slice(0, 50)) console.error(`  • ${problem}`);
    if (problems.length > 50) console.error(`  … 还有 ${problems.length - 50} 个未显示`);
    process.exitCode = 1;
    return;
  }

  // ── 组装 ────────────────────────────────────────────────
  // 指纹在加载之后、写盘之前算：它描述的是"这份产物是从哪些字节造出来的"，
  // 所以必须在读取之后算（读到一半被改的情况交给 CI 的原子性保证）。
  const fingerprint = sourceFingerprint(ROOT);
  const dump = toContentDump(bundle, CONTENT_VERSION);
  const index = buildContentIndex(bundle, fingerprint);
  const config = {
    algorithm,
    coach: readConfigSection("coach"),
    lab: readConfigSection("lab"),
  };

  // ── 落盘 ────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  writeJson(path.join(OUT_DIR, "content.json"), dump);
  writeJson(path.join(OUT_DIR, "content.index.json"), index);
  writeJson(path.join(OUT_DIR, "config.json"), config);

  console.log(`✅ 已产出 ${OUT_DIR}/ ｜ 内容版本 ${CONTENT_VERSION}`);
  for (const [key, value] of Object.entries(dump.counts)) {
    console.log(`  ${key.padEnd(16, " ")} ${value}`);
  }
  console.log(`  ${"source_fingerprint".padEnd(16, " ")} ${fingerprint.slice(0, 16)}…`);
  console.log(
    `  ${"validate".padEnd(16, " ")} 通过（0 个问题；升级门需 ${
      minPatterns === null ? "未配置的 pattern 数" : `${minPatterns} 个 pattern`
    }）`,
  );
}

main();
