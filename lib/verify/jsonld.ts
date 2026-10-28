// ============================================================
// schema.org TouristTrip JSON-LD 导出（纯函数）
//
// 为什么做：开放标准不能只活在本站。schema.org 的 TouristTrip 是搜索引擎/
// 聚合器能直接读的公共词汇（Trip > TouristTrip，含 itinerary/subTrip 属性），
// 行程页带上 JSON-LD 后，第三方无需接我们的 API 就能结构化读取行程。
// 这是「零成本分发」的一部分（R3 调研：schema.org 词汇够用，不需要自定义扩展）。
//
// 诚实边界：JSON-LD 只导出**文档里已有的事实**（名称/时间/区域/花费），
// 不导出核验结论（核验结论在 Trip Check 报告里，schema.org 没有对应词汇；
// 硬塞自定义字段只会造出没人能解析的伪标准）。
// ============================================================

import type { Plan } from "../types";

export interface JsonLdOptions {
  /** 可选的绝对 URL（分享页地址）；没有就不写 url 字段 */
  url?: string;
}

/** 把内部 Plan 转成 schema.org TouristTrip 的 JSON-LD 对象 */
export function planToTouristTripJsonLd(
  plan: Plan,
  options: JsonLdOptions = {},
): Record<string, unknown> {
  const days = Array.isArray(plan.days) ? plan.days : [];
  const title =
    plan.cities && plan.cities.length > 0
      ? `${plan.cities.map((c) => c.city).join(" → ")} · ${days.length} 天行程`
      : `${plan.city} · ${days.length} 天行程`;

  return {
    "@context": "https://schema.org",
    "@type": "TouristTrip",
    name: title,
    ...(plan.summary ? { description: plan.summary } : {}),
    ...(options.url ? { url: options.url } : {}),
    ...(plan.startDate ? { startDate: plan.startDate } : {}),
    ...(plan.endDate ? { endDate: plan.endDate } : {}),
    itinerary: {
      "@type": "ItemList",
      numberOfItems: days.length,
      itemListElement: days.map((day) => ({
        "@type": "ListItem",
        position: day.day,
        item: {
          "@type": "TouristTrip",
          name: day.theme,
          ...(day.city ? { description: `第 ${day.day} 天 · ${day.city}` } : {}),
          itinerary: {
            "@type": "ItemList",
            numberOfItems: day.spots.length,
            itemListElement: day.spots.map((spot, index) => ({
              "@type": "ListItem",
              position: index + 1,
              item: {
                "@type": "TouristAttraction",
                name: spot.name,
                ...(spot.area ? { address: spot.area } : {}),
              },
            })),
          },
        },
      })),
    },
  };
}

/**
 * 序列化成可内联 <script type="application/ld+json"> 的字符串。
 *
 * 必须转义 "<"：行程内容来自用户输入/模型生成，若含 "</script>" 会提前闭合
 * 标签形成 XSS。\u003c 在 JSON 里语义等价，解析器仍能正常读。
 */
export function jsonLdScript(trip: Record<string, unknown>): string {
  return JSON.stringify(trip).replace(/</g, "\\u003c");
}
