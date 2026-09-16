/**
 * 初始化数据库：建表之后的内容导入 —— `tools/init_db.py` 的 TypeScript 移植。
 *
 *    npx tsx scripts/init-db.ts                 # build/content_dump.json → $MATH_DB_URL
 *    npx tsx scripts/init-db.ts --dump 其他.json
 *
 * 幂等：重复执行不报错、不产生重复行（按主键/唯一键 upsert，ON CONFLICT DO UPDATE）。
 * dump 是**唯一输入**（学习内容与故事全部来自 dump 文件），与 Python 侧同源；
 * 另插入三样 dump 之外的部署必需品：
 *   - algorithm_config：各版本 yaml 原样入库，is_active = (文件名 == v0.yaml)（ADR-0002 版本 pin）
 *   - content_release：dump 的版本号 + 文件 checksum + counts 统计
 *   - 默认孩子「小明」：契约 §0 的缺省使用默认孩子
 *
 * 全部写入在一个事务里 —— 半个库的内容比空库更危险。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import pg from "pg";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_DUMP = path.join(ROOT, "build", "content_dump.json");
const ALGORITHM_CONFIG_DIR = path.join(ROOT, "config", "algorithm");
const DEFAULT_CHILD_NAME = "小明";

const UNIVERSE_NAMES: Record<string, string> = {
  number_station: "数字车站",
  detective: "侦探社",
};

type Row = Record<string, unknown>;

/**
 * JSONB 列的传参：必须显式 JSON.stringify。
 * node-pg 对 object 自动 stringify，但对 **string** 原样发送 —— dump 里
 * answer 等字段是字符串标量（"36"）时，裸 "36" 会被 JSONB 拒收
 * （invalid input syntax for type json）；数字标量则被静默解释成 JSON 数字，
 * 类型就悄悄变了。统一 stringify 才能保证"JSON 值的形状"与 dump 一致。
 */
const json = (v: unknown): string | null =>
  v === null || v === undefined ? null : JSON.stringify(v);

function loadDbUrl(): string {
  // 1) 显式环境变量 2) .env 文件（KEY=VALUE，只认 MATH_DB_URL 这一个键）
  if (process.env.MATH_DB_URL) {
    return process.env.MATH_DB_URL;
  }
  const envPath = path.join(ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*MATH_DB_URL\s*=\s*(.+?)\s*$/);
      if (m) {
        return m[1]!;
      }
    }
  }
  throw new Error("没有 MATH_DB_URL（环境变量或 .env 均未配置）");
}

function readDump(dumpPath: string): Record<string, unknown> {
  if (!existsSync(dumpPath)) {
    console.error(`找不到内容导出文件：${dumpPath}`);
    console.error("请先运行：npm run build:content");
    process.exit(1);
  }
  const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Record<string, unknown>;
  if (!("stories" in dump)) {
    console.error("dump 文件缺少 stories 段（过期导出）。");
    console.error("请先重新运行：npm run build:content");
    process.exit(1);
  }
  return dump;
}

function d(dump: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  return (dump[key] as Array<Record<string, unknown>> | undefined) ?? [];
}

// ── 各内容块的行构造（与 tools/init_db.py 的 *_rows 逐字段同构）────────

function competencyRows(dump: Record<string, unknown>): Row[] {
  return d(dump, "competencies").map((row) => ({
    code: row["code"],
    name: row["name"],
    description: row["description"] ?? "",
    stage: Number(row["stage"] ?? 1),
    active: true,
  }));
}

function prerequisiteRows(dump: Record<string, unknown>): Row[] {
  const rows: Row[] = [];
  for (const row of d(dump, "competencies")) {
    for (const prereq of (row["prerequisites"] as string[] | undefined) ?? []) {
      rows.push({
        competency_code: row["code"],
        prerequisite_code: prereq,
        weight: 1.0,
      });
    }
  }
  return rows;
}

function patternRows(dump: Record<string, unknown>): Row[] {
  return d(dump, "patterns").map((row) => ({
    code: row["code"],
    name: row["name"],
    description: row["description"] ?? "",
    cognitive_type: row["cognitive_type"],
  }));
}

function patternCompetencyRows(dump: Record<string, unknown>): Row[] {
  const rows: Row[] = [];
  for (const row of d(dump, "patterns")) {
    const primary = row["primary_competency"] as string;
    const related = new Set([
      ...((row["applicable_competencies"] as string[] | undefined) ?? []),
      primary,
    ]);
    for (const competency_code of [...related].sort()) {
      rows.push({
        pattern_code: row["code"],
        competency_code,
        is_primary: competency_code === primary,
      });
    }
  }
  return rows;
}

function misconceptionRows(dump: Record<string, unknown>): Row[] {
  return d(dump, "misconceptions").map((row) => ({
    code: row["code"],
    name: row["name"],
    description: row["description"] ?? "",
    severity: Number(row["severity"] ?? 1),
    remediation_competency: row["remediation_competency"] ?? null,
  }));
}

function itemRows(dump: Record<string, unknown>, release_id: number): Row[] {
  return d(dump, "items").map((row) => ({
    code: row["code"],
    competency_code: row["competency"],
    pattern_code: row["pattern"],
    difficulty: Number(row["difficulty"] ?? 1),
    scaffold_level: row["scaffold_level"],
    interaction_type: row["interaction_type"],
    estimated_seconds: Number(row["estimated_seconds"] ?? 15),
    problem_json: json(row["problem"] ?? {}),
    answer_json: json(row["answer"] ?? null),
    steps_json: json(row["steps"] ?? []),
    hint_chain_json: json(row["hint_chain"] ?? []),
    error_rules_json: json(row["error_rules"] ?? []),
    source_template: row["source_template"] ?? null,
    review_status: row["review_status"] ?? "approved",
    content_release_id: release_id,
  }));
}

function storyRows(dump: Record<string, unknown>): Row[] {
  // universe 为空时归入 number_station（loader 的缺省宇宙）
  return d(dump, "stories").map((row) => ({
    code: row["code"],
    universe_code: row["universe"] ?? "number_station",
    title: row["title"],
    summary: row["summary"] ?? "",
    duration_min: row["duration_min"] ?? null,
    target_competencies_json: json((row["target_competencies"] as string[] | undefined) ?? []),
    order_index: Number(row["order_index"] ?? 0),
  }));
}

function storyBeatRows(dump: Record<string, unknown>): Row[] {
  const rows: Row[] = [];
  for (const row of d(dump, "stories")) {
    for (const beat of (row["beats"] as Array<Record<string, unknown>> | undefined) ?? []) {
      rows.push({
        code: beat["code"],
        story_code: row["code"],
        sequence: Number(beat["sequence"]),
        beat_type: beat["beat_type"],
        narration: beat["narration"] ?? "",
        character: beat["character"] ?? "",
        visual_json: json(beat["visual"] ?? {}),
        reward_json: json(beat["reward"] ?? {}),
      });
    }
  }
  return rows;
}

function algorithmConfigRows(): Row[] {
  if (!existsSync(ALGORITHM_CONFIG_DIR)) {
    return [];
  }
  const rows: Row[] = [];
  for (const name of readdirSync(ALGORITHM_CONFIG_DIR).sort()) {
    if (!name.endsWith(".yaml")) {
      continue;
    }
    const payload = parseYaml(readFileSync(path.join(ALGORITHM_CONFIG_DIR, name), "utf8")) as Record<
      string,
      unknown
    >;
    rows.push({
      version: Number(payload["version"]),
      payload_json: json(payload),
      is_active: name === "v0.yaml",
    });
  }
  return rows;
}

function slotRows(dump: Record<string, unknown>): Row[] {
  return d(dump, "slots").map((row) => ({
    code: row["code"],
    story_beat_code: row["story_beat_id"] ?? null,
    competency_code: row["competency"],
    pattern_code: row["pattern"] ?? null,
    difficulty_min: Number(row["difficulty_min"] ?? 1),
    difficulty_max: Number(row["difficulty_max"] ?? 5),
    scaffold_level: row["scaffold_level"] ?? "auto",
    purpose: row["purpose"] ?? "practice",
    estimated_seconds: Number(row["estimated_seconds"] ?? 20),
    selection_policy_json: json(row["selection_policy"] ?? {}),
    review_policy_json: json(row["review_policy"] ?? {}),
  }));
}

// ── upsert（INSERT ... ON CONFLICT (key) DO UPDATE）─────────────────

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`可疑的列名：${name}`);
  }
  return name;
}

async function upsert(
  client: pg.Client,
  table: string,
  rows: Row[],
  keyColumns: string[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const columns = Object.keys(rows[0]!);
  for (const row of rows) {
    if (JSON.stringify(Object.keys(row)) !== JSON.stringify(columns)) {
      throw new Error(`${table} 的行字段不一致 —— 行构造器有问题`);
    }
  }
  const colList = columns.map(quoteIdent).join(", ");
  const conflictCols = keyColumns.map(quoteIdent).join(", ");
  const updateCols = columns
    .filter((c) => !keyColumns.includes(c))
    .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
    .join(", ");

  // 分批参数化：pg 协议上限 65535 个参数
  const perBatch = Math.max(1, Math.floor(60000 / columns.length));
  let written = 0;
  for (let i = 0; i < rows.length; i += perBatch) {
    const batch = rows.slice(i, i + perBatch);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const placeholders = columns.map((c) => {
        values.push(row[c]);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const sql = `INSERT INTO ${table} (${colList}) VALUES ${tuples.join(", ")} ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols}`;
    await client.query(sql, values);
    written += batch.length;
  }
  return written;
}

// ── main ──────────────────────────────────────────────────

async function main(argv: readonly string[]): Promise<number> {
  let dumpPath = DEFAULT_DUMP;
  const dumpIndex = argv.indexOf("--dump");
  if (dumpIndex >= 0) {
    dumpPath = argv[dumpIndex + 1]!;
  }

  const dump = readDump(dumpPath);
  const dbUrl = loadDbUrl();
  const display = dbUrl.replace(/:[^:@/]+@/, ":***@");
  console.log(`数据库：${display}`);
  console.log(`dump：${dumpPath}（sha256 ${createHash("sha256").update(readFileSync(dumpPath)).digest("hex").slice(0, 12)}…）`);

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();

  const counts: Record<string, number> = {};
  try {
    await client.query("BEGIN");

    counts["algorithm_config"] = await upsert(
      client,
      "algorithm_config",
      algorithmConfigRows(),
      ["version"],
    );

    // content_release：dump 版本 + checksum —— item 表外键指向它
    const release_version = String(dump["content_version"] ?? "v0");
    const checksum = createHash("sha256").update(readFileSync(dumpPath)).digest("hex");
    const stats_json = json((dump["counts"] as Record<string, unknown> | undefined) ?? {});
    const existing = await client.query("SELECT id FROM content_release WHERE version = $1", [
      release_version,
    ]);
    let release_id: number;
    if (existing.rowCount === 0) {
      const inserted = await client.query(
        "INSERT INTO content_release (version, checksum, stats_json) VALUES ($1, $2, $3) RETURNING id",
        [release_version, checksum, stats_json],
      );
      release_id = inserted.rows[0]!.id;
    } else {
      release_id = existing.rows[0]!.id;
      await client.query("UPDATE content_release SET checksum = $2, stats_json = $3 WHERE id = $1", [
        release_id,
        checksum,
        stats_json,
      ]);
    }

    counts["competency"] = await upsert(client, "competency", competencyRows(dump), ["code"]);
    counts["competency_prerequisite"] = await upsert(
      client,
      "competency_prerequisite",
      prerequisiteRows(dump),
      ["competency_code", "prerequisite_code"],
    );
    counts["problem_pattern"] = await upsert(client, "problem_pattern", patternRows(dump), ["code"]);
    counts["pattern_competency"] = await upsert(
      client,
      "pattern_competency",
      patternCompetencyRows(dump),
      ["pattern_code", "competency_code"],
    );
    counts["misconception"] = await upsert(client, "misconception", misconceptionRows(dump), ["code"]);
    counts["item"] = await upsert(client, "item", itemRows(dump, release_id), ["code"]);

    // 故事域：universe → story → story_beat → challenge_slot（全部来自 dump）
    const story_data = storyRows(dump);
    const universes = [...new Set(story_data.map((row) => row["universe_code"] as string))].sort();
    counts["universe"] = await upsert(
      client,
      "universe",
      universes.map((code, index) => ({
        code,
        name: UNIVERSE_NAMES[code] ?? code,
        theme: "",
        unlock_rule_json: json({}),
        order_index: index,
      })),
      ["code"],
    );
    counts["story"] = await upsert(client, "story", story_data, ["code"]);
    counts["story_beat"] = await upsert(client, "story_beat", storyBeatRows(dump), ["code"]);
    counts["challenge_slot"] = await upsert(client, "challenge_slot", slotRows(dump), ["code"]);

    // 默认孩子：库里一个孩子都没有才插（契约 §0）
    const childCount = await client.query("SELECT count(*)::int AS n FROM child");
    if (childCount.rows[0]!.n === 0) {
      await client.query("INSERT INTO child (name) VALUES ($1)", [DEFAULT_CHILD_NAME]);
    }
    const childAfter = await client.query("SELECT count(*)::int AS n FROM child");
    counts["child"] = childAfter.rows[0]!.n;

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }

  console.log("导入完成（重复执行不会产生重复行）：");
  for (const key of Object.keys(counts).sort()) {
    console.log(`  ${key.padEnd(24)} ${counts[key]}`);
  }
  return 0;
}

const argv = process.argv.slice(2);
main(argv).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
