import { describe, expect, it } from "vitest";
import { buildIcs } from "@/lib/ics";
import type { Plan, PlanSpot } from "@/lib/types";

function spot(overrides: Partial<PlanSpot> = {}): PlanSpot {
  return {
    period: "morning",
    time: "09:00-11:00",
    type: "sight",
    name: "拙政园",
    area: "姑苏区",
    durationMin: 120,
    costCny: 80,
    reason: "江南园林的代表作",
    ...overrides,
  };
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    city: "苏州",
    startDate: "2026-10-10",
    endDate: "2026-10-12",
    summary: "园林与古城三日",
    days: [
      { day: 1, theme: "园林古城", spots: [spot()], transitMin: 30, dailyCostCny: 80 },
      { day: 2, theme: "湖光山色", spots: [spot({ name: "金鸡湖", time: "14:00-17:00" })], transitMin: 20, dailyCostCny: 60 },
    ],
    totalCostCny: 140,
    tips: [],
    warnings: [],
    verified: true,
    ...overrides,
  };
}

const icsLines = (ics: string) => ics.split("\r\n");

/**
 * 把 RFC5545 折叠后的物理行还原成一条逻辑行：续行以单个空格开头，
 * 还原时去掉该空格。用于断言被折叠的长文本内容。
 */
function unfold(lines: string[], startIdx: number): string {
  let out = lines[startIdx];
  let j = startIdx + 1;
  while (j < lines.length && lines[j].startsWith(" ")) {
    out += lines[j].slice(1);
    j += 1;
  }
  return out;
}

describe("buildIcs", () => {
  it("产出合法 VCALENDAR 外壳，每个 spot 一个 VEVENT", () => {
    const ics = buildIcs(plan());
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect((ics.match(/END:VEVENT/g) ?? []).length).toBe(2);
  });

  it("事件日期按 startDate + 天序偏移", () => {
    const ics = buildIcs(plan());
    expect(ics).toContain("DTSTART:20261010T090000");
    expect(ics).toContain("DTSTART:20261011T140000");
  });

  it("跨零点时段（23:00-01:00）DTEND 顺延一天，结束不早于开始", () => {
    const ics = buildIcs(plan({
      days: [{ day: 1, theme: "夜游", spots: [spot({ time: "23:00-01:00" })], transitMin: 0, dailyCostCny: 0 }],
    }));
    expect(ics).toContain("DTSTART:20261010T230000");
    expect(ics).toContain("DTEND:20261011T010000");
    // 结束时间必须晚于开始时间，否则日历客户端会丢弃该事件
    const start = "20261010T230000";
    const end = "20261011T010000";
    expect(end > start).toBe(true);
  });

  it("时间无法解析时退化为全天事件（VALUE=DATE）", () => {
    const ics = buildIcs(plan({
      days: [{ day: 1, theme: "待定", spots: [spot({ time: "上午" })], transitMin: 0, dailyCostCny: 0 }],
    }));
    expect(ics).toContain("DTSTART;VALUE=DATE:20261010");
    expect(ics).not.toContain("DTEND;VALUE=DATE:20261010"); // 全天事件不需要 DTEND
  });

  it("缺 startDate 时退化为明天开始（老数据/分享页兜底）", () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const ics = buildIcs(plan({ startDate: undefined }));
    expect(ics).toContain(`DTSTART:${tomorrow.replace(/-/g, "")}T090000`);
  });

  it("startDate 格式非法时同样走明天兜底", () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const ics = buildIcs(plan({ startDate: "10月10日" }));
    expect(ics).toContain(`DTSTART:${tomorrow.replace(/-/g, "")}T090000`);
  });

  it("RFC5545 转义：反斜杠/分号/逗号/换行", () => {
    const ics = buildIcs(plan({
      days: [{
        day: 1,
        theme: "特殊字符",
        spots: [spot({ name: "A\\B;C,D\nE", reason: "第一行\n第二行" })],
        transitMin: 0,
        dailyCostCny: 0,
      }],
    }));
    expect(ics).toContain("SUMMARY:A\\\\B\\;C\\,D\\nE（景点）");
    expect(ics).toContain("第一行\\n第二行");
  });

  it("行折叠按 UTF-8 字节（≤75）且不劈开多字节字符", () => {
    const longReason = "理".repeat(80); // 240 字节，远超 75
    const ics = buildIcs(plan({
      days: [{ day: 1, theme: "长文本", spots: [spot({ reason: longReason })], transitMin: 0, dailyCostCny: 0 }],
    }));
    for (const line of icsLines(ics)) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    // 还原折叠行后应能取回原文（证明没有在多字节字符中间下刀）
    const lines = icsLines(ics);
    const idx = lines.findIndex((l) => l.startsWith("DESCRIPTION:"));
    expect(idx).toBeGreaterThanOrEqual(0);
    const desc = unfold(lines, idx).replace(/^DESCRIPTION:/, "");
    expect(desc).toContain(longReason);
  });

  it("不超过 75 字节的行不折叠（保持原样）", () => {
    const ics = buildIcs(plan());
    const summaryLine = icsLines(ics).find((l) => l.startsWith("SUMMARY:"));
    expect(summaryLine).toBe("SUMMARY:拙政园（景点）");
  });

  it("UID 全局唯一：同城同日起点的两份不同行程不互相覆盖", () => {
    const a = buildIcs(plan());
    const b = buildIcs(plan({
      summary: "另一份",
      days: [{ day: 1, theme: "别的安排", spots: [spot({ name: "虎丘" })], transitMin: 0, dailyCostCny: 0 }],
    }));
    const uid = (ics: string) => icsLines(ics).find((l) => l.startsWith("UID:"))!;
    expect(uid(a)).not.toBe(uid(b));
  });

  it("雨天备选与主题写入 DESCRIPTION", () => {
    const ics = buildIcs(plan({
      days: [{
        day: 1,
        theme: "园林古城",
        spots: [spot({ rainBackup: "苏州博物馆" })],
        transitMin: 0,
        dailyCostCny: 0,
      }],
    }));
    const lines = icsLines(ics);
    const desc = unfold(lines, lines.findIndex((l) => l.startsWith("DESCRIPTION:")));
    expect(desc).toContain("Day1 园林古城");
    expect(desc).toContain("雨天备选：苏州博物馆");
  });

  it("日历名含城市与天数（导入后能在日历列表里认出来）", () => {
    const ics = buildIcs(plan());
    expect(ics).toContain("X-WR-CALNAME:苏州 2 天行程");
    expect(ics).toContain("X-WR-TIMEZONE:Asia/Shanghai");
  });
});
