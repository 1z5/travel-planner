"use client";

import { useEffect, useState } from "react";
import { CloudRain, AlertTriangle, Clock } from "lucide-react";
import type { Plan } from "@/lib/types";

// ============================================================
// 行前提醒：出发前 3 天内自动检查天气，有风险立即横幅提醒。
//
// 为什么需要：用户分享行程后，打开链接时可能距离出发只有几天。
// 如果目的地有雨/雪，越早知道越好——这是产品从「被动工具」
// 变成「主动伙伴」的关键一步。
//
// 设计原则：
// - 只在出发前 3 天内触发（远期行程不打扰）
// - 客户端挂载后异步检查（不阻塞页面加载）
// - 检查失败静默降级（不弹错误）
// ============================================================

interface Props {
  plan: Plan;
}

function daysUntil(dateStr: string): number {
  const target = new Date(`${dateStr}T00:00:00`);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - now.getTime()) / 86400000);
}

export function TripAlert({ plan }: Props) {
  const [alert, setAlert] = useState<{
    type: "weather" | "departure";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!plan.startDate) return;

    const days = daysUntil(plan.startDate);

    // 已出发或已结束：不提醒
    if (days < 0) return;

    // 明天出发：倒计时提醒
    if (days === 0) {
      setAlert({ type: "departure", message: "今天出发！祝你旅途愉快 🎒" });
      return;
    }
    if (days === 1) {
      setAlert({ type: "departure", message: "明天出发，记得检查行李和天气预报" });
      return;
    }

    // 3 天内出发：检查天气
    if (days <= 3) {
      fetch(`/api/weather?city=${encodeURIComponent(plan.city)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.state !== "ok" || !Array.isArray(data.days)) return;
          // 找出发日的天气
          const dayCast = data.days.find((d: { date: string }) => d.date === plan.startDate);
          if (!dayCast) return;
          const bad = /雨|雪|雹|沙|尘|雾|霾/.test(dayCast.dayWeather + dayCast.nightWeather);
          if (bad) {
            setAlert({
              type: "weather",
              message: `出发日（${days} 天后）预报${dayCast.dayWeather}，建议准备雨具或调整行程`,
            });
          }
        })
        .catch(() => {}); // 天气查询失败：静默，不打扰
    }
  }, [plan.startDate, plan.city]);

  if (!alert) return null;

  const isUrgent = alert.type === "departure";

  return (
    <div className={`trip-alert trip-alert-${alert.type}`} role="status" aria-live="polite">
      {isUrgent ? <Clock size={16} /> : <CloudRain size={16} />}
      <span>{alert.message}</span>
    </div>
  );
}
