/**
 * 本地开发 PostgreSQL —— 免 root 的嵌入式方案。
 *
 * S4 起引擎的持久层要接真库（24 表 DDL 是 PostgreSQL 专属：JSONB /
 * NUMERIC / advisory lock / 事务原子写）。本机没有现成 PG、没有 Docker、
 * sudo 不可交互，所以用 `@embedded-postgres/linux-x64`（zonky 预编译
 * 二进制，initdb/pg_ctl/postgres 三个可执行文件）直接在 .pgdata/ 里
 * 起一个实例 —— 数据目录持久，重复使用，不污染系统。
 *
 * 为什么配置是 trust + 无密码：数据目录在项目里且只监听 127.0.0.1，
 * 本地开发库不值得引入密码管理；生产（Vercel + Neon）走环境变量。
 *
 * 用法（npm scripts 同名）：
 *   npx tsx scripts/db-local.ts init    # initdb + 启动 + 建库 + 24 表 DDL（幂等）
 *   npx tsx scripts/db-local.ts start   # 启动已有实例
 *   npx tsx scripts/db-local.ts stop    # 停止
 *   npx tsx scripts/db-local.ts reset   # 停止并删除数据目录，重新 init
 *   npx tsx scripts/db-local.ts status  # 连通性 + 表数
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(import.meta.dirname, "..");
// 数据目录必须在 WSL 原生文件系统（$HOME，ext4）：项目在 /mnt/d（DrvFS）上
// 没有 POSIX 权限位，initdb 强制 0700 会直接失败
const PGDATA = path.join(os.homedir(), ".math-pg", "pgdata");
const LOG = path.join(os.homedir(), ".math-pg", "pgdata.log");
const BIN = path.join(
  ROOT,
  "node_modules",
  "@embedded-postgres",
  "linux-x64",
  "native",
  "bin",
);
const PORT = 5432;
const DB = "db_math";
const USER = "postgres";
/** 本地连接串 —— S4 的 Route Handler / 集成测试都用它（进 .env 的 MATH_DB_URL） */
export const LOCAL_DB_URL = `postgresql://${USER}@127.0.0.1:${PORT}/${DB}`;
const DDL_PATH = path.join(ROOT, "db", "migrations", "0001_init.sql");

/** 超时=击杀（见 scripts/mutation-check.ts 的教训），一律 spawnSync + timeout */
function run(cmd: string, args: string[], timeoutMs = 60_000): number {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  if (r.error) {
    throw new Error(`${cmd} 启动失败：${r.error.message}`);
  }
  if (r.status !== 0) {
    const detail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
    throw new Error(`${cmd} ${args.join(" ")} 退出码 ${r.status}：\n${detail}`);
  }
  return r.status;
}

async function waitForReady(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const client = new pg.Client({ connectionString: `postgresql://${USER}@127.0.0.1:${PORT}/postgres` });
      await client.connect();
      await client.end();
      return;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`PG 在 ${timeoutMs}ms 内没有就绪：${lastError}`);
}

async function isRunning(): Promise<boolean> {
  try {
    await waitForReady(1_500);
    return true;
  } catch {
    return false;
  }
}

function start(): void {
  if (!existsSync(path.join(PGDATA, "PG_VERSION"))) {
    throw new Error(`数据目录 ${PGDATA} 不存在 —— 先跑 db:init`);
  }
  run(path.join(BIN, "pg_ctl"), [
    "-D",
    PGDATA,
    "-l",
    LOG,
    "-o",
    `-p ${PORT}`,
    "start",
  ]);
  console.log(`PG 已启动（127.0.0.1:${PORT}，日志 ${LOG}）`);
}

function stop(): void {
  if (!existsSync(path.join(PGDATA, "PG_VERSION"))) {
    console.log("数据目录不存在，无需停止");
    return;
  }
  // -m fast：回滚事务并断开连接（本地开发库没有需要保护的会话）
  const r = spawnSync(path.join(BIN, "pg_ctl"), ["-D", PGDATA, "-m", "fast", "stop"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  // 已经停着也会非 0 退出，不算错误
  console.log(r.status === 0 ? "PG 已停止" : "PG 未在运行（或停止时已退出）");
}

async function ensureDatabase(): Promise<"created" | "exists"> {
  const client = new pg.Client({ connectionString: `postgresql://${USER}@127.0.0.1:${PORT}/postgres` });
  await client.connect();
  try {
    const r = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB]);
    if (r.rowCount === 0) {
      await client.query(`CREATE DATABASE ${DB} ENCODING 'UTF8' TEMPLATE template0`);
      return "created";
    }
    return "exists";
  } finally {
    await client.end();
  }
}

async function applyDDL(): Promise<number> {
  // DDL 自带 BEGIN/COMMIT —— 整文件一次 simple query 发过去，要么全建要么全不建
  const ddl = readFileSync(DDL_PATH, "utf8");
  const client = new pg.Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    const r = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
    );
    if (r.rows[0]!.n > 0) {
      return -r.rows[0]!.n; // 已有表：跳过 DDL（用 reset 才能重建）
    }
    await client.query(ddl);
    const after = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
    );
    return after.rows[0]!.n;
  } finally {
    await client.end();
  }
}

async function status(): Promise<void> {
  if (!(await isRunning())) {
    console.log("PG 未运行");
    return;
  }
  const client = new pg.Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    const r = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
    );
    const v = await client.query("SHOW server_version");
    console.log(`PG 运行中：127.0.0.1:${PORT}/${DB}，server ${v.rows[0]!.server_version}，public 表 ${r.rows[0]!.n} 张`);
    console.log(`连接串：${LOCAL_DB_URL}`);
  } finally {
    await client.end();
  }
}

async function init(): Promise<void> {
  if (!existsSync(path.join(PGDATA, "PG_VERSION"))) {
    run(path.join(BIN, "initdb"), [
      "-D",
      PGDATA,
      "-U",
      USER,
      "-E",
      "UTF8",
      // locale=C：排序与 Neon（C.UTF-8）不同但对拍数据全 ASCII；不依赖系统 locale
      "--locale=C",
      "--auth-local=trust",
      "--auth-host=trust",
    ]);
    console.log(`数据目录已初始化：${PGDATA}`);
  }
  start();
  await waitForReady();
  const dbState = await ensureDatabase();
  console.log(dbState === "created" ? `已建库 ${DB}` : `库 ${DB} 已存在`);
  const tables = await applyDDL();
  if (tables < 0) {
    console.log(`库里已有 ${-tables} 张表 —— 跳过 DDL（要重建用 db:reset）`);
  } else {
    console.log(`DDL 应用完成：${tables} 张表`);
  }
  await status();
}

async function reset(): Promise<void> {
  stop();
  if (existsSync(PGDATA)) {
    rmSync(PGDATA, { recursive: true, force: true });
  }
  await init();
}

const cmd = process.argv[2] ?? "";
const handlers: Record<string, () => Promise<void> | void> = {
  init,
  start: () => {
    start();
  },
  stop,
  reset,
  status,
};

async function main(): Promise<void> {
  if (!(cmd in handlers)) {
    console.error(`未知命令：${cmd}（可用：${Object.keys(handlers).join(" / ")}）`);
    process.exitCode = 2;
    return;
  }
  await handlers[cmd]!();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
