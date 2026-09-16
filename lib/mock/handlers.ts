/**
 * Mock 后端。
 *
 * 它在浏览器里扮演服务端：判定对错、产生反馈、发奖励、改材料。
 * 前端页面代码完全不知道它的存在（只通过 lib/api/client 的 USE_MOCK 分支进入）。
 *
 * 状态是**内存态**（刷新即重置），足够 UI 自测；不写任何 storage。
 */

import { ApiError } from "@/lib/api/errors";
import type {
  AnswerValue,
  AttemptRequest,
  AttemptResponse,
  BuildRequest,
  BuildResponse,
  DetectiveAnswerRequest,
  DetectiveAnswerResponse,
  DetectivePuzzle,
  Feedback,
  GrowthResponse,
  HintRequest,
  HintResponse,
  Item,
  Materials,
  MethodUsed,
  Reward,
} from "@/lib/api/types";
import * as F from "./fixtures";

type Method = "GET" | "POST";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 模拟网络延迟，让加载态与动画在自测时真的出现 */
const LATENCY_MS = 160;

interface MockState {
  materials: Materials;
  buildings: string[];
  revealedClues: Record<string, string[]>;
  /** 已经破的案子，避免「下一个案子」又发回同一题 */
  solvedPuzzles: string[];
  attempts: Map<string, AttemptResponse>;
  seq: number;
  sampleCounts: Record<string, number>;
}

const state: MockState = {
  materials: { ...F.MOCK_MATERIALS },
  buildings: F.MOCK_BUILDINGS.filter((b) => b.built).map((b) => b.code),
  revealedClues: {},
  solvedPuzzles: [],
  attempts: new Map(),
  seq: 42,
  sampleCounts: {},
};

// ─────────────────────────────────────────────
// 判定（模拟服务端）
// ─────────────────────────────────────────────

function normalizeAnswer(answer: AnswerValue): number | null {
  if (typeof answer === "number") return Number.isFinite(answer) ? answer : null;
  const trimmed = String(answer).trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return null;
}

type FeedbackText = { praise: string; encourage: string; repair: string };

/** 题库没有该题提示链时的兜底，也是数组下标收窄的兜底值 */
const FALLBACK_HINT = "先想一想：这道题里哪个数是整十？";

// 默认值具名化：noUncheckedIndexedAccess 下 `FEEDBACK_TEXT.default` 是
// `FeedbackText | undefined`，单独声明才能让 fallback 有确定的类型。
const DEFAULT_FEEDBACK: FeedbackText = {
  praise: "对啦！小熊把这一箱稳稳地放上了车。",
  encourage: "做对了！你刚才想得久一点，但方法是自己的。",
  repair: "糟糕，小熊把一个十藏起来了！我们找一找它在哪儿。",
};

const FEEDBACK_TEXT: Record<string, FeedbackText> = {
  default: DEFAULT_FEEDBACK,
  mt_blk_8_5: {
    praise: "十格框补满啦！8 + 5 = 13，小熊把绳子系好了。",
    encourage: "补满啦！虽然慢慢数了一遍，但最后是 13，没错。",
    repair: "糟糕，小熊把一个十藏起来了！十格框满了以后，应该先数 10，再数外面的。",
  },
  mt_dec_8_5: {
    praise: "拆得漂亮！8 + 2 = 10，10 + 3 = 13。",
    encourage: "拆对了，就是慢了一点点。再来一次会更快。",
    repair: "咦，5 被拆散了可是没凑满十。8 只差 2 就到 10 啦。",
  },
  mt_cho_8_5: {
    praise: "答对啦！你用的是先凑十的办法。",
    encourage: "答对啦！再快一点就是高手了。",
    repair: "差一点点。试着让 8 先凑成 10，看看外面剩几个。",
  },
  pv_rep_23: {
    praise: "23 摆得整整齐齐：2 个十、3 个一。",
    encourage: "摆对了！十和一分清楚，就已经很棒。",
    repair: "糟糕，十位和个位混在一起了！一捆十里面藏着 10 个一呢。",
  },
  ca_ex_27_15: {
    praise: "捆得漂亮！10 个一换 1 个十，27 + 15 = 42。",
    encourage: "换对了！捆的时候慢一点也没关系。",
    repair: "个位满十了，可是还没捆起来。10 个一可以换 1 个十哦。",
  },
  nl_add_8_3: {
    praise: "落在 11 上，稳稳的！",
    encourage: "落点对啦，就是步子挪得久一点。",
    repair: "滑过头啦。从 8 出发，走 3 步应该停在 11。",
  },
  sd_dir_6_3: {
    praise: "6 + 3 = 9，答得又快又准！",
    encourage: "答对啦！下次可以再快一点。",
    repair: "再想想：从 6 往后数 3 个，会停在哪里？",
  },
  td_dir_23_14: {
    praise: "23 + 14 = 37，十位和十位、个位和个位，都算对了。",
    encourage: "做对了！两位数加法你已经找到门路了。",
    repair: "十位和个位要先分开算，再合起来。20+10 和 3+4 分别是多少？",
  },
};

function feedbackFor(item: Item, correct: boolean, slow: boolean, hintsUsed: number): Feedback {
  const table = FEEDBACK_TEXT[item.code] ?? DEFAULT_FEEDBACK;
  const tone = correct ? (slow || hintsUsed > 0 ? "encourage" : "praise") : "repair";
  return {
    tone,
    text: tone === "praise" ? table.praise : tone === "encourage" ? table.encourage : table.repair,
    character: correct ? "xiong" : "xiong",
  };
}

function rewardFor(item: Item, correct: boolean): Reward {
  if (!correct) return { materials: [], coins: 0, unlocks: [] };
  const materials = [{ code: "wood", count: 1 }];
  if (item.difficulty >= 4) materials.push({ code: "gem", count: 1 });
  return { materials, coins: item.difficulty >= 3 ? 2 : 1, unlocks: [] };
}

function progressFor(item: Item, correct: boolean) {
  const seed = F.MOCK_PROGRESS_SEED[item.competency] ?? {
    competency: item.competency,
    level: "encountering",
    level_label: "🌱 接触",
    scaffold_level: item.scaffold_level,
    signals: { mastery: 0.2, accuracy: 0.5, fluency: 0.4, independence: 0.8, transfer: null as number | null },
    sample_count: 0,
  };
  const key = item.competency;
  const count = (state.sampleCounts[key] ?? seed.sample_count) + 1;
  state.sampleCounts[key] = count;
  const drift = correct ? 0.03 : -0.04;
  const clamp = (v: number | null, d: number) =>
    v === null ? null : Math.max(0, Math.min(1, Number((v + d).toFixed(2))));
  return {
    competency: key,
    level: seed.level,
    level_label: seed.level_label,
    scaffold_level: seed.scaffold_level,
    signals: {
      mastery: clamp(seed.signals.mastery, drift) ?? 0,
      accuracy: clamp(seed.signals.accuracy, drift) ?? 0,
      fluency: clamp(seed.signals.fluency, correct ? 0.02 : -0.03),
      independence: clamp(seed.signals.independence, correct ? 0.01 : -0.02) ?? 0,
      transfer: clamp(seed.signals.transfer, correct ? 0.02 : -0.02),
    },
    sample_count: count,
  };
}

/** 推断孩子用了什么方法（mock 阶段的近似：由交互组件反推） */
function inferMethod(item: Item): MethodUsed | null {
  switch (item.interaction_type) {
    case "blocks":
      return "visual_blocks";
    case "decompose_drag":
      return "decompose";
    case "number_line":
      return "number_line";
    case "carry_exchange":
      return "make_ten";
    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// 路由
// ─────────────────────────────────────────────

export async function handleMockRequest<T>(method: Method, path: string, body?: unknown): Promise<T> {
  await sleep(LATENCY_MS + Math.random() * 80);
  const [pathname = "", search = ""] = path.split("?");
  const query = new URLSearchParams(search);
  if (typeof console !== "undefined" && console.debug) {
    console.debug(`[mock] ${method} ${path}`, body ?? "");
  }

  // ── §1 首页
  if (method === "GET" && pathname === "/v1/world") {
    return {
      ...F.MOCK_WORLD,
      growth_summary: {
        ...F.MOCK_WORLD.growth_summary,
        materials: { ...state.materials },
        buildings: [...state.buildings],
      },
    } as T;
  }

  // ── §2 会话
  if (method === "POST" && pathname === "/v1/sessions") {
    return { session_id: Date.now() % 100000, started_at: new Date().toISOString() } as T;
  }
  if (method === "POST" && /^\/v1\/sessions\/[^/]+\/end$/.test(pathname)) {
    return { ok: true } as T;
  }

  // ── §3 今日计划
  if (method === "GET" && pathname === "/v1/plans/today") {
    return F.MOCK_DAILY_PLAN as T;
  }

  // ── §4 提交作答
  if (method === "POST" && pathname === "/v1/attempts") {
    return handleAttempt(body as AttemptRequest) as T;
  }

  // ── §5 教练提示
  if (method === "POST" && pathname === "/v1/coach/hints") {
    return handleHints(body as HintRequest) as T;
  }

  // ── §6 故事
  const storyMatch = pathname.match(/^\/v1\/stories\/([^/]+)$/);
  if (method === "GET" && storyMatch) {
    const raw = storyMatch[1];
    if (raw === undefined) throw new ApiError(404, "STORY_NOT_FOUND", "故事不存在");
    const code = decodeURIComponent(raw);
    const story = F.MOCK_STORIES[code];
    if (!story) throw new ApiError(404, "STORY_NOT_FOUND", `${code} 不存在`);
    return story as T;
  }

  // ── §7 实验室
  if (method === "GET" && pathname === "/v1/lab") {
    return F.MOCK_LAB as T;
  }

  // ── §8 侦探
  if (method === "GET" && pathname === "/v1/detective/puzzle") {
    const used = [...Object.keys(state.revealedClues), ...state.solvedPuzzles];
    const pool = Object.values(F.MOCK_DETECTIVE_PUZZLES).filter((p) => !used.includes(p.puzzle_id));
    const puzzle = pool[0] ?? Object.values(F.MOCK_DETECTIVE_PUZZLES)[0];
    // 不可达：MOCK_DETECTIVE_PUZZLES 是非空字面量。仅为满足 noUncheckedIndexedAccess 收窄。
    if (puzzle === undefined) throw new ApiError(404, "PUZZLE_INVALID", "没有可用的侦探谜题");
    return withRevealedClues(puzzle) as T;
  }
  if (method === "POST" && pathname === "/v1/detective/answer") {
    return handleDetective(body as DetectiveAnswerRequest) as T;
  }

  // ── §9 成长
  if (method === "GET" && pathname === "/v1/growth") {
    return growthSnapshot() as T;
  }
  if (method === "POST" && pathname === "/v1/growth/build") {
    return handleBuild(body as BuildRequest) as T;
  }

  // ── §10 家长端
  if (method === "GET" && pathname === "/v1/parent/report") {
    return F.MOCK_PARENT_REPORT as T;
  }

  // ── §11 调试
  if (method === "GET" && pathname === "/v1/debug/learning-state") {
    return F.MOCK_DEBUG_STATE as T;
  }

  throw new ApiError(404, "NOT_FOUND", `mock 未实现的端点：${method} ${pathname}`);
}

// ─────────────────────────────────────────────
// 各端点实现
// ─────────────────────────────────────────────

function handleAttempt(req: AttemptRequest): AttemptResponse {
  // 幂等：同一 client_attempt_id 重复提交返回首次结果（契约 §0）
  const previous = state.attempts.get(req.client_attempt_id);
  if (previous) return { ...previous, duplicate: true };

  const item = F.mockItem(req.item_code);
  if (!item) throw new ApiError(404, "ITEM_NOT_FOUND", `${req.item_code} 不存在`);

  const expected = F.MOCK_ANSWER_KEY[req.item_code];
  const actual = normalizeAnswer(req.answer);
  const correct = expected !== undefined && actual !== null && actual === expected;

  const slow = req.telemetry.response_time_ms > item.estimated_seconds * 1000 * 2;
  const feedback = feedbackFor(item, correct, slow, req.hints_used);
  const reward = rewardFor(item, correct);
  const progress = progressFor(item, correct);

  if (correct) {
    for (const m of reward.materials) {
      const key = m.code as keyof Materials;
      if (key in state.materials) state.materials[key] += m.count;
    }
    state.materials.coin += reward.coins;
  }

  state.seq += 1;
  const response: AttemptResponse = {
    attempt_id: state.seq,
    seq: state.seq,
    duplicate: false,
    correct,
    judgement_mismatch: false,
    misconceptions: correct ? [] : (F.MOCK_MISCONCEPTIONS[req.item_code] ?? []),
    feedback,
    reward,
    progress,
    next: { kind: "next_item", beat_index: null, item: null },
  };
  state.attempts.set(req.client_attempt_id, response);
  return response;
}

function handleHints(req: HintRequest): HintResponse {
  const item = F.mockItem(req.item_code);
  if (!item) throw new ApiError(404, "ITEM_NOT_FOUND", `${req.item_code} 不存在`);

  const chain = F.MOCK_HINT_CHAIN[req.item_code] ?? [FALLBACK_HINT];
  const nextLevel = (req.hints_used ?? 0) + 1;

  if (nextLevel > item.hints_available) {
    return {
      hint_level: nextLevel,
      exhausted: true,
      hint_text: "你已经很努力啦！再试一次，答错也没关系。",
      source: "rule",
      fallback_used: false,
    };
  }

  const hintText = chain[Math.min(nextLevel - 1, chain.length - 1)];
  return {
    hint_level: nextLevel,
    // 不可达：chain 非空且取 min 保证下标在界内。仅为满足 noUncheckedIndexedAccess 收窄。
    hint_text: hintText ?? FALLBACK_HINT,
    source: "rule",
    fallback_used: false,
    exhausted: false,
  };
}

function withRevealedClues(puzzle: DetectivePuzzle): DetectivePuzzle {
  const extra = state.revealedClues[puzzle.puzzle_id] ?? [];
  const clues = puzzle.clues.map((c) =>
    extra.includes(c.text) ? { ...c, revealed: true } : c,
  );
  const revealedCount = clues.filter((c) => c.revealed).length;
  return { ...puzzle, clues, clues_remaining: clues.length - revealedCount };
}

function handleDetective(req: DetectiveAnswerRequest): DetectiveAnswerResponse {
  const puzzle = F.MOCK_DETECTIVE_PUZZLES[req.puzzle_id];
  if (!puzzle) throw new ApiError(404, "PUZZLE_NOT_FOUND", `${req.puzzle_id} 不存在`);

  const expected = F.MOCK_DETECTIVE_ANSWERS[req.puzzle_id];
  const correct = expected !== undefined && normalizeAnswer(req.answer) === expected;

  if (correct && !state.solvedPuzzles.includes(req.puzzle_id)) {
    state.solvedPuzzles.push(req.puzzle_id);
  }

  const revealed = state.revealedClues[req.puzzle_id] ?? [];
  let revealed_clues: string[] = [];

  if (!correct) {
    const nextClue = puzzle.clues.find((c) => !c.revealed && !revealed.includes(c.text));
    if (nextClue) {
      revealed.push(nextClue.text);
      state.revealedClues[req.puzzle_id] = revealed;
      revealed_clues = [nextClue.text];
    }
  }

  const reward: Reward = correct
    ? { materials: [{ code: "coin", count: 0 }], coins: 3, unlocks: [] }
    : { materials: [], coins: 0, unlocks: [] };

  return {
    correct,
    feedback: {
      tone: correct ? "praise" : "encourage",
      text: correct
        ? "找到了！就是 26。狐狸侦探把放大镜收进口袋。"
        : revealed_clues.length > 0
          ? `这条线索不太对——不过我又找到一条线索：${revealed_clues[0]}。`
          : "线索都用完啦，我们换一个案子试试。",
      character: "fox",
    },
    revealed_clues,
    reward,
  };
}

function growthSnapshot(): GrowthResponse {
  return {
    ...F.MOCK_GROWTH,
    materials: { ...state.materials },
    buildings: F.MOCK_BUILDINGS.map((b) => ({ ...b, built: state.buildings.includes(b.code) })),
  };
}

function handleBuild(req: BuildRequest): BuildResponse {
  const building = F.MOCK_BUILDINGS.find((b) => b.code === req.building_code);
  if (!building) throw new ApiError(404, "BUILDING_NOT_FOUND", `${req.building_code} 不存在`);

  if (state.buildings.includes(building.code)) {
    return { built: true, materials: { ...state.materials }, unlocks: [], reason: "已经建好了" };
  }

  const missing = Object.entries(building.cost).filter(
    ([code, need]) => (state.materials[code as keyof Materials] ?? 0) < need,
  );
  if (missing.length > 0) {
    const parts = missing.map(([code, need]) => {
      const have = state.materials[code as keyof Materials] ?? 0;
      return `${MATERIAL_LABEL[code] ?? code} 还差 ${need - have}`;
    });
    return {
      built: false,
      materials: { ...state.materials },
      unlocks: [],
      reason: parts.join("，"),
    };
  }

  for (const [code, need] of Object.entries(building.cost)) {
    const key = code as keyof Materials;
    if (key in state.materials) state.materials[key] -= need;
  }
  state.buildings.push(building.code);

  return {
    built: true,
    materials: { ...state.materials },
    unlocks: building.code === "platform" ? ["universe.detective"] : [],
  };
}

const MATERIAL_LABEL: Record<string, string> = {
  wood: "木材",
  coin: "金币",
  gem: "宝石",
  seed: "种子",
};
