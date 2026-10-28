// 切片 e2e · Trip Check 公开体检 API（开放标准 / schema / CORS / MCP / 体验台 / 修复）
//
// 契约：导出 `export async function runSlice(ctx)`，ctx = { check, api, mode }
//   - check(name, cond, detail?)：断言（与 orchestrator 共用计数）
//   - api：makeApi 实例——api.baseUrl / api.post(payload) / api.waitJob(jobId) …
//   - mode："mock"（3103，无高德 key）| "real"（3104，高德桩）
// 本切片在 mock 与 real 两台服务器上各跑一遍，必须幂等。
//
// 覆盖：
//  - GET /api/verify 元信息（规范/引擎/规则版本 + schema/docs 指针 + 版本响应头）
//  - GET /api/verify/schema（JSON Schema 2020-12 契约 + Cache-Control + CORS）
//  - OPTIONS 预检 → 204 + 完整 CORS 头（浏览器第三方站点可直接调用）
//  - 合法文档 → 200（两轴 grade + 凭据）；**同一输入两次 credential.id 相同**（可复算）；
//    换 pace 口径 → 凭据 id 变化（口径可追）
//  - 非法 JSON → 400 invalid_json；非法文档 → 400 invalid_request 且 errors 带 path
//  - 未知 shareId → 404 not_found；>256KiB body → 413 payload_too_large
//  - MCP：initialize / tools/list / tools/call（verify_itinerary）/ 通知 202
//  - /verify 体验台 200 且含「行程体检」
//  - shareId 路径：真实生成一份行程后 200；mock 下 facts 不得是 verified（诚实降级）
//  - 修复（document）：破损文档 → 200 changed:true / applied 含 TC-C102 / delta.improved；
//    前后凭据格式与「修复后文档再体检 = 修复响应 credential.id」的对账链；干净文档
//    changed:false 且 delta 为 0；非法 body 400 / 未知 share 404 / GET 405
//  - 修复（shareId）：只读建议（persisted:false, source:share），父凭据与该行程体检凭据一致，
//    mock 下只改时间不影响事实状态
//
// 配额注意：只生成 1 份行程（每台服务器）；429 时跳过 shareId 路径并明说——
// 配额耗尽不是本切片的缺陷（与 live 切片同口径）。体检/修复端点本身是确定性计算，
// 每台服务器 <20 次请求，远低于 VERIFY_HOURLY_LIMIT（默认 120），不影响其他切片。

const SPEC_VERSION = "trip-check/0.1";
/** body 上限（与 app/api/verify/route.ts、app/api/verify/repair/route.ts 的 MAX_BODY_BYTES 同步） */
const MAX_BODY_BYTES = 256 * 1024;

// 合法样例：1 天 2 点 + 真实路段 + 全量事实，预期 100 分 A 级 / facts verified。
// 刻意内联（不 import lib/verify/samples.ts）：切片是独立 .mjs，不能跑 TS；
// 同时也验证「第三方照公开文档写的 JSON」能直接过，不依赖本仓样例对象。
const SAMPLE_DOC = {
  specVersion: SPEC_VERSION,
  id: "e2e_verify_sample",
  city: "苏州",
  budgetCny: 800,
  days: [
    {
      day: 1,
      date: "2026-11-03",
      spots: [
        {
          name: "拙政园",
          time: "09:00-11:00",
          type: "sight",
          durationMin: 120,
          costCny: 80,
          location: "120.629,31.324",
          hours: { openTime: "周一至周日 07:30-17:30" },
          verification: { source: "amap", existence: "hit", hours: "hit" },
        },
        {
          name: "平江路",
          time: "11:30-13:00",
          type: "sight",
          durationMin: 90,
          costCny: 60,
          location: "120.631,31.317",
          hours: { openTime: "24小时营业" },
          verification: { source: "amap", existence: "hit", hours: "hit" },
        },
      ],
      legs: [{ from: "拙政园", to: "平江路", mode: "walking", durationMin: 20, distanceM: 1300 }],
    },
  ],
};

// 破损样例（修复用）：第 2 个点与第 1 个点重叠 30 分钟 → TC-C102 blocking。
// 故意不给 legs（C104 缺路段数据是 info，修复器不能编造通勤耗时）——修复后应只
// 消除 C102、结构与评分回到 A，而 C104 仍如实留在 remainingRuleIds 里。
const BROKEN_DOC = {
  specVersion: SPEC_VERSION,
  id: "e2e_repair_broken",
  city: "苏州",
  days: [
    {
      day: 1,
      spots: [
        { name: "拙政园", time: "09:00-11:00", type: "sight", durationMin: 120, costCny: 80 },
        { name: "平江路", time: "10:30-12:00", type: "sight", durationMin: 90, costCny: 60 },
      ],
    },
  ],
};

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
    // 非 JSON 响应（例如框架 500 HTML）不静默：body 保持 null，交给断言暴露
  }
  return { status: res.status, headers: res.headers, body, text };
}

export async function runSlice({ check, api, mode }) {
  const base = api.baseUrl;
  console.log(`  [verify] mode=${mode}`);

  // ============================================================
  // 0) 服务可发现性：元信息 + schema + CORS 预检
  // ============================================================
  const metaRes = await fetch(`${base}/api/verify`);
  const meta = await metaRes.json().catch(() => ({}));
  check("体检：GET /api/verify → 200", metaRes.status === 200, `got ${metaRes.status}`);
  check(
    "体检：元信息带规范/引擎/规则版本",
    meta.specVersion === SPEC_VERSION &&
      typeof meta.engineVersion === "string" &&
      meta.engineVersion.length > 0 &&
      typeof meta.rulesetVersion === "string" &&
      meta.rulesetVersion.length > 0,
    JSON.stringify(meta),
  );
  check(
    "体检：元信息指向 schema 契约与体验台",
    meta.schema === "/api/verify/schema" && meta.docs === "/verify",
    JSON.stringify({ schema: meta.schema, docs: meta.docs }),
  );
  check(
    "体检：响应头声明规范版本（X-Trip-Check-Spec）",
    metaRes.headers.get("x-trip-check-spec") === SPEC_VERSION,
    String(metaRes.headers.get("x-trip-check-spec")),
  );
  check(
    "体检：GET 也带 CORS（第三方站点可直接读元信息）",
    metaRes.headers.get("access-control-allow-origin") === "*",
    String(metaRes.headers.get("access-control-allow-origin")),
  );

  const schemaRes = await fetch(`${base}/api/verify/schema`);
  const schema = await schemaRes.json().catch(() => ({}));
  check("体检：GET /api/verify/schema → 200", schemaRes.status === 200, `got ${schemaRes.status}`);
  check(
    "体检：schema 是 JSON Schema 2020-12 契约（含 days/spot 定义）",
    String(schema.$schema ?? "").includes("2020-12") &&
      Boolean(schema.properties?.days) &&
      Boolean(schema.$defs?.spot),
    JSON.stringify({ $schema: schema.$schema, defs: Object.keys(schema.$defs ?? {}) }),
  );
  check(
    "体检：schema 允许公共缓存 1 小时",
    /max-age=3600/.test(schemaRes.headers.get("cache-control") ?? ""),
    String(schemaRes.headers.get("cache-control")),
  );
  check(
    "体检：schema 带 CORS",
    schemaRes.headers.get("access-control-allow-origin") === "*",
    String(schemaRes.headers.get("access-control-allow-origin")),
  );

  const preflight = await fetch(`${base}/api/verify`, { method: "OPTIONS" });
  const allowMethods = preflight.headers.get("access-control-allow-methods") ?? "";
  const allowHeaders = preflight.headers.get("access-control-allow-headers") ?? "";
  check("体检：OPTIONS 预检 → 204", preflight.status === 204, `got ${preflight.status}`);
  check(
    "体检：预检允许 GET/POST/OPTIONS",
    /GET/.test(allowMethods) && /POST/.test(allowMethods) && /OPTIONS/.test(allowMethods),
    allowMethods,
  );
  check(
    "体检：预检允许 Content-Type 并暴露版本头",
    /content-type/i.test(allowHeaders) &&
      /x-trip-check-spec/i.test(preflight.headers.get("access-control-expose-headers") ?? ""),
    `${allowHeaders} / ${preflight.headers.get("access-control-expose-headers")}`,
  );

  // ============================================================
  // 1) 合法文档：200 + 两轴报告 + 可复算凭据
  // ============================================================
  const first = await postJson(`${base}/api/verify`, { document: SAMPLE_DOC });
  check(
    "体检：合法文档 → 200",
    first.status === 200,
    `got ${first.status} ${JSON.stringify(first.body).slice(0, 160)}`,
  );
  const verdict = first.body?.verdict ?? {};
  check(
    "体检：报告两轴齐全（结构 grade + 事实 state）",
    ["A", "B", "C", "D"].includes(verdict.consistency?.grade) &&
      typeof verdict.facts?.state === "string",
    JSON.stringify({
      consistency: verdict.consistency ?? null,
      facts: verdict.facts?.state ?? null,
    }),
  );
  check(
    "体检：样例结构 A 级且事实 verified（两轴都过）",
    verdict.consistency?.grade === "A" && verdict.facts?.state === "verified",
    JSON.stringify({ grade: verdict.consistency?.grade, facts: verdict.facts?.state }),
  );
  check(
    "体检：凭据含 tc_ 前缀 id 与 sha256 inputHash",
    typeof first.body?.credential?.id === "string" &&
      /^tc_/.test(first.body.credential.id) &&
      /^[0-9a-f]{64}$/.test(first.body?.credential?.inputHash ?? ""),
    JSON.stringify({
      id: first.body?.credential?.id,
      inputHash: first.body?.credential?.inputHash,
    }),
  );
  check(
    "体检：POST 响应头声明规范版本",
    first.headers.get("x-trip-check-spec") === SPEC_VERSION,
    String(first.headers.get("x-trip-check-spec")),
  );

  const again = await postJson(`${base}/api/verify`, { document: SAMPLE_DOC });
  check(
    "体检：同一输入两次 → credential.id 相同（可复算，不依赖签发时间）",
    Boolean(first.body?.credential?.id) && first.body.credential.id === again.body?.credential?.id,
    `${first.body?.credential?.id} vs ${again.body?.credential?.id}`,
  );

  const paced = await postJson(`${base}/api/verify`, {
    document: SAMPLE_DOC,
    options: { pace: "relaxed" },
  });
  check(
    "体检：判定口径（pace）参与凭据（同文档换口径 → id 不同）",
    paced.status === 200 &&
      Boolean(paced.body?.credential?.id) &&
      paced.body.credential.id !== first.body?.credential?.id,
    `got ${paced.status} ${paced.body?.credential?.id}`,
  );

  // ============================================================
  // 2) 错误路径：错误码与 body 必须可编程处理（错误体不是 HTML）
  // ============================================================
  const badJsonRes = await fetch(`${base}/api/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{这不是 JSON",
  });
  const badJson = await badJsonRes.json().catch(() => ({}));
  check(
    "体检：非法 JSON → 400 invalid_json",
    badJsonRes.status === 400 && badJson.error === "invalid_json",
    `got ${badJsonRes.status} ${JSON.stringify(badJson)}`,
  );

  const noDoc = await postJson(`${base}/api/verify`, {});
  check(
    "体检：document/shareId 都不给 → 400 invalid_request",
    noDoc.status === 400 && noDoc.body?.error === "invalid_request",
    `got ${noDoc.status} ${JSON.stringify(noDoc.body).slice(0, 120)}`,
  );

  // 缺 name 的非法文档：错误必须定位到具体字段（开放 API 的调用方是代码/agent）
  const badDoc = await postJson(`${base}/api/verify`, {
    document: {
      specVersion: SPEC_VERSION,
      days: [{ day: 1, spots: [{ time: "09:00-10:00" }] }],
    },
  });
  const badErrors = Array.isArray(badDoc.body?.errors) ? badDoc.body.errors : [];
  check(
    "体检：非法文档 → 400 invalid_request",
    badDoc.status === 400 && badDoc.body?.error === "invalid_request",
    `got ${badDoc.status} ${JSON.stringify(badDoc.body).slice(0, 120)}`,
  );
  check(
    "体检：校验错误逐条带 path（能定位到 days.0.spots.0.name）",
    badErrors.length > 0 &&
      badErrors.every((e) => typeof e?.path === "string" && e.path.length > 0) &&
      badErrors.some((e) => String(e.path).includes("days.0.spots.0.name")),
    JSON.stringify(badErrors),
  );

  const unknown = await postJson(`${base}/api/verify`, { shareId: "share_doesnotexist00" });
  check(
    "体检：未知 shareId → 404 not_found",
    unknown.status === 404 && unknown.body?.error === "not_found",
    `got ${unknown.status} ${JSON.stringify(unknown.body)}`,
  );

  // 超限 body：按字节算（不是字符数），必须在解析前拒绝成 413
  const bigBody = JSON.stringify({ document: SAMPLE_DOC, padding: "x".repeat(300 * 1024) });
  check(
    "体检：超限 body 实际超过 256KiB（测试前提）",
    Buffer.byteLength(bigBody, "utf8") > MAX_BODY_BYTES,
    `${Buffer.byteLength(bigBody, "utf8")} bytes`,
  );
  const bigRes = await fetch(`${base}/api/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bigBody,
  });
  const bigJson = await bigRes.json().catch(() => ({}));
  check(
    "体检：>256KiB body → 413 payload_too_large",
    bigRes.status === 413 && bigJson.error === "payload_too_large",
    `got ${bigRes.status} ${JSON.stringify(bigJson)}`,
  );

  // ============================================================
  // 3) MCP（JSON-RPC 2.0 stateless 端点）：工具发现 + 调用 + 通知
  // ============================================================
  const init = await postJson(`${base}/api/mcp`, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "trip-check-e2e", version: "0" },
    },
  });
  check("体检：MCP initialize → 200", init.status === 200, `got ${init.status}`);
  check(
    "体检：MCP initialize 返回协议版本 + tools 能力",
    typeof init.body?.result?.protocolVersion === "string" &&
      init.body.result.protocolVersion.length > 0 &&
      Boolean(init.body?.result?.capabilities?.tools),
    JSON.stringify(init.body?.result ?? null).slice(0, 200),
  );
  check(
    "体检：MCP serverInfo 标识 trip-check",
    init.body?.result?.serverInfo?.name === "trip-check",
    JSON.stringify(init.body?.result?.serverInfo ?? null),
  );

  const toolsRes = await postJson(`${base}/api/mcp`, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  const toolNames = (toolsRes.body?.result?.tools ?? []).map((t) => t?.name);
  check(
    "体检：MCP tools/list 暴露 verify_itinerary",
    toolsRes.status === 200 && toolNames.includes("verify_itinerary"),
    JSON.stringify(toolNames),
  );

  const toolCall = await postJson(`${base}/api/mcp`, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "verify_itinerary", arguments: { document: SAMPLE_DOC } },
  });
  const callText = toolCall.body?.result?.content?.[0]?.text;
  let callPayload = null;
  try {
    callPayload = JSON.parse(callText);
  } catch {
    // 非 JSON 文本由下面两条断言暴露，不在这里伪造空报告
  }
  check(
    "体检：MCP tools/call verify_itinerary 返回两轴报告",
    toolCall.status === 200 &&
      toolCall.body?.result?.isError !== true &&
      Boolean(callPayload?.verdict?.consistency) &&
      Boolean(callPayload?.verdict?.facts),
    `got ${toolCall.status} ${String(callText).slice(0, 160)}`,
  );
  check(
    "体检：MCP 与 HTTP 同一输入 → 同一凭据（同一引擎，不分叉）",
    Boolean(callPayload?.credential?.id) &&
      callPayload.credential.id === first.body?.credential?.id,
    `${callPayload?.credential?.id} vs ${first.body?.credential?.id}`,
  );

  // JSON-RPC 通知（无 id）不需要响应体：202 + 空 body，避免客户端误当成响应
  const noteRes = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const noteText = await noteRes.text();
  check(
    "体检：MCP 通知（无 id）→ 202 空 body",
    noteRes.status === 202 && noteText === "",
    `got ${noteRes.status} body=${JSON.stringify(noteText.slice(0, 80))}`,
  );

  // ============================================================
  // 4) /verify 公开体验台（SSR 首屏必须自证是什么页面）
  // ============================================================
  const pageRes = await fetch(`${base}/verify`);
  const pageHtml = await pageRes.text();
  check(
    "体检：/verify 体验台 → 200 且含「行程体检」",
    pageRes.status === 200 && pageHtml.includes("行程体检"),
    `got ${pageRes.status}`,
  );

  // ============================================================
  // 5) 确定性修复（document 路径）：只顺延时间/删重复，不编造事实
  // ============================================================
  // 破损样例：时间重叠 30 分钟。修复器应把「平江路」整体后移到 11:00-12:30
  // （只动 time，不动地点/营业时间/路段），再用同一套引擎重验出前后两份报告。
  const repair = await postJson(`${base}/api/verify/repair`, { document: BROKEN_DOC });
  check(
    "修复：破损文档 → 200",
    repair.status === 200,
    `got ${repair.status} ${JSON.stringify(repair.body).slice(0, 160)}`,
  );
  check(
    "修复：响应字段全集（document/applied/remainingRuleIds/unrepairable/before/after/delta）",
    Boolean(repair.body?.document) &&
      Array.isArray(repair.body?.applied) &&
      Array.isArray(repair.body?.remainingRuleIds) &&
      Array.isArray(repair.body?.unrepairable) &&
      Boolean(repair.body?.before?.verdict) &&
      Boolean(repair.body?.after?.verdict) &&
      typeof repair.body?.delta?.improved === "boolean",
    JSON.stringify(Object.keys(repair.body ?? {})),
  );
  check(
    "修复：确实改动了（changed:true）且 applied 含 TC-C102（时间重叠）",
    repair.body?.changed === true && repair.body?.applied?.some((a) => a?.ruleId === "TC-C102"),
    JSON.stringify(repair.body?.applied ?? null),
  );
  check(
    "修复：after 分更高、阻断更少（delta.improved 用同一把尺子量出）",
    repair.body?.delta?.improved === true &&
      repair.body?.delta?.score > 0 &&
      repair.body?.after?.stats?.blocking < repair.body?.before?.stats?.blocking,
    JSON.stringify(repair.body?.delta ?? null),
  );
  check(
    "修复：前后两张凭据都是 tc_ + 32 hex，且文档变了 ID 必须变",
    /^tc_[0-9a-f]{32}$/.test(repair.body?.parentCredential?.id ?? "") &&
      /^tc_[0-9a-f]{32}$/.test(repair.body?.credential?.id ?? "") &&
      repair.body.parentCredential.id !== repair.body.credential.id,
    `${repair.body?.parentCredential?.id} → ${repair.body?.credential?.id}`,
  );
  // 前后凭据链可对账：拿修复后的 document 再走 /api/verify，应得到同一个 credential.id
  const repairedVerify = await postJson(`${base}/api/verify`, { document: repair.body?.document });
  check(
    "修复：修复后文档再体检 → credential.id 与修复响应一致（前后凭据链可对账）",
    repairedVerify.status === 200 &&
      repairedVerify.body?.credential?.id === repair.body?.credential?.id,
    `${repairedVerify.body?.credential?.id} vs ${repair.body?.credential?.id}`,
  );
  const parentVerify = await postJson(`${base}/api/verify`, { document: BROKEN_DOC });
  check(
    "修复：输入文档体检 → credential.id 与 parentCredential 一致（父凭据可复算）",
    parentVerify.status === 200 &&
      parentVerify.body?.credential?.id === repair.body?.parentCredential?.id,
    `${parentVerify.body?.credential?.id} vs ${repair.body?.parentCredential?.id}`,
  );
  check(
    "修复：明示不写回存储（persisted:false / source:document）",
    repair.body?.persisted === false && repair.body?.source === "document",
    JSON.stringify({ persisted: repair.body?.persisted, source: repair.body?.source }),
  );

  // 干净文档：没有可机械修复的问题时必须如实返回「没改动」，不能为了显得有用而改东西
  const cleanRepair = await postJson(`${base}/api/verify/repair`, { document: SAMPLE_DOC });
  check(
    "修复：干净文档 → changed:false 且 delta.score 为 0（不谎报改善）",
    cleanRepair.status === 200 &&
      cleanRepair.body?.changed === false &&
      cleanRepair.body?.delta?.score === 0 &&
      (cleanRepair.body?.applied?.length ?? -1) === 0,
    `got ${cleanRepair.status} ${JSON.stringify({
      changed: cleanRepair.body?.changed,
      delta: cleanRepair.body?.delta,
    })}`,
  );
  check(
    "修复：没有改动时前后凭据相同（文档未变 → ID 不变）",
    cleanRepair.body?.credential?.id === cleanRepair.body?.parentCredential?.id,
    `${cleanRepair.body?.credential?.id} vs ${cleanRepair.body?.parentCredential?.id}`,
  );

  // 错误路径：与 /api/verify 同契约（错误码可编程处理；GET 明确 405 而不是框架 HTML）
  const repairBadBody = await postJson(`${base}/api/verify/repair`, {});
  check(
    "修复：document/shareId 都不给 → 400 invalid_request",
    repairBadBody.status === 400 && repairBadBody.body?.error === "invalid_request",
    `got ${repairBadBody.status} ${JSON.stringify(repairBadBody.body).slice(0, 120)}`,
  );
  const repairUnknown = await postJson(`${base}/api/verify/repair`, {
    shareId: "share_doesnotexist00",
  });
  check(
    "修复：未知 shareId → 404 not_found",
    repairUnknown.status === 404 && repairUnknown.body?.error === "not_found",
    `got ${repairUnknown.status} ${JSON.stringify(repairUnknown.body)}`,
  );
  const repairGetRes = await fetch(`${base}/api/verify/repair`);
  const repairGetBody = await repairGetRes.json().catch(() => ({}));
  check(
    "修复：GET → 405 + 可读说明（只支持 POST，没有可查询的结果）",
    repairGetRes.status === 405 && repairGetBody.error === "method_not_allowed",
    `got ${repairGetRes.status} ${JSON.stringify(repairGetBody).slice(0, 120)}`,
  );

  // ============================================================
  // 6) shareId 路径：站内行程走同一套引擎（适配层 → 文档 → 判定）
  // ============================================================
  const gen = await api.post({ city: "苏州", days: 3, budget: 2500, preferences: ["美食"] });
  if (gen.status === 429) {
    console.log("  [verify] 生成配额已用完（429），跳过 shareId 路径（非本切片缺陷）");
    return;
  }
  check("体检：生成行程 → 202（shareId 路径的数据前提）", gen.status === 202, `got ${gen.status}`);
  const job = await api.waitJob(gen.body.jobId, 60000);
  check("体检：生成任务 done", job.status === "done", JSON.stringify(job).slice(0, 120));
  const shareId = job.shareId;
  check(
    "体检：done 返回持久分享 token",
    typeof shareId === "string" && shareId.startsWith("share_"),
    String(shareId),
  );

  if (typeof shareId === "string") {
    const shared = await postJson(`${base}/api/verify`, { shareId });
    check(
      "体检：分享行程 → 200（站内行程也走开放文档格式）",
      shared.status === 200,
      `got ${shared.status} ${JSON.stringify(shared.body).slice(0, 160)}`,
    );
    check(
      "体检：报告 document.id 就是分享 token（可追溯到来源行程）",
      shared.body?.document?.id === shareId,
      String(shared.body?.document?.id),
    );
    check(
      "体检：shareId 路径同样签发凭据",
      typeof shared.body?.credential?.id === "string" &&
        shared.body.credential.id.startsWith("tc_"),
      String(shared.body?.credential?.id),
    );
    if (mode === "mock") {
      // 红线：MOCK 的行程没有真实核验，绝不能标成 verified（不拿「没查」冒充「没问题」）
      check(
        "体检(mock)：未接真实数据源的行程不得标成 facts=verified",
        shared.body?.verdict?.facts?.state !== "verified",
        JSON.stringify(shared.body?.verdict?.facts?.state),
      );
    }

    // 修复 shareId 路径：只读 Plan（不写回存储），前后凭据与体检结果可对链
    const sharedRepair = await postJson(`${base}/api/verify/repair`, { shareId });
    check(
      "修复：分享行程 → 200（只读建议，不写回存储）",
      sharedRepair.status === 200,
      `got ${sharedRepair.status} ${JSON.stringify(sharedRepair.body).slice(0, 160)}`,
    );
    check(
      "修复：shareId 路径明示 persisted:false / source:share",
      sharedRepair.body?.persisted === false && sharedRepair.body?.source === "share",
      JSON.stringify({
        persisted: sharedRepair.body?.persisted,
        source: sharedRepair.body?.source,
      }),
    );
    check(
      "修复：父凭据与该行程的体检凭据一致（同一输入 → 同一 ID，可对账）",
      sharedRepair.body?.parentCredential?.id === shared.body?.credential?.id,
      `${sharedRepair.body?.parentCredential?.id} vs ${shared.body?.credential?.id}`,
    );
    check(
      "修复：shareId 路径也给出修复后凭据（tc_ + 32 hex）",
      /^tc_[0-9a-f]{32}$/.test(sharedRepair.body?.credential?.id ?? ""),
      String(sharedRepair.body?.credential?.id),
    );
    if (mode === "mock") {
      // 修复器只动时间/重复项；mock 行程没有真实事实，facts 状态必须原样（不能被「修好」）
      check(
        "修复(mock)：只动时间/重复项，事实核验状态不变",
        sharedRepair.body?.before?.verdict?.facts?.state ===
          sharedRepair.body?.after?.verdict?.facts?.state,
        `${sharedRepair.body?.before?.verdict?.facts?.state} → ${sharedRepair.body?.after?.verdict?.facts?.state}`,
      );
    }
  }
}
