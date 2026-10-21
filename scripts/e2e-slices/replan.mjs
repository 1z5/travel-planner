// 切片 e2e · 行中重规划求解器（确定性求解：保留什么、放弃什么、为什么）
//
// 契约：导出 `export async function runSlice(ctx)`，ctx = { check, api, mode }
//   - check(name, cond, detail?)：断言（与 orchestrator 共用计数）
//   - api：makeApi 实例——api.baseUrl / api.post(payload) / api.waitJob(jobId) …
//   - mode："mock"（3103，无高德 key）| "real"（3104，高德桩）
// 本切片在 mock 与 real 两台服务器上各跑一遍，幂等。
//
// 覆盖：
// - mock：行程没有真实 legs → 求解必须 422 诚实降级（不猜时间）；
//   real：行程带真实 legs + 19:00 固定活动 → 15:30 求解出可行子序列，
//   kept/dropped 结构齐全、reason 引用真实约束（活动时间 + 路程分钟）、
//   且**不落库**（原行程未被修改）。
// - 错误路径：缺参 400 / 行程不存在 404 / 越界天数 400 / nowMin 越界 400。

const postReplan = async (baseUrl, payload) => {
  const r = await fetch(`${baseUrl}/api/plan/replan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export async function runSlice({ check, api, mode }) {
  const base = api.baseUrl;

  // ---- 参数路径（不依赖生成的行程，先跑）----
  const missingNow = await postReplan(base, { shareId: "share_doesnotexist00", day: 1 });
  check("replan：缺 nowMin → 400", missingNow.status === 400, `got ${missingNow.status}`);
  const notFound = await postReplan(base, { shareId: "share_doesnotexist00", day: 1, nowMin: 930 });
  check("replan：行程不存在 → 404", notFound.status === 404, `got ${notFound.status}`);
  const badNow = await postReplan(base, { shareId: "share_doesnotexist00", day: 1, nowMin: 1500 });
  check("replan：nowMin 越界（>1439）→ 400", badNow.status === 400, `got ${badNow.status}`);
  const badBody = await postReplan(base, {});
  check("replan：空 body → 400", badBody.status === 400, `got ${badBody.status}`);

  // ============================================================
  // mock 模式：无高德 key → 没有真实路段 → 必须 422 诚实降级
  // ============================================================
  if (mode === "mock") {
    const r = await api.post({ city: "成都", days: 3, budget: 2500, preferences: ["美食"] });
    check("replan(mock)：提交 202", r.status === 202, `got ${r.status}`);
    const j = await api.waitJob(r.body.jobId);
    check("replan(mock)：任务 done", j.status === "done", JSON.stringify(j).slice(0, 120));
    check(
      "replan(mock)：MOCK 行程确实没有真实 legs（降级的数据前提）",
      !(j.plan?.days?.[0]?.legs ?? []).length,
      JSON.stringify(j.plan?.days?.[0]?.legs ?? null),
    );

    // 15:30 问「接下来怎么走」：Day1 还有没走的点，但没有 legs → 422
    const noLegs = await postReplan(base, { shareId: j.shareId, day: 1, nowMin: 930 });
    check(
      "replan(mock)：无真实路段 → 422 诚实降级",
      noLegs.status === 422,
      `got ${noLegs.status} ${JSON.stringify(noLegs.body).slice(0, 120)}`,
    );
    check(
      "replan(mock)：降级文案说明缺真实路程、无法重排，并给出口（不猜时间）",
      /缺少真实路段/.test(String(noLegs.body.error ?? "")) &&
        /无法重排/.test(String(noLegs.body.error ?? "")) &&
        /重排这一天/.test(String(noLegs.body.error ?? "")),
      JSON.stringify(noLegs.body),
    );

    // 当天点已走完：200 + 良性说明（不是失败，也不是 422）
    const allDone = await postReplan(base, { shareId: j.shareId, day: 1, nowMin: 1439 });
    check(
      "replan(mock)：当天点已走完 → 200（良性说明）",
      allDone.status === 200,
      `got ${allDone.status}`,
    );
    check(
      "replan(mock)：文案说明没有剩余安排",
      typeof allDone.body.message === "string" && /走完|无需重排/.test(allDone.body.message),
      JSON.stringify(allDone.body),
    );

    // 越界天数用真行程验 400（顺序：行程存在 → 天数校验）
    const badDay = await postReplan(base, { shareId: j.shareId, day: 9, nowMin: 930 });
    check("replan(mock)：越界天数 → 400", badDay.status === 400, `got ${badDay.status}`);
    return;
  }

  // ============================================================
  // real 模式：真实 legs + 19:00 固定活动 → 求解出可行子序列
  // ============================================================
  // 城市「活动编排测试」让桩把活动点（测试音乐会 18:30-21:30）插进 Day1；
  // events 带 date+time → 路由据此认 19:00 的锚点（不可移动的墙）。
  const r = await api.post({
    city: "活动编排测试",
    days: 3,
    budget: 3000,
    preferences: ["美食"],
    events: [{ name: "测试音乐会", date: "2026-10-10", time: "19:00" }],
  });
  check(
    "replan(real)：提交 202",
    r.status === 202,
    `got ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`,
  );
  const j = await api.waitJob(r.body.jobId, 60000);
  check("replan(real)：任务 done", j.status === "done", JSON.stringify(j).slice(0, 120));
  const d1 = j.plan?.days?.[0] ?? {};
  check(
    "replan(real)：Day1 含固定活动点（求解输入的数据前提）",
    (d1.spots ?? []).some((s) => s.name === "测试音乐会"),
    JSON.stringify((d1.spots ?? []).map((s) => s.name)),
  );
  check(
    "replan(real)：Day1 有真实 legs（数据前提）",
    (d1.legs ?? []).length > 0,
    `legs=${(d1.legs ?? []).length}`,
  );

  // 15:30 站在路口问「接下来怎么走」：正在桃花源记（15:30-16:30），
  // 后面还有 七里山塘 / 酒店 / 19:00 的测试音乐会（墙）
  const solved = await postReplan(base, { shareId: j.shareId, day: 1, nowMin: 930 });
  check(
    "replan(real)：求解 → 200",
    solved.status === 200,
    `got ${solved.status} ${JSON.stringify(solved.body).slice(0, 160)}`,
  );
  check("replan(real)：ok=true（数据齐全，求解完成）", solved.body.ok === true);
  check(
    "replan(real)：kept/dropped/notes 结构齐全",
    Array.isArray(solved.body.kept) &&
      Array.isArray(solved.body.dropped) &&
      Array.isArray(solved.body.notes) &&
      solved.body.kept.every((k) => k.spot && typeof k.newTime === "string") &&
      solved.body.dropped.every((d) => typeof d.name === "string" && typeof d.reason === "string"),
    JSON.stringify({
      kept: solved.body.kept?.map((k) => `${k.spot?.name}=${k.newTime}`),
      dropped: solved.body.dropped?.map((d) => d.name),
    }),
  );

  const kept = solved.body.kept ?? [];
  const dropped = solved.body.dropped ?? [];
  check(
    "replan(real)：固定活动被保留且钉在 19:00（墙本身不可移动）",
    kept.some((k) => k.spot?.name === "测试音乐会" && k.newTime === "19:00-22:00"),
    JSON.stringify(kept.map((k) => `${k.spot?.name}=${k.newTime}`)),
  );
  check(
    "replan(real)：赶不上活动的点被放弃，reason 引用活动时间与真实路程分钟",
    dropped.length > 0 &&
      dropped.every((d) => d.reason.length > 0) &&
      dropped.some((d) => /19:00/.test(d.reason) && /\d+ 分钟/.test(d.reason)),
    JSON.stringify(dropped),
  );
  check(
    "replan(real)：保留的时刻连续（相邻间隔 ≥ 0，不会时间重叠/接不上）",
    kept.every((k, i) => {
      if (i === 0) return true;
      return toMin(k.newTime.split("-")[0]) >= toMin(kept[i - 1].newTime.split("-")[1]);
    }),
    JSON.stringify(kept.map((k) => k.newTime)),
  );

  // 不落库：分享页读到的仍是原行程（酒店 18:40-20:00 没被改写）
  const shareHtml = await (await fetch(`${base}/p/${j.shareId}`)).text();
  check(
    "replan(real)：重排不落库（原行程未被修改——只是建议）",
    shareHtml.includes("18:40-20:00") || shareHtml.includes("18:40\n20:00"),
    "分享页已找不到酒店的原时间 18:40-20:00",
  );

  // 错误路径（用真行程验）
  const badDay = await postReplan(base, { shareId: j.shareId, day: 9, nowMin: 930 });
  check("replan(real)：越界天数 → 400", badDay.status === 400, `got ${badDay.status}`);
  const badNow2 = await postReplan(base, { shareId: j.shareId, day: 1, nowMin: 1500 });
  check("replan(real)：nowMin 越界 → 400", badNow2.status === 400, `got ${badNow2.status}`);
  const badShare = await postReplan(base, { shareId: "share_doesnotexist00", day: 1, nowMin: 930 });
  check("replan(real)：行程不存在 → 404", badShare.status === 404, `got ${badShare.status}`);
}
