/**
 * 请求依赖 —— `backend/api/deps.py` 的移植。
 *
 * 所有依赖都从全局单例取（Python 侧挂在 request.app.state 上，测试可以
 * 注入临时数据库与假内容；TS 侧由 db/client 的 globalThis 单例对应）。
 *
 * child_id 缺省时用默认孩子（MVP 不做账号体系，契约 §0）：
 * id 最小的那个孩子就是"当前孩子"。
 */
import { asc, eq } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import { child } from "@/src/db/schema";
import { childMissing } from "@/src/service/errors";
import { loadConfig } from "@/src/engine/config";
import type { AlgorithmConfig } from "@/src/engine/config";
import { CompetencyGraph } from "@/src/engine/graph";
import type { ContentBundle } from "@/src/content/types";
import { loadBundle } from "@/src/content/loader";
import { bundle as contentBundle } from "@/src/service/content";
import { defaultService, type CoachService } from "@/src/coach/service";

export interface ChildRow {
  id: number;
  name: string;
  /** child 表的其余列（created_at 等）——调用方按需读 */
  [key: string]: unknown;
}

export async function loadChild(childId: number | null | undefined): Promise<ChildRow> {
  const db = getDb();
  if (childId === null || childId === undefined) {
    const rows = await db.select().from(child).orderBy(asc(child.id)).limit(1);
    const first = rows[0];
    if (first === undefined) {
      throw childMissing("default");
    }
    return first as ChildRow;
  }
  const rows = await db.select().from(child).where(eq(child.id, childId));
  const found = rows[0];
  if (found === undefined) {
    throw childMissing(childId);
  }
  return found as ChildRow;
}

/** 内容入口：数据库优先，表为空时回退内存内容（见 service.content） */
export function resolveBundle(): Promise<ContentBundle> {
  return contentBundle();
}

export function getCfg(): AlgorithmConfig {
  return loadConfig();
}

/**
 * 对应 Python `app.state.graph = CompetencyGraph(bundle or load_bundle())`：
 * create_app 不注入 bundle 时，graph 从**内存内容**构建（YAML 文件的
 * prerequisites 顺序就是边的顺序）；内容载荷才走 DB。TS 侧同构 ——
 * graph 不能用 DB bundle，否则 prerequisites 的文件顺序会被
 * (competency_code, prerequisite_code) 的 DB 排序抹掉（api 对拍抓到过）。
 */
declare global {
  // Next dev 热重载防泄漏
  // eslint-disable-next-line no-var
  var __mathGraph: CompetencyGraph | undefined;
}

export function getGraph(): CompetencyGraph {
  if (globalThis.__mathGraph === undefined) {
    globalThis.__mathGraph = new CompetencyGraph(loadBundle());
  }
  return globalThis.__mathGraph;
}

declare global {
  // Next dev 热重载防泄漏：CoachService 无状态副作用，缓存一份即可
  // eslint-disable-next-line no-var
  var __mathCoach: CoachService | undefined;
}

export function getCoach(bundle: ContentBundle): CoachService {
  if (globalThis.__mathCoach === undefined) {
    globalThis.__mathCoach = defaultService(bundle, getGraph());
  }
  return globalThis.__mathCoach;
}
