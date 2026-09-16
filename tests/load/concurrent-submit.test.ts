/**
 * 并发压测：submitAttempt 的三层防护（pg_advisory_xact_lock + 原子 seq +
 * 23505 重试）。plan §五 S4-3 的验收条件：
 *
 *   a. 20 并发同 child 不同 client_attempt_id → 全部成功，seq 1..20 无重复；
 *   b. 20 并发同 client_attempt_id → 恰好 1 个 created，其余幂等命中且
 *      响应与首次逐字相同。
 *
 * 直接调 service 层（submitAttempt 自带事务与重试），不起 HTTP 层。
 * 每个用例前 TRUNCATE 事件域表并重置 serial。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import { Telemetry } from "@/src/engine/types";

const DB_NAME = "db_math_conc";
const DB_URL = `postgresql://postgres@127.0.0.1:5432/${DB_NAME}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

process.env.MATH_DB_URL = DB_URL;

type Api = typeof import("@/src/service/learning");
type ContentApi = typeof import("@/src/service/content");
type ConfigApi = typeof import("@/src/engine/config");
type CoachApi = typeof import("@/src/coach/service");

let learning: Api;
let content: ContentApi;
let config: ConfigApi;
let coachMod: CoachApi;
let bundle: Awaited<ReturnType<ContentApi["bundle"]>>;
let cfg: InstanceType<ConfigApi["AlgorithmConfig"]>;
let coach: InstanceType<CoachApi["CoachService"]>;

async function resetEventTables(): Promise<void> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    // 状态域是全量重放的投影，事件域清掉后由下次提交重建
    await client.query(
      "TRUNCATE attempt, learning_event, reward_log, learning_session, " +
        "proficiency_state, pattern_state, misconception_state, review_schedule, " +
        "inventory RESTART IDENTITY CASCADE",
    );
  } finally {
    await client.end();
  }
}

async function countAttempts(): Promise<number> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const r = await client.query("SELECT count(*)::int AS n FROM attempt");
    return r.rows[0]!.n;
  } finally {
    await client.end();
  }
}

function submissionFor(id: string, itemCode: string, childId: number): import("@/src/service/learning").AttemptSubmission {
  return {
    client_attempt_id: id,
    child_id: childId,
    item_code: itemCode,
    answer: "0",
    telemetry: new Telemetry({
      response_time_ms: 5000,
      active_time_ms: 3000,
      idle_time_ms: 500,
    }),
    hints_used: 0,
  };
}

describe("submitAttempt 并发防护", () => {
  beforeAll(async () => {
    // 重建对拍库（与 api-parity 同策略）
    const admin = new pg.Client({
      host: "127.0.0.1",
      port: 5432,
      database: "postgres",
      user: "postgres",
    });
    await admin.connect();
    try {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [DB_NAME],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
      await admin.query(`CREATE DATABASE "${DB_NAME}"`);
    } finally {
      await admin.end();
    }
    const ddl = readFileSync(path.join(REPO_ROOT, "db/migrations/0001_init.sql"), "utf8");
    const ddlClient = new pg.Client({ connectionString: DB_URL });
    await ddlClient.connect();
    try {
      await ddlClient.query(ddl);
    } finally {
      await ddlClient.end();
    }
    spawnSync("npx", ["tsx", "scripts/init-db.ts"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, MATH_DB_URL: DB_URL },
    });

    learning = await import("@/src/service/learning");
    content = await import("@/src/service/content");
    config = await import("@/src/engine/config");
    coachMod = await import("@/src/coach/service");
    bundle = await content.bundle();
    cfg = config.loadConfig();
    const graph = new (await import("@/src/engine/graph")).CompetencyGraph(
      (await import("@/src/content/loader")).loadBundle(),
    );
    coach = coachMod.defaultService(bundle, graph);
  }, 120_000);

  it("20 并发不同 client_attempt_id：全部成功，seq 1..20 无重复", async () => {
    await resetEventTables();
    // 默认孩子 id=1（init-db 在空表时插入小明）
    const item = [...bundle.items.values()][0]!;
    const payloads = Array.from({ length: 20 }, (_, i) =>
      submissionFor(`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`, item.code, 1),
    );
    const results = await Promise.all(
      payloads.map((p) => learning.submitAttempt(bundle, cfg, coach, p)),
    );
    expect(results).toHaveLength(20);
    const seqs = results.map((r) => r["seq"] as number).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const ids = new Set(results.map((r) => r["attempt_id"]));
    expect(ids.size).toBe(20);
    expect(await countAttempts()).toBe(20);
  }, 60_000);

  it("20 并发同一 client_attempt_id：恰好 1 个 created，其余幂等且响应逐字相同", async () => {
    await resetEventTables();
    const item = [...bundle.items.values()][0]!;
    const payload = submissionFor(
      "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
      item.code,
      1,
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => learning.submitAttempt(bundle, cfg, coach, payload)),
    );
    expect(await countAttempts()).toBe(1);
    const created = results.filter((r) => r["duplicate"] === false);
    const duplicated = results.filter((r) => r["duplicate"] === true);
    expect(created).toHaveLength(1);
    expect(duplicated).toHaveLength(19);
    // 幂等命中返回的响应必须与首次逐字相同（duplicate 字段除外）
    const first = created[0]!;
    const stripped = (r: Record<string, unknown>) =>
      JSON.stringify({ ...r, duplicate: undefined });
    for (const dup of duplicated) {
      expect(stripped(dup)).toBe(stripped(first));
    }
  }, 60_000);

  afterAll(async () => {
    // 让 pg 池在进程退出前收干净（vitest 偶发 open-handle 警告源）
    const { getPool } = await import("@/src/db/client");
    await getPool().end();
  });
});
