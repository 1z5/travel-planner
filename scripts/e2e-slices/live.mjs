// 切片 e2e · 流式生长体验（owner: live）
//
// 契约：导出 `export async function runSlice(ctx)`，ctx = { check, api, mode }
//   - check(name, cond, detail?)：断言（与 orchestrator 共用计数）
//   - api：makeApi 实例——api.baseUrl / api.post(payload) / api.postRaw(text) /
//     api.waitJob(jobId, timeoutMs) / api.authPost(path, payload) / api.me()
//   - mode："mock"（3103，无高德 key）| "real"（3104，高德桩）
// 每个模块在 mock 与 real 两台服务器上各跑一遍——必须幂等、自行判断模式适用性。
//
// 本切片断言的诚实契约（红线：遥测撒谎比没有遥测更糟）：
//   ≥5 天流式任务（两模式都跑）：
//     1. running 响应含 stage，且每个取值都在枚举内（outline/grounding/day:N/M/finalizing）
//     2. stage 序列单调不回退（管线只前进）——遥测不会「倒车」
//     3. day:N/M 的 N ≤ daysReady：遥测永远不领先于真实交付（滞后可接受，领先是撒谎）
//     4. daysReady 单调不减（与编排器用例 14 同口径，防前缀发布回归）
//     5. 最终 done 且 5 天齐全
//   ≤4 天单次任务（两模式都跑，用「挂起测试城市」造可观测窗口）：
//     6. running 响应含 stage（grounding/generating/verify/finalizing 之一）
//     7. running 响应里**没有任何百分比字段**——拿不到就不假装（单次路径只有
//        indeterminate，草稿天数不是生成天数，plan.draft 必须如实为 true）
//     8. 挂起任务诚实中止（error + 「中止」文案）——遥测全程不谎称完成
//        （只验 mock：real 服务器 stream 兜底是默认 10 分钟，不等它终止）
//
// 配额注意：未登录配额 50/天/服务器（orchestrator 已用掉大部分），本切片
// 每个服务器用 2 个任务（≥5 天 + ≤4 天挂起）。429 时跳过并明说——
// 配额耗尽不是本切片的缺陷，不该误报成功能失败。

/** 枚举成员表：与服务端 lib/jobs.ts 的 JobStage 一一对应 */
const STREAM_STAGES = new Set(["outline", "grounding", "finalizing"]);
const SINGLE_STAGES = new Set(["grounding", "generating", "verify", "finalizing"]);
function stageRank(stage) {
  // 管线顺序（只前进不回退）：outline < grounding < day:N/M < finalizing
  if (stage === "outline") return 0;
  if (stage === "grounding") return 1;
  if (stage.startsWith("day:")) return 2;
  if (stage === "finalizing") return 3;
  return -1; // 未知取值
}

/** 高频轮询：任务在 mock 下单次路径 ~100ms 就完成，必须密集采样才看得到 running */
async function pollObserve(baseUrl, jobId, { intervalMs = 25, maxMs = 90_000 } = {}) {
  const observations = [];
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await fetch(`${baseUrl}/api/plan/status?id=${jobId}`);
    const d = await r.json().catch(() => ({}));
    if (d.status === "done" || d.status === "error") {
      observations.push(d);
      return { final: d, observations };
    }
    observations.push(d);
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return { final: { status: "timeout" }, observations };
}

export async function runSlice({ check, api, mode }) {
  console.log(`  [live] mode=${mode}`);

  // ================= 用例 1：≥5 天流式任务（两模式都跑） =================

  const gen = await api.post({
    city: "流式测试城市",
    startAt: "2026-10-01T10:00",
    endAt: "2026-10-05T18:00", // 5 天
    budget: 5000,
    preferences: ["美食"],
  });
  if (gen.status === 429) {
    console.log("  [live] 配额已用完（429），跳过本切片（非功能缺陷）");
    return;
  }
  check("流式：5 天提交 202", gen.status === 202, `got ${gen.status}`);
  if (gen.status !== 202) return;

  const { final, observations } = await pollObserve(api.baseUrl, gen.body.jobId);
  check(
    "流式：任务最终 done",
    final.status === "done",
    JSON.stringify(final).slice(0, 120),
  );
  check(
    "流式：最终 5 天齐全",
    (final.plan?.days ?? []).length === 5,
    `got ${(final.plan?.days ?? []).length}`,
  );

  // ---- 阶段遥测断言 ----
  const running = observations.filter((o) => o.status === "running");
  check(
    "流式：轮询中观测到 running 中间态（不是干等到全量）",
    running.length > 0,
    `共 ${observations.length} 次观测`,
  );

  const withStage = running.filter((o) => typeof o.stage === "string" && o.stage.length > 0);
  check(
    "流式：running 响应透传 stage（增量字段）",
    withStage.length > 0,
    `${running.length} 次 running 中 ${withStage.length} 次带 stage`,
  );

  const badStage = withStage.filter((o) => {
    if (STREAM_STAGES.has(o.stage)) return false;
    return !/^day:\d+\/\d+$/.test(o.stage);
  });
  check(
    "流式：stage 取值全部在枚举内（outline/grounding/day:N/M/finalizing）",
    badStage.length === 0,
    JSON.stringify(badStage.map((o) => o.stage).slice(0, 5)),
  );

  // 遥测序列单调不回退（管线只前进；day:N/M 内部 N 也应不减）
  let monotonic = true;
  let lastRank = -1;
  let lastN = -1;
  for (const o of withStage) {
    const r = stageRank(o.stage);
    if (r < lastRank) monotonic = false;
    lastRank = Math.max(lastRank, r);
    const dm = /^day:(\d+)\/(\d+)$/.exec(o.stage);
    if (dm) {
      const n = Number(dm[1]);
      if (n < lastN) monotonic = false;
      lastN = Math.max(lastN, n);
    }
  }
  check(
    "流式：stage 序列单调不回退（outline→grounding→day→finalizing，遥测不倒车）",
    monotonic,
    JSON.stringify(withStage.map((o) => o.stage).slice(0, 12)),
  );

  // 诚实红线：day:N/M 的 N 永远不领先于 daysReady（真实交付）。
  // 遥测写在快照落库之后（见 lib/jobs.ts publishReady），所以只可能滞后。
  const ahead = withStage.filter((o) => {
    const dm = /^day:(\d+)\/(\d+)$/.exec(o.stage);
    return dm && Number(dm[1]) > (o.daysReady ?? 0);
  });
  check(
    "流式：遥测不领先真实交付（day:N/M 的 N ≤ daysReady）",
    ahead.length === 0,
    JSON.stringify(ahead.map((o) => ({ stage: o.stage, daysReady: o.daysReady })).slice(0, 5)),
  );

  // 观测到逐日推进：day:N/M 出现且 N 至少递增过一次（真正逐天长出来）
  const dayObs = withStage
    .map((o) => /^day:(\d+)\/(\d+)$/.exec(o.stage))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  check(
    "流式：观测到逐日推进（day:N/M 且 N 递增）",
    dayObs.length > 0 && new Set(dayObs).size >= 2,
    JSON.stringify(dayObs),
  );

  // daysReady 单调不减 + 始终是连续前缀（与编排器用例 14 同口径，防回归）
  const seenDays = [];
  for (const o of running) {
    if (typeof o.daysReady === "number" && seenDays[seenDays.length - 1] !== o.daysReady) {
      seenDays.push(o.daysReady);
    }
  }
  check(
    "流式：daysReady 单调不减（无回退）",
    seenDays.every((v, i) => i === 0 || v >= seenDays[i - 1]),
    JSON.stringify(seenDays),
  );
  check(
    "流式：部分行程始终是天数连续前缀（不乱序不跳号）",
    running.every((o) => {
      const p = o.plan?.days;
      if (!Array.isArray(p) || p.length === 0) return true;
      return p.map((x) => x.day).join(",") === Array.from({ length: p.length }, (_, i) => i + 1).join(",");
    }),
  );

  // ================= 用例 2：≤4 天单次路径（两模式都跑） =================
  //
  // 为什么用「挂起测试城市」而不是普通城市：mock 桩的普通单次响应是毫秒级，
  // 整条管线（草稿→取事实→生成→验真→收尾）50ms 内跑完，POST 的 202 还没
  // 回到脚本任务就已经 done——**根本观测不到 running 中间态**（实测 5ms
  // 密采样 ×5 次全部采到 done）。挂起城市让桩挂住连接不吐数据，管线停在
  // generating（stream 总时长兜底 = 8s）——这正是生产里 3-5 分钟长等待的
  // 缩影，也是阶段遥测最该起作用的场景。断言的是遥测契约（stage 存在、
  // 无假百分比、草稿如实标记），与 LLM 快慢无关。

  const gen2 = await api.post({
    city: "挂起测试城市",
    startAt: "2026-10-10T10:00",
    endAt: "2026-10-12T18:00", // 3 天 → 单次调用路径
    budget: 2500,
  });
  if (gen2.status === 429) {
    console.log("  [live] 配额已用完（429），跳过单次路径用例（非功能缺陷）");
    return;
  }
  check("单次：3 天提交 202", gen2.status === 202, `got ${gen2.status}`);
  if (gen2.status !== 202) return;

  const { final: singleFinal, observations: obs2 } = await pollObserve(
    api.baseUrl,
    gen2.body.jobId,
    { intervalMs: 250, maxMs: 30_000 },
  );
  const running2 = obs2.filter((o) => o.status === "running" && o.stage);

  check(
    "单次：running 中间态可观测（挂起窗口内持续在跑，不是干等）",
    running2.length >= 3,
    `${running2.length} 次带 stage 的 running 观测`,
  );
  check(
    "单次：stage 取值在枚举内（grounding/generating/verify/finalizing）",
    running2.every((o) => SINGLE_STAGES.has(o.stage)),
    JSON.stringify([...new Set(running2.map((o) => o.stage))]),
  );
  check(
    "单次：观测到 generating 阶段（单次路径真正的长等待）",
    running2.some((o) => o.stage === "generating"),
    JSON.stringify([...new Set(running2.map((o) => o.stage))]),
  );
  check(
    "单次：无假百分比——running 响应里没有任何百分比字段",
    running2.every((o) => !Object.keys(o).some((k) => /pct|percent|progress/i.test(k))),
    JSON.stringify(Object.keys(running2[0] ?? {})),
  );
  // 草稿如实标记：单次路径 running 时 plan 里的天是即时草稿（draft=true），
  // 不是已生成的天——前端据此只画 indeterminate 条，不把草稿当天数报进度
  check(
    "单次：running 时 plan 如实标记草稿（draft=true，不冒充已生成）",
    running2.every((o) => !o.plan || o.plan.draft === true),
    JSON.stringify({ draft: running2[0]?.plan?.draft }),
  );
  // 终态诚实（只验 mock）：mock 服务器把 stream 总时长兜底压到 8s，挂起任务
  // 按兜底中止报 error（不是 done）——遥测全程显示 generating，没有任何阶段
  // 谎称「完成」；配额按失败路径退还。real 服务器没压阈值（默认 10 分钟），
  // 不等它终止（套件结束会连服务器一起回收，不留脏状态）。
  if (mode === "mock") {
    check(
      "单次：挂起任务诚实中止（error 且消息带「中止」，不假装成功）",
      singleFinal.status === "error" && /中止/.test(String(singleFinal.error ?? "")),
      JSON.stringify({ status: singleFinal.status, error: singleFinal.error }).slice(0, 120),
    );
  }
}
