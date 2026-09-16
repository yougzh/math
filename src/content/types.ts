/**
 * 内容模型 —— `backend/content/loader.py` 的 TypeScript 表达。
 *
 * 命名刻意保持 Python 的 snake_case：这份模型要逐字段与 Python 对拍，
 * 改名会让"字段对不上"和"移植漏了字段"混在一起，排查成本极高。
 *
 * 字段的必填/可选、默认值全部照抄 loader.py，不允许"改进"
 * （例如 Item.steps 在 Python 里 default_factory=list，这里就必须是必填 + 构造时给 []）。
 */
import { sortedBy } from "@/src/py/pysort";

// ── 枚举（用 as const 而非 enum：序列化输出必须与 Python 字符串常量逐字一致）──

export const COGNITIVE_TYPES = ["compute", "represent", "strategy", "apply", "reverse"] as const;
export type CognitiveType = (typeof COGNITIVE_TYPES)[number];

export const SCAFFOLD_LEVELS = ["blocks", "decompose", "direct"] as const;
export type ScaffoldLevel = (typeof SCAFFOLD_LEVELS)[number];

/** 槽位脚手架多一个 'auto'：由选择器按孩子状态决定（见 ADR-0001） */
export const AUTO_SCAFFOLD = "auto";
export type SlotScaffoldLevel = ScaffoldLevel | typeof AUTO_SCAFFOLD;

/** 与规划器分段同名；一个槽位可被多个分段复用 */
export const ALLOWED_PURPOSES = [
  "warmup",
  "core",
  "practice",
  "story",
  "thinking",
  "challenge",
  "review",
  "probe",
] as const;
export type SlotPurpose = (typeof ALLOWED_PURPOSES)[number];

export const BEAT_TYPES = ["narration", "challenge", "reward"] as const;
export type BeatType = (typeof BEAT_TYPES)[number];

/**
 * steps 的写法意图：
 *   guide   —— 示范"方法"，最后一步刻意留给孩子（凑十法就该停在「10 + 3」）
 *   conclude —— 示范"完整解答"，最后一步必须写出答案
 * 默认 guide：steps 是给孩子看的策略示范，不是答案复述。
 */
export const ALLOWED_STEPS_STYLES = ["guide", "conclude"] as const;
export type StepsStyle = (typeof ALLOWED_STEPS_STYLES)[number];

// ── 内容实体 ──────────────────────────────────────────────

export interface Competency {
  code: string;
  name: string;
  description: string;
  prerequisites: string[];
  stage: number;
  /** 该能力特有的说法，供 AI 教练的"不超纲"护栏使用 */
  terms: string[];
}

export interface Pattern {
  code: string;
  name: string;
  cognitive_type: CognitiveType;
  primary_competency: string;
  applicable_competencies: string[];
  description: string;
}

/** pattern 可用于哪些能力：applicable ∪ {primary} */
export function patternAppliesTo(pattern: Pattern, competencyCode: string): boolean {
  return (
    competencyCode === pattern.primary_competency ||
    pattern.applicable_competencies.includes(competencyCode)
  );
}

export interface Misconception {
  code: string;
  name: string;
  description: string;
  severity: number;
  remediation_competency: string | null;
}

/** 错误规则：命中 match 条件即归因到该错误认知 */
export interface ErrorRule {
  code: string;
  match: Record<string, unknown>;
}

export interface Item {
  code: string;
  competency_id: string;
  pattern_id: string;
  difficulty: number;
  scaffold_level: ScaffoldLevel;
  interaction_type: string;
  estimated_seconds: number;
  problem: Record<string, unknown>;
  /** 只在服务端使用，永不下发前端（见 docs/api-contract.md） */
  answer: unknown;
  steps: string[];
  hint_chain: string[];
  error_rules: ErrorRule[];
  steps_style: StepsStyle;
}

/**
 * 题目槽位 —— 故事与题目之间的唯一桥梁（ADR-0001）。
 *
 * 故事只声明"这里需要一个什么类型的挑战"，具体做哪一道由 Planner 运行时决定。
 * 因此同一句"小熊需要把篮子装满"，强孩子拿到 8+5，弱孩子拿到 7+3。
 *
 * story_beat_id 为 null 表示这是一个独立训练槽（核心训练段在用），
 * 与故事解耦 —— 槽位机制不属于故事，故事只是它的一种使用场景。
 */
export interface ChallengeSlot {
  code: string;
  competency_id: string;
  difficulty_min: number;
  difficulty_max: number;
  purpose: SlotPurpose;
  /** null ⇒ 由规划器按状态决定 */
  pattern_id: string | null;
  scaffold_level: SlotScaffoldLevel;
  estimated_seconds: number;
  story_beat_id: string | null;
  selection_policy: Record<string, unknown>;
  review_policy: Record<string, unknown>;
}

/**
 * 故事里的一个节拍。
 *
 * beat_type='challenge' 的节拍**必须**挂一个 challenge_slot ——
 * 故事说到"这里需要算一算"的时候，系统必须知道"算什么类型"。
 * 但具体出哪一道题，故事不管（ADR-0001）。
 */
export interface StoryBeat {
  /** 约定为 "{story_code}__{local_code}"，因此全局唯一 */
  code: string;
  story_code: string;
  sequence: number;
  beat_type: BeatType;
  narration: string;
  character: string;
  /** 挑战节拍挂的槽位；slot 是声明方，这里只是快照回填 */
  slot_code: string | null;
}

export interface Story {
  code: string;
  title: string;
  universe: string;
  summary: string;
  order_index: number;
  duration_min: number;
  target_competencies: string[];
  beats: StoryBeat[];
}

export function orderedBeats(story: Story): StoryBeat[] {
  return [...story.beats].sort((a, b) => a.sequence - b.sequence);
}

export function challengeBeats(story: Story): StoryBeat[] {
  return orderedBeats(story).filter((beat) => beat.beat_type === "challenge");
}

/**
 * 加载 + 校验的完整内容包。
 *
 * load_problems 记录加载阶段发现的问题。最典型的是 **code 重复**：
 * 上面这些索引都是 Map/Record，重复 code 会静默覆盖，结果就是
 * "我明明写了这道题，系统里却没有" —— 这种 bug 找起来非常费时间。
 * 所以加载器把重复记录下来，validateContent 把它当错误报出来。
 */
export interface ContentBundle {
  competencies: Map<string, Competency>;
  patterns: Map<string, Pattern>;
  items: Map<string, Item>;
  misconceptions: Map<string, Misconception>;
  slots: Map<string, ChallengeSlot>;
  stories: Map<string, Story>;
  load_problems: string[];
}

/**
 * 按条件筛题，按 `(difficulty, code)` 排序 —— Python `ContentBundle.items_for` 的等价物。
 *
 * 三个筛选项都是**真值判断**（照抄 Python）：传空串等于不筛。
 */
export function itemsFor(
  bundle: ContentBundle,
  competencyId?: string | null,
  patternId?: string | null,
  scaffoldLevel?: string | null,
): Item[] {
  const out: Item[] = [];
  for (const item of bundle.items.values()) {
    if (competencyId && item.competency_id !== competencyId) continue;
    if (patternId && item.pattern_id !== patternId) continue;
    if (scaffoldLevel && item.scaffold_level !== scaffoldLevel) continue;
    out.push(item);
  }
  return sortedBy(
    out,
    (i) => i.difficulty,
    (i) => i.code,
  );
}

// ── 索引（选择器/规划器热路径用，避免整块内容进内存）────────

export interface ItemIndexEntry {
  code: string;
  competency: string;
  pattern: string;
  difficulty: number;
  scaffold_level: ScaffoldLevel;
  interaction_type: string;
  estimated_seconds: number;
}

// ── dump 载荷（= tools/content_cli dump 的输出格式）────────

export interface DumpCounts {
  competencies: number;
  patterns: number;
  items: number;
  misconceptions: number;
  slots: number;
  stories: number;
}

export interface DumpCompetency {
  code: string;
  name: string;
  description: string;
  stage: number;
  prerequisites: string[];
}

export interface DumpPattern {
  code: string;
  name: string;
  cognitive_type: CognitiveType;
  primary_competency: string;
  applicable_competencies: string[];
  description: string;
}

export interface DumpMisconception {
  code: string;
  name: string;
  description: string;
  severity: number;
  remediation_competency: string | null;
}

export interface DumpItem {
  code: string;
  competency: string;
  pattern: string;
  difficulty: number;
  scaffold_level: ScaffoldLevel;
  interaction_type: string;
  estimated_seconds: number;
  problem: Record<string, unknown>;
  answer: unknown;
  steps: string[];
  steps_style: StepsStyle;
  hint_chain: string[];
  error_rules: ErrorRule[];
}

export interface DumpBeat {
  code: string;
  sequence: number;
  beat_type: BeatType;
  narration: string;
  character: string;
  slot_code: string | null;
  visual: Record<string, unknown>;
  reward: Record<string, unknown>;
}

export interface DumpStory {
  code: string;
  universe: string;
  title: string;
  summary: string;
  duration_min: number;
  order_index: number;
  target_competencies: string[];
  beats: DumpBeat[];
}

export interface DumpSlot {
  code: string;
  story_beat_id: string | null;
  competency: string;
  pattern: string | null;
  difficulty_min: number;
  difficulty_max: number;
  purpose: SlotPurpose;
  scaffold_level: SlotScaffoldLevel;
  estimated_seconds: number;
  selection_policy: Record<string, unknown>;
  review_policy: Record<string, unknown>;
}

export interface ContentDump {
  content_version: string;
  counts: DumpCounts;
  competencies: DumpCompetency[];
  patterns: DumpPattern[];
  misconceptions: DumpMisconception[];
  items: DumpItem[];
  stories: DumpStory[];
  slots: DumpSlot[];
}

/**
 * 运行时索引（`src/generated/content.index.json`）—— 只放"dump 形状装不下、
 * 但运行时需要"的内容事实。
 *
 * 规则很硬：**能进 content.json 的都不许进这里**。每一项都得说清楚为什么
 * dump 装不下，否则就是立第二个事实来源。
 *
 * 1. `load_order` —— loader 的插入顺序。
 *    为什么 dump 装不下：content.json 按 code 排序，而 loader 按
 *    「文件路径排序 → 文件内行序」插入，那个顺序只存在于构建期。
 *    为什么必须有：Python 运行时的 dict 迭代顺序就是这个顺序，任何"取第一个
 *    匹配"的代码路径都可能依赖它。已核对的排序点都用了全序键（selector 的
 *    `_pick_from_pools` 末尾按 code 收尾），但"我核对过 30 处调用点"不能当长期
 *    保证 —— 让 TS 运行时按 load_order 重建 Map，顺序问题就直接不存在了。
 *
 * 2. `competency_terms` —— 能力特有说法，AI 教练"不超纲"护栏用
 *    （backend/coach/validators.py:67）。
 *    为什么 dump 装不下：`cmd_dump` 不导出 competency.terms，competency 表也没有
 *    terms 列 —— Python 侧自己的说法是"尚未入库（P1 缺口），从内存内容回填"
 *    （backend/service/content.py:108）。TS 运行时没有"内存内容"可回填，
 *    所以必须在这里带上，否则那条护栏会静默失效。
 *
 * 刻意**不放** pattern 分组之类的派生结构：`graph.patterns_for` 有自己的排序键
 * `(cognitive_type, code)`，那是引擎层策略，放进构建产物 = 立第二个事实来源。
 */
export interface ContentIndex {
  /**
   * 产出这份产物时，`content/` 与 `config/` 下**输入文件**的指纹
   * （相对路径 + 内容的 SHA-256，见 scripts/build-content.ts）。
   *
   * 为什么必须有：产物是 gitignore 的，"内容改了但忘了重新构建"是一种
   * **静默**失败 —— 对拍测试会拿旧产物去比旧 fixture，两边一致、全绿，
   * 而应用跑的是过期内容。指纹让这种状态变成一个响亮的报错。
   *
   * 放在索引文件而不是 content.json：content.json 必须逐字保持
   * `cmd_dump` 的输出形状（见 dump.ts），多一个字段就不再是它了。
   */
  source_fingerprint: string;
  load_order: {
    competencies: string[];
    patterns: string[];
    misconceptions: string[];
    items: string[];
    slots: string[];
    stories: string[];
  };
  competency_terms: Record<string, string[]>;
}
