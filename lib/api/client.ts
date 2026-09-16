import { REQUEST_TIMEOUT_MS } from "@/lib/config";
import { ApiError, parseErrorBody } from "./errors";

export type HttpMethod = "GET" | "POST";

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 拼查询串，值为 undefined / null 的键直接省略 */
export function withQuery(
  path: string,
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    search.set(k, String(v));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function realRequest<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  // 外部 signal 只是附加，不覆盖内部超时
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort);

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (e) {
    if (controller.signal.aborted && !opts.signal?.aborted) throw ApiError.timeout();
    throw ApiError.network(e instanceof Error ? e.message : "网络请求失败");
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!res.ok) throw ApiError.badBody(res.status);
      throw ApiError.badBody(res.status);
    }
  }

  if (!res.ok) {
    const parsed = parseErrorBody(payload);
    throw new ApiError(
      res.status,
      parsed?.error.code ?? `HTTP_${res.status}`,
      parsed?.error.message ?? "服务端返回错误",
    );
  }

  return payload as T;
}

/** 统一出口：真实 HTTP（同源 `/api/v1/...`，Next Route Handler）。 */
export const http = {
  get: <T>(path: string, opts?: RequestOptions) => realRequest<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    realRequest<T>("POST", path, body, opts),
};
