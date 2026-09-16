/**
 * schema 一致性：Drizzle schema 必须与 db/migrations/0001_init.sql 完全一致。
 *
 * 移植自 tests/test_db.py 的 test_schema_matches_migration /
 * test_migration_has_no_level_column_in_state_tables —— 解析逻辑逐行照搬，
 * 保证两边认定的"事实"是同一份。
 *
 * 为什么用解析 SQL 而不是读 information_schema：这份 SQL 是**部署事实**，
 * 测试不该依赖一个已经建好的库。解析文本让测试在任何环境都能跑。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import * as schema from "@/src/db/schema";

const MIGRATION_PATH = fileURLToPath(
  new URL("../../db/migrations/0001_init.sql", import.meta.url),
);

// ───────────────────────────────────────────────────────────
// SQL 解析（照搬 tests/test_db.py:133-195）
// ───────────────────────────────────────────────────────────

/** 去掉 `--` 之后的注释内容，避免注释里的括号/逗号干扰解析 */
function stripSqlComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split("--")[0] ?? "")
    .join("\n");
}

/** 按顶层逗号切分：括号内的逗号（如 NUMERIC(5,4)、CHECK(...) ）不算分隔符 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** 表级约束的首关键字：这些不是列名 */
const TABLE_CONSTRAINT_HEADS = new Set([
  "PRIMARY",
  "UNIQUE",
  "CHECK",
  "FOREIGN",
  "CONSTRAINT",
  "EXCLUDE",
]);

/** 解析 0001_init.sql 里的 CREATE TABLE，返回 { 表名: [列名] } */
export function parseMigration(sqlText: string): Record<string, string[]> {
  const text = stripSqlComments(sqlText);
  const tables: Record<string, string[]> = {};
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]+)\s*\(/gi;

  let cursor = 0;
  for (;;) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    if (match === null) break;

    const name = match[1];
    if (name === undefined) break;
    const start = match.index + match[0].length;

    // 从开括号之后向后扫，靠括号配平找到表体结束
    let depth = 1;
    let index = start;
    while (index < text.length && depth > 0) {
      const char = text[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      index += 1;
    }
    const body = text.slice(start, index - 1);
    cursor = index;

    const columns: string[] = [];
    for (const part of splitTopLevel(body)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const head = trimmed.split(/\s+/)[0];
      if (head === undefined || !head) continue;
      if (TABLE_CONSTRAINT_HEADS.has(head.toUpperCase())) continue;
      columns.push(head);
    }
    tables[name] = columns;
  }
  return tables;
}

// ───────────────────────────────────────────────────────────
// 测试
// ───────────────────────────────────────────────────────────

const sqlTables = parseMigration(readFileSync(MIGRATION_PATH, "utf-8"));

const drizzleTables: Record<string, string[]> = {};
for (const value of Object.values(schema)) {
  if (!is(value, PgTable)) continue;
  const columns = Object.values(getTableColumns(value)).map((column) => column.name);
  drizzleTables[getTableName(value)] = columns;
}

describe("schema 与 0001_init.sql 一致", () => {
  it("表名集合完全一致", () => {
    const sqlNames = new Set(Object.keys(sqlTables));
    const ormNames = new Set(Object.keys(drizzleTables));
    const missingInOrm = [...sqlNames].filter((n) => !ormNames.has(n)).sort();
    const extraInOrm = [...ormNames].filter((n) => !sqlNames.has(n)).sort();
    expect({ missingInOrm, extraInOrm }).toEqual({ missingInOrm: [], extraInOrm: [] });
  });

  it("每张表的列集合完全一致", () => {
    const problems: string[] = [];
    for (const name of Object.keys(sqlTables).sort()) {
      const sqlColumns = sqlTables[name];
      const ormColumns = drizzleTables[name];
      if (sqlColumns === undefined || ormColumns === undefined) continue;
      const sqlSet = new Set(sqlColumns);
      const ormSet = new Set(ormColumns);
      const missingInOrm = [...sqlSet].filter((c) => !ormSet.has(c)).sort();
      const extraInOrm = [...ormSet].filter((c) => !sqlSet.has(c)).sort();
      if (missingInOrm.length > 0) problems.push(`${name}: ORM 缺少列 ${missingInOrm.join(", ")}`);
      if (extraInOrm.length > 0) problems.push(`${name}: ORM 多了列 ${extraInOrm.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("解析到的表数量与 SQL 相符（防止解析器静默失配）", () => {
    expect(Object.keys(sqlTables)).toHaveLength(24);
  });
});

describe("ADR-0002 的 schema 侧证据", () => {
  it("状态表里不允许出现 level 列", () => {
    expect(sqlTables["proficiency_state"]).not.toContain("level");
    expect(sqlTables["pattern_state"]).not.toContain("level");
  });

  it("两条 schema 路径都没有把 level 落成列", () => {
    const drizzleStateTables = ["proficiency_state", "pattern_state"];
    for (const name of drizzleStateTables) {
      expect(drizzleTables[name]).not.toContain("level");
    }
    // 顺带确认没有别处偷偷加了 level——
    // 等级是 derive_level(signals, algorithm_version) 的结果，不落库。
    const allColumns = Object.values(drizzleTables).flat();
    expect(allColumns).not.toContain("level");
  });
});
