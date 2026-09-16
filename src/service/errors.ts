/**
 * API 错误 —— `backend/service/errors.py` 的移植。
 *
 * 统一错误形状（契约 §12）：
 *
 *     { "error": { "code": "ITEM_NOT_FOUND", "message": "mt_blk_8_5 不存在" } }
 *
 * 状态码约定：400 参数错误 / 404 资源不存在 / 409 冲突 / 500 服务端错误。
 * 4xx 一律不可重试（除 429），5xx 与网络错误可重试。
 * 文案逐字保留 —— tests/contract/api.test.ts 会按字面断言。
 */
export class ApiError extends Error {
  readonly status_code: number;
  readonly code: string;

  constructor(status_code: number, code: string, message: string) {
    super(message);
    this.status_code = status_code;
    this.code = code;
  }

  toDict(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export function badRequest(message: string, code = "INVALID_PARAM"): ApiError {
  return new ApiError(400, code, message);
}

export function notFound(code: string, message: string): ApiError {
  return new ApiError(404, code, message);
}

export function conflict(message: string, code = "CONFLICT"): ApiError {
  return new ApiError(409, code, message);
}

export function childMissing(childId: number | "default"): ApiError {
  return notFound("CHILD_NOT_FOUND", `孩子 ${childId} 不存在`);
}

export function itemMissing(itemCode: string): ApiError {
  return notFound("ITEM_NOT_FOUND", `${itemCode} 不存在`);
}

export function sessionMissing(sessionId: number): ApiError {
  return notFound("SESSION_NOT_FOUND", `会话 ${sessionId} 不存在`);
}

export function storyMissing(storyCode: string): ApiError {
  return notFound("STORY_NOT_FOUND", `故事 ${storyCode} 不存在`);
}

export function buildingMissing(buildingCode: string): ApiError {
  return notFound("BUILDING_NOT_FOUND", `建筑 ${buildingCode} 不存在`);
}

/** 409 冲突：当前无调用点（Python 侧同），保留常量不接线（契约 §12） */
export const CONFLICT_UNUSED = true;
