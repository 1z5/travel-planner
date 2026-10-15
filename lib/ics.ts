import type { Plan, PlanDay, PlanSpot } from "./types";

// ============================================================
// 行程 → iCalendar（.ics）：把分天时刻表转换成日历事件，
// 用户可一键导入手机/电脑日历。时间用本地浮动时间（不带时区），
// 日历应用会按本地时区解释。
// ============================================================

const TYPE_LABEL: Record<string, string> = {
  sight: "景点", food: "餐饮", hotel: "住宿", transport: "交通",
  shopping: "购物", activity: "体验",
};

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
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
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
  const startDate = plan.startDate && /^\d{4}-\d{2}-\d{2}$/.test(plan.startDate)
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
      ].filter(Boolean).join("\n");

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
      lines.push("END:VEVENT");
    });
  });

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
