import type { ApiErrorBody } from "./types";

/**
 * 契约 §12：所有非 2xx 都是 `{ "error": { "code", "message" } }`。
 *
 * 可重试：5xx、网络错误、（以及 429）。
 * 不可重试：其余 4xx。
 * 这条判定决定了断网暂存队列的重放策略，必须与契约一致。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** true 表示这条请求值得稍后重放 */
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = status >= 500 || status === 429 || status === 0;
  }

  /** 网络层失败（压根没拿到响应） */
  static network(message: string): ApiError {
    return new ApiError(0, "NETWORK_ERROR", message);
  }

  static timeout(): ApiError {
    return new ApiError(0, "TIMEOUT", "请求超时，请检查后端是否已启动");
  }

  static badBody(status: number): ApiError {
    return new ApiError(status, "BAD_RESPONSE", "服务端返回了无法解析的内容");
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function parseErrorBody(raw: unknown): ApiErrorBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const maybe = (raw as { error?: unknown }).error;
  if (typeof maybe !== "object" || maybe === null) return null;
  const { code, message } = maybe as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || typeof message !== "string") return null;
  return { error: { code, message } };
}

/** 给家长/开发者看的可读错误文案 */
export function describeError(e: unknown): string {
  if (isApiError(e)) {
    if (e.code === "NETWORK_ERROR") return "连不上服务器，先看看后端有没有启动？";
    if (e.code === "TIMEOUT") return "服务器反应有点慢，稍后再试一次。";
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return "出了点小问题";
}
