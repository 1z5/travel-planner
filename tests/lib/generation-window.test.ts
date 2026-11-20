import { describe, expect, it } from "vitest";
import { SAMPLE_PLAN } from "@/lib/demo/sample-plan";
import { fitGeneratedDayWindow, generationWindowWarning } from "@/lib/plan/generation-window";

describe("生成时间窗", () => {
  const input = { days: 1, startAt: "2026-11-20T10:00", endAt: "2026-11-20T18:00" };
  const source = SAMPLE_PLAN.days[0]!;
  const day = { ...source, spots: source.spots.slice(0, 2) };

  it("整天平移，保留停留和点位间隔，生成结果可以再次核对", () => {
    const fitted = fitGeneratedDayWindow(day, input);
    expect(fitted.spots.map(({ time }) => time)).toEqual(["10:00-12:00", "12:15-13:15"]);
    expect(day.spots[0].time).toBe("08:00-10:00");
    expect(generationWindowWarning(fitted, input)).toBeUndefined();
    expect(fitGeneratedDayWindow(fitted, input)).toBe(fitted);
  });

  it("固定时间活动或窗口过窄时保留原排程，并返回警告", () => {
    const anchored = { ...input, events: [{ date: "2026-11-20", time: "08:00", name: "拙政园" }] };
    expect(fitGeneratedDayWindow(day, anchored)).toBe(day);
    expect(fitGeneratedDayWindow(day, { ...input, endAt: "2026-11-20T10:30" })).toBe(day);
    expect(generationWindowWarning(day, anchored)).toContain("超出行程时间窗");
  });
});
