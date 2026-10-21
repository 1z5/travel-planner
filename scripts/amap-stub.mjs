#!/usr/bin/env node
/**
 * 桩高德服务（测试专用）：按官方文档的形状实现端点，
 * 让「真实模式」（AMAP key 已配置）的逻辑在没有真 key 时也可测。
 *
 *   GET /v3/place/text     → pois[0] = { name, address, location, adname, biz_ext }
 *                            location 按 keywords 哈希出**不同坐标**（成都基准
 *                            104.07,30.60 附近偏移）——真实地图要按坐标摆站点，
 *                            固定坐标会让一天内的站点全部重合、地图失去意义。
 *                            biz_ext 按关键词确定性映射评分/营业时间/人均（供 e2e
 *                            断言「营业时间体检」；见 mockBizExt，是测试数据非真实数据）。
 *                            keywords 含「暂停」时 name 追加「(暂停开放)」（模拟真实停业
 *                            状态写法）；含「桃花源记」时返回空（fixture 里的真实 POI，
 *                            测 POI 未命中预警：连真实行程里的店也可能查不到）
 *   GET /v5/direction/driving → route.paths[0].distance 固定 5000 米
 *                            （换算公式 5000/1000/22*60+8 = 22 分钟/段，测试可精确断言）
 *   GET /v3/staticmap      → 1×1 合法 PNG（Content-Type: image/png）。
 *                            缺参数时按高德真实行为返回 HTTP 200 + JSON 错误；
 *                            注意 /api/map 自身会先校验参数、不会把非法参数透传，
 *                            这个错误分支主要用来验证代理层「非图片内容→失败」的防御。
 *
 * 用法：node scripts/amap-stub.mjs [port]   （默认 8899）
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || process.env.AMAP_STUB_PORT || 8899);

// 地图测试点位的基准（成都）：与 fixture 行程城市一致，坐标散落在市域内
const MAP_BASE_LNG = 104.07;
const MAP_BASE_LAT = 30.6;

/** 稳定伪随机哈希（同输入永远同坐标，e2e 可复现） */
function hashText(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) | 0;
  return Math.abs(h);
}

/**
 * 按关键词哈希出坐标：以成都为基准偏移 ±0.06°（约 ±6km，仍在本市域内）。
 * 用 61×61 的散列网格而不是简单取模，尽量减少同一天站点坐标完全重合。
 */
function mockLocation(keywords, index = 0) {
  const h = hashText(`${keywords}#${index}`);
  const lng = MAP_BASE_LNG + ((h % 61) - 30) * 0.002;
  const lat = MAP_BASE_LAT + ((Math.floor(h / 61) % 61) - 30) * 0.002;
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

/**
 * 桩专供测试：按关键词**确定性**构造 biz_ext（字段形状照真实
 * extensions=all 返回：字符串 / 空数组 `[]`，与真机一致）。
 *
 * 这些营业时间**是测试数据、不是真实数据**——目的是让 e2e 能精确断言
 * 「营业时间体检」的三种结论（fixture 默认起始日 2026-10-10，Day3=10-12 周一）：
 * - 拙政园    09:00 开门 → fixture Day1 08:00 到 → outside（「09:00 才开门」）
 * - 苏州博物馆 周一闭馆 → 用于验证 closed 分支/文案
 * - 同里古镇   周一闭馆 → fixture Day3（2026-10-12）正是周一 → closed
 * - 餐饮类给人均 cost（预算/人均展示可断言）
 * - 其它给 00:00-24:00，避免给无关 POI 制造营业时间噪声告警
 *
 * 真实高德的营业时间原文要复杂得多（季节分段/日期段/夜游/最晚进入），
 * 那些格式由 tests/lib/poi-hours.test.ts 用真机原文覆盖；桩只负责让 e2e 稳定可断言。
 */
function mockBizExt(keywords) {
  if (keywords.includes("拙政园")) {
    return { open_time: "09:00-17:00", opentime2: "周一至周日 09:00-17:00", rating: "4.9" };
  }
  if (keywords.includes("苏州博物馆")) {
    return { open_time: [], opentime2: "周二至周日 09:00-17:00；周一 全天不开放", rating: "4.8" };
  }
  if (keywords.includes("同里古镇")) {
    return { open_time: [], opentime2: "周二至周日 08:00-17:00；周一 全天不开放", rating: "4.6" };
  }
  if (/菜馆|饭店|面馆|茶酒楼|餐厅/.test(keywords)) {
    return { open_time: [], opentime2: "周一至周日 10:30-22:00", cost: "65.00" };
  }
  return { open_time: [], opentime2: "周一至周日 00:00-24:00" };
}

/** 高德用名称表达停业状态（真实样本「金沙遗址博物馆(暂停开放)」）；桩里含「暂停」即模拟 */
function mockPoiName(keywords) {
  return keywords.includes("暂停") ? `${keywords}(暂停开放)` : keywords;
}

// 最小合法 PNG（1×1 透明）。e2e 只需断言 Content-Type 与 PNG 魔数，
// 与真实底图尺寸无关——/api/map 的尺寸语义由路由自身校验。
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const keywords = url.searchParams.get("keywords") ?? "";
  const city = url.searchParams.get("city") ?? "";
  console.log(`[amap-stub] ${path} keywords=${keywords || "-"}`);

  if (path === "/v3/place/text") {
    // 境外/无覆盖目的地：按 city 参数判断（桩约定 city 含「境外」即境外场景）。
    // 高德仅覆盖国内，境外城市的 POI 全部搜不到——实测京都 case。
    if (city.includes("境外")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "1", info: "OK", count: "0", pois: [] }));
      return;
    }
    // 「桃花源记」故意搜不到：验证 POI 未命中预警（fixture 中 Day1 的真实 POI）
    if (keywords.includes("桃花源记")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "1", info: "OK", count: "0", pois: [] }));
      return;
    }
    // 候选检索（事实先行）：带 page_size 的请求要返回**列表**——
    // 这正是「生成前取材」与「生成后验真」在 API 形状上的区别（见 lib/amap.ts
    // 的 searchPois 与 lookupPoi）。没带 page_size 的仍是单点验真，形状不变。
    const pageSize = Number(url.searchParams.get("page_size") ?? "0");
    if (pageSize > 1) {
      const isFood = /餐厅|美食|小吃|餐饮/.test(keywords);
      // 候选名跟着检索词走（不同品类 → 不同地点），同名同址的会被上层去重
      const label = keywords.replace(/^\S+\s*/, "").trim() || "地点";
      const count = Math.min(pageSize, 6);
      const pois = Array.from({ length: count }, (_, i) => ({
        name: `${label}${i + 1}`,
        address: `${label}${i + 1} 地址`,
        location: mockLocation(`${label}${i + 1}`, i),
        adname: "测试区",
        city: city || "成都市",
        pname: "四川省",
        // 高德 type 字段是「大类|小类」中文名，上层靠它归类景点/餐饮
        type: isFood ? "餐饮服务|中餐厅" : "风景名胜|公园广场",
        biz_ext: isFood
          ? { open_time: [], opentime2: "周一至周日 10:30-22:00", cost: "65.00", rating: "4.5" }
          : // 景点带「周一闭馆」：让 e2e 能断言「闭馆日已在生成前被标注出来」
            { open_time: [], opentime2: "周二至周日 09:00-17:00；周一 全天不开放", rating: "4.7" },
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "1", info: "OK", count: String(pois.length), pois }));
      return;
    }
    // offset>1 时（补全接口）返回多条建议，让 suggest 的下游逻辑可测
    const offset = Number(url.searchParams.get("offset") ?? "1");
    const pois =
      offset > 1
        ? [1, 2, 3].map((n) => ({
            name: mockPoiName(`${keywords}建议${n}`),
            address: `测试地址${n}`,
            location: mockLocation(keywords, n),
            adname: "测试区",
            city: "成都市",
            pname: "四川省",
            biz_ext: mockBizExt(keywords),
          }))
        : [
            {
              name: mockPoiName(keywords),
              address: "测试地址",
              location: mockLocation(keywords),
              adname: "测试区",
              city: "成都市",
              pname: "四川省",
              biz_ext: mockBizExt(keywords),
            },
          ];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "1", info: "OK", count: String(pois.length), pois }));
    return;
  }

  if (path === "/v3/staticmap") {
    // 静态地图：校验参数形状（缺 location/zoom/size/scale 时按高德真实行为
    // 返回 HTTP 200 + JSON 错误，而不是图片——这样 /api/map 的 502 映射可被 e2e 验证）
    const location = url.searchParams.get("location") ?? "";
    const zoom = url.searchParams.get("zoom") ?? "";
    const size = url.searchParams.get("size") ?? "";
    const scale = url.searchParams.get("scale") ?? "";
    const okParams =
      /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(location) &&
      /^\d+$/.test(zoom) &&
      /^\d+\*\d+$/.test(size) &&
      (scale === "1" || scale === "2");
    if (!okParams) {
      console.log(
        `[amap-stub] /v3/staticmap 参数非法 location=${location || "-"} zoom=${zoom || "-"} size=${size || "-"} scale=${scale || "-"}`,
      );
      res.writeHead(200, { "Content-Type": "application/json;charset=UTF-8" });
      res.end(JSON.stringify({ status: "0", info: "INVALID_PARAMS", infocode: "20000" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    });
    res.end(PNG_1X1);
    return;
  }

  // 分段路线：三种交通方式都支持（routeSegment 按 transportMode 选端点）。
  // 距离固定 5000 米/段；walking/bicycling 的时长在 path.duration，driving 在
  // path.cost.duration——两处都给，覆盖 routeSegment 的两种取值路径。
  // steps 里故意放一条带 HTML 标签的和一条空串，验证 routeSegment 的清洗逻辑。
  // 分段路线：三种交通方式都支持（routeSegment 按 transportMode 选端点）。
  //
  // 关键：桩必须**按交通方式还原各自的真实形状**，不能图省事给所有方式造同一份
  // 数据。真机直连实测（踩过）：walking/bicycling 的时长在 path.cost.duration、
  // 顶层没有 duration；**driving 全链路都不返回时长**（paths[0] 只有
  // distance/restriction/steps）。此前给 driving 也造了假 duration，结果
  // routeSegment 按「driving 有时长」写的分支在桩下永远命中、测试全绿，真机
  // 却 legs 全空。所以 driving 这里**故意不给时长**，逼 routeSegment 走
  // 「从距离折算」那条路——桩要能抓出这类形状不匹配，而不是盖住它。
  //
  // distance 固定 5000 米/段（routeSegment 折算 5000/1000/22*60+8 = 22 分钟/段）。
  // steps 里放一条带 HTML 标签的和一条空串，验证清洗逻辑。
  if (path === "/v5/direction/walking" || path === "/v5/direction/bicycling") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "1",
        info: "OK",
        route: {
          paths: [
            {
              distance: "5000",
              cost: { duration: "600" },
              steps: [
                { instruction: "向东北步行<b>341</b>米左转" },
                { instruction: "沿道路直行200米" },
                { instruction: "   " },
                { instruction: "到达目的地" },
              ],
            },
          ],
        },
      }),
    );
    return;
  }
  if (path === "/v5/direction/driving") {
    // driving 真实形状：无任何时长字段（见上方注释）
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "1",
        info: "OK",
        route: {
          paths: [
            {
              distance: "5000",
              restriction: "0",
              steps: [
                { instruction: "沿道路向东行驶162米向左后方行驶" },
                { instruction: "沿道路向西行驶14米右转" },
                { instruction: "   " },
                { instruction: "到达目的地" },
              ],
            },
          ],
        },
      }),
    );
    return;
  }

  if (path === "/v3/weather/weatherInfo") {
    // 天气预报（实时定位后的天气提示用）。返回 fixture 行程所在日期
    // （2026-10-10 ~ 10-12）的预报，其中 10-10 刻意设为「小雨」——
    // 这样 phaseB 的行程（Day1 有室外景点）应触发天气提示，可精确断言。
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "1",
        info: "OK",
        forecasts: [
          {
            city: "成都市",
            casts: [
              {
                date: "2026-10-10",
                week: "6",
                dayweather: "小雨",
                nightweather: "多云",
                daytemp: "24",
                nighttemp: "18",
                daywind: "北",
                nightwind: "北",
                daypower: "1-3",
                nightpower: "1-3",
              },
              {
                date: "2026-10-11",
                week: "7",
                dayweather: "晴",
                nightweather: "晴",
                daytemp: "26",
                nighttemp: "19",
                daywind: "北",
                nightwind: "北",
                daypower: "1-3",
                nightpower: "1-3",
              },
              {
                date: "2026-10-12",
                week: "1",
                dayweather: "多云",
                nightweather: "晴",
                daytemp: "25",
                nighttemp: "18",
                daywind: "北",
                nightwind: "北",
                daypower: "1-3",
                nightpower: "1-3",
              },
            ],
          },
        ],
      }),
    );
    return;
  }

  if (path === "/v3/geocode/regeo") {
    // 逆地理编码（实时定位用）。按坐标区分两种**真实形态**（均已用真实 key 验证）：
    //   坐标以 116.4 开头 → 直辖市：addressComponent.city 是空数组
    //                       （高德把 city 与 province 合一，实测天安门如此）
    //   其他               → 普通城市：city 带「市」后缀
    const location = url.searchParams.get("location") ?? "";
    const isMunicipality = location.startsWith("116.4");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "1",
        info: "OK",
        regeocode: {
          addressComponent: isMunicipality
            ? { city: [], province: "北京市", district: "朝阳区" }
            : { city: "成都市", province: "四川省", district: "武侯区" },
          formatted_address: isMunicipality
            ? "北京市朝阳区望京街道方恒国际中心"
            : "四川省成都市武侯区武侯祠大街",
        },
      }),
    );
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[amap-stub] listening on http://127.0.0.1:${PORT}`);
});
