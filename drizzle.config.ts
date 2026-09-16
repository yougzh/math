import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit 配置。
 *
 * 迁移的权威基线是 `db/migrations/0001_init.sql`——那份 SQL 是部署事实，
 * `tests/contract/schema-parity.test.ts` 会拿它和 src/db/schema.ts 双向比对。
 * 因此：
 *   - 0001 不放进 drizzle-kit 的 journal，不由它生成或改写；
 *   - 新库初始化时先原样应用 0001（见 Makefile 的 db-migrate）；
 *   - 之后的结构变更用 `drizzle-kit generate` 增量产出到 out 目录。
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
