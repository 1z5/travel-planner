// 切片 e2e · 产品内 Trip Check（/api/plan/check + /api/plan/repair + 修复写回）
//
// 契约：导出 `export async function runSlice(ctx)`，ctx = { check, api, mode }
//   - check(name, cond, detail?)：断言（与 orchestrator 共用计数）
//   - api：makeApi 实例——api.baseUrl / api.post(payload) / api.waitJob(jobId) …
//   - mode："mock"（3103，无高德 key，无真实 legs → 通常 changed=false）| "real"
//     （3104，高德桩：每段固定 22 分钟，和 fixture 时刻对不上 → 通常 changed=true）
// 本切片在 mock 与 real 两台服务器上各跑一遍，必须幂等（每次生成自己的一份新行程）。
//
// 覆盖：
//  - check：200（两轴 report + tc_ 凭据 + 数字 planRevision + tripCheck=null）；
//    同一行程重复 check → 凭据 ID 相同（只读、不推进版本）；与开放端点 /api/verify
//    的 shareId 路径凭据一致（产品内/开放口径不分叉）
//  - 旧 job 链接：check 200 + planRevision=null（resolvePlan 只读兜底）；repair → 404
//  - repair 预览：persisted:false、planRevision 不变、parentCredential.id = check 凭据；
//    changed=true 时 applied 非空且子凭据 ≠ 父凭据，changed=false 时两者相同
//  - repair 确认：
//    * changed=true → persisted:true、revision=旧+1、plan.tripCheck 凭据链与力度、
//      再 check 版本/tripCheck 一致、/p 页面显示修复记录、结论不劣于修复前
//    * changed=false → persisted:false、revision 不变、tripCheck 仍为 null（没写就不装）
//  - 错误路径：expectedRevision 传错 → 409 {revision}；未知 shareId → 404；缺参 → 400
//
// 配额注意：只生成 1 份行程（每台服务器），429 时跳过并明说（与 live 切片同口径）。
// 请求数 <20/服务器；plan-check 120/h、plan-repair 30/h 的限流桶都远未打满。

/** 通用 JSON POST：始终把 text 也带回来（空 body/非 JSON 由断言暴露，不静默） */
async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 响应（框架 500 HTML 等）不静默：body 保持 null，交给断言暴露
  }
  return { status: res.status, headers: res.headers, body, text };
}

/** 凭据格式：tc_ + 32 位十六进制（见 lib/verify/credential.ts） */
const TC_ID = /^tc_[0-9a-f]{32}$/;

export async function runSlice({ check, api, mode }) {
  const base = api.baseUrl;
  console.log(`  [plan-check] mode=${mode}`);

  // ============================================================
  // 0) 参数 / 不存在路径（不依赖生成，先跑）
  // ============================================================
  const noParamCheck = await postJson(`${base}/api/plan/check`, {});
  check(
    "产品内体检：缺 shareId → 400（errors 可编程处理）",
    noParamCheck.status === 400 && typeof noParamCheck.body?.error === "string",
    `got ${noParamCheck.status} ${JSON.stringify(noParamCheck.body).slice(0, 120)}`,
  );
  const noParamRepair = await postJson(`${base}/api/plan/repair`, {});
  check(
    "产品内修复：缺 shareId → 400",
    noParamRepair.status === 400 && typeof noParamRepair.body?.error === "string",
    `got ${noParamRepair.status}`,
  );
  const unknownCheck = await postJson(`${base}/api/plan/check`, {
    shareId: "share_doesnotexist00",
  });
  check(
    "产品内体检：未知 shareId → 404",
    unknownCheck.status === 404 && unknownCheck.body?.error === "行程不存在或已被删除",
    `got ${unknownCheck.status} ${JSON.stringify(unknownCheck.body)}`,
  );
  const unknownRepair = await postJson(`${base}/api/plan/repair`, {
    shareId: "share_doesnotexist00",
  });
  check(
    "产品内修复：未知 shareId → 404",
    unknownRepair.status === 404,
    `got ${unknownRepair.status}`,
  );

  // ============================================================
  // 1) 生成 1 份行程（桩 LLM；mock/real 都用 苏州 3 天 fixture）
  // ============================================================
  const gen = await api.post({ city: "苏州", days: 3, budget: 2500, preferences: ["美食"] });
  if (gen.status === 429) {
    console.log("  [plan-check] 生成配额已用完（429），跳过本切片（非功能缺陷）");
    return;
  }
  check("产品内体检：提交生成 202", gen.status === 202, `got ${gen.status}`);
  const job = await api.waitJob(gen.body.jobId, 120000);
  check("产品内体检：生成任务 done", job.status === "done", JSON.stringify(job).slice(0, 120));
  const shareId = job.shareId;
  check(
    "产品内体检：done 返回持久分享 token",
    typeof shareId === "string" && shareId.startsWith("share_"),
    String(shareId),
  );
  if (typeof shareId !== "string") return;

  // ============================================================
  // 2) check：两轴报告 + 凭据 + revision；只读（重复调用结论相同）
  // ============================================================
  const first = await postJson(`${base}/api/plan/check`, { shareId });
  check(
    "产品内体检：check → 200",
    first.status === 200,
    `got ${first.status} ${JSON.stringify(first.body).slice(0, 160)}`,
  );
  const firstReport = first.body?.report ?? {};
  check(
    "产品内体检：report 两轴齐全（结构 grade + 事实 state）",
    ["A", "B", "C", "D"].includes(firstReport.verdict?.consistency?.grade) &&
      typeof firstReport.verdict?.facts?.state === "string",
    JSON.stringify({
      grade: firstReport.verdict?.consistency?.grade,
      facts: firstReport.verdict?.facts?.state,
    }),
  );
  check(
    "产品内体检：返回可复算凭据（tc_ + 32 hex）",
    TC_ID.test(first.body?.credential?.id ?? ""),
    String(first.body?.credential?.id),
  );
  check(
    "产品内体检：planRevision 是数字（修复/撤销的并发基准）",
    Number.isInteger(first.body?.planRevision) && first.body.planRevision >= 1,
    JSON.stringify(first.body?.planRevision),
  );
  check(
    "产品内体检：新生成的行程 tripCheck 为 null（没修过就不编修复历史）",
    first.body?.tripCheck === null,
    JSON.stringify(first.body?.tripCheck),
  );
  check(
    "产品内体检：shareId 原样回传（调用方可断言对应行程）",
    first.body?.shareId === shareId,
    String(first.body?.shareId),
  );

  // 只读：同一行程再 check 一次，凭据 ID 与版本都不变（时间只影响时间戳）
  const second = await postJson(`${base}/api/plan/check`, { shareId });
  check(
    "产品内体检：重复 check → 同一凭据 ID（只读、可复算）",
    second.body?.credential?.id === first.body?.credential?.id,
    `${second.body?.credential?.id} vs ${first.body?.credential?.id}`,
  );
  check(
    "产品内体检：重复 check 不推进版本",
    second.body?.planRevision === first.body?.planRevision,
    `${second.body?.planRevision} vs ${first.body?.planRevision}`,
  );

  // 与开放端点同口径：/api/verify 的 shareId 路径应给出同一个凭据 ID
  const openVerify = await postJson(`${base}/api/verify`, { shareId });
  check(
    "产品内体检：与开放端点 /api/verify 的凭据一致（同一套判定，不分叉）",
    openVerify.body?.credential?.id === first.body?.credential?.id,
    `${openVerify.body?.credential?.id} vs ${first.body?.credential?.id}`,
  );

  // ============================================================
  // 3) 旧 job 链接：可体检（只读）但没有 revision，且不可修复
  // ============================================================
  const legacy = await postJson(`${base}/api/plan/check`, { shareId: gen.body.jobId });
  check(
    "产品内体检：旧 job 链接 → 200 且 planRevision=null（只读兜底）",
    legacy.status === 200 && legacy.body?.planRevision === null,
    `got ${legacy.status} ${JSON.stringify(legacy.body?.planRevision)}`,
  );
  const legacyRepair = await postJson(`${base}/api/plan/repair`, { shareId: gen.body.jobId });
  check(
    "产品内修复：旧 job 链接只读 → 404（不允许修改历史任务结果）",
    legacyRepair.status === 404,
    `got ${legacyRepair.status} ${JSON.stringify(legacyRepair.body).slice(0, 120)}`,
  );

  // ============================================================
  // 4) repair 预览：不写库、不推进版本，前后凭据与 check 对得上
  // ============================================================
  const preview = await postJson(`${base}/api/plan/repair`, { shareId });
  check(
    "产品内修复：预览 → 200（先看后写）",
    preview.status === 200,
    `got ${preview.status} ${JSON.stringify(preview.body).slice(0, 160)}`,
  );
  check(
    "产品内修复：预览 persisted:false（不写库）",
    preview.body?.persisted === false,
    JSON.stringify(preview.body?.persisted),
  );
  check(
    "产品内修复：预览不推进 revision",
    preview.body?.planRevision === first.body?.planRevision,
    `${preview.body?.planRevision} vs ${first.body?.planRevision}`,
  );
  check(
    "产品内修复：changed 是 boolean（调用方据此决定是否确认写入）",
    typeof preview.body?.changed === "boolean",
    JSON.stringify(preview.body?.changed),
  );
  check(
    "产品内修复：parentCredential 与 check 凭据一致（同一输入 → 同一 ID）",
    preview.body?.parentCredential?.id === first.body?.credential?.id,
    `${preview.body?.parentCredential?.id} vs ${first.body?.credential?.id}`,
  );
  if (preview.body?.changed === true) {
    check(
      "产品内修复：有机械修复时 applied 非空、子凭据 ≠ 父凭据",
      Array.isArray(preview.body.applied) &&
        preview.body.applied.length > 0 &&
        TC_ID.test(preview.body?.credential?.id ?? "") &&
        preview.body.credential.id !== preview.body.parentCredential?.id,
      `${preview.body?.parentCredential?.id} → ${preview.body?.credential?.id}`,
    );
  } else {
    check(
      "产品内修复：没有机械修复时 applied 为空、子凭据 = 父凭据（文档没变）",
      Array.isArray(preview.body?.applied) &&
        preview.body.applied.length === 0 &&
        preview.body?.credential?.id === preview.body?.parentCredential?.id,
      JSON.stringify(preview.body?.applied),
    );
  }

  // ============================================================
  // 5) repair 确认：changed=true 真写入（revision+1 + tripCheck 凭据链）；
  //    changed=false 明确不写（不为了「看起来有用」而改行程）
  // ============================================================
  const confirmed = await postJson(`${base}/api/plan/repair`, {
    shareId,
    confirm: true,
    expectedRevision: preview.body?.planRevision,
  });
  if (preview.body?.changed === true) {
    check(
      "产品内修复：确认写入 → persisted:true / changed:true",
      confirmed.status === 200 &&
        confirmed.body?.persisted === true &&
        confirmed.body?.changed === true,
      `got ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 200)}`,
    );
    check(
      "产品内修复：revision = 旧版本 + 1",
      confirmed.body?.revision === preview.body.planRevision + 1,
      `${confirmed.body?.revision} vs ${preview.body?.planRevision} + 1`,
    );
    check(
      "产品内修复：写入的 Plan.tripCheck 记录前后凭据链与次数",
      confirmed.body?.plan?.tripCheck?.credentialId === confirmed.body?.credential?.id &&
        confirmed.body?.plan?.tripCheck?.parentCredentialId ===
          confirmed.body?.parentCredential?.id &&
        confirmed.body?.plan?.tripCheck?.repairCount >= 1 &&
        confirmed.body?.plan?.tripCheck?.applied === confirmed.body?.applied?.length,
      JSON.stringify(confirmed.body?.plan?.tripCheck ?? null),
    );
    // 再体检：版本与新凭据要落到同一个 Plan 上（写回后 check 不能还看到旧版本）
    const after = await postJson(`${base}/api/plan/check`, { shareId });
    check(
      "产品内体检：写入后再 check → planRevision 为新版本、tripCheck 非空",
      after.status === 200 &&
        after.body?.planRevision === confirmed.body?.revision &&
        after.body?.tripCheck?.credentialId === confirmed.body?.credential?.id,
      JSON.stringify({
        revision: after.body?.planRevision,
        tripCheck: after.body?.tripCheck ?? null,
      }),
    );
    check(
      "产品内体检：修复后结论不劣于修复前（同一把尺子，分数/阻断）",
      after.body?.report?.verdict?.consistency?.score >= firstReport.verdict?.consistency?.score &&
        after.body?.report?.stats?.blocking <= firstReport.stats?.blocking,
      JSON.stringify({
        before: [firstReport.verdict?.consistency?.score, firstReport.stats?.blocking],
        after: [
          after.body?.report?.verdict?.consistency?.score,
          after.body?.report?.stats?.blocking,
        ],
      }),
    );
    // 分享页是产品内最终证据：修复历史必须可见（不是只在 API 里有）
    const pageRes = await fetch(`${base}/p/${shareId}`);
    const pageHtml = await pageRes.text();
    check(
      "产品内修复：/p 分享页显示修复记录（已确定性修复 / 修复链）",
      pageRes.status === 200 && (pageHtml.includes("已确定性修复") || pageHtml.includes("修复链")),
      `got ${pageRes.status}`,
    );
  } else {
    check(
      "产品内修复：无机械修复时确认 → persisted:false / changed:false（不写）",
      confirmed.status === 200 &&
        confirmed.body?.persisted === false &&
        confirmed.body?.changed === false,
      `got ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 160)}`,
    );
    check(
      "产品内修复：无机械修复时不推进 revision",
      confirmed.body?.planRevision === preview.body?.planRevision,
      `${confirmed.body?.planRevision} vs ${preview.body?.planRevision}`,
    );
    const after = await postJson(`${base}/api/plan/check`, { shareId });
    check(
      "产品内体检：未写入时 check 版本与 tripCheck 均不变",
      after.body?.planRevision === preview.body?.planRevision && after.body?.tripCheck === null,
      JSON.stringify({
        revision: after.body?.planRevision,
        tripCheck: after.body?.tripCheck ?? null,
      }),
    );
  }

  // ============================================================
  // 6) 版本冲突：expectedRevision 与当前不符 → 409（不覆盖别人的修改）
  // ============================================================
  const conflict = await postJson(`${base}/api/plan/repair`, {
    shareId,
    confirm: true,
    expectedRevision: 999,
  });
  check(
    "产品内修复：expectedRevision 传错 → 409 且返回当前 revision",
    conflict.status === 409 &&
      typeof conflict.body?.error === "string" &&
      Number.isInteger(conflict.body?.revision),
    `got ${conflict.status} ${JSON.stringify(conflict.body).slice(0, 160)}`,
  );
}
