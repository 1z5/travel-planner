// 首屏「灵感」三卡的数据：给「不知道去哪」的新用户三个可点的具体起点。
//
// 为什么存在：产品入口是一张空列表 + 一个要求用户先想清楚「去哪/几天/喜欢
// 什么」的空白表单——冷启动摩擦全压在用户身上。成熟 To C 产品的首屏先给
// 内容再要输入。这三条就是「内容」，但只承担**引子**功能：点开只是把城市、
// 天数和偏好带进 /new 表单，**不是预置行程**。
//
// 诚实口径（不可违反）：
// 1. 这里不是已核验行程，卡片必须标注「示例条件」——不写具体 POI 的营业时间、
//    评分、票价，也不写「热门/爆款/10w+」这类编造数据，避免暗示 POI 已验真。
// 2. budget 是「示例条件的量级」（人均、不含大交通），不是报价、不是高德事实，
//    用户点开后可以在表单里改。
// 3. 纯数据 + 纯函数，无副作用、无 IO，客户端组件可安全 import。

export interface FeaturedDestination {
  city: string;
  /** 行程天数（1-7，与表单「起止时间」支持区间一致） */
  days: number;
  /** 出行偏好；取值必须落在 app/home-client.tsx 的 PREF_OPTIONS 白名单内 */
  prefs: readonly string[];
  /** 人均预算（元，不含大交通）——示例条件，用户可在表单里改 */
  budget: number;
  /** 一句话说清「这趟是什么味道」 */
  blurb: string;
  /** 2-3 条具体玩法（方向性建议，不是已验证的点位清单） */
  highlights: readonly string[];
}

export const FEATURED_DESTINATIONS: readonly FeaturedDestination[] = [
  {
    city: "成都",
    days: 3,
    prefs: ["美食", "历史文化"],
    budget: 1600,
    blurb: "吃为主、逛为辅：一口辣、一只熊猫、一条老街，三天松着走也够。",
    highlights: [
      "早上去看熊猫，中午前撤出来",
      "火锅和小面分开两顿吃，辣度自己定",
      "老城巷子慢慢逛，不追打卡点",
    ],
  },
  {
    city: "大理",
    days: 4,
    prefs: ["自然风光", "小众冷门"],
    budget: 2400,
    blurb: "环海、上山、进古镇：四天刚好把苍山洱海走成一条不用折返的线。",
    highlights: [
      "环洱海分段骑，别一天赶完",
      "苍山上半天，山下古城留半天",
      "拐进沙溪这类小古镇住一晚",
    ],
  },
  {
    city: "西安",
    days: 4,
    prefs: ["历史文化", "美食"],
    budget: 2000,
    blurb: "两天看遗址、两天吃：白天钻地下，晚上回民街，城墙上去骑一圈。",
    highlights: [
      "兵马俑单独占一天，别顺路加别的",
      "城墙骑行收一段傍晚的风",
      "肉夹馍和泡馍分两顿吃，不互相将就",
    ],
  },
];

/**
 * 把一条示例条件拼成 /new 深链（表单据此预填）。
 *
 * 为什么要编码：城市名和偏好都是中文，未编码在部分浏览器/代理下会被截断；
 * URLSearchParams 同时保证逗号分隔不会被当成参数分隔符。
 */
export function featuredHref(d: FeaturedDestination): string {
  const params = new URLSearchParams({
    city: d.city,
    days: String(d.days),
    prefs: d.prefs.join(","),
  });
  return `/new?${params.toString()}`;
}
