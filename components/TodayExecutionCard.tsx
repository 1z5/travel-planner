"use client";

import { useEffect, useState } from "react";
import { Bike, Car, Check, Footprints, LogOut } from "lucide-react";
import type { PlanLeg, PlanSpot } from "@/lib/types";
import type { SpotNow } from "@/lib/trip-day";
import {
  arrivedSpotNames,
  departureAdvice,
  loadDayExecution,
  markArrived,
  markDeparted,
  type SpotExecution,
} from "@/lib/trip-execution";
import { track } from "@/lib/track";

// ============================================================
// 行中执行卡（产品线 C2）：出发建议 + 我已出发/我已到达
//
// 为什么做：北极星「照着走完率」原来的口径只是「行中打开过且没改过」——打开
// 不等于照着走。用户点「我已到达」是强信号：他真的按这个行程走了。埋点
// today_departed/today_arrived 让看板能区分「没改过」和「确实走了」。
//
// 三条红线：
// 1. 出发建议只用**真实路段**算（lib/trip-execution.ts）；没有 legs 就说
//    「无法建议」，不拿直线距离估算——估算值会让人赶不上车。
// 2. 打卡只记用户主动点的动作，不拿「页面打开过」冒充「到达」。
// 3. 已到达的点位显示 ✓，不重复计次（存储层幂等）。
// ============================================================

const MODE_ICON = { walking: Footprints, bicycling: Bike, driving: Car, auto: Car } as const;
const MODE_LABEL = { walking: "步行", bicycling: "骑行", driving: "驾车", auto: "驾车" } as const;

export function TodayExecutionCard({
  shareId,
  city,
  dayNo,
  status,
  spots,
  legs,
  nowMinutes,
}: {
  shareId: string;
  city: string;
  dayNo: number;
  status: SpotNow | null;
  spots: PlanSpot[];
  legs: PlanLeg[];
  nowMinutes: number;
}) {
  const [exec, setExec] = useState<Record<string, SpotExecution>>({});

  // 打卡记录按「行程 + 天」读取：换一天/换一份行程要跟着切
  useEffect(() => {
    setExec(loadDayExecution(shareId, dayNo));
  }, [shareId, dayNo]);

  // 「接下来要去的那一站」：next 状态就是它；now 状态是当前点的下一站
  // （人站在当前点，该关心的是什么时候从这里出发）。其它状态不渲染卡片。
  const upcomingIndex =
    status?.kind === "next" ? status.index : status?.kind === "now" ? status.index + 1 : null;
  if (upcomingIndex === null) return null;
  const upcoming = spots[upcomingIndex];
  if (!upcoming) return null;
  const from = upcomingIndex > 0 ? spots[upcomingIndex - 1] : undefined;
  const leg = from ? legs.find((l) => l.from === from.name && l.to === upcoming.name) : undefined;
  const advice = departureAdvice(nowMinutes, upcoming, leg);

  const spotExec = exec[upcoming.name];
  const arrived = typeof spotExec?.arrivedAt === "number";
  const departed = typeof spotExec?.departedAt === "number";

  const onDepart = () => {
    setExec(markDeparted(shareId, dayNo, upcoming.name));
    track("today_departed", { shareId, city, day: dayNo });
  };
  const onArrive = () => {
    setExec(markArrived(shareId, dayNo, upcoming.name));
    track("today_arrived", { shareId, city, day: dayNo });
  };

  const ModeIcon = advice ? MODE_ICON[advice.mode] : LogOut;

  return (
    <div className="today-exec">
      <p className="today-exec-head">
        <span className="today-exec-next">下一站</span>
        <strong>{upcoming.name}</strong>
        <span className="today-exec-time">{upcoming.time}</span>
      </p>

      {advice ? (
        <p className="today-exec-advice">
          <ModeIcon size={14} aria-hidden="true" />
          建议 <strong>{advice.departAt}</strong> 出发 · {MODE_LABEL[advice.mode]}{" "}
          {advice.transitMin} 分钟 + {advice.bufferMin} 分钟缓冲
        </p>
      ) : (
        // 没有真实路段就明说：不拿直线距离算一个「看起来精确」的建议时间
        <p className="today-exec-advice today-exec-advice-none">通勤数据缺失，无法建议出发时间</p>
      )}

      <div className="today-exec-actions">
        {arrived ? (
          <span className="today-exec-done">
            <Check size={14} aria-hidden="true" />
            已到达
          </span>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onDepart}
              disabled={departed}
              aria-label={`标记已出发前往${upcoming.name}`}
            >
              {departed ? "已出发" : "我已出发"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onArrive}
              aria-label={`标记已到达${upcoming.name}`}
            >
              我已到达
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** 当天已到达的点位名（时间轴打勾用） */
export function useArrivedSpots(shareId: string, dayNo: number): string[] {
  const [exec, setExec] = useState<Record<string, SpotExecution>>({});
  useEffect(() => {
    setExec(loadDayExecution(shareId, dayNo));
  }, [shareId, dayNo]);
  return arrivedSpotNames(exec);
}
