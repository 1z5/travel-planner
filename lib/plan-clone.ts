import "server-only";
import { z } from "zod";
import type { PlanInput } from "./types";
import type { PlanRecord } from "./store/types";

// ============================================================
// 一键克隆：把「别人的行程」翻译成「我的生成输入」。
//
// 这是病毒飞轮的引擎——分享页上看到一份行程，一键带出按自己日期重排的版本。
//
// 核心红线（与竞品拉开差距的地方）：克隆**不是**「复制 JSON 改日期」。
// 行程里闭馆日、营业时间、通勤耗时全是**按旧日期核验过**的结论，换日期后
// 照样会把周一闭馆的博物馆排在周一。所以本模块只推导**输入**（PlanInput），
// 真正的行程仍然走 createJob 的完整生成管线——事实层（grounding）会对
// **新日期**重新检索 POI、重新判定闭馆与通勤。这是「诚实」的产品级表达：
// 换个日期就是一次新的生成，不是一份改名换姓的复印件。
//
// 继承口径：city/preferences/hotel/mustVisit/events/scope/transportMode
// 原样继承（别人这份行程之所以成立，靠的就是这些约束）；只有
// startAt/endAt/budget/pace 可覆盖——恰好是「我的时间、我的钱、我的体力」
// 这三件私事。刻意不做任何「改编自 XXX」的溯源字段（v1 不假装来源）。
// ============================================================

// 起止时间（本地时间，精确到分钟）：决定行程天数
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// 天数推导：按起止「日历日」含头含尾（10月1日→10月3日 = 3 天；同日 = 1 天）
function deriveDays(startAt: string, endAt: string): number {
  const s = new Date(`${startAt.slice(0, 10)}T00:00:00Z`).getTime();
  const e = new Date(`${endAt.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((e - s) / 86400000) + 1;
}

/** 覆盖项：只允许改「我的时间 / 我的钱 / 我的节奏」，其余一律继承 */
export interface CloneOverrides {
  startAt?: string;
  endAt?: string;
  budget?: number;
  pace?: "relaxed" | "balanced" | "packed";
}

/**
 * 覆盖项的请求体形状（宽松版：路由层先挡明显畸形）。
 * budget 用 coerce：表单可能以字符串提交，与 /api/plan 的输入口径一致。
 * 最终仍以全量 InputSchema 校验为准（deriveCloneInput 里做）。
 */
export const CloneOverridesSchema = z
  .object({
    startAt: z.string().regex(DT_RE, "起始时间格式不正确").optional(),
    endAt: z.string().regex(DT_RE, "结束时间格式不正确").optional(),
    budget: z.coerce.number().int().min(500).max(200000).optional(),
    pace: z.enum(["relaxed", "balanced", "packed"]).optional(),
  })
  .strict();

// ============================================================
// 全量输入校验（口径与 app/api/plan/route.ts 的 InputSchema 完全一致）。
//
// 为什么复制而不是 import：那份 schema 定义在 Next 路由模块里（还带着
// runtime/dynamic 导出），lib 层不该反向依赖 app 层；而克隆合并后的字段
// （含继承来的 events/mustVisit/hotel）最终都会拼进 LLM prompt，字符
// 白名单校验**不能省**——漏一处就是一个 prompt 注入面。改动时必须与
// app/api/plan/route.ts 同步。
// ============================================================
const InputSchema = z
  .object({
    // 字符白名单：用户输入会拼进 LLM prompt，必须防注入（拒绝特殊字符/超长）
    city: z.string().regex(/^[\u4e00-\u9fa5A-Za-z·\s]{2,20}$/, "城市名格式不正确"),
    startAt: z.string().regex(DT_RE, "起始时间格式不正确"),
    endAt: z.string().regex(DT_RE, "结束时间格式不正确"),
    budget: z.coerce.number().int().min(500).max(200000),
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
    // 行程节奏：轻松/适中/紧凑（影响 prompt 密度与体检阈值）
    pace: z.enum(["relaxed", "balanced", "packed"]).default("balanced"),
    // 规划范围：city=单城市（默认）/ region=区域环线（如川西环线、关西）。
    // 区域游天数更长，上限放宽到 10（单城市保持 7）。
    scope: z.enum(["city", "region"]).default("city"),
    // 交通方式：决定每天各景点间怎么走（串成可跟着走的路线链）。默认驾车。
    transportMode: z.enum(["walking", "bicycling", "driving"]).default("driving"),
    // 重点活动（选填，最多 3 个）：用户提供的演唱会/赛事/展览等，需编进行程。
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
  })
  .refine((d) => d.endAt > d.startAt, { message: "结束时间必须晚于开始时间" })
  .refine((d) => deriveDays(d.startAt, d.endAt) <= (d.scope === "region" ? 10 : 7), {
    message: "城市行程支持 1-7 天，区域行程支持 1-10 天；更长的请拆成多段分别规划",
  });

export type CloneDeriveResult = { ok: true; input: PlanInput } | { ok: false; error: string };

/**
 * 起止日期的兜底来源：原始 input 可能缺日期（老数据），退回 plan 的展示日期。
 * 为什么值得兜底：缺日期的老记录仍有一份可看的行程，克隆它（默认时间）
 * 比直接拒绝更有用；补的时刻与首页表单默认一致（10:00 出发 / 18:00 结束）。
 */
function baseDatesOf(record: PlanRecord): { startAt: string; endAt: string } | null {
  const { startAt, endAt } = record.input;
  if (startAt && endAt) return { startAt, endAt };
  const s = record.plan.startDate;
  const e = record.plan.endDate ?? s;
  if (s) return { startAt: `${s}T10:00`, endAt: `${e}T18:00` };
  return null;
}

/** 日期平移（"YYYY-MM-DD"；UTC 口径计算，不受本机时区/夏令时影响） */
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * 推导克隆的生成输入：继承原输入 + 应用覆盖 + 全量校验。
 *
 * 返回结果而不是抛异常：失败在这里是**正常业务分支**（旧链接/脏数据/非法
 * 覆盖），路由要把它映射成具体状态码，用 try/catch 处理可预期结果反而容易
 * 把「链接不存在」误报成 500（与 adjust 路由同样的取舍）。
 *
 * record 为 null 时返回错误结果：调用方（路由）通常已先查过，但本函数不
 * 假设调用顺序——旧 job 链接与不存在的链接都必须被明确拒绝，不能假装能克隆。
 */
export function deriveCloneInput(
  record: PlanRecord | null,
  overrides?: CloneOverrides,
): CloneDeriveResult {
  if (!record) {
    return { ok: false, error: "行程不存在或已被删除，无法克隆" };
  }

  const base = baseDatesOf(record);
  if (!base) {
    // 老记录连展示日期都没有：没有任何日期基准，编一个出来就是猜
    return {
      ok: false,
      error: "原行程缺少日期信息，无法按新日期重排；请到首页重新规划",
    };
  }
  // 兜底基准的格式必须可识别（脏历史记录可能带坏日期）。后续所有日期算术
  // （平移/推导天数）都以「格式合法」为前提，先校验再计算——否则脏输入
  // 会在 Date.parse 上变成 NaN 并抛 RangeError（踩过：非法格式的覆盖值
  // 直接把接口打成 500，而不是用户该看到的 400）。
  if (!DT_RE.test(base.startAt) || !DT_RE.test(base.endAt)) {
    return {
      ok: false,
      error: "原行程的日期信息无法识别，暂时不支持克隆；请到首页重新规划",
    };
  }

  // 覆盖值先做格式校验：表单里最常见的两种错误（乱填/粘贴）在这里就能
  // 拿到明确文案，不用等全量校验把第一条 issue 兜出来。
  if (overrides?.startAt !== undefined && !DT_RE.test(overrides.startAt)) {
    return { ok: false, error: "起始时间格式不正确" };
  }
  if (overrides?.endAt !== undefined && !DT_RE.test(overrides.endAt)) {
    return { ok: false, error: "结束时间格式不正确" };
  }

  // 单边覆盖的处理（表单默认两个都带，这是 API 鲁棒性分支）：
  // - 只给出发时间 → 结束时间同步平移，**天数不变**（用户想改的是「哪天
  //   出发」，不是「去几天」）
  // - 只给结束时间 → 保持出发时间，天数自然变化（改的是「去哪天回来」）
  let startAt = overrides?.startAt ?? base.startAt;
  let endAt = overrides?.endAt ?? base.endAt;
  if (overrides?.startAt && !overrides?.endAt) {
    const delta = deriveDays(base.startAt, overrides.startAt) - 1;
    endAt = `${shiftDate(base.endAt.slice(0, 10), delta)}${base.endAt.slice(10)}`;
  }

  // 重点活动的日期随行程档期整体平移：活动是「围绕着行程某一天」编进去的，
  // 档期平移后日期不动反而会让模型围着一个不在本次旅行里的日期排动线。
  // 平移后落在新档期之外（原主人把活动排在行程前后）→ 保留活动本身、
  // 丢掉过期日期，由 AI 在新档期内自由安排。
  const delta = deriveDays(base.startAt, startAt) - 1;
  const newStartDate = startAt.slice(0, 10);
  const newEndDate = endAt.slice(0, 10);
  const events = (record.input.events ?? []).map((ev) => {
    if (!ev.date) return ev;
    const shifted = shiftDate(ev.date, delta);
    if (shifted < newStartDate || shifted > newEndDate) {
      const kept: { name: string; time?: string } = { name: ev.name };
      if (ev.time) kept.time = ev.time;
      return kept;
    }
    return { ...ev, date: shifted };
  });

  // 合并：继承项（...record.input）+ 可覆盖项。zod 会剥掉 input 里的 days
  // 等非 schema 字段，避免脏字段直接流进下游。
  const parsed = InputSchema.safeParse({
    ...record.input,
    startAt,
    endAt,
    budget: overrides?.budget ?? record.input.budget,
    pace: overrides?.pace ?? record.input.pace,
    events,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "克隆参数不合法" };
  }

  // days 由新起止时间重新推导（克隆的核心：天数跟着新日期走，不抄旧的）
  return {
    ok: true,
    input: { ...parsed.data, days: deriveDays(startAt, endAt) },
  };
}
