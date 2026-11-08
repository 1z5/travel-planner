import type { HandoffClaim } from "./types";

// 原文 → 可独立签字的断言。
//
// 这是本产品与 /check 最不一样的技术决定：**不让模型理解行程**。
// /check 的 trip-document-extract.ts 要把文本重构成 day/spot/time，因此必须
// 请 LLM、必须防注入、必须担心「上午」被编成 09:00。交接单不需要任何理解——
// 它只需要把原文切成能逐条签字的片段。于是：
//   - 断言天然是原文连续子串，span 精确，从结构上不可能凭空生成内容；
//   - 全程纯客户端，0 请求 / 0 key / 0 落库，才真正配得上「零留存」；
//   - 代价是切片粒度粗（一行可能含两条信息），但「把判断权交还用户」本来就
//     不该由我们先替他拆好。太细或太粗，用户都能在签字时自己忽略。

export const HANDOFF_MAX_CLAIMS = 60;

const BREAKS = new Set(["\n", "\r", "。", "；", ";", "！", "!", "？", "?", "|", "→"]);

// 「第 1 天」「Day 2」这类是分节标题，不是可核的事实断言；不签字。
const HEADING = /^(第\s*\d+\s*天|day\s*\d+|d\s*\d+)\s*[:：]?$/i;

export interface SliceResult {
  claims: HandoffClaim[];
  /** 因上限被截掉的条数。必须摊给用户，不静默丢弃 */
  truncated: number;
}

export function sliceSource(text: string, max: number = HANDOFF_MAX_CLAIMS): SliceResult {
  const found: HandoffClaim[] = [];
  let start = 0;

  const push = (rawStart: number, rawEnd: number) => {
    const raw = text.slice(rawStart, rawEnd);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const s = rawStart + leading;
    const e = rawEnd - trailing;
    const claimText = text.slice(s, e);
    if (claimText.length < 4) return;
    if (HEADING.test(claimText)) return;
    found.push({
      id: `c${found.length + 1}`,
      text: claimText,
      span: [s, e],
      status: "unchecked",
    });
  };

  for (let i = 0; i < text.length; i++) {
    if (!BREAKS.has(text[i] as string)) continue;
    push(start, i + 1);
    start = i + 1;
  }
  if (start < text.length) push(start, text.length);

  const kept = found.slice(0, max);
  // id 重排，保证截断后仍连续，避免单子里出现 c7 之后直接 c31
  kept.forEach((c, i) => {
    c.id = `c${i + 1}`;
  });
  return { claims: kept, truncated: found.length - kept.length };
}
