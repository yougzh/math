/**
 * 故事逻辑专项审查（一次性工具，非入库脚本）。
 *
 * A. 静态（bundle 层）：结构完整性 / beat↔slot 对称绑定 / 选题可行性 /
 *    文本数字方向与能力粗检 / 跨故事全局性
 * B. reward 合法性（DB 层 reward_json —— bundle 不含 visual/reward）
 * C. 运行时（需 next start 在 3000）：逐故事 GET，验证 planner 真实选题
 */
import pg from "pg";
import { loadBundle } from "../src/content/loader";

const BASE = "http://127.0.0.1:3000/api/v1";
const problems: string[] = [];
const notes: string[] = [];

const bundle = loadBundle();
const stories = [...bundle.stories.values()].sort(
  (a, b) => a.order_index - b.order_index,
);
const competencies = new Set([...bundle.competencies.keys()]);
const items = [...bundle.items.values()];
const slots = [...bundle.slots.values()];

const eligiblePool = (
  competency: string,
  dmin: number,
  dmax: number,
  pattern: string | null,
) =>
  items.filter(
    (i) =>
      i.competency_id === competency &&
      i.difficulty >= dmin &&
      i.difficulty <= dmax &&
      (pattern === null || i.pattern_id === pattern),
  );

const ADD_WORDS = /加|合起来|一共|总共|又来|再加|凑/;
const SUB_WORDS = /减|还剩|拿走|去掉|开走|少了|借|找回|用去|吃掉|卖掉|开走了/;

console.log(
  `bundle：${stories.length} 故事 / ${slots.length} 槽 / ${items.length} 题 / ${competencies.size} 能力\n`,
);

// ── A. 逐故事静态审查 ──
const seenOrder = new Map<number, string>();
const seenCompetency = new Map<string, string>();
for (const s of stories) {
  const sid = s.code;
  const beats = [...s.beats].sort((a, b) => a.sequence - b.sequence);

  // 1) beat 序列与类型
  if (beats.length === 0) problems.push(`${sid}: 无 beats`);
  const types = beats.map((b) => b.beat_type);
  const chCount = types.filter((t) => t === "challenge").length;
  const rwCount = types.filter((t) => t === "reward").length;
  if (chCount === 0) problems.push(`${sid}: 没有任何 challenge beat`);
  if (rwCount > 1) problems.push(`${sid}: 有 ${rwCount} 个 reward beat（期望 ≤1）`);
  const last = beats[beats.length - 1];
  if (last && last.beat_type === "challenge")
    problems.push(`${sid}: 最后一个 beat 是 challenge（孩子答完没有收尾段落）`);

  // sequence 连续且从 1 开始
  beats.forEach((b, i) => {
    if (b.sequence !== i + 1)
      problems.push(`${sid}: beat ${b.code} 的 sequence=${b.sequence}，位置 ${i}，序列断裂`);
  });

  // 文本与角色非空
  for (const b of beats) {
    if (!b.narration.trim())
      problems.push(`${sid}: beat ${b.code}（${b.beat_type}）narration 为空`);
    if (b.beat_type !== "challenge" && !b.character.trim())
      problems.push(`${sid}: beat ${b.code}（${b.beat_type}）缺 character`);
  }

  // 2) challenge ↔ slot 对称绑定（loader 已把 slot_code 回填到 beat）
  for (const b of beats) {
    if (b.beat_type === "challenge") {
      if (b.slot_code === null) {
        problems.push(`${sid}: challenge beat ${b.code} 未挂任何 slot（孩子会看到"没有题目"）`);
      } else {
        const sl = bundle.slots.get(b.slot_code);
        if (!sl) problems.push(`${sid}: beat ${b.code} 挂的 slot ${b.slot_code} 不存在`);
        else if (sl.story_beat_id !== b.code)
          problems.push(
            `${sid}: beat ${b.code} ↔ slot ${sl.code} 绑定不对称（slot 指向 ${sl.story_beat_id}）`,
          );
      }
    } else if (b.slot_code !== null) {
      problems.push(`${sid}: ${b.beat_type} beat ${b.code} 不应挂 slot（挂了 ${b.slot_code}）`);
    }
  }
  const storySlots = slots.filter(
    (sl) => sl.story_beat_id !== null && sl.story_beat_id.startsWith(sid + "__"),
  );
  for (const sl of storySlots) {
    const beat = beats.find((b) => b.code === sl.story_beat_id);
    if (!beat)
      problems.push(`${sid}: slot ${sl.code} 的 story_beat_id 指向不存在的 beat`);
    else if (beat.beat_type !== "challenge")
      problems.push(`${sid}: slot ${sl.code} 绑到 ${beat.beat_type} beat（只有 challenge 需要槽）`);
  }

  // 3) 选题可行性：每个 story slot 的 (competency, 区间, pattern) 至少 1 题 + 每脚手架层有题
  for (const sl of storySlots) {
    if (!competencies.has(sl.competency_id)) {
      problems.push(`${sid}: slot ${sl.code} 绑定不存在的 competency ${sl.competency_id}`);
      continue;
    }
    const pool = eligiblePool(sl.competency_id, sl.difficulty_min, sl.difficulty_max, sl.pattern_id);
    if (pool.length === 0) {
      problems.push(
        `${sid}: slot ${sl.code}（${sl.competency_id} d${sl.difficulty_min}~${sl.difficulty_max}${sl.pattern_id ? " " + sl.pattern_id : ""}）题池为空`,
      );
      continue;
    }
    if (sl.scaffold_level !== "auto") {
      const inLayer = pool.filter((i) => i.scaffold_level === sl.scaffold_level);
      if (inLayer.length === 0)
        problems.push(
          `${sid}: slot ${sl.code} 在脚手架 ${sl.scaffold_level} 层无题（池 ${pool.length} 题都在别的层）`,
        );
    }
    // 题目交互类型分布（告知产品：该槽孩子会遇到什么交互）
    const byType = new Map<string, number>();
    for (const i of pool) byType.set(i.interaction_type, (byType.get(i.interaction_type) ?? 0) + 1);
    const dist = [...byType.entries()].map(([k, n]) => `${k}×${n}`).join("/");
    const beat = beats.find((b) => b.code === sl.story_beat_id);
    if (beat) {
      const text = beat.narration;
      const wantsAdd = /add|make_ten/.test(sl.competency_id);
      const wantsSub = /sub|borrow/.test(sl.competency_id);
      const saysAdd = ADD_WORDS.test(text);
      const saysSub = SUB_WORDS.test(text);
      if (wantsAdd && saysSub && !saysAdd)
        notes.push(`${sid}: beat ${beat.code} 文本偏减法但槽 ${sl.code} 考 ${sl.competency_id}`);
      if (wantsSub && saysAdd && !saysSub)
        notes.push(`${sid}: beat ${beat.code} 文本偏加法但槽 ${sl.code} 考 ${sl.competency_id}`);
      console.log(`  ${sl.code}: 池 ${pool.length} 题（${dist}）「${text.slice(0, 22)}…」`);
    }
  }

  // 5) 全局性
  if (seenOrder.has(s.order_index))
    problems.push(`${sid}: order_index ${s.order_index} 与 ${seenOrder.get(s.order_index)} 重复`);
  seenOrder.set(s.order_index, sid);
  for (const c of s.target_competencies) {
    if (!competencies.has(c)) problems.push(`${sid}: target_competencies 含不存在的能力 ${c}`);
    else if (seenCompetency.has(c))
      notes.push(`${sid}: 能力 ${c} 已由 ${seenCompetency.get(c)} 覆盖（跨故事重复训练）`);
    else seenCompetency.set(c, sid);
  }
}

// ── B. reward 合法性（DB reward_json）──
async function rewardCheck(): Promise<void> {
  const client = new pg.Client({
    connectionString: process.env.MATH_DB_URL ?? "postgresql://postgres@127.0.0.1:5432/db_math",
  });
  await client.connect();
  const rewardRows = await client.query(
    "SELECT story_code, code, reward_json FROM story_beat WHERE beat_type = 'reward' ORDER BY story_code",
  );
  let withReward = 0;
  for (const row of rewardRows.rows) {
    const r = row.reward_json;
    if (!r || Object.keys(r).length === 0) {
      notes.push(`${row.story_code}: reward beat ${row.code} 无奖励内容（纯剧情收尾，可接受）`);
      continue;
    }
    withReward++;
    for (const m of r.materials ?? []) {
      if (!(m.count > 0)) problems.push(`${row.story_code}: reward ${row.code} 材料 ${m.code} 数量 ${m.count} ≤ 0`);
    }
    if (r.coins != null && r.coins < 0) problems.push(`${row.story_code}: reward ${row.code} 金币为负`);
  }
  console.log(`\nreward beat：${rewardRows.rows.length} 个，带奖励 ${withReward} 个`);
  await client.end();
}

// ── C. 运行时逐故事（真实 planner 选题）──
async function runtimeCheck(): Promise<void> {
  console.log("── 运行时逐故事选题 ──");
  let rtOk = 0;
  for (const s of stories) {
    try {
      const res = await fetch(`${BASE}/stories/${s.code}?child_id=1`);
      if (!res.ok) {
        problems.push(`运行时: GET ${s.code} → HTTP ${res.status}`);
        continue;
      }
      const story = await res.json();
      const chs = (story.beats ?? []).filter((b: { type: string }) => b.type === "challenge");
      const empty = chs.filter(
        (b: { challenge?: { item?: { code?: string } | null } }) => !b.challenge?.item?.code,
      );
      if (empty.length > 0)
        problems.push(`运行时: ${s.code} 有 ${empty.length}/${chs.length} 个 challenge 选题为空`);
      else rtOk++;
      console.log(
        `  ${s.code}: beats=${story.beats?.length} challenge=${chs.length} 选题${empty.length === 0 ? "全成功" : "有 " + empty.length + " 个空"}`,
      );
    } catch (e) {
      problems.push(`运行时: GET ${s.code} 失败：${(e as Error).message}（next start 是否在跑？）`);
    }
  }
  console.log(`\n运行时选题成功：${rtOk}/${stories.length}`);
}

// ── D. 逐题验算（problem 与 answer 的数学一致性）──
function verifyItem(item: {
  code: string;
  competency_id: string;
  pattern_id: string;
  problem: Record<string, unknown>;
  answer: unknown;
}): string | null {
  const p = item.problem;
  const a = p.a as number | undefined;
  const b = p.b as number | undefined;
  const target = p.target as number | undefined;
  const known = p.known as number | undefined;
  const ask = p.ask as string | undefined;
  const ans = item.answer;
  const num = (v: unknown) => (typeof v === "number" ? v : NaN);

  const isSub = /sub|borrow/.test(item.competency_id) || p.op === "sub";
  // missing_part（known/target）：「已经有 known 个，凑满 target 个还差几个」
  // 挂在 sd_sub_10 / make_ten 下都是这个语义（missing addend）
  if (known !== undefined && target !== undefined) {
    return num(ans) === target - known
      ? null
      : `验算失败：${target} - ${known}（missing_part）≠ ${JSON.stringify(ans)}`;
  }
  // 加法族（含凑十的 total/decompose/direct_compute：答案 = a + b）
  if (isSub) {
    if (a === undefined || b === undefined) return "减法题缺 a/b";
    if (num(ans) !== a - b) return `验算失败：${a} - ${b} ≠ ${JSON.stringify(ans)}`;
    if (a - b < 0) return `减法结果为负：${a} - ${b}`;
    return null;
  }
  switch (item.competency_id) {
    case "make_ten":
      if (item.pattern_id === "number_friends") {
        if (target === undefined || a === undefined) return "number_friends 缺 target/a";
        return num(ans) === target - a ? null : `验算失败：10 - ${a} ≠ ${JSON.stringify(ans)}`;
      }
      if (item.pattern_id === "missing_part" && target === undefined) {
        // 「已经有 a 个，凑满 b 个还差几个」→ b - a
        if (a === undefined || b === undefined) return "make_ten missing_part 缺 a/b";
        return num(ans) === b - a ? null : `验算失败：${b} - ${a} ≠ ${JSON.stringify(ans)}`;
      }
      if (item.pattern_id === "reverse") {
        // 「加上 added 以后变成了 result，原来是多少」→ result - added
        const result = p.result as number | undefined;
        const added = p.added as number | undefined;
        if (result === undefined || added === undefined) return "make_ten reverse 缺 result/added";
        return num(ans) === result - added
          ? null
          : `验算失败：${result} - ${added} ≠ ${JSON.stringify(ans)}`;
      }
      break;
    case "place_value":
      // combine/total：a 已是整十数（60）+ 个位 b（3）→ 默认加法分支处理
      if (item.pattern_id !== "combine" && item.pattern_id !== "total") {
        if (ask === "tens") return num(ans) === Math.floor(a! / 10) ? null : `验算失败：${a} 的十位 ≠ ${JSON.stringify(ans)}`;
        if (ask === "ones") return num(ans) === a! % 10 ? null : `验算失败：${a} 的个位 ≠ ${JSON.stringify(ans)}`;
        return `place_value 未知形态：ask=${ask} pattern=${item.pattern_id}`;
      }
      break;
    default:
      break;
  }
  // 默认：加法族 a + b
  if (a === undefined || b === undefined) return `缺 a/b（problem=${JSON.stringify(p).slice(0, 80)}）`;
  if (num(ans) !== a + b) return `验算失败：${a} + ${b} ≠ ${JSON.stringify(ans)}`;
  // 数轴题的边界
  if (typeof p.min === "number" && typeof p.max === "number") {
    if (num(ans) < p.min || num(ans) > p.max)
      return `答案 ${ans} 超出数轴范围 [${p.min}, ${p.max}]`;
  }
  return null;
}

async function itemCheck(): Promise<void> {
  const tally = new Map<string, number>();
  let bad = 0;
  for (const i of items) {
    const err = verifyItem(i);
    if (err) {
      bad++;
      problems.push(`题目 ${i.code}（${i.competency_id}/${i.pattern_id}）：${err}`);
    }
    tally.set(i.competency_id, (tally.get(i.competency_id) ?? 0) + 1);
  }
  console.log(
    `\n逐题验算：${items.length} 题，失败 ${bad}（` +
      [...tally.entries()].map(([k, n]) => `${k}×${n}`).join(" ") +
      `）`,
  );
}

// ── 汇总 ──
async function main(): Promise<void> {
  await rewardCheck();
  await itemCheck();
  await runtimeCheck();
  if (notes.length) {
    console.log(`\n备注（非缺陷）：`);
    for (const n of notes) console.log("  · " + n);
  }
  if (problems.length) {
    console.error(`\n❌ 发现 ${problems.length} 个问题：`);
    for (const p of problems) console.error("  ✗ " + p);
    process.exit(1);
  } else {
    console.log("\n✅ 全部故事逻辑检查通过");
  }
}

void main();
