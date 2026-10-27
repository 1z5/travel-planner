"use client";

import { useState } from "react";
import { Heart } from "lucide-react";
import { track } from "@/lib/track";

// ============================================================
// 付费意愿按钮（产品线 S3：商业化试点）
//
// 为什么只收意愿、不接支付：现在连「用户愿意为什么付费」都还没有数据，
// 先接支付是把工程预算押在猜测上。这个按钮只是给候选付费点投票：
// 记一条 upgrade_intent（meta.tier = 候选点），后端聚合后看付费意愿分布。
//
// 诚实口径（不可违反）：
// 1. 不承诺上线时间、不承诺价格、不扣任何费用；
// 2. 点击后按钮变成「已记录」，不重复上报（避免刷数据把意愿分布搞歪）；
// 3. 不收集身份信息——只记 tier 计数，看板只有聚合值。
// ============================================================

export function IntentButton({ tier, label = "我想要这个" }: { tier: string; label?: string }) {
  const [done, setDone] = useState(false);

  const onClick = () => {
    if (done) return;
    track("upgrade_intent", { meta: { tier } });
    setDone(true);
  };

  return (
    <button
      type="button"
      className={`btn btn-sm intent-btn${done ? " intent-btn-done" : ""}`}
      onClick={onClick}
      disabled={done}
      aria-label={done ? "已记录你的意愿" : `${label}（${tier}）`}
    >
      <Heart size={14} aria-hidden="true" fill={done ? "currentColor" : "none"} />
      {done ? "已记录，谢谢" : label}
    </button>
  );
}
