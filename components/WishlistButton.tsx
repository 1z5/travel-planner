"use client";

import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import { isWished, toggleWish } from "@/lib/wishlist";

// ============================================================
// 「想去」按钮（产品线 B3）：分享页的收藏入口
//
// 为什么放在分享页：看到别人的行程心动时，最自然的动作是「先记下来」——我们的
// 「克隆」是「现在就排」，缺一个「以后再说」的中间态。愿望清单是旅行产品最低
// 成本的留存钩子（Airbnb 心愿单/Google Maps Saved 同源）。
//
// 状态从 localStorage 读、点一下就切换；失败静默（隐私模式写不进去也不阻断浏览）。
// ============================================================

export function WishlistButton({
  shareId,
  city,
  days,
  startDate,
  summary,
}: {
  shareId: string;
  city: string;
  days: number;
  startDate?: string;
  summary?: string;
}) {
  const [wished, setWished] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setWished(isWished(shareId));
    setReady(true);
  }, [shareId]);

  const onClick = () => {
    const { wished: next } = toggleWish({ shareId, city, days, startDate, summary });
    setWished(next);
  };

  // SSR/首帧不渲染错误状态：挂载后才知道本机有没有收藏过
  if (!ready) {
    return (
      <button type="button" className="btn btn-sm wishlist-btn" disabled aria-label="加入想去">
        <Heart size={14} aria-hidden="true" />
        想去
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`btn btn-sm wishlist-btn${wished ? " wishlist-btn-on" : ""}`}
      onClick={onClick}
      aria-pressed={wished}
      aria-label={wished ? `取消想去${city}` : `把${city}加入想去`}
      title={wished ? "从想去清单移除" : "先记下来，以后去"}
    >
      <Heart size={14} aria-hidden="true" fill={wished ? "currentColor" : "none"} />
      {wished ? "已在想去" : "想去"}
    </button>
  );
}
