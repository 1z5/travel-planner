import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getPlanForEdit, resolvePlan } from "@/lib/plan-repo";
import { matchSpotName, replanSolve } from "@/lib/replan";
import { parseTimeRange } from "@/lib/schedule";
import { consume, hourKey, refund } from "@/lib/ratelimit";
import { clientIpFromHeaders } from "@/lib/client-ip";
import type { HoursPoiInput } from "@/lib/poi-hours";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/plan/replan —— 行中重规划求解器（确定性、毫秒级、不调模型）
//
// 场景：出行当天打开 /t/<token>，点「重新安排接下来」。客户端把「今天第
// 几天、现在几点（按用户手机本地时钟）」传上来，服务端读行程、取出当天
// 还没走的点 + 真实路段 + 营业时间 + 固定活动，交给 lib/replan.ts 求解。
//
// 与 /api/plan/adjust 的契约对齐（也是本路由刻意不偏离的地方）：
// - 毫秒级：纯计算，不打任何上游（高德数据在生成/体检时已落进行程）；
// - 不调模型：约束满足问题，模型又慢又会编，理由必须来自真实约束数据；
// - 不扣生成配额：只按 IP 做小时桶限流防滥用（REPLAN_HOURLY_LIMIT）；
// - **不落库**：这是「建议」——用户可能站在路口试算好几次，落库会把
//   revision 搅乱、也会让「算了但没采用」变成事实上的修改。想采用走
//   /p 页的「一句话改」（refine），控制权始终在用户手里。
//
// 为什么「今天第几天/现在几点」由客户端算：服务端 UTC 时区会把中国清晨
// 算成前一天（理由同 components/TodayView.tsx 的注释），本地时钟才是
// 用户眼里的「现在」。
// ============================================================

/** 求解按 IP 每小时上限：确定性操作成本极低，额度与 adjust 同量级 */
function replanHourlyLimit(): number {
  return Number(process.env.REPLAN_HOURLY_LIMIT || 60);
}

// IP 由 lib/client-ip 统一提取（不再取 XFF 首值：客户端可伪造，见审计 P0-3）
function clientIp(req: NextRequest): string {
  return clientIpFromHeaders(req.headers);
}

/**
 * 无真实路段的统一降级文案（422）。
 * 覆盖 MOCK 模式/境外/旧版本行程：没有真实路段就没有「几点到几点走不走
 * 得完」的判定依据。刻意给一条可行动的出口（到完整行程页用 AI 重排），
 * 而不是让用户对着按钮反复点。
 */
const UNAVAILABLE =
  "这份行程缺少真实路段数据（未验真/境外/旧版本行程），无法重排接下来的安排；可到完整行程页用「重排这一天」让 AI 重排";

const BodySchema = z.object({
  shareId: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/, "行程链接格式不正确"),
  day: z.number().int().min(1, "天数不合法").max(10, "天数不合法"),
  // 当天分钟数（0-1439）：客户端按本地时钟算好后传入
  nowMin: z.number().int().min(0, "当前时间不合法").max(1439, "当前时间不合法"),
});

/** "YYYY-MM-DD" 加 n 天（UTC 算术避免时区漂移）；非法返回 null。
 *  与 lib/schedule.ts 的日期工具重复（那边 client-safe 且未导出） */
function addDaysIso(iso: string | undefined, n: number): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = new Date(`${iso}T00:00:00Z`).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

/** "HH:mm" → 当天分钟数；非法返回 null（活动时间格式不猜，同 schedule.ts 口径） */
function parseClock(hhmm: string): number | null {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export async function POST(req: NextRequest) {
  // 1) 参数校验（放在限流之前：畸形请求不该消耗用户的小时额度）
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式不正确，需要 JSON body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不正确" },
      { status: 400 },
    );
  }
  const { shareId, day } = parsed.data;
  const nowMin = parsed.data.nowMin;

  // 2) 读可编辑行程。只认持久化 Plan（share token）；旧 job 链接是只读历史结果
  const record = await getPlanForEdit(shareId);
  if (!record) {
    if (await resolvePlan(shareId)) {
      return NextResponse.json(
        { error: "这条是旧版分享链接，只读、不支持重排；请打开新生成的行程再操作" },
        { status: 404 },
      );
    }
    return NextResponse.json({ error: "行程不存在或已被删除" }, { status: 404 });
  }

  // 3) 目标天必须真实存在（用户可能拿着旧页面点按钮）
  const targetDay = record.plan.days.find((d) => d.day === day);
  if (!targetDay) {
    return NextResponse.json(
      { error: `这份行程没有第 ${day} 天（共 ${record.plan.days.length} 天），请刷新页面后重试` },
      { status: 400 },
    );
  }

  // 4) 限流（确认请求有效之后再扣，坏请求不扣）
  const limit = replanHourlyLimit();
  const winKey = hourKey("replan", clientIp(req));
  const quota = await consume(winKey, limit);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: `重排接下来的安排每小时 ${limit} 次，已用完，请稍后再试` },
      { status: 429 },
    );
  }

  // 5) 组装求解输入（纯内存计算，毫秒级）
  const t0 = Date.now();
  const daySpots = Array.isArray(targetDay.spots) ? targetDay.spots : [];
  const timed = daySpots.map((s) => ({ spot: s, range: parseTimeRange(s.time) }));

  // 只对「还没走」的点重排：已开始（含正在进行）的点是既成事实。
  // 时间解析不出的点保守算未来（可能是后面的点，也可能只是数据脏——
  // 求解器只按 durationMin 重排它，不依赖原时间）。
  const futureSpots = timed
    .filter((x) => (x.range ? x.range.start > nowMin : true))
    .map((x) => x.spot);

  // 你现在的位置：进行中的点（含原定结束时间 = 最早能出发的时刻）；
  // 否则是最后一个已结束的点。首站的行进路程从这里开始算。
  const current = timed
    .filter((x) => x.range && x.range.start <= nowMin && x.range.end > nowMin)
    .pop();
  const lastPast = timed.filter((x) => x.range && x.range.end <= nowMin).pop();
  const from = current
    ? { name: current.spot.name, endMin: current.range?.end }
    : lastPast
      ? { name: lastPast.spot.name }
      : undefined;

  // 固定活动锚点（与 lib/schedule.ts 的 collectAnchors 同口径）：只认
  // 「给了日期+时间、落在今天、还没开始」的活动——已开始/已结束的活动
  // 不再是墙（你已经在现场，剩下的点应排在它之后而不是被挡死）。
  // 活动对应的点位已经走过/正在走时同理跳过。
  const dayIso = addDaysIso(record.plan.startDate, day - 1);
  let anchor: { time: string; name: string } | undefined;
  if (dayIso) {
    for (const ev of record.input?.events ?? []) {
      if (!ev.time || ev.date !== dayIso) continue;
      const evMin = parseClock(ev.time);
      if (evMin === null || evMin <= nowMin) continue;
      const anchorSpot = daySpots.find((s) => matchSpotName(s.name, ev.name));
      const anchorRange = anchorSpot ? parseTimeRange(anchorSpot.time) : null;
      if (anchorSpot && anchorRange && anchorRange.start <= nowMin) continue;
      anchor = { time: ev.time, name: ev.name };
      break;
    }
  }

  // 营业时间判定数据：只在能算出「今天几号」时给（checkOpenHours 要日期
  // 算星期）；算不出就整个不判——不猜星期，也不猜营业时间。
  const hours =
    dayIso && futureSpots.length > 0
      ? {
          isoDate: dayIso,
          byName: Object.fromEntries(
            futureSpots.map((s) => [s.name, s.poi as HoursPoiInput | undefined]),
          ),
        }
      : undefined;

  // 6) 求解（纯函数，不应抛错；防御性兜底仍然 refund）
  let result: ReturnType<typeof replanSolve>;
  try {
    result = replanSolve({
      nowMin,
      spots: futureSpots,
      legs: Array.isArray(targetDay.legs) ? targetDay.legs : [],
      from,
      hours,
      anchor,
    });
  } catch (e) {
    await refund(winKey);
    console.error(`[replan] ${shareId} 第 ${day} 天求解未预期失败: ${(e as Error)?.message ?? e}`);
    return NextResponse.json({ error: "重排失败：服务暂时不可用，请稍后重试" }, { status: 500 });
  }

  // 7) 缺真实路段 → 422 诚实降级（不猜时间、不落库）
  if (!result.ok) {
    await refund(winKey); // 没产出结果不消耗名额（与 adjust 同口径）
    console.log(`[replan] ${shareId} 第 ${day} 天 ok=false 用时 ${Date.now() - t0}ms`);
    return NextResponse.json({ error: UNAVAILABLE }, { status: 422 });
  }

  // 8) 只返回建议，不落库（见文件头说明）：kept/dropped/notes 全量透出
  console.log(
    `[replan] ${shareId} 第 ${day} 天 nowMin=${nowMin} 用时 ${Date.now() - t0}ms 保留=${result.kept.length} 放弃=${result.dropped.length}`,
  );
  return NextResponse.json({
    ok: true,
    day,
    nowMin,
    kept: result.kept,
    dropped: result.dropped,
    notes: result.notes,
    ...(result.message ? { message: result.message } : {}),
  });
}
