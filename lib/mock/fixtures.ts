/**
 * Mock 示例数据。
 *
 * 硬约束：形状必须与 `docs/api-contract.md` **逐字段一致**。
 * 这里扮演的是「后端」，因此可以持有答案（真实后端同样持有）；
 * 题目载荷下发给前端的部分（Item）依旧**不含答案**，答案只存在于 ANSWER_KEY，
 * 供 mock 的判定逻辑使用，模拟服务端判定。
 */

import type {
  AttemptProgress,
  Badge,
  Building,
  DailyPlan,
  DetectivePuzzle,
  GrowthResponse,
  Item,
  LabResponse,
  Materials,
  ParentReport,
  StoryResponse,
  WorldResponse,
} from "@/lib/api/types";

export const MOCK_CHILD_ID = 1;

// ─────────────────────────────────────────────
// §1 首页
// ─────────────────────────────────────────────

export const MOCK_WORLD: WorldResponse = {
  child: { id: MOCK_CHILD_ID, name: "小明" },
  today: {
    headline: "小熊的桥坏啦！",
    subtitle: "去数字车站帮它一把",
    story_code: "ns_01_first_day",
    universe_code: "number_station",
    estimated_minutes: 12,
    completed: false,
  },
  universes: [
    {
      code: "number_station",
      name: "数字车站",
      emoji: "🚂",
      unlocked: true,
      progress: 0.35,
      stories: [
        { code: "ns_01_first_day", title: "小站第一天", completed: true, unlocked: true },
        { code: "ns_02_ticket", title: "小兔买车票", completed: false, unlocked: true },
        { code: "ns_03_train", title: "火车来了", completed: false, unlocked: true },
      ],
    },
    {
      code: "detective",
      name: "侦探社",
      emoji: "🦊",
      unlocked: true,
      progress: 0.1,
      stories: [
        { code: "det_01_missing", title: "消失的数字", completed: false, unlocked: true },
      ],
    },
    {
      code: "shop",
      name: "开心商店",
      emoji: "🏪",
      unlocked: false,
      progress: 0.0,
      stories: [],
    },
    {
      code: "build_kingdom",
      name: "建造王国",
      emoji: "🏗️",
      unlocked: false,
      progress: 0.0,
      stories: [],
    },
  ],
  lab_unlocked: true,
  detective_unlocked: true,
  growth_summary: {
    materials: { wood: 12, coin: 8, gem: 1, seed: 3 },
    buildings: ["ticket_booth"],
    newest_badge: { code: "first_make_ten", name: "第一次凑十", emoji: "🎖️" },
  },
};

// ─────────────────────────────────────────────
// §3 / §6 题目与故事
// ─────────────────────────────────────────────

// 不加 `Record<string, Item>` 注解：noUncheckedIndexedAccess 下注解会让
// `MOCK_ITEMS.mt_blk_8_5` 变成 `Item | undefined`，本文件内 13 处已知键访问
// 就都要断言。改成 `satisfies` 保留字面量类型，动态查找走下面的 mockItem()。
const MOCK_ITEMS = {
  // sd_add_10 · 直接计算 · 数字键盘
  sd_dir_6_3: {
    code: "sd_dir_6_3",
    competency: "sd_add_10",
    pattern: "direct_compute",
    difficulty: 1,
    scaffold_level: "direct",
    interaction_type: "number_pad",
    estimated_seconds: 6,
    prompt: "6 + 3 = ?",
    problem: { a: 6, b: 3 },
    answer_type: "number",
    choices: null,
    hints_available: 2,
  },

  // make_ten · 十格框积木
  mt_blk_8_5: {
    code: "mt_blk_8_5",
    competency: "make_ten",
    pattern: "decompose",
    difficulty: 1,
    scaffold_level: "blocks",
    interaction_type: "blocks",
    estimated_seconds: 20,
    prompt: "摆出 8 个，再摆出 5 个。把十格框补满，一共是多少个？",
    problem: { a: 8, b: 5, target: 10 },
    answer_type: "number",
    choices: null,
    hints_available: 3,
  },

  // make_ten · 拆分拖拽
  mt_dec_8_5: {
    code: "mt_dec_8_5",
    competency: "make_ten",
    pattern: "decompose",
    difficulty: 2,
    scaffold_level: "decompose",
    interaction_type: "decompose_drag",
    estimated_seconds: 15,
    prompt: "8 + 5，先把 5 拆成两块，让 8 凑满 10。",
    problem: { a: 8, b: 5, target: 10 },
    answer_type: "number",
    choices: null,
    hints_available: 3,
  },

  // make_ten · 选择题
  mt_cho_8_5: {
    code: "mt_cho_8_5",
    competency: "make_ten",
    pattern: "direct_compute",
    difficulty: 2,
    scaffold_level: "direct",
    interaction_type: "choice",
    estimated_seconds: 8,
    prompt: "8 + 5 等于几？",
    problem: { a: 8, b: 5 },
    answer_type: "choice",
    choices: ["12", "13", "14", "11"],
    hints_available: 2,
  },

  // sd_sub_10 · 十格框减法（真实内容里 problem.op === "sub"）
  s10sb_10_2: {
    code: "s10sb_10_2",
    competency: "sd_sub_10",
    pattern: "direct_compute",
    difficulty: 1,
    scaffold_level: "blocks",
    interaction_type: "blocks",
    estimated_seconds: 14,
    prompt: "摆出 10 个圆片，拿走 2 个。还剩多少个？",
    problem: { a: 10, b: 2, op: "sub" },
    answer_type: "number",
    choices: null,
    hints_available: 2,
  },

  // place_value · 积木表征
  pv_rep_23: {
    code: "pv_rep_23",
    competency: "place_value",
    pattern: "represent_place_value",
    difficulty: 2,
    scaffold_level: "blocks",
    interaction_type: "blocks",
    estimated_seconds: 20,
    prompt: "用积木摆出 23：2 个十和 3 个一。一共是多少个一？",
    problem: { target: 23 },
    answer_type: "number",
    choices: null,
    hints_available: 2,
  },

  // carry_add · 进位交换
  ca_ex_27_15: {
    code: "ca_ex_27_15",
    competency: "carry_add",
    pattern: "carry_exchange",
    difficulty: 4,
    scaffold_level: "blocks",
    interaction_type: "carry_exchange",
    estimated_seconds: 25,
    prompt: "27 + 15：个位满十了，把 10 个一捆成一捆十，再算一共多少。",
    problem: { a: 27, b: 15, target: 10 },
    answer_type: "number",
    choices: null,
    hints_available: 3,
  },

  // sd_add_20 · 数轴
  nl_add_8_3: {
    code: "nl_add_8_3",
    competency: "sd_add_20",
    pattern: "combine",
    difficulty: 2,
    scaffold_level: "decompose",
    interaction_type: "number_line",
    estimated_seconds: 14,
    prompt: "在数轴上，从 8 往右走 3 步，落在哪个数上？",
    problem: { a: 8, b: 3, min: 0, max: 20 },
    answer_type: "number",
    choices: null,
    hints_available: 2,
  },

  // td_add_nocarry · 直接计算（数轴之外的补位题）
  td_dir_23_14: {
    code: "td_dir_23_14",
    competency: "td_add_nocarry",
    pattern: "direct_compute",
    difficulty: 3,
    scaffold_level: "direct",
    interaction_type: "number_pad",
    estimated_seconds: 12,
    prompt: "23 + 14 = ?",
    problem: { a: 23, b: 14 },
    answer_type: "number",
    choices: null,
    hints_available: 2,
  },
} satisfies Record<string, Item>;

export { MOCK_ITEMS };

/** 键未知时的动态查找入口（返回值可能为 undefined，调用方必须判空） */
export function mockItem(code: string): Item | undefined {
  return (MOCK_ITEMS as Record<string, Item>)[code];
}

/** mock 的「服务端答案」，绝不随 Item 下发给前端 */
export const MOCK_ANSWER_KEY: Record<string, number> = {
  sd_dir_6_3: 9,
  s10sb_10_2: 8,
  mt_blk_8_5: 13,
  mt_dec_8_5: 13,
  mt_cho_8_5: 13,
  pv_rep_23: 23,
  ca_ex_27_15: 42,
  nl_add_8_3: 11,
  td_dir_23_14: 37,
};

/** mock 的提示链（对应契约 §5，服务端规则提示） */
export const MOCK_HINT_CHAIN: Record<string, string[]> = {
  sd_dir_6_3: ["从 6 开始，再往后数 3 个。", "6 和 3 合起来，比 6 多几个？"],
  s10sb_10_2: ["框里摆好 10 个了，先拿走 2 个。", "从 10 往前数 2 个，是几？"],
  mt_blk_8_5: [
    "8 再添几个就满十格框了？",
    "从 5 个里面拿几个过去补满？",
    "补满以后，外面还剩几个？",
  ],
  mt_dec_8_5: ["8 差几个才到 10？", "把 5 分成那个数和剩下的。", "10 加上剩下的数就是答案。"],
  mt_cho_8_5: ["先想 8 加几等于 10，再看看还剩几。", "8 + 2 = 10，那 5 还剩 3。"],
  pv_rep_23: ["一捆十里面有几个一？", "2 个十就是 20 个一，再加 3 个。"],
  ca_ex_27_15: ["先把 10 个一捆成一捆十。", "7 + 5 满十了，捆好之后十位多 1。"],
  nl_add_8_3: ["从 8 开始，往右数 3 格。", "先走到 10，再走剩下的一步。"],
  td_dir_23_14: ["十位和十位加，个位和个位加。", "20 + 10 = 30，3 + 4 = 7。"],
};

/** 错误认知（mock 判定用，对应契约 §4 misconceptions） */
export const MOCK_MISCONCEPTIONS: Record<string, string[]> = {
  mt_blk_8_5: ["counting_dependency"],
  mt_dec_8_5: ["make_ten_not_used"],
  mt_cho_8_5: ["make_ten_not_used"],
  ca_ex_27_15: ["carry_forgotten"],
  pv_rep_23: ["place_value_confusion"],
  nl_add_8_3: ["counting_dependency"],
  sd_dir_6_3: ["counting_dependency"],
  td_dir_23_14: ["place_value_confusion"],
};

export const MOCK_STORIES: Record<string, StoryResponse> = {
  ns_01_first_day: {
    code: "ns_01_first_day",
    universe: "number_station",
    title: "小站第一天",
    duration_min: 6,
    order_index: 1,
    beats: [
      {
        index: 1,
        type: "narration",
        narration: "清晨，数字车站醒过来了。今天是小熊站长第一天上班。",
        visual: { kind: "station", mood: "morning", characters: ["xiong"] },
        reward: null,
        challenge: null,
      },
      {
        index: 2,
        type: "challenge",
        narration: "先要把站台上的行李数清楚。",
        visual: { kind: "luggage", mood: "calm", characters: ["xiong"] },
        reward: null,
        challenge: {
          slot_code: "ns_01_beat_2",
          purpose: "warmup",
          scaffold_level: "direct",
          item: MOCK_ITEMS.sd_dir_6_3,
        },
      },
      {
        index: 3,
        type: "reward",
        narration: "行李都数清楚啦！小熊捡到一块木板。",
        visual: { kind: "station", mood: "happy", characters: ["xiong"] },
        reward: { materials: [{ code: "wood", count: 2 }], coins: 1, unlocks: [] },
        challenge: null,
      },
      {
        index: 4,
        type: "challenge",
        narration: "车厢里还有一堆水果箱，十格框好像快满了……",
        visual: { kind: "box", mood: "calm", characters: ["xiong"] },
        reward: null,
        challenge: {
          slot_code: "ns_01_beat_4",
          purpose: "teach",
          scaffold_level: "blocks",
          item: MOCK_ITEMS.mt_blk_8_5,
        },
      },
      {
        index: 5,
        type: "reward",
        narration: "十格框补满啦！小熊把木板收进背包。",
        visual: { kind: "station", mood: "happy", characters: ["xiong"] },
        reward: { materials: [{ code: "wood", count: 1 }], coins: 2, unlocks: [] },
        challenge: null,
      },
      {
        index: 6,
        type: "narration",
        narration: "第一天的班就这样上完啦。小熊说：明天还要请你来帮忙。",
        visual: { kind: "night", mood: "happy", characters: ["xiong"] },
        reward: null,
        challenge: null,
      },
    ],
  },

  ns_02_ticket: {
    code: "ns_02_ticket",
    universe: "number_station",
    title: "小兔买车票",
    duration_min: 5,
    order_index: 2,
    beats: [
      {
        index: 1,
        type: "narration",
        narration: "小兔跑到售票窗口，手里的硬币叮当作响。",
        visual: { kind: "ticket", mood: "calm", characters: ["rabbit"] },
        reward: null,
        challenge: null,
      },
      {
        index: 2,
        type: "challenge",
        narration: "车票的价格藏在一个算式里。",
        visual: { kind: "ticket", mood: "calm", characters: ["rabbit", "xiong"] },
        reward: null,
        challenge: {
          slot_code: "ns_02_beat_2",
          purpose: "practice",
          scaffold_level: "direct",
          item: MOCK_ITEMS.mt_cho_8_5,
        },
      },
      {
        index: 3,
        type: "challenge",
        narration: "小兔还想在数轴上确认一下自己坐过几站。",
        visual: { kind: "train", mood: "calm", characters: ["rabbit"] },
        reward: null,
        challenge: {
          slot_code: "ns_02_beat_3",
          purpose: "practice",
          scaffold_level: "decompose",
          item: MOCK_ITEMS.nl_add_8_3,
        },
      },
      {
        index: 4,
        type: "challenge",
        narration: "小兔的点心盒里有 10 块饼干，它想留 2 块给朋友。",
        visual: { kind: "box", mood: "calm", characters: ["rabbit"] },
        reward: null,
        challenge: {
          slot_code: "ns_02_beat_4",
          purpose: "practice",
          scaffold_level: "blocks",
          item: MOCK_ITEMS.s10sb_10_2,
        },
      },
      {
        index: 5,
        type: "reward",
        narration: "车票买好啦！小兔送你一颗种子。",
        visual: { kind: "ticket", mood: "happy", characters: ["rabbit"] },
        reward: { materials: [{ code: "seed", count: 1 }], coins: 1, unlocks: [] },
        challenge: null,
      },
    ],
  },

  ns_03_train: {
    code: "ns_03_train",
    universe: "number_station",
    title: "火车来了",
    duration_min: 7,
    order_index: 3,
    beats: [
      {
        index: 1,
        type: "narration",
        narration: "远处传来汽笛声，火车进站了。车厢里的箱子要重新数一遍。",
        visual: { kind: "train", mood: "calm", characters: ["xiong"] },
        reward: null,
        challenge: null,
      },
      {
        index: 2,
        type: "challenge",
        narration: "先把 5 拆开，让 8 凑满十格框。",
        visual: { kind: "box", mood: "calm", characters: ["xiong"] },
        reward: null,
        challenge: {
          slot_code: "ns_03_beat_2",
          purpose: "practice",
          scaffold_level: "decompose",
          item: MOCK_ITEMS.mt_dec_8_5,
        },
      },
      {
        index: 3,
        type: "challenge",
        narration: "货单上的数字有点大：27 加 15。个位好像满十了。",
        visual: { kind: "luggage", mood: "calm", characters: ["xiong"] },
        reward: null,
        challenge: {
          slot_code: "ns_03_beat_3",
          purpose: "challenge",
          scaffold_level: "blocks",
          item: MOCK_ITEMS.ca_ex_27_15,
        },
      },
      {
        index: 4,
        type: "reward",
        narration: "货单对上了！小熊送你一块亮亮的宝石。",
        visual: { kind: "train", mood: "happy", characters: ["xiong"] },
        reward: {
          materials: [
            { code: "wood", count: 1 },
            { code: "gem", count: 1 },
          ],
          coins: 2,
          unlocks: [],
        },
        challenge: null,
      },
    ],
  },
};

/** 实验室里也能直接试这几道题（LabPreview 用） */
export const MOCK_LAB_ITEMS = {
  blocks: MOCK_ITEMS.pv_rep_23,
  make_ten: MOCK_ITEMS.mt_blk_8_5,
  decompose: MOCK_ITEMS.mt_dec_8_5,
  place_value_train: MOCK_ITEMS.td_dir_23_14,
} satisfies Record<string, Item>;

// ─────────────────────────────────────────────
// §3 今日计划（首页之外的次要入口，调试面板会用到）
// ─────────────────────────────────────────────

export const MOCK_DAILY_PLAN: DailyPlan = {
  child_id: MOCK_CHILD_ID,
  budget_minutes: 12,
  intents: [{ kind: "teach", competency: "make_ten", reason: "当前聚焦能力尚未达标" }],
  segments: [
    {
      type: "warmup",
      budget_s: 154,
      intent_kinds: [],
      slot_code: null,
      scaffold_level: null,
      items: [MOCK_ITEMS.sd_dir_6_3],
      note: "本段今日无意图",
    },
    {
      type: "core",
      budget_s: 309,
      intent_kinds: ["teach"],
      slot_code: "core_make_ten_practice",
      scaffold_level: "blocks",
      items: [MOCK_ITEMS.mt_blk_8_5],
      note: "",
    },
    { type: "story", budget_s: 240, intent_kinds: [], slot_code: null, scaffold_level: null, items: [], note: "" },
    {
      type: "thinking",
      budget_s: 185,
      intent_kinds: [],
      slot_code: null,
      scaffold_level: null,
      items: [],
      note: "本段今日无意图",
    },
    { type: "discovery", budget_s: 72, intent_kinds: [], slot_code: null, scaffold_level: null, items: [], note: "" },
  ],
  discovery: "今天你发现了：凑十，第一次还要用积木摆，现在可以直接算了。",
  notes: [],
};

// ─────────────────────────────────────────────
// §7 实验室
// ─────────────────────────────────────────────

export const MOCK_LAB: LabResponse = {
  experiments: [
    {
      code: "blocks",
      name: "数字积木",
      emoji: "🧱",
      description: "23 = 2 个十 + 3 个一",
      unlocked: true,
    },
    { code: "decompose", name: "拆分数字", emoji: "✂️", description: "23 = 20 + 3", unlocked: true },
    { code: "make_ten", name: "凑十", emoji: "🔟", description: "8+5 → 8+2+3", unlocked: true },
    {
      code: "place_value_train",
      name: "十位小火车",
      emoji: "🚃",
      description: "十位、个位分别移动",
      unlocked: true,
    },
    {
      code: "carry_exchange",
      name: "进位交换",
      emoji: "🔁",
      description: "10 个一换 1 个十",
      unlocked: false,
    },
    {
      code: "shape_build",
      name: "图形搭建",
      emoji: "🔺",
      description: "为几何做准备",
      unlocked: false,
    },
  ],
};

// ─────────────────────────────────────────────
// §8 侦探
// ─────────────────────────────────────────────

export const MOCK_DETECTIVE_PUZZLES: Record<string, DetectivePuzzle> = {
  det_0007: {
    puzzle_id: "det_0007",
    kind: "guess_number",
    prompt: "我想了一个数字。",
    clues: [
      { text: "它大于 20", revealed: true },
      { text: "它小于 40", revealed: true },
      { text: "它是偶数", revealed: false },
      { text: "它的个位是 6", revealed: false },
    ],
    candidates: [26, 28, 36, 38],
    answer_type: "number",
    clues_remaining: 2,
  },
  det_0008: {
    puzzle_id: "det_0008",
    kind: "guess_number",
    prompt: "仓库里少了一箱货，箱号是这个数。",
    clues: [
      { text: "它比 50 大", revealed: true },
      { text: "它比 60 小", revealed: false },
      { text: "它的十位和个位加起来是 9", revealed: false },
    ],
    candidates: [45, 54, 56, 63],
    answer_type: "number",
    clues_remaining: 2,
  },
};

/** mock 侦探答案（服务端持有） */
export const MOCK_DETECTIVE_ANSWERS: Record<string, number> = {
  det_0007: 26,
  det_0008: 54,
};

// ─────────────────────────────────────────────
// §9 成长
// ─────────────────────────────────────────────

export const MOCK_MATERIALS: Materials = { wood: 12, coin: 8, gem: 1, seed: 3 };

export const MOCK_BUILDINGS: Building[] = [
  {
    code: "ticket_booth",
    name: "售票亭",
    emoji: "🎫",
    built: true,
    cost: { wood: 5, coin: 2 },
  },
  { code: "platform", name: "站台", emoji: "🛤️", built: false, cost: { wood: 10, coin: 5 } },
  { code: "water_tower", name: "水塔", emoji: "🚰", built: false, cost: { wood: 8, coin: 10 } },
  { code: "signal_light", name: "信号灯", emoji: "🚦", built: false, cost: { coin: 6, gem: 1 } },
];

export const MOCK_BADGES: Badge[] = [
  {
    code: "first_make_ten",
    name: "第一次凑十",
    emoji: "🎖️",
    earned: true,
    earned_at: "2026-09-09T10:20:00Z",
  },
  {
    code: "block_master",
    name: "积木小能手",
    emoji: "🧱",
    earned: true,
    earned_at: "2026-09-11T09:05:00Z",
  },
  {
    code: "three_day_streak",
    name: "连续三天来玩",
    emoji: "🔥",
    earned: true,
    earned_at: "2026-09-13T19:40:00Z",
  },
  { code: "carry_hero", name: "进位小英雄", emoji: "🚃", earned: false, earned_at: null },
  { code: "detective_star", name: "侦探之星", emoji: "🦊", earned: false, earned_at: null },
  { code: "story_finisher", name: "故事全通关", emoji: "📖", earned: false, earned_at: null },
];

export const MOCK_GROWTH: GrowthResponse = {
  tree: {
    nodes: [
      {
        code: "sd_add_10",
        name: "10 以内加法",
        level: "automatic",
        level_label: "🔥 自动化",
        mastered: true,
        emoji: "🌟",
        unlocked: true,
        position: { x: 0, y: 0 },
      },
      {
        code: "sd_sub_10",
        name: "10 以内减法",
        level: "can_do",
        level_label: "🌳 会做",
        mastered: false,
        emoji: "➖",
        unlocked: true,
        position: { x: 3, y: 0 },
      },
      {
        code: "sd_add_20",
        name: "20 以内加法",
        level: "understanding",
        level_label: "🌿 理解",
        mastered: false,
        emoji: "➕",
        unlocked: true,
        position: { x: 1, y: 1 },
      },
      {
        code: "make_ten",
        name: "凑十",
        level: "proficient",
        level_label: "⭐ 熟练",
        mastered: false,
        emoji: "🔟",
        unlocked: true,
        position: { x: 0, y: 2 },
      },
      {
        code: "place_value",
        name: "十位与个位",
        level: "can_do",
        level_label: "🌳 会做",
        mastered: false,
        emoji: "🚃",
        unlocked: true,
        position: { x: 2, y: 2 },
      },
      {
        code: "td_add_nocarry",
        name: "两位数加法（不进位）",
        level: "encountering",
        level_label: "🌱 接触",
        mastered: false,
        emoji: "🚂",
        unlocked: true,
        position: { x: 1, y: 3 },
      },
      {
        code: "carry_add",
        name: "进位加法",
        level: "encountering",
        level_label: "🌱 接触",
        mastered: false,
        emoji: "🔁",
        unlocked: false,
        position: { x: 0, y: 4 },
      },
    ],
    edges: [
      { from: "sd_add_10", to: "sd_add_20" },
      { from: "sd_add_10", to: "make_ten" },
      { from: "place_value", to: "td_add_nocarry" },
      { from: "sd_add_10", to: "td_add_nocarry" },
      { from: "td_add_nocarry", to: "carry_add" },
      { from: "make_ten", to: "carry_add" },
    ],
  },
  materials: MOCK_MATERIALS,
  buildings: MOCK_BUILDINGS,
  badges: MOCK_BADGES,
};

// ─────────────────────────────────────────────
// §10 家长端
// ─────────────────────────────────────────────

export const MOCK_PARENT_REPORT: ParentReport = {
  child: { id: MOCK_CHILD_ID, name: "小明" },
  range: { days: 7, from: "2026-09-08", to: "2026-09-15" },
  headline: "本周不是「不会两位数加法」，而是「已经理解，但流畅度不足」。",
  competencies: [
    {
      code: "sd_add_10",
      name: "10 以内加法",
      level: "automatic",
      level_label: "🔥 自动化",
      score: 0.95,
      signals: { mastery: 0.97, accuracy: 0.98, fluency: 0.91, independence: 0.99, transfer: 0.9 },
    },
    {
      code: "make_ten",
      name: "凑十",
      level: "can_do",
      level_label: "🌳 会做",
      score: 0.61,
      signals: { mastery: 0.72, accuracy: 0.68, fluency: 0.55, independence: 0.94, transfer: 0.7 },
    },
    {
      code: "place_value",
      name: "十位与个位",
      level: "understanding",
      level_label: "🌿 理解",
      score: 0.48,
      signals: { mastery: 0.55, accuracy: 0.72, fluency: null, independence: 0.88, transfer: 0.4 },
    },
    {
      code: "td_add_nocarry",
      name: "两位数加法（不进位）",
      level: "encountering",
      level_label: "🌱 接触",
      score: 0.22,
      signals: { mastery: 0.3, accuracy: 0.5, fluency: null, independence: 0.8, transfer: null },
    },
  ],
  weak_points: [
    {
      type: "fluency",
      competency: "make_ten",
      text: "能独立做对，但每次要多想几秒；建议继续用「先凑十」的方法，不要退回逐个数。",
    },
    {
      type: "transfer",
      competency: "place_value",
      text: "在积木题里表现稳定，换成纯算式时正确率下降，说明表征还没迁移到抽象符号。",
    },
  ],
  misconceptions: [
    {
      code: "counting_dependency",
      name: "依赖数数",
      hit_count: 3,
      text: "近一周出现 3 次逐个数的情况。",
    },
    {
      code: "make_ten_not_used",
      name: "凑十未被使用",
      hit_count: 2,
      text: "有 2 次明明可以用凑十，孩子选择了从头数。",
    },
  ],
  progress: [
    { date: "2026-09-09", level: "understanding", note: "第一次在提示下完成凑十" },
    { date: "2026-09-11", level: "understanding", note: "十格框补满速度明显变快" },
    { date: "2026-09-13", level: "can_do", note: "不用积木也能拆分了" },
  ],
  engagement: {
    sessions: 5,
    total_minutes: 58,
    avg_minutes_per_session: 11.6,
    next_day_return_rate: 0.8,
    story_completion_rate: 0.75,
  },
  advice: [
    "每天 10～15 分钟即可，不要延长。",
    "本周重点是「快一点」，可以玩「限时凑十」，但不要催。",
    "孩子答错时系统会把它演成剧情，请配合不要说「又错了」。",
  ],
  disclaimer: "数据来自孩子在应用内的真实作答，仅供家庭参考，不作为学业评价。",
};

// ─────────────────────────────────────────────
// §11 调试（契约未固定字段名，这里是推测形状；
//      调试面板在结构不匹配时会退化成原始 JSON）
// ─────────────────────────────────────────────

export const MOCK_DEBUG_STATE = {
  child_id: MOCK_CHILD_ID,
  algorithm_version: 0,
  updated_at: "2026-09-15T10:12:00Z",
  competencies: [
    {
      code: "sd_add_10",
      name: "10 以内加法",
      level: "automatic",
      level_label: "🔥 自动化",
      scaffold_level: "direct",
      sample_count: 34,
      assessment_samples: 4,
      probe_status: "done",
      signals: { mastery: 0.97, accuracy: 0.98, fluency: 0.91, independence: 0.99, transfer: 0.9 },
      updated_at: "2026-09-15T10:10:00Z",
    },
    {
      code: "make_ten",
      name: "凑十",
      level: "can_do",
      level_label: "🌳 会做",
      scaffold_level: "decompose",
      sample_count: 11,
      assessment_samples: 4,
      probe_status: "in_progress",
      signals: { mastery: 0.72, accuracy: 0.68, fluency: 0.55, independence: 0.94, transfer: 0.7 },
      updated_at: "2026-09-15T10:12:00Z",
    },
  ],
  patterns: [
    {
      competency: "make_ten",
      pattern: "decompose",
      level: "can_do",
      level_label: "🌳 会做",
      sample_count: 7,
      signals: { mastery: 0.75, accuracy: 0.71, fluency: 0.52, independence: 1.0, transfer: null },
      method_distribution: { decompose: 5, visual_blocks: 2 },
    },
    {
      competency: "make_ten",
      pattern: "direct_compute",
      level: "understanding",
      level_label: "🌿 理解",
      sample_count: 4,
      signals: { mastery: 0.62, accuracy: 0.6, fluency: 0.58, independence: 0.85, transfer: null },
      method_distribution: { mental: 2, counting: 2 },
    },
  ],
};

/** 供 mock 生成 progress 用的初始状态 */
export const MOCK_PROGRESS_SEED: Record<string, AttemptProgress> = {
  sd_add_10: {
    competency: "sd_add_10",
    level: "automatic",
    level_label: "🔥 自动化",
    scaffold_level: "direct",
    signals: { mastery: 0.97, accuracy: 0.98, fluency: 0.91, independence: 0.99, transfer: 0.9 },
    sample_count: 34,
  },
  make_ten: {
    competency: "make_ten",
    level: "can_do",
    level_label: "🌳 会做",
    scaffold_level: "decompose",
    signals: { mastery: 0.72, accuracy: 0.68, fluency: 0.55, independence: 0.94, transfer: 0.7 },
    sample_count: 11,
  },
  place_value: {
    competency: "place_value",
    level: "understanding",
    level_label: "🌿 理解",
    scaffold_level: "blocks",
    signals: { mastery: 0.55, accuracy: 0.72, fluency: 0.5, independence: 0.88, transfer: 0.4 },
    sample_count: 6,
  },
  sd_add_20: {
    competency: "sd_add_20",
    level: "understanding",
    level_label: "🌿 理解",
    scaffold_level: "decompose",
    signals: { mastery: 0.5, accuracy: 0.75, fluency: 0.6, independence: 0.9, transfer: 0.45 },
    sample_count: 5,
  },
  carry_add: {
    competency: "carry_add",
    level: "encountering",
    level_label: "🌱 接触",
    scaffold_level: "blocks",
    signals: { mastery: 0.2, accuracy: 0.5, fluency: 0.35, independence: 0.8, transfer: 0.2 },
    sample_count: 2,
  },
  td_add_nocarry: {
    competency: "td_add_nocarry",
    level: "encountering",
    level_label: "🌱 接触",
    scaffold_level: "blocks",
    signals: { mastery: 0.3, accuracy: 0.6, fluency: 0.45, independence: 0.85, transfer: 0.25 },
    sample_count: 3,
  },
};
