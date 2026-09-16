export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 运维端点，与 backend/api/app.py 的 GET /health 一致（返回 {"ok": true}） */
export async function GET() {
  return Response.json({ ok: true });
}
