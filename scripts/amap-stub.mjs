#!/usr/bin/env node
/**
 * 桩高德服务（测试专用）：按官方文档的形状实现两个端点，
 * 让「真实模式」（AMAP key 已配置）的逻辑在没有真 key 时也可测。
 *
 *   GET /v3/place/text     → pois[0] = { name, address, location:"116.40,39.90", adname }
 *                            keywords 含「桃花源记」时返回空（fixture 里的真实 POI，
 *                            测 POI 未命中预警：连真实行程里的店也可能查不到）
 *   GET /v5/direction/driving → route.paths[0].distance 固定 5000 米
 *                            （换算公式 5000/1000/22*60+8 = 22 分钟/段，测试可精确断言）
 *
 * 用法：node scripts/amap-stub.mjs [port]   （默认 8899）
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || process.env.AMAP_STUB_PORT || 8899);

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const keywords = url.searchParams.get("keywords") ?? "";
  console.log(`[amap-stub] ${path} keywords=${keywords || "-"}`);

  if (path === "/v3/place/text") {
    // 「桃花源记」故意搜不到：验证 POI 未命中预警（fixture 中 Day1 的真实 POI）
    if (keywords.includes("桃花源记")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "1", info: "OK", count: "0", pois: [] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "1", info: "OK", count: "1",
      pois: [{
        name: keywords,
        address: "测试地址",
        location: "116.400000,39.900000",
        adname: "测试区",
      }],
    }));
    return;
  }

  if (path === "/v5/direction/driving") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "1", info: "OK",
      route: { paths: [{ distance: "5000", duration: "600" }] },
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
