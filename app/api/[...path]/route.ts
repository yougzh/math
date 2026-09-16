import { notFoundResponse } from "@/src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * catch-all：任何未注册的 API 路径 → 契约 §12 的 404 形状
 * （对应 Starlette 的默认 404，detail = "Not Found"）。
 * 已注册路径的错误 method 由各 route.ts 显式导出的 405 处理。
 */
export async function GET() {
  return notFoundResponse();
}

export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
