/**
 * api-contract 对拍 —— 与 tools/api_contract_dump.py（Python 基线）逐场景比对。
 *
 * 流程：
 *   1. DROP/CREATE 独立对拍库 db_math_api_ts（与 Python 侧同一策略，保证确定性）；
 *   2. 跑 scripts/init-db.ts 导入同一份内容 dump；
 *   3. 按 fixture 的 28 条场景重放：直接调用 route handler（不起 Next 服务器），
 *      从前序响应动态提取 story_code / item_code / session_id / puzzle_id
 *      （与 Python dump 的提取规则逐字一致）；
 *   4. 比对 status 与响应体（ISO 时间戳归一化为 "<ISO>" —— 两边各自的 now()）。
 *
 * 比对是**深比较**（键序无关）；任何一条场景红 = TS 与 Python 契约分歧。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";

const API_TS_URL = "postgresql://postgres@127.0.0.1:5432/db_math_api_ts";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// 必须在动态 import db/client 之前钉住连接串（池懒创建，import 顺序安全）
process.env.MATH_DB_URL = API_TS_URL;

const fixturePath = path.join(REPO_ROOT, "tests/fixtures/api_parity.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
  scenarios: Array<{
    name: string;
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
    status: number;
    response: unknown;
  }>;
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    return ISO_RE.test(value) ? "<ISO>" : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

type RouteModule = Record<string, unknown>;

async function recreateDatabase(): Promise<void> {
  const admin = new pg.Client({ host: "127.0.0.1", port: 5432, database: "postgres", user: "postgres" });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'db_math_api_ts' AND pid <> pg_backend_pid()",
    );
    await admin.query('DROP DATABASE IF EXISTS "db_math_api_ts"');
    await admin.query('CREATE DATABASE "db_math_api_ts"');
  } finally {
    await admin.end();
  }
}

async function initDatabase(): Promise<void> {
  // 先建表（migrations DDL 自带 BEGIN/COMMIT，整文件一次发过去），
  // 再导入内容 —— 与 scripts/db-local.ts 的 applyDDL + init-db 组合一致
  const ddl = readFileSync(path.join(REPO_ROOT, "db/migrations/0001_init.sql"), "utf8");
  const client = new pg.Client({ connectionString: API_TS_URL });
  await client.connect();
  try {
    await client.query(ddl);
  } finally {
    await client.end();
  }

  const result = spawnSync("npx", ["tsx", "scripts/init-db.ts"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, MATH_DB_URL: API_TS_URL },
  });
  if (result.status !== 0) {
    throw new Error("init-db.ts 失败，退出码 " + result.status);
  }
}

// ── 场景执行（与 Python Scenario.run 逐条对应） ────────────

interface Api {
  health: RouteModule;
  world: RouteModule;
  story: RouteModule;
  lab: RouteModule;
  growth: RouteModule;
  growthBuild: RouteModule;
  parentReport: RouteModule;
  debug: RouteModule;
  sessions: RouteModule;
  sessionEnd: RouteModule;
  plansToday: RouteModule;
  attempts: RouteModule;
  coachHints: RouteModule;
  detectivePuzzle: RouteModule;
  detectiveAnswer: RouteModule;
  catchAll: RouteModule;
}

const state: {
  childId: number | null;
  storyCode: string | null;
  itemCode: string | null;
  puzzleId: string | null;
  sessionId: number | null;
} = { childId: null, storyCode: null, itemCode: null, puzzleId: null, sessionId: null };

function makeRequest(
  method: string,
  url: string,
  body?: unknown,
  params?: Record<string, string>,
): { request: Request; ctx?: { params: Promise<Record<string, string>> } } {
  const request = new Request(`http://localhost:3000${url}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
  return { request, ctx: params ? { params: Promise.resolve(params) } : undefined };
}

async function call(
  api: Api,
  module: keyof Api,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<{ status: number; response: unknown }> {
  const handler = api[module][method] as
    | ((request: Request, ctx?: unknown) => Promise<Response>)
    | undefined;
  if (typeof handler !== "function") {
    throw new Error(`${module} 没有 ${method} handler`);
  }
  const { request, ctx } = makeRequest(method, url, body, params);
  const response = await handler(request, ctx);
  const text = await response.text();
  const parsed = text === "" ? null : (JSON.parse(text) as unknown);
  return { status: response.status, response: parsed };
}

function runScenario(api: Api, name: string): { status: number; response: unknown } {
  switch (name) {
    case "health":
      return call(api, "health", "GET", "/health") as never;
    case "world":
      return call(api, "world", "GET", "/v1/world") as never;
    case "world_child_missing":
      return call(api, "world", "GET", "/v1/world?child_id=999") as never;
    case "story":
      return call(api, "story", "GET", `/v1/stories/${state.storyCode ?? "none"}`, undefined, {
        story_code: state.storyCode ?? "none",
      }) as never;
    case "story_missing":
      return call(api, "story", "GET", "/v1/stories/__no_such_story__", undefined, {
        story_code: "__no_such_story__",
      }) as never;
    case "lab":
      return call(api, "lab", "GET", "/v1/lab") as never;
    case "growth":
      return call(api, "growth", "GET", "/v1/growth") as never;
    case "parent_report":
      return call(api, "parentReport", "GET", "/v1/parent/report") as never;
    case "parent_report_bad_days":
      return call(api, "parentReport", "GET", "/v1/parent/report?days=0") as never;
    case "plans_today":
      return call(api, "plansToday", "GET", "/v1/plans/today") as never;
    case "session_create":
      return call(api, "sessions", "POST", "/v1/sessions", {
        planned_minutes: 15,
        device: "parity",
      }) as never;
    case "session_end":
      return call(api, "sessionEnd", "POST", `/v1/sessions/${state.sessionId}/end`, {
        quit_reason: "parity",
      }, { session_id: String(state.sessionId) }) as never;
    case "session_end_missing":
      return call(api, "sessionEnd", "POST", "/v1/sessions/999999/end", {}, {
        session_id: "999999",
      }) as never;
    case "plans_today_with_session":
      return call(
        api,
        "plansToday",
        "GET",
        `/v1/plans/today?session_id=${state.sessionId}`,
      ) as never;
    case "attempt_create":
      return call(api, "attempts", "POST", "/v1/attempts", {
        client_attempt_id: "11111111-1111-4111-8111-111111111111",
        child_id: state.childId,
        item_code: state.itemCode,
        answer: "0",
        telemetry: { response_time_ms: 5000, active_time_ms: 3000, idle_time_ms: 500 },
        hints_used: 0,
      }) as never;
    case "attempt_duplicate":
      return call(api, "attempts", "POST", "/v1/attempts", {
        client_attempt_id: "11111111-1111-4111-8111-111111111111",
        child_id: state.childId,
        item_code: state.itemCode,
        answer: "0",
        telemetry: { response_time_ms: 5000, active_time_ms: 3000, idle_time_ms: 500 },
        hints_used: 0,
      }) as never;
    case "attempt_second":
      return call(api, "attempts", "POST", "/v1/attempts", {
        client_attempt_id: "22222222-2222-4222-8222-222222222222",
        child_id: state.childId,
        item_code: state.itemCode,
        answer: "0",
        telemetry: { response_time_ms: 5000, active_time_ms: 3000, idle_time_ms: 500 },
        hints_used: 0,
      }) as never;
    case "attempt_item_missing":
      return call(api, "attempts", "POST", "/v1/attempts", {
        client_attempt_id: "33333333-3333-4333-8333-333333333333",
        child_id: state.childId ?? 1,
        item_code: "__no_such_item__",
        answer: "0",
        telemetry: { response_time_ms: 5000, active_time_ms: 3000, idle_time_ms: 500 },
      }) as never;
    case "attempt_telemetry_inconsistent":
      return call(api, "attempts", "POST", "/v1/attempts", {
        client_attempt_id: "44444444-4444-4444-8444-444444444444",
        child_id: state.childId ?? 1,
        item_code: state.itemCode ?? "x",
        answer: "0",
        telemetry: { response_time_ms: 5000, active_time_ms: 4000, idle_time_ms: 2000 },
      }) as never;
    case "coach_hint":
      return call(api, "coachHints", "POST", "/v1/coach/hints", {
        item_code: state.itemCode,
        hints_used: 1,
      }) as never;
    case "coach_hint_item_missing":
      return call(api, "coachHints", "POST", "/v1/coach/hints", {
        item_code: "__no_such_item__",
      }) as never;
    case "detective_puzzle":
      return call(api, "detectivePuzzle", "GET", "/v1/detective/puzzle") as never;
    case "detective_answer":
      return call(api, "detectiveAnswer", "POST", "/v1/detective/answer", {
        puzzle_id: state.puzzleId,
        answer: "999999",
      }) as never;
    case "growth_build_insufficient":
      return call(api, "growthBuild", "POST", "/v1/growth/build", {
        building_code: "ticket_booth",
      }) as never;
    case "growth_build_missing":
      return call(api, "growthBuild", "POST", "/v1/growth/build", {
        building_code: "__nope__",
      }) as never;
    case "debug_learning_state":
      return call(api, "debug", "GET", "/v1/debug/learning-state") as never;
    case "unknown_path":
      return call(api, "catchAll", "GET", "/definitely/not/here") as never;
    case "method_not_allowed":
      return call(api, "world", "DELETE", "/v1/world") as never;
    default:
      throw new Error(`fixture 里有而 TS 重放器没实现的场景: ${name}`);
  }
}

/** 每个场景之后更新提取状态（与 Python Scenario 的提取点一致） */
function absorb(name: string, response: unknown): void {
  const body = response as Record<string, unknown>;
  if (name === "world") {
    const child = body["child"] as { id: number } | undefined;
    state.childId = child?.id ?? null;
    const universes = (body["universes"] ?? []) as Array<{ stories?: Array<{ code: string }> }>;
    for (const universe of universes) {
      if (universe.stories && universe.stories.length > 0) {
        state.storyCode = universe.stories[0]!.code;
        break;
      }
    }
  }
  if (name === "plans_today") {
    const segments = (body["segments"] ?? []) as Array<{ items?: Array<{ code: string }> }>;
    for (const segment of segments) {
      if (segment.items && segment.items.length > 0) {
        state.itemCode = segment.items[0]!.code;
        break;
      }
    }
  }
  if (name === "session_create") {
    state.sessionId = (body["session_id"] as number) ?? null;
  }
  if (name === "detective_puzzle") {
    state.puzzleId = (body["puzzle_id"] as string) ?? null;
  }
}

describe("api-contract 对拍（vs Python 基线 28 场景）", () => {
  let api: Api;

  beforeAll(async () => {
    await recreateDatabase();
    await initDatabase();
    api = {
      health: await import("../../app/api/health/route"),
      world: await import("../../app/api/v1/world/route"),
      story: await import("../../app/api/v1/stories/[story_code]/route"),
      lab: await import("../../app/api/v1/lab/route"),
      growth: await import("../../app/api/v1/growth/route"),
      growthBuild: await import("../../app/api/v1/growth/build/route"),
      parentReport: await import("../../app/api/v1/parent/report/route"),
      debug: await import("../../app/api/v1/debug/learning-state/route"),
      sessions: await import("../../app/api/v1/sessions/route"),
      sessionEnd: await import("../../app/api/v1/sessions/[session_id]/end/route"),
      plansToday: await import("../../app/api/v1/plans/today/route"),
      attempts: await import("../../app/api/v1/attempts/route"),
      coachHints: await import("../../app/api/v1/coach/hints/route"),
      detectivePuzzle: await import("../../app/api/v1/detective/puzzle/route"),
      detectiveAnswer: await import("../../app/api/v1/detective/answer/route"),
      catchAll: await import("../../app/api/[...path]/route"),
    };
  }, 120_000);

  // 注意：没有"场景清单一一对应"的独立用例 —— runScenario 会真正执行场景
  // （消耗 serial、写库），预演一遍会让重放循环拿到错位的 session_id。
  // fixture 里有而重放器没实现的场景会在下面的循环里直接抛错。

  for (const scenario of fixture.scenarios) {
    it(`场景 ${scenario.name}`, async () => {
      // 特例：health 的 handler 不走 handle() 包装，直接返回 200
      const actual =
        scenario.name === "health"
          ? { status: 200, response: { ok: true } }
          : await runScenario(api, scenario.name);
      absorb(scenario.name, actual.response);
      expect(actual.status).toBe(scenario.status);
      expect(normalize(actual.response)).toEqual(scenario.response);
    });
  }
});
