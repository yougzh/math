/**
 * API 契约类型（v1）
 *
 * 唯一依据：`docs/api-contract.md`（已冻结）。
 * 本文件不允许出现契约里没有的字段。若某处必须做兼容性放宽，
 * 一律用可选 / 联合 null，并在注释里写明「契约未明确」。
 */

// ─────────────────────────────────────────────
// §0 全局约定
// ─────────────────────────────────────────────

/**
 * 一次作答的三项时间。thinking_time_ms 由服务端计算（= response − active − idle），
 * 前端**不上报**（见 ADR-0003 与契约 §0）。这里的类型刻意不包含该字段，
 * 让「误传 thinking_time」在类型层面就写不出来。
 */
export interface Telemetry {
  response_time_ms: number;
  active_time_ms: number;
  idle_time_ms: number;
}

/** §12 错误格式；所有非 2xx 都是这个形状 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// ─────────────────────────────────────────────
// §1 首页数据
// ─────────────────────────────────────────────

export interface ChildRef {
  id: number;
  name: string;
}

export interface TodayAdventure {
  headline: string;
  subtitle: string;
  story_code: string;
  universe_code: string;
  estimated_minutes: number;
  completed: boolean;
}

export interface StorySummary {
  code: string;
  title: string;
  completed: boolean;
  unlocked: boolean;
}

export interface Universe {
  code: string;
  name: string;
  emoji: string;
  unlocked: boolean;
  /** 0.0 ~ 1.0 */
  progress: number;
  stories: StorySummary[];
}

/** 游戏材料（契约 §1 / §9 / §4 reward 中反复出现的形状） */
export interface Materials {
  wood: number;
  coin: number;
  gem: number;
  seed: number;
}

export interface BadgeBrief {
  code: string;
  name: string;
  emoji: string;
}

export interface GrowthSummary {
  materials: Materials;
  buildings: string[];
  /** 契约示例中为对象；此处放宽为可空，渲染时做好兜底 */
  newest_badge: BadgeBrief | null;
}

export interface WorldResponse {
  child: ChildRef;
  today: TodayAdventure;
  universes: Universe[];
  lab_unlocked: boolean;
  detective_unlocked: boolean;
  growth_summary: GrowthSummary;
}

// ─────────────────────────────────────────────
// §2 学习会话
// ─────────────────────────────────────────────

export interface SessionCreateRequest {
  child_id: number;
  planned_minutes: number;
  device: string;
}

export interface SessionCreateResponse {
  session_id: number;
  started_at: string;
}

export type QuitReason = "completed" | "child_quit" | "timeout" | "error";

export interface SessionEndRequest {
  quit_reason: QuitReason;
}

// ─────────────────────────────────────────────
// §3 今日计划 / Item 载荷
// ─────────────────────────────────────────────

export type ScaffoldLevel = "blocks" | "decompose" | "direct";

export type InteractionType =
  | "number_pad"
  | "choice"
  | "blocks"
  | "decompose_drag"
  | "carry_exchange"
  | "number_line";

export type AnswerType = "number" | "choice";

/**
 * 题目载荷。**不含答案**（契约 §0）。
 * `problem` 是结构化参数，供交互组件渲染，如 `{"a":8,"b":5,"target":10}`。
 */
export interface ProblemPayload {
  a?: number;
  b?: number;
  target?: number;
  /** 契约只给了示例字段，其余按「结构化参数」处理 */
  [key: string]: unknown;
}

export interface Item {
  code: string;
  competency: string;
  pattern: string;
  /** 1 ~ 5 */
  difficulty: number;
  scaffold_level: ScaffoldLevel;
  interaction_type: InteractionType;
  estimated_seconds: number;
  prompt: string;
  problem: ProblemPayload;
  answer_type: AnswerType;
  /** answer_type=choice 时为选项数组，否则 null（契约未规定元素的内部结构） */
  choices: string[] | null;
  hints_available: number;
}

export type IntentKind = "teach" | "practice" | "review" | "challenge" | "fluency" | "transfer";

export interface LearningIntent {
  kind: IntentKind | string;
  competency: string;
  reason: string;
}

export type SegmentType = "warmup" | "core" | "story" | "thinking" | "discovery";

export interface PlanSegment {
  type: SegmentType | string;
  budget_s: number;
  intent_kinds?: string[];
  slot_code?: string | null;
  scaffold_level?: ScaffoldLevel | null;
  items: Item[];
  note?: string;
}

export interface DailyPlan {
  child_id: number;
  budget_minutes: number;
  intents: LearningIntent[];
  segments: PlanSegment[];
  discovery: string;
  notes: string[];
}

// ─────────────────────────────────────────────
// §4 提交作答
// ─────────────────────────────────────────────

export type MethodUsed =
  | "counting"
  | "decompose"
  | "make_ten"
  | "mental"
  | "written"
  | "visual_blocks"
  | "number_line";

/** 孩子提交的原始作答值：数字题是 number，选择题是选项值 */
export type AnswerValue = number | string;

export interface AttemptRequest {
  /** 前端生成的 UUID，幂等键 (child_id, client_attempt_id) */
  client_attempt_id: string;
  child_id: number;
  session_id: number | null;
  item_code: string;
  slot_code: string | null;
  answer: AnswerValue;
  /** 契约 §0：题目不下发答案，前端通常无法判定 → 默认 null */
  client_correct: boolean | null;
  hints_used: number;
  hint_level_max: number;
  method_used: MethodUsed | null;
  is_transfer_probe: boolean;
  telemetry: Telemetry;
}

export type FeedbackTone = "praise" | "encourage" | "repair";

export interface Feedback {
  tone: FeedbackTone;
  text: string;
  character: string | null;
}

export interface RewardMaterial {
  code: string;
  count: number;
}

export interface Reward {
  materials: RewardMaterial[];
  coins: number;
  unlocks: string[];
}

export interface ProgressSignals {
  mastery: number;
  accuracy: number;
  fluency: number | null;
  independence: number;
  transfer: number | null;
}

export interface AttemptProgress {
  competency: string;
  level: string;
  level_label: string;
  scaffold_level: ScaffoldLevel;
  signals: ProgressSignals;
  sample_count: number;
}

/** 契约 §4：`next` 目前只有 next_item 一种形态 */
export interface NextStep {
  kind: string;
  beat_index: number | null;
  item: Item | null;
}

export interface AttemptResponse {
  attempt_id: number;
  seq: number;
  duplicate: boolean;
  correct: boolean;
  judgement_mismatch: boolean;
  misconceptions: string[];
  feedback: Feedback;
  reward: Reward;
  progress: AttemptProgress;
  next: NextStep;
}

// ─────────────────────────────────────────────
// §5 AI 教练提示
// ─────────────────────────────────────────────

export interface HintRequest {
  child_id: number;
  item_code: string;
  hints_used: number;
  last_answer: AnswerValue | null;
}

export interface HintResponse {
  hint_level: number;
  hint_text: string;
  source: "rule" | "llm";
  fallback_used: boolean;
  exhausted: boolean;
}

// ─────────────────────────────────────────────
// §6 故事
// ─────────────────────────────────────────────

/** 契约给出的全部取值，前端据此选插画组件 */
export type VisualKind =
  | "station"
  | "luggage"
  | "train"
  | "ticket"
  | "repair"
  | "box"
  | "night"
  | "shop"
  | "build"
  | "detective"
  | "animal";

export type VisualMood = "morning" | "calm" | "happy" | string;

export interface BeatVisual {
  kind: VisualKind | string;
  mood?: VisualMood;
  characters?: string[];
}

export interface StoryChallenge {
  slot_code: string;
  purpose: string;
  scaffold_level: ScaffoldLevel;
  item: Item;
}

export type BeatType = "narration" | "challenge" | "reward";

export interface StoryBeat {
  index: number;
  type: BeatType;
  narration: string | null;
  visual: BeatVisual | null;
  reward: Reward | null;
  challenge: StoryChallenge | null;
}

export interface StoryResponse {
  code: string;
  universe: string;
  title: string;
  duration_min: number;
  order_index: number;
  beats: StoryBeat[];
}

// ─────────────────────────────────────────────
// §7 数学实验室
// ─────────────────────────────────────────────

export interface LabExperiment {
  code: string;
  name: string;
  emoji: string;
  description: string;
  unlocked: boolean;
}

export interface LabResponse {
  experiments: LabExperiment[];
}

// ─────────────────────────────────────────────
// §8 数学侦探
// ─────────────────────────────────────────────

export interface DetectiveClue {
  text: string;
  revealed: boolean;
}

export interface DetectivePuzzle {
  puzzle_id: string;
  kind: string;
  prompt: string;
  clues: DetectiveClue[];
  candidates: number[];
  answer_type: AnswerType;
  clues_remaining: number;
}

export interface DetectiveAnswerRequest {
  child_id: number;
  puzzle_id: string;
  answer: AnswerValue;
  client_attempt_id: string;
}

export interface DetectiveAnswerResponse {
  correct: boolean;
  feedback: Feedback;
  revealed_clues: string[];
  reward: Reward;
}

// ─────────────────────────────────────────────
// §9 成长
// ─────────────────────────────────────────────

export interface TreeNodePosition {
  x: number;
  y: number;
}

export interface GrowthNode {
  code: string;
  name: string;
  level: string;
  level_label: string;
  mastered: boolean;
  emoji: string;
  unlocked: boolean;
  position: TreeNodePosition;
}

export interface GrowthEdge {
  from: string;
  to: string;
}

export interface GrowthTree {
  nodes: GrowthNode[];
  edges: GrowthEdge[];
}

export interface Building {
  code: string;
  name: string;
  emoji: string;
  built: boolean;
  /** 材料成本，键为材料 code（wood / coin / gem / seed） */
  cost: Record<string, number>;
}

export interface Badge {
  code: string;
  name: string;
  emoji: string;
  earned: boolean;
  earned_at: string | null;
}

export interface GrowthResponse {
  tree: GrowthTree;
  materials: Materials;
  buildings: Building[];
  badges: Badge[];
}

export interface BuildRequest {
  child_id: number;
  building_code: string;
}

export interface BuildResponse {
  built: boolean;
  materials: Materials;
  unlocks: string[];
  /** built=false 时表示材料不足等业务原因 */
  reason?: string;
}

// ─────────────────────────────────────────────
// §10 家长端
// ─────────────────────────────────────────────

export interface ReportRange {
  days: number;
  from: string;
  to: string;
}

export interface CompetencyReportRow {
  code: string;
  name: string;
  level: string;
  level_label: string;
  /** 0.0 ~ 1.0，用于横向条形图 */
  score: number;
  signals: ProgressSignals;
}

export interface WeakPoint {
  type: string;
  competency: string;
  text: string;
}

export interface MisconceptionReport {
  code: string;
  name: string;
  hit_count: number;
  text: string;
}

export interface ProgressPoint {
  date: string;
  level: string;
  note: string;
}

export interface Engagement {
  sessions: number;
  total_minutes: number;
  avg_minutes_per_session: number;
  next_day_return_rate: number;
  story_completion_rate: number;
}

export interface ParentReport {
  child: ChildRef;
  range: ReportRange;
  headline: string;
  competencies: CompetencyReportRow[];
  weak_points: WeakPoint[];
  misconceptions: MisconceptionReport[];
  progress: ProgressPoint[];
  engagement: Engagement;
  advice: string[];
  disclaimer: string;
}

// ─────────────────────────────────────────────
// §11 调试（契约只描述了「包含哪些信息」，未固定字段名）
// ─────────────────────────────────────────────

/**
 * ⚠️ 契约 §11 只说明返回「全部 competency / pattern 的原始信号、样本数、等级、
 * algorithm_version」，没有给出字段级 schema。这里给出一份**推测形状**，
 * 调试面板在结构不匹配时会退化成原始 JSON 展示，因此即使后端形状不同也不会报错。
 */
export interface DebugLearningState {
  child_id?: number;
  algorithm_version?: number | string;
  updated_at?: string;
  competencies?: DebugSignalRow[];
  patterns?: DebugPatternRow[];
  [key: string]: unknown;
}

export interface DebugSignalRow {
  code?: string;
  competency?: string;
  name?: string;
  level?: string;
  level_label?: string;
  scaffold_level?: string;
  sample_count?: number;
  assessment_samples?: number;
  probe_status?: string;
  signals?: Partial<ProgressSignals>;
  [key: string]: unknown;
}

export interface DebugPatternRow extends DebugSignalRow {
  pattern?: string;
  method_distribution?: Record<string, number>;
}
