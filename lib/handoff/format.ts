import { countByStatus } from "./receipt";
import type { HandoffReceipt } from "./types";

// 单子的两种「可带走」形态：完整 JSON（可复算）+ 一段能粘进微信的纯文本卡。
//
// 刻意不做二维码：零留存架构下，短码没有可解析的服务端目标；硬做就得把单子
// 存回服务器，等于把「我们不持有」推翻。要转发，发文件或粘贴文本卡就够了。

const STATUS_LABEL: Record<string, string> = {
  verified: "我核过",
  changed: "我改了",
  trusted: "先信着",
  unchecked: "还没表态",
};

export function receiptFileName(r: HandoffReceipt): string {
  return `交接单-${r.id}.json`;
}

export function serializeReceipt(r: HandoffReceipt): string {
  return JSON.stringify(r, null, 2);
}

function clock(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}

export function toTextCard(r: HandoffReceipt): string {
  const n = countByStatus(r);
  const lines: string[] = [
    "【出发前交接单】",
    `编号 ${r.id}`,
    `生成 ${clock(r.createdAt)}（设备自述时间）`,
    `来源 ${r.source.chars} 字 · sha256 ${r.source.sha256.slice(0, 12)}…`,
    "",
    `共 ${r.claims.length} 条断言：核过 ${n.verified} · 改了 ${n.changed} · 先信着 ${n.trusted} · 未表态 ${n.unchecked}`,
  ];

  for (const status of ["verified", "changed", "trusted"] as const) {
    const group = r.claims.filter((c) => c.status === status);
    if (group.length === 0) continue;
    lines.push("", `${STATUS_LABEL[status]}：`);
    for (const c of group) {
      const extra = [c.basis && `依据：${c.basis}`, c.note && `备注：${c.note}`]
        .filter(Boolean)
        .join(" · ");
      lines.push(`  · ${c.text}${extra ? `（${extra}）` : ""}`);
    }
  }

  if (r.decision.trim()) lines.push("", `我的决定：${r.decision.trim()}`);
  if (r.truncated > 0) lines.push("", `另有 ${r.truncated} 条因上限未纳入（如实记录）`);
  lines.push("", r.notice);
  lines.push("", "完整可复算文件：同目录下的 .json；任何人都能离线重跑核对。");
  return lines.join("\n");
}
