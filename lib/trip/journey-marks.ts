import type { Plan } from "../types";

export type JourneyAction = "arrived" | "skipped";

export interface JourneyCommand {
  stopId: string;
  commandId: string;
  action: JourneyAction;
  planRevision: number;
}

export interface JourneyMark {
  stopId: string;
  commandId: string;
  action: JourneyAction;
  day: number;
  name: string;
  recordedAt: number;
}

export type JourneyWrite =
  { state: "saved" | "replayed"; mark: JourneyMark } | { state: "conflict" | "missing" | "limit" };

export function decideJourneyMark(
  trip: { plan: Plan; revision: number },
  marks: JourneyMark[],
  command: JourneyCommand,
  now: number,
): JourneyWrite {
  const replay = marks.find((mark) => mark.commandId === command.commandId);
  if (replay) {
    return replay.stopId === command.stopId && replay.action === command.action
      ? { state: "replayed", mark: replay }
      : { state: "conflict" };
  }
  if (trip.revision !== command.planRevision) return { state: "conflict" };
  if (marks.some((mark) => mark.stopId === command.stopId)) return { state: "conflict" };
  // 历史站点会保留，限制单趟记录数，避免反复编辑计划造成无限增长。
  if (marks.length >= 400) return { state: "limit" };
  for (const day of trip.plan.days) {
    const spot = day.spots.find((item) => item.stopId === command.stopId);
    if (spot) {
      return {
        state: "saved",
        mark: {
          stopId: command.stopId,
          commandId: command.commandId,
          action: command.action,
          name: spot.name,
          day: day.day,
          recordedAt: now,
        },
      };
    }
  }
  return { state: "conflict" };
}
