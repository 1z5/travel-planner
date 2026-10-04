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

  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[amap-stub] listening on http://127.0.0.1:${PORT}`);
});
