// 城市模板（产品线 B2）：SEO / 内容获取层的「条件模板」，不是已核验行程。
//
// 为什么做：SEO 调研（2026-10）里「城市/天数 行程」是搜索量最大的长尾（小红书、
// 马蜂窝、知乎都是这套结构），而我们的 /new 要求用户先自己想清楚「去哪/几天/喜欢
// 什么」——冷启动摩擦全压在用户身上。这些页面提供的是「起手条件」：城市 + 3/4/5
// 天的条件组合，点一下就把条件带进表单，生成时仍然逐条核验真实世界。
//
// 诚实口径（不可违反，与 lib/featured-destinations.ts 同源）：
// 1. 这不是已核验行程，页面上必须标注「示例条件」——不写具体 POI 的营业时间、
//    评分、票价，不写「热门/爆款/必去榜」这类编造或竞价性质的措辞；
// 2. 每条 variant 只描述「条件与节奏」（天数/偏好/预算量级/一句话味道），
//    不冒充事实；
// 3. 纯数据 + 纯函数，无 IO，客户端组件可安全 import。

export interface CityVariant {
  /** 3 / 4 / 5 天（与表单起止时间支持区间一致；模板只做这三档） */
  days: 3 | 4 | 5;
  /** 出行偏好，取值必须落在 lib/pref-options.ts 的白名单内 */
  prefs: readonly string[];
  /** 人均预算（元，不含大交通）——示例条件的量级，不是报价 */
  budget: number;
  /** 一句话说清「这几天的条件是什么样」 */
  blurb: string;
}

export interface CityTemplate {
  city: string;
  /** URL slug（拼音）；必须唯一，且只含小写字母与连字符 */
  slug: string;
  /** 区域标签（如「川西」「江南」），用于列表分组观感，不是行政区划承诺 */
  region: string;
  /** 一句话城市气质（方向性描述，不是事实断言） */
  tagline: string;
  /** 适合的季节（一句人话，不是气候数据） */
  season: string;
  variants: readonly CityVariant[];
}

export const CITY_TEMPLATES: readonly CityTemplate[] = [
  {
    city: "成都",
    slug: "chengdu",
    region: "川西",
    tagline: "吃得不将就，走得也不赶：老城、熊猫和一顿正经火锅。",
    season: "春秋最舒服，夏天避午后的晒",
    variants: [
      {
        days: 3,
        prefs: ["美食", "历史文化"],
        budget: 1600,
        blurb: "三天：老城巷子 + 一个博物馆级去处 + 一晚夜市，中间留出喝咖啡的时间。",
      },
      {
        days: 4,
        prefs: ["美食", "自然风光"],
        budget: 2100,
        blurb: "四天：老城两天 + 近郊一天 + 留一天机动，吃和逛分开排。",
      },
      {
        days: 5,
        prefs: ["美食", "历史文化", "自然风光"],
        budget: 2600,
        blurb: "五天：把近郊和古镇都放进来，最后一天只留轻松的收尾。",
      },
    ],
  },
  {
    city: "西安",
    slug: "xian",
    region: "关中",
    tagline: "城墙里外都是历史，但别把一天塞满三个博物馆。",
    season: "春秋宜人，冬天风大",
    variants: [
      {
        days: 3,
        prefs: ["历史文化", "美食"],
        budget: 1500,
        blurb: "三天：城墙内一天 + 一个重量级遗址半天 + 回民街一顿，节奏别太满。",
      },
      {
        days: 4,
        prefs: ["历史文化"],
        budget: 1900,
        blurb: "四天：把东线（兵马俑方向）单独占一天，避免来回通勤。",
      },
      {
        days: 5,
        prefs: ["历史文化", "美食", "博物馆"],
        budget: 2400,
        blurb: "五天：主城区两天 + 东线一天 + 一天机动给排队与体力。",
      },
    ],
  },
  {
    city: "杭州",
    slug: "hangzhou",
    region: "江南",
    tagline: "西湖不只有一圈水，周边山里的茶和寺更安静。",
    season: "春看花、秋闻桂，梅雨季备室内",
    variants: [
      {
        days: 3,
        prefs: ["自然风光", "Citywalk"],
        budget: 1800,
        blurb: "三天：西湖东岸走一天，山里茶园半天，剩下半天留给河坊街。",
      },
      {
        days: 4,
        prefs: ["自然风光", "小众冷门"],
        budget: 2300,
        blurb: "四天：西湖两天 + 龙井/寺庙半天 + 一天去周边古镇当天往返。",
      },
      {
        days: 5,
        prefs: ["自然风光", "Citywalk", "拍照打卡"],
        budget: 2800,
        blurb: "五天：主城两天 + 西湖深度一天 + 周边两天，避免每天折返。",
      },
    ],
  },
  {
    city: "苏州",
    slug: "suzhou",
    region: "江南",
    tagline: "园林要一个一个看，平江路要一段一段走。",
    season: "春秋最佳，雨天也有味道",
    variants: [
      {
        days: 3,
        prefs: ["历史文化", "Citywalk"],
        budget: 1700,
        blurb: "三天：两个园林 + 平江路一段 + 一天去古镇（当天往返）。",
      },
      {
        days: 4,
        prefs: ["历史文化", "博物馆"],
        budget: 2100,
        blurb: "四天：园林两天、博物馆半天、古镇一天，夜里留时间走河。",
      },
      {
        days: 5,
        prefs: ["历史文化", "小众冷门"],
        budget: 2500,
        blurb: "五天：主城两天半 + 两个古镇各半天，别一天赶两个古镇。",
      },
    ],
  },
  {
    city: "大理",
    slug: "dali",
    region: "滇西",
    tagline: "环海、上山、进古镇：别一天赶完洱海。",
    season: "春秋舒服，雨季带备选",
    variants: [
      {
        days: 3,
        prefs: ["自然风光", "小众冷门"],
        budget: 1800,
        blurb: "三天：洱海分段骑/开一段 + 古城半天 + 苍山半天。",
      },
      {
        days: 4,
        prefs: ["自然风光", "拍照打卡"],
        budget: 2300,
        blurb: "四天：环海分成两段，中间留一天只逛古镇与咖啡。",
      },
      {
        days: 5,
        prefs: ["自然风光", "小众冷门", "美食"],
        budget: 2700,
        blurb: "五天：海西一天、海东一天、苍山半天，其余留给发呆。",
      },
    ],
  },
  {
    city: "重庆",
    slug: "chongqing",
    region: "山城",
    tagline: "立体城市靠腿，坡多别贪心：一天两个片区就够。",
    season: "春秋宜人，夏天避开正午",
    variants: [
      {
        days: 3,
        prefs: ["美食", "Citywalk"],
        budget: 1500,
        blurb: "三天：渝中一天 + 南岸一天 + 一晚看夜景，别把过江当散步。",
      },
      {
        days: 4,
        prefs: ["美食", "拍照打卡"],
        budget: 1900,
        blurb: "四天：主城两天 + 近郊半天 + 留半天给排队和小面。",
      },
      {
        days: 5,
        prefs: ["美食", "Citywalk", "小众冷门"],
        budget: 2300,
        blurb: "五天：主城两天半 + 周边一天 + 一天机动，坡多留体力。",
      },
    ],
  },
  {
    city: "厦门",
    slug: "xiamen",
    region: "闽南",
    tagline: "岛内慢慢走，岛外当天往返，别把船票排太紧。",
    season: "春秋舒服，台风季看预报",
    variants: [
      {
        days: 3,
        prefs: ["自然风光", "Citywalk"],
        budget: 1600,
        blurb: "三天：岛内环岛走一段 + 老街区半天 + 一天去鼓浪屿（看船票）。",
      },
      {
        days: 4,
        prefs: ["自然风光", "美食"],
        budget: 2000,
        blurb: "四天：岛内两天 + 鼓浪屿一天 + 集美/环岛路一天。",
      },
      {
        days: 5,
        prefs: ["自然风光", "拍照打卡", "美食"],
        budget: 2400,
        blurb: "五天：岛内两天 + 鼓浪屿一天 + 周边两天，海边留出日落时间。",
      },
    ],
  },
  {
    city: "青岛",
    slug: "qingdao",
    region: "胶东",
    tagline: "海边城市别只拍海：老城坡道和啤酒馆才是日常。",
    season: "5-10 月适合看海，冬天风大",
    variants: [
      {
        days: 3,
        prefs: ["自然风光", "Citywalk"],
        budget: 1700,
        blurb: "三天：老城一天 + 海边一天 + 半天市场与啤酒。",
      },
      {
        days: 4,
        prefs: ["自然风光", "美食"],
        budget: 2100,
        blurb: "四天：老城一天半 + 海边一天 + 崂山方向半天。",
      },
      {
        days: 5,
        prefs: ["自然风光", "拍照打卡", "美食"],
        budget: 2500,
        blurb: "五天：市区两天 + 崂山一天 + 海边两天，避开正午暴晒。",
      },
    ],
  },
  {
    city: "长沙",
    slug: "changsha",
    region: "湘中",
    tagline: "白天博物馆，晚上夜市；辣度自己定，别硬撑。",
    season: "春秋最好，夏天夜出",
    variants: [
      {
        days: 3,
        prefs: ["美食", "博物馆"],
        budget: 1400,
        blurb: "三天：博物馆半天 + 老城一天 + 两个晚上给夜市。",
      },
      {
        days: 4,
        prefs: ["美食", "历史文化"],
        budget: 1800,
        blurb: "四天：主城两天 + 岳麓方向半天 + 一天机动给排队。",
      },
      {
        days: 5,
        prefs: ["美食", "夜生活", "博物馆"],
        budget: 2100,
        blurb: "五天：主城两天半 + 周边一天 + 晚上单独安排，不挤白天。",
      },
    ],
  },
  {
    city: "南京",
    slug: "nanjing",
    region: "江南",
    tagline: "城的尺度大，别一天跨两个区：选一片走深。",
    season: "春秋佳，梅雨季备室内",
    variants: [
      {
        days: 3,
        prefs: ["历史文化", "博物馆"],
        budget: 1600,
        blurb: "三天：城中一天 + 一个遗址/博物馆半天 + 秦淮晚间一段。",
      },
      {
        days: 4,
        prefs: ["历史文化", "Citywalk"],
        budget: 2000,
        blurb: "四天：主城两天 + 东郊半天 + 一天给大学城/江边。",
      },
      {
        days: 5,
        prefs: ["历史文化", "博物馆", "小众冷门"],
        budget: 2400,
        blurb: "五天：主城三天 + 东郊一天 + 一天机动，别把通勤算漏。",
      },
    ],
  },
  {
    city: "北京",
    slug: "beijing",
    region: "华北",
    tagline: "预约与安检是变量：一天一个大片区，别贪多。",
    season: "春秋最佳，冬天室内为主",
    variants: [
      {
        days: 3,
        prefs: ["历史文化", "博物馆"],
        budget: 1900,
        blurb: "三天：中轴一天 + 一个博物馆半天 + 胡同/公园半天。",
      },
      {
        days: 4,
        prefs: ["历史文化"],
        budget: 2300,
        blurb: "四天：城区两天 + 近郊（长城方向）一天 + 一天机动。",
      },
      {
        days: 5,
        prefs: ["历史文化", "博物馆", "Citywalk"],
        budget: 2800,
        blurb: "五天：城区三天 + 近郊一天 + 一天只留休息与补漏。",
      },
    ],
  },
  {
    city: "上海",
    slug: "shanghai",
    region: "江南",
    tagline: "城市很大，按片区排：一天一个街区，别横穿。",
    season: "春秋舒服，梅雨季备室内",
    variants: [
      {
        days: 3,
        prefs: ["Citywalk", "美食"],
        budget: 2000,
        blurb: "三天：老城/外滩一天 + 一个街区一天 + 半天看展。",
      },
      {
        days: 4,
        prefs: ["Citywalk", "博物馆"],
        budget: 2400,
        blurb: "四天：城区三天 + 半天近郊，晚上留给吃。",
      },
      {
        days: 5,
        prefs: ["Citywalk", "拍照打卡", "美食"],
        budget: 2900,
        blurb: "五天：城区三天 + 近郊一天 + 一天机动，通勤优先地铁。",
      },
    ],
  },
];

/** slug → 模板（找不到返回 undefined，路由翻 404） */
export function cityTemplateBySlug(slug: string): CityTemplate | undefined {
  return CITY_TEMPLATES.find((c) => c.slug === slug);
}

/** 城市名 → 模板（用于详情页互链，找不到返回 undefined） */
export function cityTemplateByCity(city: string): CityTemplate | undefined {
  return CITY_TEMPLATES.find((c) => c.city === city);
}

/** 模板条件的深链：/new?city=…&days=…&prefs=…
 *  与 lib/featured-destinations.ts 的 featuredHref 同构（客户端自己也会再校验白名单） */
export function templateHref(city: string, days: number, prefs: readonly string[]): string {
  const q = new URLSearchParams({ city, days: String(days) });
  if (prefs.length > 0) q.set("prefs", prefs.join(","));
  return `/new?${q.toString()}`;
}
