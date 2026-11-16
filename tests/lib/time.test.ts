import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  fmtClock,
  fmtHourMin,
  isRealDate,
  parseClock,
  parseTimeRange,
  parseTimeRangeTolerant,
} from "@/lib/plan/time";

// time.ts 是全项目时间/日期算术的唯一来源（ADR-020 · R5）。偏离检测
// （time_overrun）直接踩这些函数，边界必须钉死。

describe("parseTimeRange（严格口径）", () => {
  it("标准区间解析为当天分钟数", () => {
    expect(parseTimeRange("09:00-11:30")).toEqual({ start: 540, end: 690 });
  });

  it("容忍 1-2 位小时与虚线空格", () => {
    expect(parseTimeRange("9:30-11:00")).toEqual({ start: 570, end: 660 });
    expect(parseTimeRange("9:30 - 11:00")).toEqual({ start: 570, end: 660 });
  });

  it("跨零点/零长 → null（不替用户假设跨天停留）", () => {
    expect(parseTimeRange("23:00-01:00")).toBeNull();
    expect(parseTimeRange("10:00-10:00")).toBeNull();
  });

  it("「24:00」算出来恰好 1440，必须按原时分挡住", () => {
    expect(parseTimeRange("09:00-24:00")).toBeNull();
    expect(parseTimeRange("24:00-24:30")).toBeNull();
  });

  it("时分越界（25:00 / 09:60）→ null", () => {
    expect(parseTimeRange("25:00-26:00")).toBeNull();
    expect(parseTimeRange("09:60-11:00")).toBeNull();
  });

  it("格式垃圾 → null（不猜）", () => {
    expect(parseTimeRange("")).toBeNull();
    expect(parseTimeRange("上午-下午")).toBeNull();
    expect(parseTimeRange("09:00")).toBeNull();
  });
});

describe("parseTimeRangeTolerant（容错口径）", () => {
  it("合法区间与严格口径一致", () => {
    expect(parseTimeRangeTolerant("09:00-11:30")).toEqual({ start: 540, end: 690 });
  });

  it("跨零点按零长：不参与 now 判定，仅参与 next（已知局限）", () => {
    expect(parseTimeRangeTolerant("23:00-01:00")).toEqual({ start: 1380, end: 1380 });
  });

  it("时刻越界仍 → null（容错不等于接受 25 点）", () => {
    expect(parseTimeRangeTolerant("25:00-26:00")).toBeNull();
    expect(parseTimeRangeTolerant("")).toBeNull();
  });
});

describe("parseClock", () => {
  it("HH:mm → 分钟数", () => {
    expect(parseClock("19:00")).toBe(1140);
    expect(parseClock("0:05")).toBe(5);
  });

  it("非法 → null", () => {
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("19:60")).toBeNull();
    expect(parseClock("")).toBeNull();
    expect(parseClock("19点")).toBeNull();
  });
});

describe("fmtHourMin / fmtClock", () => {
  it("fmtHourMin 不取整不取模（1440 → 24:00，锚点跨零点用）", () => {
    expect(fmtHourMin(540)).toBe("09:00");
    expect(fmtHourMin(1440)).toBe("24:00");
  });

  it("fmtClock 取整后取模 1440（出发建议可能算出负数）", () => {
    expect(fmtClock(540)).toBe("09:00");
    expect(fmtClock(1439)).toBe("23:59");
    expect(fmtClock(-30)).toBe("23:30");
    expect(fmtClock(1500)).toBe("01:00");
    expect(fmtClock(90.4)).toBe("01:30");
  });
});

describe("isRealDate", () => {
  it("合法日期", () => {
    expect(isRealDate("2026-10-18")).toBe(true);
    expect(isRealDate("2024-02-29")).toBe(true); // 闰日
  });

  it("日历不存在的日期 → false（round-trip 对不上）", () => {
    expect(isRealDate("2026-02-30")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
    expect(isRealDate("2025-02-29")).toBe(false); // 非闰年
  });

  it("空/undefined/格式错 → false", () => {
    expect(isRealDate("")).toBe(false);
    expect(isRealDate(undefined)).toBe(false);
    expect(isRealDate("2026-1-1")).toBe(false);
  });
});

describe("addDays / daysBetween", () => {
  it("跨月/跨年/闰日边界", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("daysBetween 是同口径的 UTC 算术", () => {
    expect(daysBetween("2026-10-18", "2026-10-21")).toBe(3);
    expect(daysBetween("2026-10-21", "2026-10-18")).toBe(-3);
    expect(daysBetween("bad", "2026-10-18")).toBeNull();
  });
});
