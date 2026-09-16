/**
 * 运行期配置。S5 起后端就是同源 Next Route Handler（/api/v1/*），
 * 不再有外部 API_BASE 与 mock 分支。
 */

/** MVP 不做账号体系，缺省使用默认孩子（契约 §0；数据库里只有「小明」id=1） */
export const DEFAULT_CHILD_ID = 1;

/** 单次请求超时（毫秒） */
export const REQUEST_TIMEOUT_MS = 10_000;

/** 是否处于调试模式（?debug=1），由组件在运行时判断 */
export const DEBUG_QUERY_KEY = "debug";
