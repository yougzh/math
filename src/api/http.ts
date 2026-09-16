/**
 * Route Handler 的公共件 —— 对应 `backend/api/app.py` 的异常处理半边。
 *
 * 统一错误形状（契约 §12）：
 *     { "error": { "code": "ITEM_NOT_FOUND", "message": "..." } }
 *
 * 与 Python 的对应关系：
 *   - `handle()` 的 try/catch   ⇔ app.py 的 ApiError / Exception 两个 handler
 *   - `validationError()`       ⇔ app.py 的 RequestValidationError handler
 *                                 （"请求参数不合法: {loc}: {msg}"，只报第一个错）
 *   - `methodNotAllowed()`      ⇔ Starlette 405（每个 route 显式导出未用 method）
 *   - `notFoundResponse()`      ⇔ Starlette 404（catch-all 路由）
 */
import { ApiError, badRequest } from "@/src/service/errors";

export async function handle(fn: () => Promise<Record<string, unknown>>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (err) {
    if (err instanceof ApiError) {
      return Response.json(err.toDict(), { status: err.status_code });
    }
    console.error("未处理异常", err);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "服务端错误，请稍后重试" } },
      { status: 500 },
    );
  }
}

/** pydantic v2 校验失败的等价物：只报第一个错（Python `exc.errors()[0]`） */
export function validationError(location: string, msg: string): ApiError {
  return badRequest(`请求参数不合法: ${location}: ${msg}`);
}

export function methodNotAllowed(): Response {
  return Response.json(
    { error: { code: "METHOD_NOT_ALLOWED", message: "Method Not Allowed" } },
    { status: 405 },
  );
}

export function notFoundResponse(): Response {
  return Response.json(
    { error: { code: "NOT_FOUND", message: "Not Found" } },
    { status: 404 },
  );
}

/** 解析请求体 JSON；空/非法 body 报 pydantic 同款形状 */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (text.trim() === "") {
      throw validationError("body", "Input should be a valid dictionary or object to extract fields from");
    }
    return JSON.parse(text) as unknown;
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    throw validationError("body", "Input should be a valid dictionary or object to extract fields from");
  }
}

/** query/path 的整型参数：缺失返回 null，非法按 pydantic v2 的 msg 报 400 */
export function intParam(value: string | null, location: string): number | null {
  if (value === null) {
    return null;
  }
  const text = value.trim();
  if (!/^[+-]?\d+$/.test(text)) {
    throw validationError(location, "Input should be a valid integer, unable to parse string as an integer");
  }
  return Number.parseInt(text, 10);
}

/** pydantic v2 的 ge/le 约束（int 参数） */
export function ensureRange(
  value: number,
  location: string,
  opts: { ge?: number; le?: number },
): number {
  if (opts.ge !== undefined && value < opts.ge) {
    throw validationError(location, `Input should be greater than or equal to ${opts.ge}`);
  }
  if (opts.le !== undefined && value > opts.le) {
    throw validationError(location, `Input should be less than or equal to ${opts.le}`);
  }
  return value;
}
