// 切片 e2e · 一键克隆（owner: clone）
//
// 契约：导出 `export async function runSlice(ctx)`，ctx = { check, api, mode }
//   - check(name, cond, detail?)：断言（与 orchestrator 共用计数）
//   - api：makeApi 实例——api.baseUrl / api.post(payload) / api.postRaw(text) /
//     api.waitJob(jobId, timeoutMs) / api.authPost(path, payload) / api.me()
//   - mode："mock"（3103，无高德 key）| "real"（3104，高德桩）
// 每个模块在 mock 与 real 两台服务器上各跑一遍——必须幂等、自行判断模式适用性。

// 断言「真克隆」而不是「复制 JSON 改日期」的三条硬证据：
// 1. 克隆走的是同一个异步任务（/api/plan/status 可轮询），不是同步返回的复印件
// 2. 新行程的起止日期 = 用户覆盖的新日期（facts 层据此重新核验闭馆/通勤）
// 3. 新行程有**新的持久 shareId**，与来源无关（v1 无溯源字段，不假装改编）
//
// 为什么 mock 与 real 都跑：real 模式下生成会真走高德桩（POI 验真 + 营业
// 时间），克隆同样要走一遍——这正是克隆与「改日期的复印件」的分水岭。

/** 原行程时间 +7 天错峰（与 CloneCTA 默认值同口径：保留星期几、错开档期） */
const SHIFT = 7;
function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export async function runSlice({ check, api, mode }) {
  console.log(`  [clone] mode=${mode}`);

  // ---- 1) 基线行程：先生成一份可被克隆的行程 ----
  const gen = await api.post({ city: "苏州", budget: 2500 });
  check("克隆：基线行程提交 202", gen.status === 202, `got ${gen.status}`);
  const base = await api.waitJob(gen.body.jobId);
  check("克隆：基线行程 done", base.status === "done", JSON.stringify(base).slice(0, 120));
  const srcShareId = base.shareId;
  check(
    "克隆：基线行程拿到持久 shareId",
    typeof srcShareId === "string" && srcShareId.startsWith("share_"),
    String(srcShareId),
  );
  if (base.status !== "done" || !srcShareId) return; // 基线没成，后面无从谈起

  const clonePost = (payload) => api.authPost("/api/plan/clone", payload);

  // ---- 2) 真克隆：覆盖日期（+7 天错峰），走完整生成管线 ----
  const newStart = `${shiftDate(base.plan.startDate ?? "2026-10-10", SHIFT)}T10:00`;
  const newEnd = `${shiftDate(base.plan.endDate ?? "2026-10-12", SHIFT)}T18:00`;
  const c1 = await clonePost({
    shareId: srcShareId,
    overrides: { startAt: newStart, endAt: newEnd },
  });
  check(
    "克隆：提交 202 + 返回 jobId",
    c1.status === 202 && typeof c1.body.jobId === "string",
    JSON.stringify(c1.body).slice(0, 120),
  );
  const j1 = await api.waitJob(c1.body.jobId);
  check(
    "克隆：任务 done（走完整生成管线，不是同步复制）",
    j1.status === "done",
    JSON.stringify(j1).slice(0, 120),
  );
  if (j1.status !== "done") return;

  const newShareId = j1.shareId;
  check(
    "克隆：新行程有新的持久 shareId（与原行程不同）",
    typeof newShareId === "string" && newShareId.startsWith("share_") && newShareId !== srcShareId,
    `${srcShareId} → ${newShareId}`,
  );
  check(
    "克隆：新行程城市与原行程一致（继承目的地）",
    j1.plan?.city === base.plan?.city,
    `${base.plan?.city} → ${j1.plan?.city}`,
  );
  check(
    "克隆：新行程按新起止时间重排（日期是新档期，不是抄旧的）",
    j1.plan?.startDate === newStart.slice(0, 10) && j1.plan?.endDate === newEnd.slice(0, 10),
    `${j1.plan?.startDate}~${j1.plan?.endDate}（期望 ${newStart.slice(0, 10)}~${newEnd.slice(0, 10)}）`,
  );
  check(
    "克隆：天数按新档期重推（与原行程相同长度）",
    (j1.plan?.days ?? []).length === (base.plan?.days ?? []).length,
    `${(base.plan?.days ?? []).length} → ${(j1.plan?.days ?? []).length}`,
  );
  check(
    "克隆：新行程是完整结构（含体检/总价，不是半成品）",
    typeof j1.plan?.totalCostCny === "number" && Array.isArray(j1.plan?.warnings),
    JSON.stringify({ total: j1.plan?.totalCostCny }),
  );

  // ---- 3) 新链接可打开（新主人即刻能进自己的行程）----
  const page = await (await fetch(`${api.baseUrl}/p/${newShareId}`)).text();
  check(
    "克隆：/p/<新 shareId> 可打开且是同一座城市",
    page.includes(j1.plan?.city ?? ""),
    `status/内容检查失败（城市=${j1.plan?.city}）`,
  );

  // ---- 4) 覆盖预算生效（证明覆盖真的流进了生成输入）----
  const c2 = await clonePost({ shareId: srcShareId, overrides: { budget: 4000 } });
  check("克隆：覆盖预算提交 202", c2.status === 202, JSON.stringify(c2.body).slice(0, 120));
  const j2 = await api.waitJob(c2.body.jobId);
  check(
    "克隆：覆盖预算生效（新行程预算 = 覆盖值）",
    j2.status === "done" && j2.plan?.budgetCny === 4000,
    JSON.stringify({ status: j2.status, budgetCny: j2.plan?.budgetCny }),
  );

  // ---- 5) 错误路径：非法 / 不存在 / 旧链接 / 超天数 ----
  const badFmt = await clonePost({ shareId: "非法!id" });
  check(
    "克隆：非法 shareId → 400",
    badFmt.status === 400,
    `got ${badFmt.status} ${JSON.stringify(badFmt.body).slice(0, 80)}`,
  );

  const missing = await clonePost({ shareId: "share_does_not_exist_000000" });
  check("克隆：不存在的 shareId → 404", missing.status === 404, `got ${missing.status}`);

  const oldJob = await clonePost({ shareId: gen.body.jobId });
  check(
    "克隆：旧 job 链接被拒（只读历史不支持克隆）",
    oldJob.status === 404 && /旧版|只读/.test(String(oldJob.body.error ?? "")),
    `got ${oldJob.status} ${JSON.stringify(oldJob.body).slice(0, 100)}`,
  );

  const tooLong = await clonePost({
    shareId: srcShareId,
    overrides: { startAt: "2026-11-01T10:00", endAt: "2026-11-20T18:00" }, // 20 天
  });
  check(
    "克隆：超过天数上限 → 400 且文案带天数口径",
    tooLong.status === 400 && /1-7 天/.test(String(tooLong.body.error ?? "")),
    `got ${tooLong.status} ${JSON.stringify(tooLong.body).slice(0, 100)}`,
  );

  const badPace = await clonePost({ shareId: srcShareId, overrides: { pace: "extreme" } });
  check("克隆：非法节奏 → 400", badPace.status === 400, `got ${badPace.status}`);
}
