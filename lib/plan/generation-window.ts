import type { PlanDay, PlanInput } from "../types";
import { addDays, fmtHourMin, isRealDate, parseClock, parseTimeRange } from "./time";

type WindowInput = Pick<PlanInput, "days" | "startAt" | "endAt" | "events">;
type TimedDay = Pick<PlanDay, "day" | "spots">;

function windowFor(input: WindowInput, day: number) {
  return {
    start: day === 1 ? (parseClock(input.startAt?.slice(11, 16) ?? "") ?? 0) : 0,
    end: day === input.days ? (parseClock(input.endAt?.slice(11, 16) ?? "") ?? 1439) : 1439,
  };
}

export function generationWindowWarning(day: TimedDay, input: WindowInput): string | undefined {
  const { start, end } = windowFor(input, day.day);
  if (
    day.spots.some(({ time }) => {
      const range = parseTimeRange(time);
      return range && (range.start < start || range.end > end);
    })
  ) {
    return `第 ${day.day} 天有站点超出行程时间窗 ${fmtHourMin(start)}–${fmtHourMin(end)}，请核对抵达和离开时间`;
  }
}

export function fitGeneratedDayWindow<T extends TimedDay>(day: T, input: WindowInput): T {
  if (!day.spots.length || !generationWindowWarning(day, input)) return day;
  const date = input.startAt?.slice(0, 10);
  // 固定时间活动可能依赖当天的交通安排，保留模型给出的时段供用户核对。
  if (
    input.events?.some(
      ({ time, date: eventDate }) =>
        time && (!eventDate || !isRealDate(date) || eventDate === addDays(date, day.day - 1)),
    )
  ) {
    return day;
  }
  const ranges = day.spots.map(({ time }) => parseTimeRange(time));
  if (ranges.some((range) => !range)) return day;
  const earliest = Math.min(...ranges.map((range) => range!.start));
  const latest = Math.max(...ranges.map((range) => range!.end));
  const { start, end } = windowFor(input, day.day);
  if (latest - earliest > end - start) return day;
  const offset = earliest < start ? start - earliest : end - latest;
  return {
    ...day,
    spots: day.spots.map((spot, index) => ({
      ...spot,
      time: `${fmtHourMin(ranges[index]!.start + offset)}-${fmtHourMin(ranges[index]!.end + offset)}`,
    })),
  };
}
