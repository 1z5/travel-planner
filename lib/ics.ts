import type { Plan, PlanDay, PlanSpot } from "./types";

// ============================================================
// 行程 → iCalendar（.ics）：把分天时刻表转换成日历事件，
// 用户可一键导入手机/电脑日历。时间用本地浮动时间（不带时区），
// 日历应用会按本地时区解释。
// ============================================================

const TYPE_LABEL: Record<string, string> = {
  sight: "景点",
  food: "餐饮",
  hotel: "住宿",
  transport: "交通",
  shopping: "购物",
  activity: "体验",
};

/** 到点提醒的提前量：每个有时刻的点位提前 15 分钟。
 *
 * 为什么是固定常量而不是按通勤时间算：
 *   1. `day.transitMin` 是**当日合计**、不是「上一站 → 这一站」的路程，
 *      拿它当单点提前量会系统性地偏大；
 *   2. 按点位算真实通勤要对每个点位各调一次路径规划（贵 + 慢），而提醒
 *      提前量的边际收益远低于这个成本；
 *   3. 固定值可预测——用户知道「日历会提前 15 分钟响」，比一个算错的通勤
 *      更诚实。
 * 全天事件（`VALUE=DATE`，时间解析不出来）不加提醒：DTSTART 只有日期、
 * 没有时刻，TRIGGER 会相对午夜触发，对用户没有意义（见下方 VEVENT 分支）。
 */
const REMIND_LEAD = "-PT15M";

/** 订阅型日历客户端的刷新间隔提示（RFC 5543 X-PUBLISHED-TTL）。
 *
 * 为什么取 1 小时而不是 15 分钟：行程变更主要由用户自己触发（改完打开
 * 行中模式立即生效），日历只需要在变更后一小时内跟上就够；刷得太勤只会
 * 把配额耗在轮询上——该接口按 IP 限流 60 次/小时，1 小时 + 多设备订阅
 * 也远低于这个上限。 */
const PUBLISHED_TTL = "PT1H";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" + offsetDays → "YYYYMMDD"（ics 日期格式） */
function icsDate(dateStr: string, offsetDays: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** "HH:MM-HH:MM" → ["HHMMSS","HHMMSS"]；解析不了返回 null */
function parseRange(time: string): [string, string] | null {
  const m = time.match(/(\d{1,2}):(\d{2})\s*[-–~]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, h1, m1, h2, m2] = m;
  return [`${pad(Number(h1))}${m1}00`, `${pad(Number(h2))}${m2}00`];
}

/** 结束早于开始 = 跨零点（如 "23:00-01:00"），DTEND 需顺延一天 */
function crossesMidnight(range: [string, string]): boolean {
  return range[1] < range[0];
}

/** RFC5545 文本转义：换行/分号/逗号/反斜杠 */
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * 行折叠：RFC 5545 要求行不超过 75 **字节**（不是字符）。中文在 UTF-8 下
 * 占 3 字节，按字符折叠会让一行实际达到 200+ 字节，严格的日历客户端
 * （部分 Outlook 版本）会直接拒收整个文件。
 * 实现按字节累计，且不在多字节字符中间下刀（否则续行是非法 UTF-8）。
 */
function fold(line: string): string {
  const enc = new TextEncoder();
  const MAX = 75;
  if (enc.encode(line).length <= MAX) return line;

  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  let budget = MAX; // 首行可用满 75；续行要留 1 字节给行首那个空格
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    if (curBytes + chBytes > budget) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
      budget = MAX - 1;
    }
    cur += ch;
    curBytes += chBytes;
  }
  if (cur) parts.push(cur);
  return parts.join("\r\n "); // 续行以单空格开头（RFC 5545 §3.1）
}

/**
 * UID 需全局唯一：两份「同城市 + 同首日」的行程导入同一个日历时，
 * 若 UID 相同会被日历应用当成同一事件而互相覆盖。
 */
function uidFor(plan: Plan, day: PlanDay, spot: PlanSpot, i: number, date: string): string {
  const raw = `${plan.city}|${date}|${day.day}|${i}|${spot.name}|${spot.time}`;
  let h = 0;
  for (const c of raw) h = (h * 31 + c.codePointAt(0)!) | 0;
  return `tp-${Math.abs(h).toString(36)}`;
}

export function buildIcs(plan: Plan): string {
  // 没有 startDate 时退化为明天开始（老数据/分享页兜底）
  const startDate =
    plan.startDate && /^\d{4}-\d{2}-\d{2}$/.test(plan.startDate)
      ? plan.startDate
      : new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//行程规划师//Travel Planner//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(`${plan.city} ${plan.days.length} 天行程`)}`,
    `X-WR-TIMEZONE:Asia/Shanghai`,
    // 订阅型日历（webcal）靠这个字段决定多久拉一次新版本；缺省客户端可能
    // 按自己的默认值（几天一次）刷新，改过的行程迟迟不更新
    `X-PUBLISHED-TTL:${PUBLISHED_TTL}`,
  ];

  plan.days.forEach((day, dayIdx) => {
    day.spots.forEach((spot, i) => {
      const date = icsDate(startDate, dayIdx);
      const range = parseRange(spot.time);
      // 跨零点时段（23:00-01:00）的 DTEND 顺延一天：结束早于开始的事件
      // 会被日历客户端丢弃或显示成零时长
      const endDate = range && crossesMidnight(range) ? icsDate(startDate, dayIdx + 1) : date;
      const summary = `${spot.name}（${TYPE_LABEL[spot.type] ?? spot.type}）`;
      const desc = [
        `Day${day.day} ${day.theme}`,
        spot.reason,
        spot.rainBackup ? `🌧 雨天备选：${spot.rainBackup}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${uidFor(plan, day, spot, i, date)}@travel-planner`);
      if (range) {
        lines.push(`DTSTART:${date}T${range[0]}`);
        lines.push(`DTEND:${endDate}T${range[1]}`);
      } else {
        lines.push(`DTSTART;VALUE=DATE:${date}`);
      }
      lines.push(fold(`SUMMARY:${esc(summary)}`));
      if (spot.area) lines.push(fold(`LOCATION:${esc(spot.area)}`));
      lines.push(fold(`DESCRIPTION:${esc(desc)}`));
      // 到点提醒（RFC 5545 VALARM）：这是「行中值班」最便宜的一环——系统日历
      // 替我们推送，不需要任何推送资质，也不会被用户当垃圾通知划掉。
      // 只给有时刻的事件加：全天事件的 TRIGGER 会落在午夜，响起来毫无意义。
      if (range) {
        lines.push("BEGIN:VALARM");
        lines.push(`TRIGGER:${REMIND_LEAD}`);
        lines.push("ACTION:DISPLAY");
        // DESCRIPTION 是 RFC 5545 的必填属性，也是部分客户端唯一的展示文本
        lines.push(fold(`DESCRIPTION:${esc(`行程提醒：${spot.name}`)}`));
        lines.push("END:VALARM");
      }
      lines.push("END:VEVENT");
    });
  });

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
