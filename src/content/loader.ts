/**
 * 内容加载 —— `backend/content/loader.py` 的 TypeScript 移植。
 *
 * ⚠️ 这个文件用 `node:fs` 读 YAML，**只能在构建期跑**（scripts/build-content.ts /
 * check-content.ts）。运行时不读 YAML —— 内容由构建期固化成
 * `src/generated/content.json`（见 src/content/bundle.ts）。
 *
 * 移植纪律：逐行照抄 loader.py 的语义，包括
 *   - 文件遍历顺序（`sorted(glob(dir/**\/*.yaml))`）—— 顺序影响 put_unique 的"先到先得"
 *   - 浅拷贝语义（Python 的 `dict(row)` / `list(row)` 都是浅拷贝，这里用 `{...}` / `[...]`）
 *   - 默认值（`row.get("x", default)`）
 * 任何"更地道的 TS 写法"都可能改变输出，而输出要逐字段对拍。
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  AUTO_SCAFFOLD,
  type BeatType,
  type ChallengeSlot,
  type CognitiveType,
  type Competency,
  type ContentBundle,
  type ErrorRule,
  type Item,
  type Misconception,
  type Pattern,
  type ScaffoldLevel,
  type SlotPurpose,
  type StepsStyle,
  type Story,
  type StoryBeat,
} from "./types";

// ── 目录常量（对应 backend/paths.py）──────────────────────
// 路径以仓库根为基准；构建脚本从仓库根运行。

export const CONTENT_DIR = "content";
export const COMPETENCY_DIR = path.join(CONTENT_DIR, "competencies");
export const PATTERN_DIR = path.join(CONTENT_DIR, "patterns");
export const ITEM_DIR = path.join(CONTENT_DIR, "items");
export const MISCONCEPTION_DIR = path.join(CONTENT_DIR, "misconceptions");
export const STORY_DIR = path.join(CONTENT_DIR, "stories");
export const SLOT_DIR = path.join(CONTENT_DIR, "slots");

// ── 配置读取（构建脚本与 check 脚本共用）──────────────────
//
// 只读 YAML 原文，不经过 src/engine/config.ts —— 那个模块顶层静态 import 了
// 构建产物 src/generated/config.json，而构建脚本正是要产出它的人：
// 首次构建时那份文件还不存在，import 它会在模块解析阶段就炸掉，
// 内容构建从此无法自举。读取语义的对齐由 tests/unit/validate.test.ts 守着。

export const CONFIG_DIR = "config";

/** 配置的版本目录名。产物结构（config.json 的形状）跟着它走，改动要同步 build-content.ts。 */
export const CONFIG_VERSION = "v0";

/** 读 `config/{name}/{version}.yaml` 段。文件不存在直接抛错 —— 缺配置不该静默降级。 */
export function readConfigSection(
  name: string,
  version: string = CONFIG_VERSION,
): Record<string, unknown> {
  const file = path.join(CONFIG_DIR, name, `${version}.yaml`);
  if (!existsSync(file)) {
    throw new Error(`找不到配置文件：${file}`);
  }
  return readYamlFile(file);
}

// ── 工具 ───────────────────────────────────────────────────

/**
 * 递归收集目录下所有 *.yaml，按完整路径排序（等价 glob(dir/**\/*.yaml, recursive) + sorted）。
 *
 * 导出是给构建脚本的**原文级断言**用的（见 scripts/build-content.ts）：
 * 有些差异（YAML 写的是 `3.0` 还是 `3`）在解析后的对象上不可观测，
 * 只有在原始字节上才查得出来。让构建脚本自己遍历一遍目录会更容易漂移 ——
 * 它必须看到与 loader 完全相同的那批文件、完全相同的顺序。
 */
export function collectYamlPaths(directory: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    // 显式写 encoding 而不是用 ReturnType<typeof readdirSync>：
    // 后者的重载解析会落到 Dirent<NonSharedBuffer> 上，entry.name 就不是 string 了。
    // 目录不存在时返回空列表 —— Python 的 glob 同样返回空列表，行为一致。
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".yaml")) out.push(full);
    }
  };
  walk(directory);
  // Python 比较的是完整路径字符串；这里排序前先归一化分隔符，
  // 避免 Windows 的 "\" 参与比较导致顺序不同。
  return out.sort((a, b) => (a.split(path.sep).join("/") < b.split(path.sep).join("/") ? -1 : 1));
}

export type YamlDoc = Record<string, unknown> & { __file__?: string };

/**
 * 解析一份 YAML 文本。
 *
 * 两个显式设置，都是为了让 `yaml` 包的行为与 PyYAML 对齐：
 *
 * 1. `version: "1.1"` —— PyYAML 是 1.1 语义（on/off/yes/no 是 bool、1_000 是数字），
 *    `yaml` 包默认 1.2。当前内容层没有这类字面量，但显式声明能防止将来踩坑。
 *
 * 2. `maxAliasCount: -1`（关闭别名数量限制）—— `yaml` 包默认上限 100，
 *    判据是「单锚点的被引用次数 × 该子树内锚点数 > 100 就抛
 *    Excessive alias count」。**PyYAML 没有这个限制**。
 *    实测现状：`core_number_sense.yaml` 有 313 个锚点 / 645 处别名，
 *    单锚点最多被引用 4 次 —— 离上限还有 25 倍余量，但余量会随内容增长而缩小，
 *    而撞上时的报错是一句"疑似资源耗尽攻击"，跟真实原因（内容变多了）毫无关系。
 *    风险面：这个限制防的是"不可信 YAML 做十亿大笑话攻击"，而 content/ 是
 *    跟代码一起提交进仓库的 —— 能改它的人本来就能改一切，这层防护在这里不成立。
 *    真要引入不可信来源的内容，先回来把这里改回显式上限。
 *
 * 抽成独立函数是为了让配置（config/**）也走同一套解析设置 ——
 * 内容与配置对同一个字面量解析出不同类型，会是最难查的一类对拍失败。
 */
export function parseYamlDoc(text: string): YamlDoc {
  // 空文档（只有注释的文件）PyYAML 返回 None，这里统一成 {}
  return (parseYaml(text, { version: "1.1", maxAliasCount: -1 }) ?? {}) as YamlDoc;
}

/** 读取单个 YAML 文件。相对路径按调用方的 cwd 解析。 */
export function readYamlFile(file: string): YamlDoc {
  return parseYamlDoc(readFileSync(file, "utf-8"));
}

/**
 * 与 `parseYamlDoc` 同一套解析设置，但**整数解析成 BigInt**。
 *
 * 只给构建脚本的原文级断言用（scripts/build-content.ts 的 assertNoDecimalScalars）：
 * `intAsBigInt` 让"原文里写的是小数"变成可观测的事实 —— 整数变 BigInt、小数仍是
 * number，于是"值是 number"精确等价于"原文写的是 3.0 而不是 3"。
 * 产物绝不能走这条路：BigInt 过不了 JSON.stringify。
 */
export function parseYamlDocWithIntsAsBigInt(text: string): YamlDoc {
  return (parseYaml(text, { version: "1.1", maxAliasCount: -1, intAsBigInt: true }) ??
    {}) as YamlDoc;
}

/** 递归读取目录下的 *.yaml（生成内容放在子目录里）。 */
export function readYamlDir(directory: string): YamlDoc[] {
  return collectYamlPaths(directory).map((file) => {
    const data = readYamlFile(file);
    data.__file__ = path.relative(directory, file).split(path.sep).join("/");
    return data;
  });
}

/** 读取一个 YAML 文档为数组字段；缺失或非数组一律当空数组 */
function rows(doc: YamlDoc, key: string): Record<string, unknown>[] {
  const value = doc[key];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Python 的 `int(row.get(key, default))`：字符串数字也能转 */
function int(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return fallback;
}

/** 字符串数组：Python 的 `list(row.get(key, []) or [])` */
function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** 浅拷贝对象：等价 Python 的 `dict(row.get(key, {}) or {})` */
function objCopy(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function putUnique<T>(
  out: Map<string, T>,
  key: string,
  value: T,
  kind: string,
  problems: string[] | null,
  source = "",
): void {
  // 不用 out.set 直接写 —— 静默覆盖会让"内容明明写了却不在系统里"变成一场长时间排查。
  if (out.has(key)) {
    const where = source ? `（${source}）` : "";
    problems?.push(`${kind} code 重复：${key}${where}，后出现的那条会覆盖前一条`);
    return;
  }
  out.set(key, value);
}

// ── 各类内容加载 ───────────────────────────────────────────

export function loadCompetencies(problems: string[] | null = null): Map<string, Competency> {
  const out = new Map<string, Competency>();
  for (const doc of readYamlDir(COMPETENCY_DIR)) {
    // 注意：stage 取自文档级，不是行级（照抄 loader.py:256）
    const docStage = int(doc["stage"], 1);
    for (const row of rows(doc, "competencies")) {
      const code = str(row["code"]);
      const competency: Competency = {
        code,
        name: str(row["name"], code),
        description: str(row["description"], ""),
        prerequisites: strList(row["prerequisites"]),
        stage: docStage,
        terms: strList(row["terms"]),
      };
      putUnique(out, competency.code, competency, "competency", problems, doc.__file__ ?? "");
    }
  }
  return out;
}

export function loadPatterns(problems: string[] | null = null): Map<string, Pattern> {
  const out = new Map<string, Pattern>();
  for (const doc of readYamlDir(PATTERN_DIR)) {
    for (const row of rows(doc, "patterns")) {
      const code = str(row["code"]);
      const pattern: Pattern = {
        code,
        name: str(row["name"], code),
        cognitive_type: str(row["cognitive_type"]) as CognitiveType,
        primary_competency: str(row["primary_competency"]),
        applicable_competencies: strList(row["applicable_competencies"]),
        description: str(row["description"], ""),
      };
      putUnique(out, pattern.code, pattern, "pattern", problems, doc.__file__ ?? "");
    }
  }
  return out;
}

export function loadMisconceptions(
  problems: string[] | null = null,
): Map<string, Misconception> {
  const out = new Map<string, Misconception>();
  for (const doc of readYamlDir(MISCONCEPTION_DIR)) {
    for (const row of rows(doc, "misconceptions")) {
      const code = str(row["code"]);
      const remediation = row["remediation_competency"];
      const misc: Misconception = {
        code,
        name: str(row["name"], code),
        description: str(row["description"], ""),
        severity: int(row["severity"], 1),
        // Python 的 row.get(...) 缺键返回 None；显式 null 也保持 null
        remediation_competency: typeof remediation === "string" ? remediation : null,
      };
      putUnique(out, misc.code, misc, "misconception", problems, doc.__file__ ?? "");
    }
  }
  return out;
}

export function loadItems(problems: string[] | null = null): Map<string, Item> {
  const out = new Map<string, Item>();
  for (const doc of readYamlDir(ITEM_DIR)) {
    for (const row of rows(doc, "items")) {
      const item: Item = {
        code: str(row["code"]),
        competency_id: str(row["competency"]),
        pattern_id: str(row["pattern"]),
        difficulty: int(row["difficulty"], 1),
        scaffold_level: str(row["scaffold_level"], "direct") as ScaffoldLevel,
        interaction_type: str(row["interaction_type"], "number_pad"),
        estimated_seconds: int(row["estimated_seconds"], 15),
        problem: objCopy(row["problem"]),
        answer: row["answer"] ?? null,
        steps: strList(row["steps"]),
        hint_chain: strList(row["hint_chain"]),
        // 浅拷贝列表：等价 Python 的 list(row.get("error_rules", []) or [])
        //
        // ⚠️ 只拷一层 —— **内层 dict 是共享引用**，这是刻意的：
        // generated/core_number_sense.yaml 用 YAML 别名复用 error_rules
        // （`error_rules: &id001` / `*id001`，313 个锚点 / 645 处别名），
        // `yaml` 包与 PyYAML 一样让同一个锚点的所有引用指向同一对象。
        // Python 那边 `list(...)` 也只拷一层，所以"共享内层"就是原语义。
        // 序列化（JSON.stringify / json.dump）会把共享引用展开成完整副本，
        // 所以产物看不出差别。想让两边不一样，唯一的办法是深拷贝 —— 那是**偏离**，不是修正。
        error_rules: Array.isArray(row["error_rules"])
          ? ([...row["error_rules"]] as ErrorRule[])
          : [],
        steps_style: str(row["steps_style"], "guide") as StepsStyle,
      };
      putUnique(out, item.code, item, "item", problems, doc.__file__ ?? "");
    }
  }
  return out;
}

/** 槽位既可能写在 content/slots/，也可能内联在故事文件里（loader.py:326） */
export function loadSlots(problems: string[] | null = null): Map<string, ChallengeSlot> {
  const out = new Map<string, ChallengeSlot>();
  const docs = [...readYamlDir(SLOT_DIR), ...readYamlDir(STORY_DIR)];
  for (const doc of docs) {
    for (const row of rows(doc, "slots")) {
      const pattern = row["pattern"];
      const beatId = row["story_beat_id"];
      const slot: ChallengeSlot = {
        code: str(row["code"]),
        competency_id: str(row["competency"]),
        difficulty_min: int(row["difficulty_min"], 1),
        difficulty_max: int(row["difficulty_max"], 5),
        purpose: str(row["purpose"], "practice") as SlotPurpose,
        pattern_id: typeof pattern === "string" ? pattern : null,
        scaffold_level: str(row["scaffold_level"], AUTO_SCAFFOLD) as ChallengeSlot["scaffold_level"],
        estimated_seconds: int(row["estimated_seconds"], 20),
        story_beat_id: typeof beatId === "string" ? beatId : null,
        selection_policy: objCopy(row["selection_policy"]),
        review_policy: objCopy(row["review_policy"]),
      };
      putUnique(out, slot.code, slot, "slot", problems, doc.__file__ ?? "");
    }
  }
  return out;
}

/**
 * 故事叙事与节拍。
 *
 * 一个故事 YAML 同时含 `story`（叙事）、`beats`（节拍）和 `slots`（挑战槽）。
 * story_beat.code 约定为 "{story_code}__{local}"，所以 beat 天然归属唯一的故事，
 * 而 slot 通过 `story_beat_id` 反向指回 beat —— 单一事实来源，不双向声明。
 */
export function loadStories(): Map<string, Story> {
  const out = new Map<string, Story>();
  for (const doc of readYamlDir(STORY_DIR)) {
    const row = (doc["story"] ?? null) as Record<string, unknown> | null;
    if (row === null || typeof row !== "object") continue;
    const code = typeof row["code"] === "string" ? row["code"] : "";
    if (!code) continue;

    const story: Story = {
      code,
      title: str(row["title"], code),
      universe: str(row["universe"], ""),
      summary: str(row["summary"], ""),
      order_index: int(row["order_index"], 0),
      duration_min: int(row["duration_min"], 8),
      target_competencies: strList(row["target_competencies"]),
      beats: [],
    };

    // 先建 beat，位置由 sequence 决定；slot 稍后回填
    for (const raw of rows(doc, "beats")) {
      const local = str(raw["code"]);
      story.beats.push({
        code: `${code}__${local}`,
        story_code: code,
        sequence: int(raw["sequence"], story.beats.length + 1),
        beat_type: str(raw["type"], "narration") as BeatType,
        narration: str(raw["text"], ""),
        character: str(raw["character"], ""),
        slot_code: null,
      });
    }

    out.set(code, story);
  }
  return out;
}

/**
 * 把 slot 挂回它所属的 challenge beat（就地修改 stories）。
 *
 * 引用不存在 / 一个 beat 挂两个 slot，都属于内容错误，
 * 交给 validateContent 报出来，加载阶段不抛异常。
 */
export function linkSlotsToBeats(
  stories: Map<string, Story>,
  slots: Map<string, ChallengeSlot>,
): void {
  const beatIndex = new Map<string, StoryBeat>();
  for (const story of stories.values()) {
    for (const beat of story.beats) beatIndex.set(beat.code, beat);
  }
  for (const slot of slots.values()) {
    if (!slot.story_beat_id) continue;
    const beat = beatIndex.get(slot.story_beat_id);
    if (beat === undefined || beat.slot_code !== null) continue;
    beat.slot_code = slot.code;
  }
}

export function loadBundle(): ContentBundle {
  const problems: string[] = [];
  // 顺序照抄 loader.py:407-410：slots 先加载（它带 problems），再 stories，再回填
  const slots = loadSlots(problems);
  const stories = loadStories();
  linkSlotsToBeats(stories, slots);
  return {
    competencies: loadCompetencies(problems),
    patterns: loadPatterns(problems),
    items: loadItems(problems),
    misconceptions: loadMisconceptions(problems),
    slots,
    stories,
    load_problems: problems,
  };
}
