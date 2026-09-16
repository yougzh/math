/**
 * 运行期配置（全部来自 NEXT_PUBLIC_*，构建期内联）。
 */

/** 后端基址，默认本机 FastAPI */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000";

/**
 * NEXT_PUBLIC_USE_MOCK=1 时走 lib/mock 的本地数据。
 * 默认（不设该变量）走真实 HTTP。
 */
export const USE_MOCK =
  process.env.NEXT_PUBLIC_USE_MOCK === "1" || process.env.NEXT_PUBLIC_USE_MOCK === "true";

/** MVP 不做账号体系，缺省使用默认孩子（契约 §0） */
export const DEFAULT_CHILD_ID = Number(process.env.NEXT_PUBLIC_CHILD_ID ?? "1") || 1;

/** 单次请求超时（毫秒） */
export const REQUEST_TIMEOUT_MS = 10_000;

/** 是否处于调试模式（?debug=1），由组件在运行时判断 */
export const DEBUG_QUERY_KEY = "debug";
