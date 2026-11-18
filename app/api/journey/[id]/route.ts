import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readSession } from "@/lib/auth/session";
import { readJsonBody } from "@/lib/server/http-body";
import { crossSiteWriteError } from "@/lib/server/http-origin";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CommandSchema = z.strictObject({
  stopId: z.uuid(),
  commandId: z.uuid(),
  action: z.enum(["arrived", "skipped"]),
  planRevision: z.number().int().positive(),
});
type Context = { params: Promise<{ id: string }> };

function reply(body: object, status = 200) {
  // 该接口独立于 /t HTML，私人记录不会进入当前行中页的离线缓存。
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(req: NextRequest, { params }: Context) {
  const session = readSession(req.headers.get("cookie"));
  if (!session) return reply({ error: "请登录后查看旅行记录" }, 401);
  const { id } = await params;
  const journey = await getStore().journey.read(id, `u:${session.p}`);
  return journey ? reply(journey) : reply({ error: "未找到可访问的旅行记录" }, 404);
}

export async function POST(req: NextRequest, { params }: Context) {
  const crossSite = crossSiteWriteError(req);
  if (crossSite) return reply({ error: crossSite }, 403);
  const session = readSession(req.headers.get("cookie"));
  if (!session) return reply({ error: "请登录后记录旅行进展" }, 401);
  const body = await readJsonBody(req, 1024);
  if (!body.ok) return reply({ error: body.error }, body.status);
  const parsed = CommandSchema.safeParse(body.json);
  if (!parsed.success) return reply({ error: "旅行记录参数不合法" }, 400);

  const { id } = await params;
  const result = await getStore().journey.mark(id, `u:${session.p}`, parsed.data);
  if ("mark" in result) return reply({ mark: result.mark }, result.state === "saved" ? 201 : 200);
  if (result.state === "missing") return reply({ error: "未找到可访问的旅行记录" }, 404);
  if (result.state === "limit") return reply({ error: "这趟旅行的记录已达上限" }, 429);
  return reply({ error: "行程或站点状态已改变，请刷新后重试" }, 409);
}
