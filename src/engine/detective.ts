/**
 * 数学侦探 —— `backend/engine/detective.py` 的 TypeScript 移植。
 *
 * 侦探模式不是"换个壳的计算题"——它的认知目标是**逻辑推理**：
 * 从若干条线索里排除不可能，剩下的就是答案。
 *
 * 因此这里有一条硬性不变量：
 *
 *     把所有线索都用上，候选集必须恰好只剩一个数，且它就是答案。
 *
 * 否则孩子不是在推理，是在猜。这条不变量由 `Puzzle.validate()` 强制，
 * 并且有测试对全部种类 × 上千个种子做穷举验证。
 *
 * 两个刻意的设计：
 *
 * 1. **无状态**：`puzzle_id` 里编码了种子，答案不落库。
 *    GET 出题和 POST 判题各自独立地从 puzzle_id 重新生成一次，
 *    两次结果必然一致，省掉一张表和一个会话状态。
 *
 * 2. **线索按"由宽到窄"的书写顺序揭示**，不做"筛得最多优先"的排序——
 *    因为"它就是下一项"这种决定性的线索排除得最多，排在前面等于直接给答案。
 */
import { PyRandom } from "@/src/py/pyrandom";

export const PUZZLE_ID_PREFIX = "det";

export const KIND_GUESS_NUMBER = "guess_number";
export const KIND_FIND_PATTERN = "find_pattern";
export const KIND_BALANCE = "balance";
export const ALL_KINDS = [KIND_GUESS_NUMBER, KIND_FIND_PATTERN, KIND_BALANCE];

export type PuzzlePredicate = (n: number) => boolean;

// ── 谜题模型 ───────────────────────────────────────────────

export class Clue {
  text: string;
  predicate: PuzzlePredicate | null;
  revealed: boolean;

  constructor(init: { text: string; predicate?: PuzzlePredicate | null; revealed?: boolean }) {
    this.text = init.text;
    this.predicate = init.predicate === undefined ? null : init.predicate;
    this.revealed = init.revealed ?? false;
  }

  toDict(): Record<string, unknown> {
    return { text: this.text, revealed: this.revealed };
  }
}

export class Puzzle {
  puzzle_id: string;
  kind: string;
  prompt: string;
  clues: Clue[];
  answer: number;
  /**
   * domain 是**下发给孩子的候选项**，不是全部可能的数。
   * 它是"看起来都像对的"那几个（典型的错法），孩子要靠线索把它们排掉。
   */
  domain: number[];

  constructor(init: {
    puzzle_id: string;
    kind: string;
    prompt: string;
    clues: Clue[];
    answer: number;
    domain?: number[];
  }) {
    this.puzzle_id = init.puzzle_id;
    this.kind = init.kind;
    this.prompt = init.prompt;
    this.clues = init.clues;
    this.answer = init.answer;
    this.domain = init.domain ?? [];
  }

  // ── 求解 ──────────────────────────────────────────────

  /** 只用**已揭示**的线索求候选集。 */
  candidates(revealed_count?: number | null): number[] {
    const count =
      revealed_count === undefined || revealed_count === null
        ? this.clues.filter((c) => c.revealed).length
        : revealed_count;
    const active = this.clues.slice(0, count).filter((c) => c.predicate !== null);
    return this.domain.filter((v) => active.every((c) => c.predicate!(v)));
  }

  get clues_remaining(): number {
    return this.clues.filter((c) => !c.revealed).length;
  }

  reveal_next(): string | null {
    for (const clue of this.clues) {
      if (!clue.revealed) {
        clue.revealed = true;
        return clue.text;
      }
    }
    return null;
  }

  /** 独立求解：不信任 answer 字段，用线索自己算。 */
  solve(): number[] {
    return this.candidates(this.clues.length);
  }

  // ── 不变量 ────────────────────────────────────────────

  /**
   * 内容错误的机器判定：孩子能不能靠推理得到唯一答案。
   *
   * 两条硬性要求：
   *   1. 全部线索用上后，候选集恰好只剩 [answer]
   *   2. **每个非答案候选项都能被至少一条线索排除**
   *      —— 排不掉的候选项是"陷阱"，孩子无论怎么推理都走不出来，
   *      最后只能猜。这是侦探模式最致命的缺陷，必须机器拦住。
   */
  validate(): string[] {
    const problems: string[] = [];
    if (this.clues.length === 0) {
      problems.push("谜题没有任何线索");
    }
    for (const clue of this.clues) {
      if (clue.predicate === null) {
        problems.push(`线索「${clue.text}」没有判定逻辑，无法参与求解`);
      }
    }
    if (this.domain.length === 0) {
      problems.push("候选域为空");
    }
    if (!this.domain.includes(this.answer)) {
      problems.push(`答案 ${this.answer} 不在候选域 ${pyList(this.domain)}`);
    }
    if (problems.length > 0) {
      return problems;
    }

    const final = this.solve();
    if (!(final.length === 1 && final[0] === this.answer)) {
      problems.push(
        `全部线索用上后候选集是 ${pyList(final)}，应当恰好只剩 [${this.answer}]`,
      );
    }

    for (const value of this.domain) {
      if (value === this.answer) {
        continue;
      }
      if (this.clues.every((clue) => clue.predicate !== null && clue.predicate(value))) {
        problems.push(`候选项 ${value} 没有任何线索能排除它，孩子只能靠猜`);
      }
    }
    return problems;
  }

  /**
   * 信息量低的线索：揭示了却一个候选项都没排除。
   *
   * 不算错误 —— 建立范围感的线索（"它大于 20"）本来就不负责排除，
   * 但生成器如果产出一堆这种线索，值得人看一眼。
   */
  weak_clues(): string[] {
    const weak: string[] = [];
    for (let index = 0; index < this.clues.length; index += 1) {
      const before = this.candidates(index).length;
      const after = this.candidates(index + 1).length;
      if (after === before) {
        weak.push(this.clues[index]!.text);
      }
    }
    return weak;
  }

  /**
   * 一开局就已经唯一确定 —— 孩子不用推理，点一下就行。
   *
   * 这种题比"太难"更糟：它把侦探模式变成了点击训练。
   */
  is_trivial(reveal_count: number): boolean {
    return this.candidates(reveal_count).length <= 1;
  }

  // ── 下发 ──────────────────────────────────────────────

  /** 契约 §8 的形状。**不含 answer** —— 答案永不下发。 */
  toDict(): Record<string, unknown> {
    return {
      puzzle_id: this.puzzle_id,
      kind: this.kind,
      prompt: this.prompt,
      clues: this.clues.map((c) => c.toDict()),
      candidates: this.candidates(),
      answer_type: "number",
      clues_remaining: this.clues_remaining,
    };
  }
}

/** Python str(list) 的复刻：[1, 2, 3]（validate 的报错文案进测试断言） */
function pyList(values: readonly number[]): string {
  return `[${values.join(", ")}]`;
}

// ── puzzle_id：种子即身份 ──────────────────────────────────

export function makePuzzleId(seed: number): string {
  return `${PUZZLE_ID_PREFIX}_${String(seed % 10000).padStart(4, "0")}`;
}

export function parsePuzzleId(puzzle_id: string): number | null {
  if (!puzzle_id || !puzzle_id.startsWith(`${PUZZLE_ID_PREFIX}_`)) {
    return null;
  }
  const tail = puzzle_id.slice(PUZZLE_ID_PREFIX.length + 1);
  // Python 的 isdigit()/int() 连全角数字都接受；API 入口处这类输入
  // 不会出现，这里按 ASCII 判定（差异只在非法输入的拒绝方式上）。
  return /^[0-9]+$/.test(tail) ? Number.parseInt(tail, 10) : null;
}

function distractors(
  answer: number,
  variants: readonly number[],
  low = 1,
  high = 99,
): number[] {
  /** 候选项 = 答案 + 几个"典型错法"，去重排序。 */
  const pool = new Set<number>([answer]);
  for (const value of variants) {
    if (low <= value && value <= high) {
      pool.add(value);
    }
  }
  return [...pool].sort((a, b) => a - b);
}

// ── 生成器 ─────────────────────────────────────────────────

function genGuessNumber(rng: PyRandom, puzzle_id: string): Puzzle {
  /** 猜数字：范围 → 奇偶 → 个位 → 十位，逐步锁定。 */
  const tens = rng.randint(2, 8);
  const ones = rng.randint(2, 9);
  const answer = tens * 10 + ones;

  const domain = distractors(
    answer,
    [
      tens * 10 + (ones < 9 ? ones + 1 : ones - 1), // 个位记错
      tens * 10 + (ones - 1), // 个位差一
      (tens + 1) * 10 + ones, // 十位记错
      (tens - 1) * 10 + ones, // 十位差一
    ],
    11,
    99,
  );

  // 线索顺序 = 揭示顺序：由宽到窄。前两条是"框定范围"，
  // 但第 2 条已经带上奇偶，孩子一开始就有东西可排，不至于面对一堆废话。
  const clues = [
    new Clue({ text: "它大于 20", predicate: (n) => n > 20 }),
    new Clue({
      text: `它是${answer % 2 === 0 ? "偶" : "奇"}数`,
      predicate: (n) => n % 2 === answer % 2,
    }),
    new Clue({ text: "它小于 90", predicate: (n) => n < 90 }),
    new Clue({ text: `它的个位是 ${ones}`, predicate: (n) => n % 10 === ones }),
    new Clue({ text: `它的十位是 ${tens}`, predicate: (n) => Math.floor(n / 10) === tens }),
  ];
  return new Puzzle({
    puzzle_id,
    kind: KIND_GUESS_NUMBER,
    prompt: "我想了一个数字。",
    clues,
    answer,
    domain,
  });
}

function genFindPattern(rng: PyRandom, puzzle_id: string): Puzzle {
  /** 找规律：三种适龄规律，逐步给线索。 */
  const variant = rng.choice(["step", "alternate", "growing_step"]);

  let seq: number[] = [];
  let answer = 0;
  let clues: Clue[] = [];

  if (variant === "step") {
    const start = rng.randint(1, 8);
    const step = rng.randint(2, 5);
    seq = [0, 1, 2, 3, 4].map((i) => start + step * i);
    answer = seq[4]! + step;
    const domain = distractors(
      answer,
      [seq[4]! + 1, seq[4]! + step - 1, seq[4]! + step + 1, seq[4]! + 2 * step],
      1,
      99,
    );
    clues = [
      new Clue({
        text: "每一步加的数都一样",
        predicate: (n) => (n - start) % step === 0,
      }),
      new Clue({ text: `它比 ${seq[4]!} 大`, predicate: (n) => n > seq[4]! }),
      new Clue({ text: `它比 ${answer + 4} 小`, predicate: (n) => n < answer + 4 }),
      // 最后一条也是**真线索**，不是"就是它"——
      // 孩子的推理路径不能被一句宣告代替
      new Clue({
        text: `它和 ${seq[4]!} 相差 ${step}`,
        predicate: (n) => Math.abs(n - seq[4]!) === step,
      }),
    ];
    return new Puzzle({
      puzzle_id,
      kind: KIND_FIND_PATTERN,
      prompt: `看看这串数的规律：${seq.join("、")}。下一个是多少？`,
      clues,
      answer,
      domain,
    });
  }

  if (variant === "alternate") {
    const low = rng.randint(1, 5);
    const high = low + rng.randint(3, 6);
    seq = [low, high, low, high, low];
    answer = high;
    const domain = distractors(answer, [low, answer - 1, answer + 1, answer + 2], 1, 99);
    // 交替规律的"规律"本身没法写成一个数的谓词：
    // 真正的推理发生在孩子看序列的时候，线索只负责把范围收紧。
    clues = [
      new Clue({ text: `它比 ${low} 大`, predicate: (n) => n > low }),
      new Clue({ text: `它比 ${high + 3} 小`, predicate: (n) => n < high + 3 }),
      new Clue({ text: "它和刚才那个数不一样", predicate: (n) => n !== low }),
      new Clue({ text: `它比 ${high + 1} 小`, predicate: (n) => n < high + 1 }),
      new Clue({
        text: `它是${answer % 2 === 0 ? "偶" : "奇"}数`,
        predicate: (n) => n % 2 === answer % 2,
      }),
    ];
    return new Puzzle({
      puzzle_id,
      kind: KIND_FIND_PATTERN,
      prompt: `看看这串数的规律：${seq.join("、")}。下一个是多少？`,
      clues,
      answer,
      domain,
    });
  }

  const start = rng.randint(1, 4);
  seq = [];
  let value = start;
  for (let gap = 1; gap <= 5; gap += 1) {
    seq.push(value);
    value += gap;
  }
  answer = seq[4]! + 5;
  const domain = distractors(
    answer,
    [seq[4]! + 1, seq[4]! + 4, seq[4]! + 5, seq[4]! + 6],
    1,
    99,
  );
  clues = [
    new Clue({ text: `它比 ${seq[4]!} 大`, predicate: (n) => n > seq[4]! }),
    new Clue({ text: `它比 ${answer + 3} 小`, predicate: (n) => n < answer + 3 }),
    new Clue({
      text: `它是${answer % 2 === 0 ? "偶" : "奇"}数`,
      predicate: (n) => n % 2 === answer % 2,
    }),
    new Clue({
      text: `它和 ${seq[4]!} 相差 5`,
      predicate: (n) => Math.abs(n - seq[4]!) === 5,
    }),
  ];
  return new Puzzle({
    puzzle_id,
    kind: KIND_FIND_PATTERN,
    prompt: `看看这串数的规律：${seq.join("、")}。下一个是多少？`,
    clues,
    answer,
    domain,
  });
}

function genBalance(rng: PyRandom, puzzle_id: string): Puzzle {
  /** 天平：方框里填几，两边才一样重。
   *
   * 这是最容易做到"线索全都有信息量"的一种，
   * 因为答案天然被限制在 1~9（孩子能口算的范围）。
   */
  const box = rng.randint(2, 9);
  const other = rng.randint(2, 9);
  const total = box + other;

  const domain = distractors(box, [other, box - 1, box + 1, total - 1], 1, 18);

  const clues = [
    new Clue({ text: `它比 ${total} 小`, predicate: (n) => n < total }),
    new Clue({
      text: `它是${box % 2 === 0 ? "偶" : "奇"}数`,
      predicate: (n) => n % 2 === box % 2,
    }),
    new Clue({
      text: `${other} 加上它等于 ${total}`,
      predicate: (n) => n + other === total,
    }),
    new Clue({ text: `它小于 ${box + 2}`, predicate: (n) => n < box + 2 }),
  ];
  return new Puzzle({
    puzzle_id,
    kind: KIND_BALANCE,
    prompt: `天平左边是 □ + ${other}，右边是 ${total}。□ 是几才能平衡？`,
    clues,
    answer: box,
    domain,
  });
}

export const GENERATORS: Record<string, (rng: PyRandom, puzzle_id: string) => Puzzle> = {
  [KIND_GUESS_NUMBER]: genGuessNumber,
  [KIND_FIND_PATTERN]: genFindPattern,
  [KIND_BALANCE]: genBalance,
};

export function generatePuzzle(
  puzzle_id: string,
  kind?: string | null,
  reveal_count = 2,
  max_attempts = 40,
): Puzzle {
  /** 从 puzzle_id 确定性地重建一道谜题。
   *
   * GET /v1/detective/puzzle 与 POST /v1/detective/answer 各自调用一次，
   * 得到的结果必然一致 —— 答案不需要落库。
   *
   * `max_attempts` 是一道保险：某个种子碰巧生成了不自洽的谜题（线索排不掉候选项、
   * 或者一开局就唯一确定），就顺延到下一个种子。搜索过程是确定性的，
   * 所以同一 puzzle_id 永远得到同一道题。
   * 这类"被顺延掉"的种子在测试里会被穷举找出来，所以不会长期潜伏。
   */
  const base = parsePuzzleId(puzzle_id);
  if (base === null) {
    throw new ValueErrorDetective(`非法的 puzzle_id: ${puzzle_id}`);
  }

  for (let offset = 0; offset < max_attempts; offset += 1) {
    const seed = base + offset;
    const rng = new PyRandom(seed * 7919 + 13);
    const chosen = kind || ALL_KINDS[seed % ALL_KINDS.length]!;
    const generator = GENERATORS[chosen];
    if (generator === undefined) {
      throw new ValueErrorDetective(`未知的谜题类型: ${chosen}`);
    }

    const puzzle = generator(rng, makePuzzleId(seed));
    if (puzzle.validate().length > 0) {
      continue;
    }

    const reveal = Math.max(1, Math.min(reveal_count, puzzle.clues.length - 1));
    if (puzzle.is_trivial(reveal)) {
      continue;
    }

    for (const clue of puzzle.clues.slice(0, reveal)) {
      clue.revealed = true;
    }
    return puzzle;
  }

  throw new RuntimeErrorDetective(
    `从 ${puzzle_id} 起连续 ${max_attempts} 个种子都生成不出自洽的谜题，生成器有问题`,
  );
}

export function judge(puzzle: Puzzle, answer: unknown): boolean {
  // Python: int(str(answer).strip()) —— 只接受整数字面量（"3.5" 会抛 ValueError）
  const text = String(answer).trim();
  if (!/^[+-]?[0-9]+$/.test(text)) {
    return false;
  }
  try {
    return Number.parseInt(text, 10) === puzzle.answer;
  } catch {
    return false;
  }
}

export function revealAfterAttempt(puzzle: Puzzle, correct: boolean): string[] {
  /** 答错了就多给一条线索；答对了不再揭。 */
  if (correct) {
    return [];
  }
  const text = puzzle.reveal_next();
  return text ? [text] : [];
}

export class ValueErrorDetective extends Error {
  override readonly name = "ValueErrorDetective";
}
export class RuntimeErrorDetective extends Error {
  override readonly name = "RuntimeErrorDetective";
}
