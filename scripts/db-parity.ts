/**
 * 数据库行级对拍 —— TS 导入（scripts/init-db.ts → db_math）vs
 * Python 导入（tools/init_db.py → db_math_py）。
 *
 * 这是 S4 数据层的对拍基准：同一份 dump、同一份 DDL，两侧各自的
 * 导入实现写库，逐表逐行逐列对比。任何字段映射、类型转换、JSON
 * 序列化的差异都会在这里现形。
 *
 * 用法：
 *   npx tsx scripts/db-parity.ts <ts库url> <py库url>
 *   默认 postgresql://postgres@127.0.0.1:5432/db_math vs db_math_py
 *
 * 注意 JSONB 的比较：PG 的 JSONB 存储会重排对象键序（长度 + 字典序），
 * 驱动解析回 JS 对象后是"键序 = 存储序"。两侧同一 PG 引擎同一列类型，
 * 存储序一致，所以 stringify 后可以直接比。
 */
import pg from "pg";

const urlA = process.argv[2] ?? "postgresql://postgres@127.0.0.1:5432/db_math";
const urlB = process.argv[3] ?? "postgresql://postgres@127.0.0.1:5432/db_math_py";

const clientA = new pg.Client({ connectionString: urlA });
const clientB = new pg.Client({ connectionString: urlB });

async function tables(client: pg.Client): Promise<string[]> {
  const r = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  );
  return r.rows.map((row) => row.table_name as string);
}

interface ColumnInfo {
  name: string;
  orderBy: string;
}

async function columns(client: pg.Client, table: string): Promise<ColumnInfo[]> {
  const r = await client.query(
    `SELECT c.column_name, c.ordinal_position,
            (SELECT count(*)::int FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage k
               ON tc.constraint_name = k.constraint_name AND tc.table_name = k.table_name
              AND tc.constraint_type='PRIMARY KEY'
             WHERE tc.table_name = $1 AND k.column_name = c.column_name) AS is_pk,
            (SELECT min(k.ordinal_position) FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage k
               ON tc.constraint_name = k.constraint_name AND tc.table_name = k.table_name
              AND tc.constraint_type='PRIMARY KEY'
             WHERE tc.table_name = $1 AND k.column_name = c.column_name) AS pk_pos
       FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name = $1
      ORDER BY c.ordinal_position`,
    [table],
  );
  const cols = r.rows.map((row) => ({
    name: row.column_name as string,
    pk: Number(row.is_pk) > 0,
    pkPos: row.pk_pos === null ? 999 : Number(row.pk_pos),
    pos: Number(row.ordinal_position),
  }));
  // 排序键：PK 列（按 PK 位置）在前，其余列按表内位置 —— 无 PK 表退化为全列
  const ordered = [...cols.filter((c) => c.pk).sort((a, b) => a.pkPos - b.pkPos), ...cols.filter((c) => !c.pk)];
  return ordered.map((c) => ({ name: c.name, orderBy: `ordinality` }));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

async function main(): Promise<void> {
await clientA.connect();
await clientB.connect();

const tablesA = await tables(clientA);
const tablesB = await tables(clientB);
if (JSON.stringify(tablesA) !== JSON.stringify(tablesB)) {
  console.error("表清单不一致！");
  console.error("A:", tablesA.join(","));
  console.error("B:", tablesB.join(","));
  process.exitCode = 1;
  return;
}

let totalRows = 0;
let diffTables = 0;
for (const table of tablesA) {
  const cols = await columns(clientA, table);
  const colList = cols.map((c) => `"${c.name}"`).join(", ");
  const qA = await clientA.query(`SELECT ${colList} FROM "${table}"`);
  const qB = await clientB.query(`SELECT ${colList} FROM "${table}"`);
  const rowsA = qA.rows.map((row) => cols.map((c) => stableStringify(row[c.name])).join("\u0001"));
  const rowsB = qB.rows.map((row) => cols.map((c) => stableStringify(row[c.name])).join("\u0001"));
  totalRows += rowsA.length;
  if (rowsA.length !== rowsB.length) {
    console.error(`✗ ${table}: 行数 ${rowsA.length} vs ${rowsB.length}`);
    diffTables += 1;
    continue;
  }
  // 行集比较（顺序无关）：先按字符串排序再逐一比
  const sortedA = [...rowsA].sort();
  const sortedB = [...rowsB].sort();
  const diffs: string[] = [];
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) {
      diffs.push(`  行 ${i}:\n    A: ${sortedA[i]?.slice(0, 300)}\n    B: ${sortedB[i]?.slice(0, 300)}`);
      if (diffs.length >= 3) break;
    }
  }
  if (diffs.length > 0) {
    console.error(`✗ ${table}: ${diffs.length}+ 行内容不同`);
    for (const d of diffs) console.error(d);
    diffTables += 1;
  } else {
    console.log(`✓ ${table}: ${rowsA.length} 行一致`);
  }
}

await clientA.end();
await clientB.end();
console.log(`\n结果：${tablesA.length - diffTables}/${tablesA.length} 表一致，共 ${totalRows} 行`);
process.exitCode = diffTables === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
