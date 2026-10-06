import type { Plan } from "./types";

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

/** RFC5545 文本转义：换行/分号/逗号/反斜杠 */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** 行折叠（>75 字节按 RFC 折叠，此处简化按字符数）——中文按字符安全 */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const parts: string[] = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) {
    parts.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  if (rest) parts.push(` ${rest}`);
  return parts.join("\r\n");
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
      const summary = `${spot.name}（${TYPE_LABEL[spot.type] ?? spot.type}）`;
      const desc = [
        `Day${day.day} ${day.theme}`,
        spot.reason,
        spot.rainBackup ? `🌧 雨天备选：${spot.rainBackup}` : "",
      ].filter(Boolean).join("\n");

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${plan.city}-d${day.day}-${i}-${date}@travel-planner`);
      if (range) {
        lines.push(`DTSTART:${date}T${range[0]}`);
        lines.push(`DTEND:${date}T${range[1]}`);
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
