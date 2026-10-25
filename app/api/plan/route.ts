import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createJob } from "@/lib/jobs";
import { consume, refund } from "@/lib/ratelimit";
import { readSession } from "@/lib/auth/session";
import { validateProfile, type TravelProfile } from "@/lib/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 起止时间（本地时间，精确到分钟）：决定行程天数
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// 天数推导：按起止「日历日」含头含尾（10月1日→10月3日 = 3 天；同日 = 1 天）
function deriveDays(startAt: string, endAt: string): number {
  const s = new Date(`${startAt.slice(0, 10)}T00:00:00Z`).getTime();
  const e = new Date(`${endAt.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((e - s) / 86400000) + 1;
}

const InputSchema = z
  .object({
    // 字符白名单：用户输入会拼进 LLM prompt，必须防注入（拒绝特殊字符/超长）
    city: z.string().regex(/^[\u4e00-\u9fa5A-Za-z·\s]{2,20}$/, "城市名格式不正确"),
    startAt: z.string().regex(DT_RE, "起始时间格式不正确"),
    endAt: z.string().regex(DT_RE, "结束时间格式不正确"),
    // 下限 0 而不是 500：穷游/Citywalk/免费景点为主是正当需求（预算 0 = 明确
    // 选择少花钱）。原来的 min(500) 会把「周末进城逛免费博物馆」直接拒掉。
    // 预算为 0 时 planner/validate/budget 都切换成「穷游模式」：优先免费低价、
    // 不判超支、不算使用率（见 lib/planner.ts 的 isFrugalBudget）。
    budget: z.coerce.number().int().min(0, "预算不能为负").max(200000),
    // 偏好标签同样进 prompt：白名单 + 数量上限
    preferences: z
      .array(z.string().regex(/^[\u4e00-\u9fa5A-Za-z]{1,10}$/))
      .max(5)
      .default([]),
    // 住所（选填）：允许数字/书名号/括号（"7天酒店(春熙路店)"）
    hotel: z.preprocess(
      (v) => (v === "" || v == null ? undefined : v),
      z
        .string()
        .trim()
        .max(40)
        .regex(/^[\u4e00-\u9fa5A-Za-z0-9·（）()\s]{2,40}$/)
        .optional(),
    ),
    // 期望必游地（选填）：最多 5 个，硬约束（validate 会核验是否全部出现）
    mustVisit: z.preprocess(
      (v) => (v === "" || v == null ? [] : v),
      z
        .array(
          z
            .string()
            .trim()
            .max(20)
            .regex(/^[\u4e00-\u9fa5A-Za-z0-9·（）()\s]{2,20}$/),
        )
        .max(5)
        .default([]),
    ),
    // 跨城/多城市（选填，有序）：深圳 2 天 + 香港 2 天这类「按天串段」的行程。
    // days 之和必须等于由起止时间推导的总天数（下面 refine 校验），否则前端
    // 天数分配和实际日期对不上。每座城市仍是 city 模式精确检索（citylimit 开着），
    // 与 region（松散环线、关 citylimit）是两种不同的东西。
    cities: z.preprocess(
      (v) => (v === "" || v == null ? undefined : v),
      z
        .array(
          z.object({
            city: z.string().regex(/^[\u4e00-\u9fa5A-Za-z·\s]{2,20}$/, "城市名格式不正确"),
            days: z.number().int().min(1).max(10),
          }),
        )
        .min(2, "跨城行程至少两座城市")
        .max(4, "跨城行程最多四座城市（更长的请拆成多段分别规划）")
        .optional(),
    ),
    // 行程节奏：轻松/适中/紧凑（影响 prompt 密度与体检阈值）
    pace: z.enum(["relaxed", "balanced", "packed"]).default("balanced"),
    // 规划范围：city=单城市（默认）/ region=区域环线（如川西环线、关西）。
    // 区域游天数更长，上限放宽到 10（单城市保持 7）。
    scope: z.enum(["city", "region"]).default("city"),
    // 交通方式：决定每天各景点间怎么走（串成可跟着走的路线链）。默认驾车。
    // 公交/地铁当前高德 key 未开放（实测 HTTP 400），故不提供。
    // auto = 智能组合：按两点距离逐段选步行(≤1.2km)/骑行(≤5km)/驾车。
    // 公交/地铁暂不提供——高德 integrated 接口在个人 key 上实测不可用
    // （errcode 10002 SERVICE_NOT_AVAILABLE），给了就是假选项。
    transportMode: z.enum(["walking", "bicycling", "driving", "auto"]).default("auto"),
    // 重点活动（选填，最多 3 个）：用户提供的演唱会/赛事/展览等，需编进行程。
    // 时间可选——给了就围绕它倒推动线，没给则由 AI 建议。名称会拼进 prompt，
    // 因此与 city/hotel 同等防注入（字符白名单 + 长度上限）。
    events: z.preprocess(
      (v) => (v === "" || v == null ? [] : v),
      z
        .array(
          z.object({
            name: z
              .string()
              .trim()
              .max(30)
              .regex(/^[\u4e00-\u9fa5A-Za-z0-9·（）()\s]{2,30}$/),
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            time: z
              .string()
              .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
              .optional(),
          }),
        )
        .max(3)
        .default([]),
    ),
    // 旅行档案（切片3 · 旅行档案）：客户端 localStorage 里的长期记忆
    // （体力/忌口/作息/通勤耐受/推断偏好）。**校验不在这里做**——档案
    // 的校验是字段级白名单（lib/profile.ts 的 validateProfile，与
    // city/hotel 同等的防注入口径），放进 zod 里 schema 会膨胀且错误
    // 文案不好给。下面 POST 里显式校验：传了但不过 → 400（配额退还）。
    // z.unknown() 保留原值不剥离（zod 默认剥未知字段，档案会被丢掉）。
    // 不传 = 原样不带：无档案时全链路行为与本字段加入前完全一致。
    profile: z.unknown().optional(),
  })
  .refine((d) => d.endAt > d.startAt, { message: "结束时间必须晚于开始时间" })
  .refine((d) => deriveDays(d.startAt, d.endAt) <= (d.scope === "region" ? 10 : 7), {
    message: "城市行程支持 1-7 天，区域行程支持 1-10 天；更长的请拆成多段分别规划",
  })
  .refine(
    (d) => {
      if (!d.cities?.length) return true;
      // 天数分配必须正好覆盖整个日期区间：少一天就有一天没有城市，多一天就排不下
      return d.cities.reduce((s, c) => s + c.days, 0) === deriveDays(d.startAt, d.endAt);
    },
    {
      message: "各城市天数之和必须等于行程总天数（按起止日期计算）",
      path: ["cities"],
    },
  );

// 配额双轨：登录用户按手机号计数（默认 10 次/天），陌生人按 IP（默认 3 次/天）
function quotaOf(req: NextRequest): { key: string; limit: number; isUser: boolean } {
  const session = readSession(req.headers.get("cookie"));
  if (session) {
    return {
      key: `u:${session.p}`,
      limit: Number(process.env.AUTH_USER_LIMIT || 10),
      isUser: true,
    };
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  return { key: `ip:${ip}`, limit: Number(process.env.DAILY_FREE_LIMIT || 3), isUser: false };
}

export async function POST(req: NextRequest) {
  // 1) 配额（提交即扣，失败归还）
  const q = quotaOf(req);
  const quota = await consume(q.key, q.limit);
  if (!quota.allowed) {
    const msg = q.isUser
      ? `今日免费次数已用完（登录用户每天 ${q.limit} 次）。明天再来。`
      : `今日免费次数已用完（未登录每天 ${q.limit} 次）。登录后可提升到 ${Number(process.env.AUTH_USER_LIMIT || 10)} 次/天。`;
    return NextResponse.json({ error: msg }, { status: 429 });
  }

  // 2) 参数校验
  let input: z.infer<typeof InputSchema>;
  try {
    input = InputSchema.parse(await req.json());
  } catch (e) {
    await refund(q.key);
    const msg = e instanceof z.ZodError ? e.issues[0]?.message : null;
    return NextResponse.json(
      { error: msg ?? "参数不完整：需要城市、起止时间、预算（元）" },
      { status: 400 },
    );
  }

  // 2b) 旅行档案校验（切片3）：档案字段（忌口/推断文案）会进 LLM prompt，
  //     必须过字符白名单（与 city/hotel 同口径）。校验失败走 400 而不是
  //     静默丢字段——「改了档案却没用上」无声发生是最伤信任的失败。
  //     null 与 undefined 一样视为「没传」：档案存储层（lib/profile-store）
  //     用 null 表达「用户没填过」，JSON.stringify 也会把 null 带进请求体
  //     ——对 null 报 400 的话，集成方（home-client）每次生成都会被拒，
  //     这是边界上不该让调用方自己防的坑。
  let profile: TravelProfile | undefined;
  if (input.profile !== undefined && input.profile !== null) {
    const checked = validateProfile(input.profile);
    if (!checked) {
      await refund(q.key);
      return NextResponse.json(
        {
          error:
            "旅行档案格式不正确（体力/忌口/作息/通勤上限/推断偏好之一不合法），请在「我的档案」里重新填写",
        },
        { status: 400 },
      );
    }
    profile = checked;
  }

  // 3) 创建异步任务（days 由起止时间推导），立即返回
  const job = await createJob(
    {
      ...input,
      days: deriveDays(input.startAt, input.endAt),
      // 档案显式覆盖 input 里的 zod unknown 原值：传下去的是校验+归一化
      // 后的档案；没传档案时这里是 undefined，等于本字段加入前完全一致。
      // createJob → generatePlan/validateDay 是 input 整体透传，无需下游改动。
      profile,
    },
    q.key,
    q.limit,
    () => void refund(q.key),
  );
  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
