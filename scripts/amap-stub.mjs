#!/usr/bin/env node
/**
 * 桩高德服务（测试专用）：按官方文档的形状实现端点，
 * 让「真实模式」（AMAP key 已配置）的逻辑在没有真 key 时也可测。
 *
 *   GET /v3/place/text     → pois[0] = { name, address, location, adname }
 *                            location 按 keywords 哈希出**不同坐标**（成都基准
 *                            104.07,30.60 附近偏移）——真实地图要按坐标摆站点，
 *                            固定坐标会让一天内的站点全部重合、地图失去意义。
 *                            keywords 含「桃花源记」时返回空（fixture 里的真实 POI，
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
    // offset>1 时（补全接口）返回多条建议，让 suggest 的下游逻辑可测
    const offset = Number(url.searchParams.get("offset") ?? "1");
    const pois = offset > 1
      ? [1, 2, 3].map((n) => ({
          name: `${keywords}建议${n}`,
          address: `测试地址${n}`,
          location: mockLocation(keywords, n),
          adname: "测试区",
          city: "成都市",
          pname: "四川省",
        }))
      : [{
          name: keywords,
          address: "测试地址",
          location: mockLocation(keywords),
          adname: "测试区",
          city: "成都市",
          pname: "四川省",
        }];
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
      console.log(`[amap-stub] /v3/staticmap 参数非法 location=${location || "-"} zoom=${zoom || "-"} size=${size || "-"} scale=${scale || "-"}`);
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
  if (path === "/v5/direction/walking" || path === "/v5/direction/bicycling" || path === "/v5/direction/driving") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "1", info: "OK",
      route: {
        paths: [{
          distance: "5000",
          duration: "600",
          cost: { duration: "700" },
          steps: [
            { instruction: "向东北步行<b>341</b>米左转" },
            { instruction: "沿道路直行200米" },
            { instruction: "   " },
            { instruction: "到达目的地" },
          ],
        }],
      },
    }));
    return;
  }

  if (path === "/v3/weather/weatherInfo") {
    // 天气预报（实时定位后的天气提示用）。返回 fixture 行程所在日期
    // （2026-10-10 ~ 10-12）的预报，其中 10-10 刻意设为「小雨」——
    // 这样 phaseB 的行程（Day1 有室外景点）应触发天气提示，可精确断言。
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "1", info: "OK",
      forecasts: [{
        city: "成都市",
        casts: [
          { date: "2026-10-10", week: "6", dayweather: "小雨", nightweather: "多云", daytemp: "24", nighttemp: "18", daywind: "北", nightwind: "北", daypower: "1-3", nightpower: "1-3" },
          { date: "2026-10-11", week: "7", dayweather: "晴", nightweather: "晴", daytemp: "26", nighttemp: "19", daywind: "北", nightwind: "北", daypower: "1-3", nightpower: "1-3" },
          { date: "2026-10-12", week: "1", dayweather: "多云", nightweather: "晴", daytemp: "25", nighttemp: "18", daywind: "北", nightwind: "北", daypower: "1-3", nightpower: "1-3" },
        ],
      }],
    }));
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
    res.end(JSON.stringify({
      status: "1", info: "OK",
      regeocode: {
        addressComponent: isMunicipality
          ? { city: [], province: "北京市", district: "朝阳区" }
          : { city: "成都市", province: "四川省", district: "武侯区" },
        formatted_address: isMunicipality
          ? "北京市朝阳区望京街道方恒国际中心"
          : "四川省成都市武侯区武侯祠大街",
      },
    }));
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[amap-stub] listening on http://127.0.0.1:${PORT}`);
});
