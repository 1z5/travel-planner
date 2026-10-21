// 切片 e2e · 旅程报告（/r/<token>）
//
// 契约：导出 `export async function runSlice(ctx)`，ctx = { check, api, mode }
//   - check(name, cond, detail?)：断言（与 orchestrator 共用计数）
//   - api：makeApi 实例——api.baseUrl / api.post(payload) / api.postRaw(text) /
//     api.waitJob(jobId, timeoutMs) / api.authPost(path, payload) / api.me()
//   - mode："mock"（3103，无高德 key）| "real"（3104，高德桩）
// 每个模块在 mock 与 real 两台服务器上各跑一遍——必须幂等、自行判断模式适用性。
//
// 本切片的断言在两台机器上都成立：站点数/城市名/餐厅名都来自行程本体
// （不依赖 legs 与高德），因此不按 mode 分支。
export async function runSlice({ check, api }) {
  // 桩 LLM 对「苏州 3 天」恒返回 fixture：16 站（无重名）、6 景点、6 餐厅、
  // 总价 1925。城市与统计数字是真实字段算出来的，不依赖 MOCK/real 模式。
  const r = await api.post({ city: "苏州", days: 3, budget: 2500, preferences: ["美食"] });
  check("报告：提交 202", r.status === 202, `got ${r.status}`);
  const j = await api.waitJob(r.body.jobId);
  check("报告：任务 done", j.status === "done", JSON.stringify(j).slice(0, 120));
  const shareId = j.shareId;
  check(
    "报告：done 返回 shareId",
    typeof shareId === "string" && shareId.startsWith("share_"),
    JSON.stringify(shareId),
  );

  const res = await fetch(`${api.baseUrl}/r/${shareId}`);
  const html = await res.text();
  check("/r/<shareId> → 200", res.status === 200, `got ${res.status}`);
  check("报告页含城市名（苏州）", html.includes("苏州"));
  // 「行程包含 16 站」由 computeTripReport 从真实字段算出——全页最稳的统计
  // 钩子（不依赖 legs/地图/状态判定）。
  check("报告页含站点数（行程包含 16 站）", html.includes("行程包含 16 站"));
  check("报告页含「旅行报告」标题", html.includes("旅行报告"));
  check("报告页含餐饮清单标题（行程餐饮）", html.includes("行程餐饮"));
  // 餐厅名来自行程数据（真实 POI 名），清单真的渲染了而不是只有标题
  check("报告页含真实餐厅名（老苏州茶酒楼）", html.includes("老苏州茶酒楼"));
  check("报告页含餐饮家数徽章（6 家）", html.includes(">6 家<"));
  check("报告页含路线回顾（第 1 天）", html.includes("路线回顾") && html.includes("第 1 天"));
  check("报告页含回到行程链接（/p/<shareId>）", html.includes(`/p/${shareId}`));
  // 诚实声明：传播物必须自证只陈述行程，不冒充打卡回忆
  check("报告页含诚实声明（不包含行中打卡与消费记录）", html.includes("不包含行中打卡与消费记录"));
  // 红线守卫：没有行中确认数据，任何「打卡了 X」叙事都不允许出现
  check("报告页无打卡叙事（没有行中确认数据不编造回忆）", !/打卡了|已打卡|你打卡/.test(html));
  // 动态 OG：城市 + 报告（分享到微信/Twitter 的卡片预览）
  check(
    "报告页 OG 标题含城市与「旅行报告」",
    /og:title" content="[^"]*苏州[^"]*旅行报告/.test(html),
    (html.match(/<meta property="og:title" content="([^"]+)"/) ?? ["", "无"])[1],
  );

  // 无效 token → 与 /p、/t 同口径的友好失效页（200，不是 500）
  const bad = await fetch(`${api.baseUrl}/r/share_doesnotexist00`);
  const badHtml = await bad.text();
  check(
    "/r 无效 token → 200 + 链接已失效",
    bad.status === 200 && badHtml.includes("链接已失效"),
    `got ${bad.status}`,
  );

  // 旧 jobId 链接：任务 TTL 内与 /p 同口径兜底可读（resolvePlan 的兼容路径）
  const legacy = await fetch(`${api.baseUrl}/r/${r.body.jobId}`);
  const legacyHtml = await legacy.text();
  check(
    "/r/<旧 jobId> 兜底可读（与 /p 同一 resolvePlan 口径）",
    legacy.status === 200 && legacyHtml.includes("苏州"),
    `got ${legacy.status}`,
  );
}
