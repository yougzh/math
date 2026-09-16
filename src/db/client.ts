/**
 * 数据库连接 —— 全站唯一的 Pool / Drizzle 实例。
 *
 * ⚠️ 驱动纪律（计划 §五 S4 的 serverless 硬伤 #3）：
 *   - 本地开发与集成测试用 `pg`（TCP）；生产 Vercel + Neon 用
 *     `@neondatabase/serverless` 的 **Pool（WebSocket）** —— 它支持事务。
 *   - **禁止 neon-http 驱动**：它不支持事务，17 步提交流程会在本地通过、
 *     线上静默失败。这里的 connect() 只接受 pg.PoolClient，neon-http
 *     没有 PoolClient 类型，TypeScript 层就把它挡在外面。
 *   - NUMERIC 列必须用 parseFloat parser：Python 侧是
 *     `Numeric(5, 4, asdecimal=False)`（models.py:41），返回 float；
 *     pg 默认把 NUMERIC 解析成 string，不换 parser 的话两侧对拍会挂。
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema";

/** NUMERIC → float（全局生效，pg.types 是模块级的） */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, parseFloat);

function dbUrl(): string {
  if (process.env.MATH_DB_URL) {
    return process.env.MATH_DB_URL;
  }
  // 本地开发缺省（scripts/db-local.ts 起的嵌入式实例）
  return "postgresql://postgres@127.0.0.1:5432/db_math";
}

declare global {
  // Next dev 热重载会反复执行模块 —— 单例挂在 globalThis 上避免连接泄漏
  // eslint-disable-next-line no-var
  var __mathPgPool: pg.Pool | undefined;
}

export function getPool(): pg.Pool {
  if (!globalThis.__mathPgPool) {
    globalThis.__mathPgPool = new pg.Pool({
      connectionString: dbUrl(),
      max: 10,
      // serverless 环境下空闲连接要及时收（Neon 会断空闲连接）
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalThis.__mathPgPool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export type Db = ReturnType<typeof getDb>;

/** 事务回调里拿到的 tx 类型（drizzle node-postgres） */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 「连接或事务」—— service 层函数的 session 参数对应物。
 *
 * Python 侧所有 payload 函数第一个参数都是 SQLAlchemy session，事务边界
 * 由路由层控制（routes_world.py: `build_payload(session, ...)` 后 `session.commit()`）。
 * TS 侧对应：只读函数传全局 Db，写函数（build/submitAttempt）传路由层开好的 tx。
 */
export type DbExecutor = Db | DbTx;
