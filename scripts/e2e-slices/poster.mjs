// 切片1 · 海报级分享页 e2e（owner: poster）
//
// 契约：导出 `export async function runSlice(ctx)`，ctx = { check, api, mode }
//   - check(name, cond, detail?)：断言（与 orchestrator 共用计数）
//   - api：makeApi 实例——api.baseUrl / api.post(payload) / api.waitJob(jobId, timeoutMs) /
//     api.postRaw(text) / api.authPost(path, payload) / api.me()
//   - mode："mock"（3103，无高德 key）| "real"（3104，高德桩）
//
// 本切片在两种模式下各跑一遍，断言 /p/<shareId> 的 SSR HTML：
//   1. 海报块渲染：poster-city 城市大标题 + 副题「N 天 · M 站 · 人均 ¥X · 主题」
//   2. 徽章齐全（天数/站点/花费/预算使用率——桩行程有 budgetCny，使用率徽章应出现）
//   3. 路线地图块：mock 无坐标 → 整块不渲染；real 有坐标 → 渲染
//   4. 动态 OG 图：og:image 元数据 + 图路由返回合法 PNG（城市名 + N 天 + 预算）
//   5. 纯增量：旧断言依赖的元素（「也想去」传播 CTA、「链接已失效」兜底页）原样保留
//
// 幂等性：每次运行只生成 1 份新行程（各自独立的 shareId），不依赖执行顺序。

export async function runSlice({ check, api, mode }) {
  const tag = `[${mode}]`;

  // ---- 生成一份 3 天行程（桩 LLM 立即返回 fixture；城市按请求透传）----
  const r = await api.post({ city: "成都", days: 3, budget: 2500, preferences: ["美食"] });
  check(`${tag} 海报：提交 202`, r.status === 202, `got ${r.status}`);
  const j = await api.waitJob(r.body.jobId, 120000);
  check(`${tag} 海报：任务 done`, j.status === "done", JSON.stringify(j).slice(0, 120));
  if (j.status !== "done") return;

  const shareId = j.shareId;
  const city = j.plan?.city ?? "成都";
  const days = j.plan?.days?.length ?? 3;
  check(
    `${tag} 海报：done 返回 shareId`,
    typeof shareId === "string" && shareId.length >= 8,
    `shareId=${shareId}`,
  );
  if (typeof shareId !== "string") return;

  const res = await fetch(`${api.baseUrl}/p/${shareId}`);
  const html = await res.text();
  check(`${tag} 海报：/p/<shareId> → 200`, res.status === 200, `got ${res.status}`);

  // ---- 海报块（从根元素 class="poster" 起截一段，只查海报区域，避免误中页面其他文本）----
  const posterAt = html.indexOf('class="poster"');
  check(`${tag} 海报：根元素渲染`, posterAt >= 0);
  const poster = posterAt >= 0 ? html.slice(posterAt, posterAt + 3000) : "";
  check(
    `${tag} 海报：城市大标题 = ${city}`,
    poster.includes("poster-city") && poster.includes(city),
  );
  check(`${tag} 海报：副题含「${days} 天 · 」`, poster.includes(`${days} 天 · `));
  check(`${tag} 海报：副题含「站」`, poster.includes("站"));
  check(`${tag} 海报：副题含「人均 ¥」`, poster.includes("人均 ¥"));
  // 桩行程带 budgetCny（finalizePlan 回填）→ 预算使用率徽章必须出现
  check(`${tag} 海报：预算使用率徽章`, poster.includes("预算使用率"));

  // ---- 路线地图块：mock 无坐标整块不渲染；real 有坐标渲染（RealMap 懒加载骨架 div）----
  if (mode === "mock") {
    check(`${tag} 海报：MOCK 行程不渲染地图块`, !html.includes("poster-map-wrap"));
  } else {
    check(`${tag} 海报：real 行程渲染地图块`, html.includes("poster-map-wrap"));
  }

  // ---- 旅行报告链接（切片4 在建，链接先就位：指向 /r/<shareId>）----
  check(`${tag} 海报：旅行报告链接 → /r/<shareId>`, html.includes(`href="/r/${shareId}"`));

  // ---- 动态 OG 图：元数据 + 图路由实际出图（城市名 + N 天 + 预算）----
  const ogImg = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  check(`${tag} OG：og:image 元数据存在`, Boolean(ogImg), `og:image=${ogImg ?? "无"}`);
  if (ogImg) {
    const imgRes = await fetch(new URL(ogImg, api.baseUrl));
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const isPng = buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    check(
      `${tag} OG：图路由返回合法 PNG`,
      imgRes.status === 200 && isPng,
      `status=${imgRes.status} bytes=${buf.length}`,
    );
  }

  // ---- 纯增量：旧断言依赖的现有元素原样保留 ----
  check(`${tag} 增量：现有传播 CTA（也想去…）保留`, html.includes("也想去"));
  const expired = await fetch(`${api.baseUrl}/p/job_nonexistent`);
  check(
    `${tag} 增量：无效链接仍显示「链接已失效」`,
    expired.status === 200 && (await expired.text()).includes("链接已失效"),
    `got ${expired.status}`,
  );
}
