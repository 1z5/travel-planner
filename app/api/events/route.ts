import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/http-body";
import { crossSiteWriteError } from "@/lib/http-origin";
import { getStore } from "@/lib/store";
import { consume, hourKey } from "@/lib/ratelimit";
import { EVENT_NAMES, newEventId } from "@/lib/metrics";
import { clientIpFromHeaders } from "@/lib/client-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/events —— 产品事件埋点（度量闭环的写入端）。
//
// 隐私口径（与 lib/metrics.ts 一致）：只收 shareId（用户本就持有的 token）、
// 城市、第几天、少量布尔/枚举 meta。**不收手机号、不收 IP 进事件表、不收行程内容**。
// IP 只用于限流（hourKey），不落库。
//
// meta 限额（安全审计 R14）：这是个公开可写的表，之前 meta 是任意 JSON——
// 可以塞嵌套大对象/超长字符串污染看板、放大存储。现在只允许**原始值**
// （string ≤40 / number / boolean）且序列化后 ≤1 KiB；看板口径不变。
//
// 失败不阻塞：埋点写入失败也返回 204——看板少一条可以，把用户操作拖坏不行。
// ============================================================

const BodySchema = z.object({
  name: z.enum(EVENT_NAMES, { message: "未知的事件名" }),
  shareId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{6,40}$/, "行程链接格式不正确")
    .optional(),
  city: z.string().max(40).optional(),
  day: z.number().int().min(1).max(30).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** meta 限额：原始值 + 字符串长度 + 序列化体积（见文件头 R14 说明） */
const META_MAX_BYTES = 1024;
const META_STRING_MAX = 40;

function validateMeta(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string") {
      if (value.length > META_STRING_MAX) {
        return `meta.${key} 字符串太长（上限 ${META_STRING_MAX} 字）`;
      }
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return `meta.${key} 必须是有限数字`;
    } else if (typeof value !== "boolean") {
      return `meta.${key} 只允许字符串/数字/布尔值`;
    }
  }
  if (Buffer.byteLength(JSON.stringify(meta), "utf8") > META_MAX_BYTES) {
    return `meta 过大（序列化后上限 ${META_MAX_BYTES} 字节）`;
  }
  return null;
}

/** 埋点限流：每 IP 每小时 300 条（正常浏览远到不了；防刷） */
function eventHourlyLimit(): number {
  return Number(process.env.EVENT_HOURLY_LIMIT || 300);
}

// IP 由 lib/client-ip 统一提取（不再取 XFF 首值：客户端可伪造，见审计 P0-3）。
// 埋点限流本来就只是防刷，伪造 IP 影响有限；但口径必须与其它端点一致，
// 否则「换头即新用户」在埋点侧同样成立。
function clientIp(req: NextRequest): string {
  return clientIpFromHeaders(req.headers);
}

export async function POST(req: NextRequest) {
  // 0) 浏览器跨站写保护：埋点虽是低价值写，但同样不该被第三方页面代刷
  const crossSite = crossSiteWriteError(req);
  if (crossSite) {
    return NextResponse.json({ error: crossSite }, { status: 403 });
  }

  // 1) body 上限 16 KiB（安全审计 R1；埋点 body 正常 <1 KiB）
  const body = await readJsonBody(req, 16 * 1024);
  if (!body.ok) {
    return NextResponse.json(
      { error: body.status === 413 ? body.error : "请求格式不正确，需要 JSON body" },
      { status: body.status },
    );
  }
  const parsed = BodySchema.safeParse(body.json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不正确" },
      { status: 400 },
    );
  }
  const metaError = validateMeta(parsed.data.meta);
  if (metaError) {
    return NextResponse.json({ error: metaError }, { status: 400 });
  }

  const limit = eventHourlyLimit();
  const winKey = hourKey("events", clientIp(req));
  const quota = await consume(winKey, limit);
  if (!quota.allowed) {
    return NextResponse.json({ error: "上报太频繁，本次已忽略" }, { status: 429 });
  }

  const d = parsed.data;
  try {
    await getStore().events.record({
      id: newEventId(),
      name: d.name,
      shareId: d.shareId,
      city: d.city,
      day: d.day,
      meta: d.meta,
      createdAt: Date.now(),
    });
  } catch {
    /* 埋点失败不阻塞用户操作 */
  }
  return new NextResponse(null, { status: 204 });
}
