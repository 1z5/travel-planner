#!/usr/bin/env node
/**
 * M2 验收脚本：拿到高德 key 后跑一遍，5 秒出 verdict。
 *
 *   npm run verify:amap        # 会用 .env 里的 AMAP_WEB_SERVICE_KEY 打真实接口
 *
 * 依次验证：① key 是否有效 ② POI 验真（place/text）③ 通勤估算（v5/direction/driving，
 * 地名先解析坐标——与 lib/amap.ts 相同路径）。任一失败给出可操作的原因。
 */
const KEY = process.env.AMAP_WEB_SERVICE_KEY;
const BASE = process.env.AMAP_BASE_URL || "https://restapi.amap.com";

if (!KEY) {
  console.log("❌ .env 里没有 AMAP_WEB_SERVICE_KEY");
  console.log("");
  console.log("申请步骤：");
  console.log("  1. 打开 https://console.amap.com/dev/key/app");
  console.log("  2. 创建应用 → 添加 Key → 服务平台选「Web服务」");
  console.log("  3. 把 key 填进 .env 的 AMAP_WEB_SERVICE_KEY=，重跑本命令");
  process.exitCode = 1;
} else {
  await verify();
}

async function verify() {
  let pass = 0;
  let locA = "";

  // ---- ① POI 验真：搜一个必然存在的 POI ----
  const probePoi = "成都武侯祠";
  const url1 = new URL(`${BASE}/v3/place/text`);
  url1.searchParams.set("key", KEY);
  url1.searchParams.set("keywords", probePoi);
  url1.searchParams.set("city", "成都");
  url1.searchParams.set("citylimit", "true");
  url1.searchParams.set("offset", "1");

  try {
    const d1 = await (await fetch(url1)).json();
    if (d1.status === "1" && d1.pois?.length) {
      pass += 1;
      const poi = d1.pois[0];
      console.log(`✅ POI 验真可用：「${poi.name}」→ 坐标 ${poi.location}`);
      locA = poi.location;
    } else {
      console.log(`❌ POI 验真失败: status=${d1.status} info=${d1.info}`);
      if (d1.info === "INVALID_USER_KEY") {
        console.log("   → key 无效：检查是否复制完整、服务平台是否选了「Web服务」");
      } else if (d1.info === "DAILY_QUERY_OVER_LIMIT") {
        console.log("   → 日配额已用尽（个人免费 key 有日上限），明天恢复或申请提额");
      } else if (d1.info === "USER_DAILY_QUERY_OVER_LIMIT") {
        console.log("   → 该 key 日调用量超限");
      }
      process.exitCode = 1;
    }
  } catch (e) {
    console.log(`❌ POI 验真请求异常: ${e?.message ?? String(e)}`);
    process.exitCode = 1;
  }

  // ---- ② 通勤矩阵：再解析一个 POI，算两点间距离 ----
  if (pass === 1) {
    const dest = "成都杜甫草堂";
    const url2 = new URL(`${BASE}/v3/place/text`);
    url2.searchParams.set("key", KEY);
    url2.searchParams.set("keywords", dest);
    url2.searchParams.set("city", "成都");
    url2.searchParams.set("citylimit", "true");
    const d2 = await (await fetch(url2)).json();
    const locB = d2?.pois?.[0]?.location;
    if (!locB) {
      console.log(`❌ 目的地解析失败（${dest}），无法测试距离矩阵`);
      process.exitCode = 1;
    } else {
      const url3 = new URL(`${BASE}/v5/direction/driving`);
      url3.searchParams.set("key", KEY);
      url3.searchParams.set("origin", locA);
      url3.searchParams.set("destination", locB);
      const d3 = await (await fetch(url3)).json();
      const meters = Number(d3?.route?.paths?.[0]?.distance);
      if (Number.isFinite(meters) && meters > 0) {
        const minutes = Math.round(meters / 1000 / 22 * 60 + 8);
        console.log(`✅ 通勤矩阵可用：武侯祠→杜甫草堂 ${(meters / 1000).toFixed(1)}km ≈ ${minutes} 分钟（应用同款换算）`);
        pass += 1;
      } else {
        console.log(`❌ 距离矩阵失败: status=${d3.status} info=${d3.info}`);
        if (d3.info === "INVALID_USER_KEY") console.log("   → key 无效");
        if (d3.info === "DAILY_QUERY_OVER_LIMIT") console.log("   → 日配额超限");
        process.exitCode = 1;
      }
    }
  }

  if (pass === 2) {
    console.log("\n🟢 高德 key 完全可用。接下来：");
    console.log("  1. 重启 dev server（npm run dev）——.env 变更需要重启");
    console.log("  2. 前端提交任意行程，页面上应显示「POI 已通过高德验真」（不再有 MOCK 标注）");
    console.log("  3. 想跑系统评估：告诉我，我起 20 个 case 的验真率/绕路误报率评测");
  }
}
