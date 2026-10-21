// 切片 e2e · 旅行档案（Travel DNA）
//
// 契约：导出 `export async function runSlice(ctx)`，ctx = { check, api, mode }
//   - check(name, cond, detail?)：断言（与 orchestrator 共用计数）
//   - api：makeApi 实例——api.baseUrl / api.post(payload) / api.postRaw(text) /
//     api.waitJob(jobId, timeoutMs) / api.authPost(path, payload) / api.me()
//   - mode："mock"（3103，无高德 key）| "real"（3104，高德桩）
// 每个模块在 mock 与 real 两台服务器上各跑一遍——必须幂等、自行判断模式适用性。
//
// 本切片验的服务端契约（组件行为由 tests/components/ProfileDrawer.test.tsx 覆盖）：
// 1. 档案行进 prompt：POST 带 profile → 完成 → 桩 LLM 的 /_last_user 回看
//    （与「住所行进 prompt」的 e2e 同构）；
// 2. 零变化红线：无档案的请求 prompt 里一行档案行都没有，节奏预警文案与
//    切片 3 之前逐字一致；
// 3. 脏档案归一化（不拒整档）：非法忌口条目被丢弃，合法条目照常生效；
// 4. 非法档案（非对象）→ 400（防注入的拒绝路径）；
// 5. 体检阈值随 stamina 变化（relaxed 收紧 / packed 放宽）——放宽的方向
//    在两种模式下断言不同值（mock 下 Day1 净时长 610 分钟 < 720 不报；
//    real 下含通勤估算必然 > 720，报且带「已按你的体力上限放宽」）。
//
// 关于 AGENTS.md 的桩开关词警告：本切片不依赖桩的任何 mode 分支（fixture
// 恒返回），只回看 _last_user。档案行都是新行（"- 我的体力上限：" 等），
// 桩的 switchSource 只读「目的地/出行偏好」两行，互不干扰。

// 桩 LLM 端口：与 orchestrator（scripts/run-tests.mjs）的 STUB_PORT 常量
// 保持一致（那里是 8898）。切片与编排器同进程，但常量未导出，用环境变量
// 优先 + 默认值兜底——改端口时两边同步。
const STUB_LLM_PORT = Number(process.env.STUB_PORT || 8898);

/** 完整档案（覆盖 5 个字段 + 推断偏好），用于 prompt 接线断言 */
const FULL_PROFILE = {
  stamina: "packed",
  diet: ["海鲜过敏"],
  schedule: "late",
  maxCommuteMin: 90,
  inferred: [{ text: "更偏好步行游览", source: "上次行程：苏州 3 天", editable: true }],
};

/** 回看桩 LLM 最近一次收到的 user 消息（验证输入确实拼进了 prompt） */
async function lastUserMsg() {
  const r = await fetch(`http://127.0.0.1:${STUB_LLM_PORT}/_last_user`);
  const j = await r.json();
  return j.user ?? "";
}

/** 节奏类预警（超出上限）——filter 复用 orchestrator 的既有口径 */
function paceWarnings(plan) {
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings : [];
  return warnings.filter((w) => typeof w === "string" && w.includes("超出") && w.includes("节奏上限"));
}

/** 苏州 3 天（fixture：Day1 净停留 610 分钟，≤4 天走单次调用路径） */
function suzhou(over = {}) {
  return { city: "苏州", days: 3, budget: 2500, preferences: ["美食"], ...over };
}

export async function runSlice({ check, api, mode }) {
  // ---- 1) 档案行进 prompt（两种模式都成立：档案行与高德模式无关）----
  const r1 = await api.post(suzhou({ profile: FULL_PROFILE }));
  check("档案：提交 202", r1.status === 202, `got ${r1.status}`);
  const j1 = await api.waitJob(r1.body.jobId);
  check("档案：任务 done", j1.status === "done", JSON.stringify(j1).slice(0, 120));
  const u1 = await lastUserMsg();
  check("prompt 含体力行（偏紧凑）", u1.includes("我的体力上限：偏紧凑"), u1.slice(-400));
  check("prompt 含忌口行（必须避开的硬约束措辞）", u1.includes("饮食忌口：海鲜过敏（全程餐饮安排必须避开这些）"), u1.slice(-400));
  check("prompt 含作息行（夜猫型）", u1.includes("我的作息：夜猫型"));
  check("prompt 含通勤耐受行（90 分钟）", u1.includes("通勤可接受上限：90 分钟"));
  check(
    "prompt 含推断行且带「根据你上次的行程推测」标注（红线）",
    u1.includes("更偏好步行游览（根据你上次的行程推测，仅供参考）"),
    u1.slice(-400),
  );

  // ---- 2) 零变化红线：无档案 → prompt 无档案行 + 节奏预警文案与历史逐字一致 ----
  const r2 = await api.post(suzhou());
  const j2 = await api.waitJob(r2.body.jobId);
  check("无档案：任务 done", j2.status === "done", JSON.stringify(j2).slice(0, 120));
  const u2 = await lastUserMsg();
  check("无档案：prompt 不含任何档案行", !u2.includes("我的体力上限") && !u2.includes("饮食忌口"));
  const p2 = paceWarnings(j2.plan);
  check(
    "无档案：Day1 节奏预警与切片 3 之前逐字一致（610min > 适中 600）",
    p2.some((w) => w.includes("超出适中节奏上限（10 小时）")) &&
      !p2.some((w) => w.includes("收紧") || w.includes("放宽")),
    JSON.stringify(p2),
  );

  // ---- 3) 脏档案归一化：非法条目丢弃、合法条目照常生效（不拒整档）----
  const r3 = await api.post(suzhou({ profile: { diet: ["海鲜过敏", "x".repeat(40)] } }));
  check("脏档案（合法字段）：仍 202", r3.status === 202, `got ${r3.status}`);
  const j3 = await api.waitJob(r3.body.jobId);
  check("脏档案：任务 done", j3.status === "done", JSON.stringify(j3).slice(0, 120));
  const u3 = await lastUserMsg();
  check("脏档案：合法忌口仍进 prompt", u3.includes("饮食忌口：海鲜过敏"));
  check("脏档案：超长条目（40 字）被丢弃，不进 prompt", !u3.includes("x".repeat(40)));

  // ---- 4) 非法档案（非对象）→ 400（防注入拒绝路径；配额已退还）----
  const r4 = await api.post(suzhou({ profile: "不是对象" }));
  check("非法档案（字符串）→ 400", r4.status === 400, `got ${r4.status}`);
  check(
    "400 文案指向「旅行档案」且给可行动建议",
    (r4.body.error ?? "").includes("旅行档案") && (r4.body.error ?? "").includes("重新填写"),
    JSON.stringify(r4.body),
  );

  // null = 「没填过档案」（存储层语义），边界上必须与「没传」同等对待——
  // 否则集成方（home-client）带 null 提交会被 400 拒掉每次生成
  const r4b = await api.post(suzhou({ profile: null }));
  check("profile: null → 202（与「没传」同等对待，不误拒）", r4b.status === 202, `got ${r4b.status}`);
  const j4b = await api.waitJob(r4b.body.jobId);
  check("null 档案：任务 done 且 prompt 无档案行", j4b.status === "done" && !(await lastUserMsg()).includes("我的体力上限"), JSON.stringify(j4b).slice(0, 120));

  // ---- 5) 体检阈值随 stamina 变化 ----
  // 收紧方向（两种模式都成立）：packed 节奏（780）本不报，relaxed 体力把
  // 上限收到 600（780×0.8 取整），Day1 净时长必然 > 600 → 报且带收紧标注。
  // （packed 节奏本身不报的控制由 orchestrator 用例 8 覆盖，不重复烧配额）
  const r5 = await api.post(suzhou({ pace: "packed", profile: { stamina: "relaxed" } }));
  const j5 = await api.waitJob(r5.body.jobId);
  check("收紧：任务 done", j5.status === "done", JSON.stringify(j5).slice(0, 120));
  const p5 = paceWarnings(j5.plan);
  check(
    "relaxed 体力收紧上限：紧凑节奏也报「节奏上限（10 小时，已按你的体力上限收紧）」",
    p5.some((w) => w.includes("超出紧凑节奏上限（10 小时，已按你的体力上限收紧）")),
    JSON.stringify(p5),
  );

  // 放宽方向：适中节奏（600）+ packed 体力（×1.2 → 720）。
  // mock 模式 Day1 净时长 610 < 720 → 预警消失；real 模式含通勤估算
  // （≥132 分钟）必然 > 720 → 预警仍在但带「已按你的体力上限放宽」。
  const r6 = await api.post(suzhou({ profile: { stamina: "packed" } }));
  const j6 = await api.waitJob(r6.body.jobId);
  check("放宽：任务 done", j6.status === "done", JSON.stringify(j6).slice(0, 120));
  const p6 = paceWarnings(j6.plan);
  if (mode === "mock") {
    check(
      "packed 体力放宽上限：Day1（610min < 720）节奏预警消失",
      p6.length === 0,
      JSON.stringify(p6),
    );
  } else {
    check(
      "packed 体力放宽上限：real 模式仍报（含通勤 >720）但带「已按你的体力上限放宽」",
      p6.some((w) => w.includes("已按你的体力上限放宽")),
      JSON.stringify(p6),
    );
  }
}
