#!/usr/bin/env node
/**
 * 端到端测试编排器（自包含，可本地跑也可在 CI 跑）：
 *   阶段 A（MOCK 高德）：桩 LLM + 测试服务器 3103 → 输入边界 16 例 + 健康检查 + 故障注入 5 例
 *   阶段 B（真实模式）：桩 LLM + 高德桩 + 测试服务器 3104（带 AMAP key）→ 验真/坐标解析/通勤换算/未命中预警
 *   阶段 C（dev 登录）：测试服务器 3105 → 验证码流 + 双轨配额 + 防轰炸
 *   阶段 D（微信）：桩微信 + 测试服务器 3106 → OAuth 全流程 + CSRF
 *   阶段 E（短信）：桩腾讯云短信 + 测试服务器 3107 → TC3 直签 + 服务端验证码 + 一次性消费
 *   全部 tear down，退出码非零即失败
 *
 * 用法：npm test
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB_PORT = 8898;   // 桩 LLM
const AMAP_STUB_PORT = 8899; // 桩高德
const WECHAT_STUB_PORT = 8900; // 桩微信
const SMS_STUB_PORT = 8901; // 桩腾讯云短信
const PORTS = { mock: 3103, real: 3104, auth: 3105, wx: 3106, sms: 3107, pg: 3108 };
const HAS_PG = Boolean(process.env.DATABASE_URL);
const APP = (k) => `http://127.0.0.1:${PORTS[k]}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${detail}`);
    console.log(`  ❌ ${name} ${detail}`);
  }
}

const children = [];
function spawnCmd(cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${cmd}] ${d}`));
  child.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[${cmd}] ${d}`));
  children.push(child);
  return child;
}

async function waitReady(url, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 400) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const DEFAULT_TIME = { startAt: "2026-10-10T10:00", endAt: "2026-10-12T18:00" }; // 默认 3 天

function makeApi(base) {
  const jar = { cookie: "" };
  const withCookie = (headers = {}) =>
    jar.cookie ? { ...headers, Cookie: jar.cookie } : headers;
  const captureCookie = (r) => {
    const setCookie = r.headers.get("set-cookie");
    if (setCookie) jar.cookie = setCookie.split(";")[0];
  };
  return {
    jar,
    baseUrl: base,
    async post(payload) {
      const r = await fetch(`${base}/api/plan`, {
        method: "POST",
        headers: withCookie({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ...DEFAULT_TIME, ...payload }),
      });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    },
    async postRaw(text) {
      const r = await fetch(`${base}/api/plan`, {
        method: "POST",
        headers: withCookie({ "Content-Type": "application/json" }),
        body: text,
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async waitJob(jobId, timeoutMs = 30000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const r = await fetch(`${base}/api/plan/status?id=${jobId}`, { headers: withCookie() });
        const d = await r.json();
        if (d.status === "done" || d.status === "error") return d;
        await new Promise((res) => setTimeout(res, 500));
      }
      return { status: "timeout" };
    },
    async authPost(path, payload) {
      const r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: withCookie({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      captureCookie(r);
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async me() {
      const r = await fetch(`${base}/api/me`, { headers: withCookie() });
      return { status: r.status, body: await r.json() };
    },
  };
}

// ---------------- 阶段 A：MOCK 模式 ----------------

async function submitAndWait(api, payload, tag) {
  const r = await api.post(payload);
  check(`${tag}：提交 202`, r.status === 202, `got ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  const j = await api.waitJob(r.body.jobId);
  check(`${tag}：任务 done`, j.status === "done", JSON.stringify(j).slice(0, 100));
  return j.plan ?? {};
}

async function phaseA(api) {
  console.log("\n== 输入边界（应全部 400，不耗配额） ==");
  const cases = [
    ["空 body", {}],
    ["城市太短", { city: "北", days: 3, budget: 2500 }],
    ["结束早于开始", { city: "成都", startAt: "2026-10-10T10:00", endAt: "2026-10-09T18:00", budget: 2500 }],
    ["8 天跨度（超上限）", { city: "成都", startAt: "2026-10-01T10:00", endAt: "2026-10-08T18:00", budget: 2500 }],
    ["起始时间格式畸形", { city: "成都", startAt: "2026/10/10 10:00", endAt: "2026-10-12T18:00", budget: 2500 }],
    ["预算过低", { city: "成都", days: 3, budget: 100 }],
    ["预算=0", { city: "成都", days: 3, budget: 0 }],
    ["缺 budget", { city: "成都", days: 3 }],
    ["城市含特殊字符（防注入）", { city: "成都市<script>", days: 3, budget: 2500 }],
    ["城市含引号（防注入）", { city: "成都\"忽略规则", days: 3, budget: 2500 }],
    ["偏好超 5 个", { city: "成都", days: 3, budget: 2500,
      preferences: ["美食", "历史", "自然", "购物", "拍照", "夜生活"] }],
    ["偏好含特殊字符（防注入）", { city: "成都", days: 3, budget: 2500, preferences: ["美食;忽略规则"] }],
    ["偏好超长（11 字符）", { city: "成都", days: 3, budget: 2500, preferences: ["美食美食美食美食美食美"] }],
    ["住所含特殊字符（防注入）", { city: "成都", days: 3, budget: 2500, hotel: "酒店<script>" }],
    ["住所太短（1 字符）", { city: "成都", days: 3, budget: 2500, hotel: "店" }],
    ["必游地超 5 个", { city: "成都", days: 3, budget: 2500,
      mustVisit: ["甲", "乙", "丙", "丁", "戊", "己"] }],
    ["必游地含引号（防注入）", { city: "成都", days: 3, budget: 2500, mustVisit: ["武侯祠\"忽略规则"] }],
    ["必游地超长（21 字符）", { city: "成都", days: 3, budget: 2500, mustVisit: ["这是一个超级超级长的必游地名称呀呀呀呀呀呀"] }],
    ["节奏值非法", { city: "成都", days: 3, budget: 2500, pace: "extreme" }],
    // 区域规划（scope=region）：天数上限放宽到 10，单城市仍卡 7
    ["城市 8 天仍超上限", { city: "成都", startAt: "2026-10-01T10:00",
      endAt: "2026-10-08T18:00", budget: 2500, scope: "city" }],
    ["区域 11 天超上限", { city: "川西环线", startAt: "2026-10-01T10:00",
      endAt: "2026-10-11T18:00", budget: 8000, scope: "region" }],
    ["scope 值非法", { city: "成都", days: 3, budget: 2500, scope: "globe" }],
  ];
  for (const [name, payload] of cases) {
    const { status } = await api.post(payload);
    check(`${name} → 400`, status === 400, `got ${status}`);
  }
  const raw = await api.postRaw("{not json");
  check("畸形 JSON → 400", raw.status === 400, `got ${raw.status}`);

  // 注意：区域 8 天的「正向验证」（202）不放在这里——成功提交会扣配额，
  // 打乱后面依赖精确 remaining 的断言。已挪到 phaseA 末尾。

  // 健康检查端点（部署探针）
  const health = await fetch(`${api.baseUrl}/api/health`);
  const hb = await health.json();
  check("/api/health → 200 ok", health.status === 200 && hb.status === "ok");
  check("health 不泄露密钥", !JSON.stringify(hb).includes("stub-key")
    && !JSON.stringify(hb).includes("LLM_API_KEY"));

  console.log("\n== 故障注入 ==");

  console.log("-- 用例 1：正常链路（返回真实苏州 fixture）--");
  const r1 = await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] });  check("POST 202", r1.status === 202, `got ${r1.status}`);
  const j1 = await api.waitJob(r1.body.jobId);
  check("任务 done", j1.status === "done", JSON.stringify(j1).slice(0, 120));
  const plan = j1.plan ?? {};
  check("3 天结构", plan.days?.length === 3);
  check("Day1 含真实 POI（拙政园/苏州博物馆）",
    (plan.days?.[0]?.spots ?? []).some((s) => s.name.includes("拙政园"))
    && (plan.days?.[0]?.spots ?? []).some((s) => s.name.includes("苏州博物馆")));
  check("预算预警触发（fixture 总价 1925 > 1000×1.05）",
    (plan.warnings ?? []).some((w) => w.includes("超出预算")),
    JSON.stringify(plan.warnings));
  check("节奏预警触发（Day1 7 点超 10 小时）",
    (plan.warnings ?? []).some((w) => w.includes("偏满") || w.includes("超出") && w.includes("节奏上限")),
    JSON.stringify(plan.warnings));
  check("MOCK 模式 verified=false", plan.verified === false);
  check("remaining = 49（LIMIT 50 - 1）", j1.remaining === 49, `got ${j1.remaining}`);

  // 分享页：同一份 job 的只读链接
  const share = await fetch(`${api.baseUrl}/p/${r1.body.jobId}`);
  const shareHtml = await share.text();
  check("分享页 /p/{jobId} → 200", share.status === 200, `got ${share.status}`);
  check("分享页 SSR 含行程内容（拙政园）", shareHtml.includes("拙政园"));
  const ogMatch = shareHtml.match(/<meta property="og:title" content="([^"]+)"/);
  check("分享页有动态 OG 标题（微信/Twitter 卡片预览）",
    ogMatch?.[1]?.includes("3 天行程"), `og:title=${ogMatch?.[1] ?? "无"}`);
  const expired = await fetch(`${api.baseUrl}/p/job_nonexistent`);
  check("无效分享链接 → 友好提示（非 500）",
    expired.status === 200 && (await expired.text()).includes("链接已失效"),
    `got ${expired.status}`);

  console.log("-- 用例 2：垃圾输出 --");
  const j2 = await api.waitJob((await api.post({ city: "垃圾测试城市", days: 3, budget: 1000, preferences: [] })).body.jobId);
  check("任务 error", j2.status === "error");
  check("错误提示 JSON 不合法", (j2.error ?? "").includes("JSON"), j2.error);
  check("配额退还（remaining = 49）", j2.remaining === 49, `got ${j2.remaining}`);

  console.log("-- 用例 3：空 content --");
  const j3 = await api.waitJob((await api.post({ city: "空内容城市", days: 3, budget: 1000, preferences: [] })).body.jobId);
  check("任务 error", j3.status === "error");
  check("错误提示返回为空", (j3.error ?? "").includes("为空"), j3.error);
  check("配额退还（remaining = 49）", j3.remaining === 49, `got ${j3.remaining}`);

  console.log("-- 用例 4：上游 HTTP 500 --");
  const j4 = await api.waitJob((await api.post({ city: "上游故障城市", days: 3, budget: 1000, preferences: [] })).body.jobId);
  check("任务 error", j4.status === "error");
  check("配额退还（remaining = 49）", j4.remaining === 49, `got ${j4.remaining}`);

  console.log("-- 用例 5：配额最终账目 --");
  const j5 = await api.waitJob((await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] })).body.jobId);
  check("再次生成成功", j5.status === "done");
  check("remaining = 48（50 - 1成功 - 1重试）", j5.remaining === 48, `got ${j5.remaining}`);

  console.log("-- 用例 6：用户住所 + 期望必游地（硬约束）--");
  // fixture（苏州）含拙政园、不含测试酒店A/测试必游地X：一条满足两条告警
  const r6 = await api.post({ city: "苏州", days: 3, budget: 2500, preferences: ["美食"],
    hotel: "测试酒店A", mustVisit: ["拙政园", "测试必游地X"] });
  check("带住所/必游地的提交 → 202", r6.status === 202, `got ${r6.status}`);
  const j6 = await api.waitJob(r6.body.jobId);
  const p6 = j6.plan ?? {};
  check("已满足的必游地（拙政园）不告警",
    !(p6.warnings ?? []).some((w) => w.includes("拙政园") && w.includes("未出现")),
    JSON.stringify(p6.warnings));
  check("未安排的必游地告警（测试必游地X）",
    (p6.warnings ?? []).some((w) => w.includes("测试必游地X") && w.includes("未出现在行程中")),
    JSON.stringify(p6.warnings));
  check("未体现的住所告警（测试酒店A）",
    (p6.warnings ?? []).some((w) => w.includes("测试酒店A") && w.includes("未体现在行程中")),
    JSON.stringify(p6.warnings));
  // prompt 接线验证：住所与必游地确实拼进了发给 LLM 的 user 消息
  const lastUser = await (await fetch(`http://127.0.0.1:${STUB_PORT}/_last_user`)).json();
  check("prompt 含住所字段", (lastUser.user ?? "").includes("我的住所") && (lastUser.user ?? "").includes("测试酒店A"));
  check("prompt 含必游地字段", (lastUser.user ?? "").includes("期望必游地") && (lastUser.user ?? "").includes("测试必游地X"));

  // 用例 11：日历导出（.ics）——时刻表 → VEVENT，日期按 startDate 推导
  const r11 = await api.post({ city: "苏州", days: 3, budget: 2500, preferences: ["美食"] });
  check("日历导出：提交 202", r11.status === 202, `got ${r11.status}`);
  const j11 = await api.waitJob(r11.body.jobId);
  check("日历导出：任务 done", j11.status === "done");
  check("plan 带 startDate（2026-10-10）", j11.plan?.startDate === "2026-10-10",
    `got ${j11.plan?.startDate}`);
  const ics = await (await fetch(`${api.baseUrl}/api/plan/ics?id=${r11.body.jobId}`)).text();
  const vevents = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
  check(".ics 含 VCALENDAR 头", ics.includes("BEGIN:VCALENDAR") && ics.includes("END:VCALENDAR"));
  check(".ics 每个 spot 一个 VEVENT（fixture 16 个点）", vevents === 16, `got ${vevents}`);
  check(".ics 事件日期按 Day 偏移（首日 20261010）", ics.includes("DTSTART:20261010T"),
    ics.match(/DTSTART:\d+T\d+/)?.[0]);
  check(".ics 次日偏移正确（20261011）", ics.includes("DTSTART:20261011T"));
  check(".ics 含转义与中文 SUMMARY", ics.includes("SUMMARY:") && /SUMMARY:[^\r]*景/.test(ics));
  const icsBad = await fetch(`${api.baseUrl}/api/plan/ics?id=job_nonexistent`);
  check(".ics 无效 id → 404", icsBad.status === 404, `got ${icsBad.status}`);

  // 用例 7：模糊住所描述（真实 case 揪出的误报修复）——fixture 含「平江历史街区」，
  // 用户说「住平江附近」时模型会转化成具体酒店，全串匹配会误报，核心词匹配才正确
  const p7 = await submitAndWait(api, { city: "苏州", days: 3, budget: 2500, preferences: ["美食"],
    hotel: "住平江附近", mustVisit: [] }, "模糊住所");
  check("模糊住所不误报（住平江附近 → 平江历史街区）",
    !(p7.warnings ?? []).some((w) => w.includes("住所")),
    JSON.stringify(p7.warnings));

  // 用例 8/9：行程节奏分档（fixture Day1 停留 610min：packed 780 不报 / relaxed 480 报）
  const p8 = await submitAndWait(api, { city: "苏州", days: 3, budget: 2500,
    preferences: ["美食"], pace: "packed" }, "紧凑节奏");
  check("紧凑节奏不报偏满（610min < 780min）",
    !((p8.warnings ?? []).some((w) => w.includes("超出") && w.includes("节奏上限"))),
    JSON.stringify(p8.warnings));
  const p9 = await submitAndWait(api, { city: "苏州", days: 3, budget: 2500,
    preferences: ["美食"], pace: "relaxed" }, "轻松节奏");
  check("轻松节奏报偏满（610min > 480min）",
    (p9.warnings ?? []).some((w) => w.includes("超出轻松节奏上限")),
    JSON.stringify(p9.warnings));

  // 用例 10：起止时间 → 天数推导 + prompt 接线（含当天往返特例）
  await submitAndWait(api, { city: "成都", startAt: "2026-10-01T10:00",
    endAt: "2026-10-04T18:00", budget: 2500 }, "4 天跨度");
  const lastUser4 = await (await fetch(`http://127.0.0.1:${STUB_PORT}/_last_user`)).json();
  check("prompt 含推导天数（共 4 天）", (lastUser4.user ?? "").includes("共 4 天"), lastUser4.user?.slice(-80));
  const p10 = await submitAndWait(api, { city: "成都", startAt: "2026-10-10T09:00",
    endAt: "2026-10-10T20:00", budget: 1500 }, "当天往返");
  const lastUser1 = await (await fetch(`http://127.0.0.1:${STUB_PORT}/_last_user`)).json();
  check("当天往返 prompt 无酒店安排", (lastUser1.user ?? "").includes("当天往返行程") && (lastUser1.user ?? "").includes("不要安排酒店"),
    lastUser1.user?.slice(-100));

  // 用例 12：模型输出乱序 + 跳号（数组 [Day2,Day3,Day1]，day 字段 [5,9,2]）
  // → planner 归一化（按 day 排序 + 重编号 1..N）后应与 canonical fixture 一致。
  // 回归价值：zod 只校验「day 是 number」，以前这种输出会被原样渲染成错乱行程
  const r12 = await api.post({ city: "编号乱序测试城市", days: 3, budget: 2500, preferences: ["美食"] });
  check("乱序输出：提交 202", r12.status === 202, `got ${r12.status}`);
  const j12 = await api.waitJob(r12.body.jobId);
  const p12 = j12.plan ?? {};
  check("乱序输出：任务 done（归一化后结构合法）", j12.status === "done", JSON.stringify(j12).slice(0, 120));
  check("乱序输出：天数 = 3", p12.days?.length === 3, `got ${p12.days?.length}`);
  check("乱序输出：day 被重编号为连续的 1,2,3",
    (p12.days ?? []).map((d) => d.day).join(",") === "1,2,3",
    JSON.stringify((p12.days ?? []).map((d) => d.day)));
  check("乱序输出：排序正确（Day1 是拙政园所在的那天）",
    (p12.days?.[0]?.spots ?? []).some((s) => s.name.includes("拙政园")),
    JSON.stringify(p12.days?.[0]?.spots?.map((s) => s.name)));
  check("乱序输出：总价 1925（内容未被重排破坏）", p12.totalCostCny === 1925, `got ${p12.totalCostCny}`);

  // 用例 13：输出天数与请求不符（桩恒返回 3 天，请求 4 天）
  // → 带纠正指令重试一次 → 仍不符 → 明确报错 + 退还配额（不把 3 天行程
  //   冒充成 4 天行程交付给用户）
  const rBase = await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] });
  const jBase = await api.waitJob(rBase.body.jobId);
  const before = jBase.remaining;
  const r13 = await api.post({ city: "天数错测试城市", startAt: "2026-10-01T10:00",
    endAt: "2026-10-04T18:00", budget: 2500 });
  check("天数不符：提交 202", r13.status === 202, `got ${r13.status}`);
  const j13 = await api.waitJob(r13.body.jobId);
  check("天数不符：任务 error", j13.status === "error", JSON.stringify(j13).slice(0, 120));
  check("天数不符：报错点明天数差异（输出 3 天，请求 4 天）",
    (j13.error ?? "").includes("输出 3 天，请求 4 天"), j13.error);
  check("天数不符：配额未扣（失败退还）", j13.remaining === before, `before=${before} got=${j13.remaining}`);
  const lastUser13 = await (await fetch(`http://127.0.0.1:${STUB_PORT}/_last_user`)).json();
  check("天数不符：重试时 prompt 带回灌的纠正指令",
    (lastUser13.user ?? "").includes("上一次输出不符合要求")
    && (lastUser13.user ?? "").includes("输出 3 天，请求 4 天"),
    lastUser13.user?.slice(-120));

  // 用例 14：分日流式（≥5 天）——M6 新架构的核心行为验证。
  // 以前 5 天起就被拒（单次生成必爆 token），现在走「大纲 → 逐日生成」。
  // 关键断言是「渐进式交付」：轮询过程中 daysReady 必须逐日递增，
  // 而不是一直 0 然后突然 5——后者说明退化成了等全量完成。
  const r14 = await api.post({ city: "流式测试城市", startAt: "2026-10-01T10:00",
    endAt: "2026-10-05T18:00", budget: 5000, preferences: ["美食"] });
  check("分日流式：5 天提交 202", r14.status === 202, `got ${r14.status}`);
  const seenDays = [];
  let final14 = {};
  // 前缀发布的核心不变式：任何时候看到的部分行程，天数必须是 1..k 的连续前缀。
  // 并发下第 3 天可能比第 2 天先生成完，但绝不能让用户看到乱序或跳号——
  // 这是「前缀发布」要保证的东西，也是本轮并发改造最该守的性质。
  let prefixOk = true;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const d = await (await fetch(`${api.baseUrl}/api/plan/status?id=${r14.body.jobId}`)).json();
      if (d.status === "done" || d.status === "error") { final14 = d; break; }
      // 记录观测到的中间进度（只记变化，避免同一值重复入栈）
      if (typeof d.daysReady === "number" && seenDays[seenDays.length - 1] !== d.daysReady) {
        seenDays.push(d.daysReady);
      }
      // 校验部分行程是天数连续前缀
      const partial = d.plan?.days;
      if (Array.isArray(partial) && partial.length > 0) {
        const nums = partial.map((x) => x.day).join(",");
        const expect = Array.from({ length: partial.length }, (_, i) => i + 1).join(",");
        if (nums !== expect) prefixOk = false;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  check("分日流式：任务最终 done", final14.status === "done",
    JSON.stringify(final14).slice(0, 120));
  check("分日流式：最终 5 天齐全", (final14.plan?.days ?? []).length === 5,
    `got ${(final14.plan?.days ?? []).length}`);
  check("分日流式：daysReady 单调不减（无回退）",
    seenDays.every((v, i) => i === 0 || v >= seenDays[i - 1]),
    JSON.stringify(seenDays));
  check("分日流式：观测到至少一个中间态（非等全量）",
    seenDays.some((v) => v > 0), JSON.stringify(seenDays));
  check("分日流式：部分行程始终是天数连续前缀（并发不乱序）",
    prefixOk, JSON.stringify(seenDays));
  check("分日流式：天数连续编号 1..5",
    (final14.plan?.days ?? []).map((d) => d.day).join(",") === "1,2,3,4,5",
    JSON.stringify((final14.plan?.days ?? []).map((d) => d.day)));
  check("分日流式：大纲的概览落进了最终 plan",
    typeof final14.plan?.summary === "string" && final14.plan.summary.length > 0);
  check("分日流式：住宿只出现在第一天（分日 prompt 的约束兑现）",
    (final14.plan?.days ?? []).every((d, i) =>
      i === 0 || !d.spots.some((s) => s.type === "hotel")),
    JSON.stringify((final14.plan?.days ?? []).map((d) =>
      d.spots.filter((s) => s.type === "hotel").length)));

  // 用例 15：分日中途失败——第 2 天起返回垃圾 → 任务 error + 退还配额，
  // 且不把「只生成了一部分」的行程当成功交付
  const rBase15 = await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] });
  const jBase15 = await api.waitJob(rBase15.body.jobId);
  const before15 = jBase15.remaining;
  const r15 = await api.post({ city: "单日坏测试城市", startAt: "2026-10-01T10:00",
    endAt: "2026-10-05T18:00", budget: 5000 });
  check("分日故障：提交 202", r15.status === 202, `got ${r15.status}`);
  const j15 = await api.waitJob(r15.body.jobId, 90000);
  check("分日故障：任务 error（不交付半成品）", j15.status === "error",
    JSON.stringify(j15).slice(0, 150));
  check("分日故障：配额已退还", j15.remaining === before15,
    `before=${before15} got=${j15.remaining}`);

  // 用例 16：分日 prompt 接线——单日提示词必须带上当天的区域约束
  // （这是「不绕路」的关键：模型只在大纲指定的区域内排点）
  const lastUser16 = await (await fetch(`http://127.0.0.1:${STUB_PORT}/_last_user`)).json();
  check("分日 prompt：单日请求含当天主战场区域约束",
    (lastUser16.user ?? "").includes("主战场区域"),
    lastUser16.user?.slice(0, 200));

  // 用例 17：预算体检的对称性——以前只查「超预算 105%」，对「远低于预算」
  // 完全沉默，而 prompt 承诺「至少用掉 80%」。fixture 总价恒为 1925，
  // 可以精确构造两个场景来锁住这条契约。
  // 放在 phaseA 末尾：前面有用例依赖精确的 remaining 账目，加提交会打乱。
  const pLoose = await submitAndWait(api, { city: "苏州", days: 3, budget: 2500, preferences: [] }, "预算宽松");
  check("预算宽松：低于 80% 触发提示（1925/2500=77%）",
    (pLoose.warnings ?? []).some((w) => w.includes("预算较为宽松")),
    JSON.stringify(pLoose.warnings));
  const pFit = await submitAndWait(api, { city: "苏州", days: 3, budget: 2200, preferences: [] }, "预算贴合");
  check("预算贴合：达到 80% 不误报宽松提示（1925/2200=88%）",
    !(pFit.warnings ?? []).some((w) => w.includes("预算较为宽松")),
    JSON.stringify(pFit.warnings));
  check("预算贴合：落在契约区间内也不误报超预算",
    !(pFit.warnings ?? []).some((w) => w.includes("超出预算")),
    JSON.stringify(pFit.warnings));

  // 用例 18/19：LLM 连接中断（terminated）的健壮性。
  // 真机冒烟实测踩过：京都 5 天跑到第 4 天时连接被上游掐断，已成功生成 3 天、
  // 跑了 828 秒的任务整体废掉，用户只看到一个无法行动的 "terminated"。
  // 修了两件事：瞬时连接故障重试一次；失败信息带「已生成 N 天」进度。

  // 场景 A「断流」：只掐第 2 天的第一次调用，重试后应恢复。
  // 核心断言：长任务不该被一次连接抖动全废。
  const r18 = await api.post({ city: "断流测试城市", startAt: "2026-10-01T10:00",
    endAt: "2026-10-05T18:00", budget: 5000 });
  check("连接中断：提交 202", r18.status === 202, `got ${r18.status}`);
  const j18 = await api.waitJob(r18.body.jobId, 90000);
  check("连接中断重试：瞬时故障后恢复，任务 done", j18.status === "done",
    JSON.stringify(j18).slice(0, 150));
  check("连接中断重试：5 天齐全（重试救回了长任务）",
    (j18.plan?.days ?? []).length === 5, `got ${(j18.plan?.days ?? []).length}`);

  // 场景 B「持续断流」：每次都掐，重试也救不回来 → 必须失败（不假装成功），
  // 且错误信息要带进度——用户等了十几分钟，至少该知道成了几天、该不该重试
  const rBase19 = await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] });
  const jBase19 = await api.waitJob(rBase19.body.jobId);
  const before19 = jBase19.remaining;
  const r19 = await api.post({ city: "持续断流测试城市", startAt: "2026-10-01T10:00",
    endAt: "2026-10-05T18:00", budget: 5000 });
  check("持续断流：提交 202", r19.status === 202, `got ${r19.status}`);
  const j19 = await api.waitJob(r19.body.jobId, 90000);
  check("持续断流：任务 error（重试也救不回时不假装成功）", j19.status === "error",
    JSON.stringify(j19).slice(0, 200));
  check("持续断流：错误信息带「已成功生成 N 天」进度",
    /已成功生成 \d+ 天/.test(j19.error ?? ""), j19.error);
  check("持续断流：错误信息指明第几天失败",
    /第 \d+ 天生成失败/.test(j19.error ?? ""), j19.error);
  check("持续断流：配额已退还", j19.remaining === before19,
    `before=${before19} got=${j19.remaining}`);

  // 用例 20：逆序完成——桩让后面的天比前面的天更早返回，人为制造
  // 「第 3 天比第 1 天先生成完」。串行时代不可能出现这种出场顺序，所以这是
  // 本轮并发改造最需要的专项覆盖：此时用户绝不能看到乱序或跳号的行程，
  // 未就绪的天必须挡住它后面的所有天（前缀发布）。
  const r20 = await api.post({ city: "逆序完成测试城市", startAt: "2026-10-01T10:00",
    endAt: "2026-10-05T18:00", budget: 5000 });
  check("逆序完成：提交 202", r20.status === 202, `got ${r20.status}`);
  const seen20 = [];
  let final20 = {};
  let prefixOk20 = true;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const d = await (await fetch(`${api.baseUrl}/api/plan/status?id=${r20.body.jobId}`)).json();
      if (d.status === "done" || d.status === "error") { final20 = d; break; }
      if (typeof d.daysReady === "number" && seen20[seen20.length - 1] !== d.daysReady) {
        seen20.push(d.daysReady);
      }
      // 前缀不变式：任何时刻看到的部分行程，天数必须是 1..k 连续前缀
      const partial = d.plan?.days;
      if (Array.isArray(partial) && partial.length > 0) {
        const nums = partial.map((x) => x.day).join(",");
        const expect = Array.from({ length: partial.length }, (_, i) => i + 1).join(",");
        if (nums !== expect) prefixOk20 = false;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  check("逆序完成：任务最终 done", final20.status === "done", JSON.stringify(final20).slice(0, 150));
  check("逆序完成：最终 5 天且顺序 1..5",
    (final20.plan?.days ?? []).map((d) => d.day).join(",") === "1,2,3,4,5",
    JSON.stringify((final20.plan?.days ?? []).map((d) => d.day)));
  check("逆序完成：部分行程始终是连续前缀（并发不乱序/不跳号）",
    prefixOk20, JSON.stringify(seen20));
  check("逆序完成：daysReady 单调不减",
    seen20.every((v, i) => i === 0 || v >= seen20[i - 1]), JSON.stringify(seen20));

  // 用例 21：区域分散度预警——MOCK 模式下唯一的绕路信号。
  // 没配高德 key 时通勤完全不估算，「景点集中在同一区域」这条 prompt 规则
  // 有没有被遵守，用户此前得不到任何信号。阈值 4 是用真实数据校准的
  // （京都 5 天归一到区县后是 1/1/1/2/3，全部正常），所以 fixture 的
  // 归一 2/2/1 绝不该误报——先证伪，再证真。
  const pNeg = await submitAndWait(api, { city: "苏州", days: 3, budget: 2500, preferences: [] }, "区域分散负例");
  check("区域分散：fixture（归一 2/2/1 个区县）不误报",
    !(pNeg.warnings ?? []).some((w) => w.includes("个不同区域")),
    JSON.stringify(pNeg.warnings));

  const r21 = await api.post({ city: "区域散测试城市", startAt: "2026-10-01T10:00",
    endAt: "2026-10-05T18:00", budget: 5000 });
  check("区域分散：提交 202", r21.status === 202, `got ${r21.status}`);
  const j21 = await api.waitJob(r21.body.jobId, 90000);
  check("区域分散：任务 done", j21.status === "done", JSON.stringify(j21).slice(0, 120));
  const spreadWarnings = (j21.plan?.warnings ?? []).filter((w) => w.includes("个不同区域"));
  check("区域分散：高分散行程触发预警（5 景点跨 5 区县）",
    spreadWarnings.length > 0, JSON.stringify(j21.plan?.warnings));
  check("区域分散：预警点明第几天、景点数与区域数",
    /第 \d+ 天的 \d+ 个景点分散在 \d+ 个不同区域/.test(spreadWarnings[0] ?? ""),
    spreadWarnings[0]);
  check("区域分散：文案给出可行动建议",
    (spreadWarnings[0] ?? "").includes("合并同区域景点"), spreadWarnings[0]);

  // 用例 22：区域模式天数上限放宽（正向验证）。必须放在 phaseA 末尾——
  // 成功提交会扣配额，插在中间会打乱前面依赖精确 remaining 的断言。
  const rRegion8 = await api.post({ city: "川西环线", startAt: "2026-10-01T10:00",
    endAt: "2026-10-08T18:00", budget: 8000, scope: "region" });
  check("区域 8 天 → 202（分日流式支持，上限放宽到 10）", rRegion8.status === 202,
    `got ${rRegion8.status} ${JSON.stringify(rRegion8.body).slice(0, 80)}`);
  const jRegion8 = await api.waitJob(rRegion8.body.jobId, 90000);
  check("区域 8 天：任务 done 且 8 天齐全", jRegion8.status === "done"
    && (jRegion8.plan?.days ?? []).length === 8,
    `status=${jRegion8.status} days=${(jRegion8.plan?.days ?? []).length}`);

  // 用例 23-25：重点活动（用户提供、AI 编排）
  // 活动与必游地同为硬约束：漏排告警；另加时间合理性——spot 排在活动
  // 开始之后 = 用户错过开场，这是比漏排更隐蔽的问题。
  // 注意：这些用例会消耗配额，必须放在 phaseA 末尾（前面有精确 remaining 断言）。

  // 23：正常编排——活动出现在行程里，且不误报
  const r23 = await api.post({ city: "活动编排测试", days: 3, budget: 3000,
    events: [{ name: "测试音乐会", date: "2026-10-10", time: "19:00" }] });
  check("活动：提交 202", r23.status === 202, `got ${r23.status}`);
  const j23 = await api.waitJob(r23.body.jobId);
  const evSpots = (j23.plan?.days ?? []).flatMap((d) => d.spots)
    .filter((sp) => sp.name.includes("测试音乐会"));
  check("活动：编排进行程（出现 activity spot）", evSpots.length > 0,
    JSON.stringify((j23.plan?.days ?? []).flatMap((d) => d.spots.map((s) => s.name))));
  check("活动：spot 类型为 activity",
    evSpots.length > 0 && evSpots.every((sp) => sp.type === "activity"),
    JSON.stringify(evSpots.map((s) => s.type)));
  check("活动：正常编排不误报漏排",
    !(j23.plan?.warnings ?? []).some((w) => w.includes("测试音乐会") && w.includes("未出现")),
    JSON.stringify(j23.plan?.warnings));

  // 24：活动 spot 排在开始时间之后 → 「错过开场」告警
  const r24 = await api.post({ city: "活动晚点测试", days: 3, budget: 3000,
    events: [{ name: "测试音乐会", date: "2026-10-10", time: "19:00" }] });
  check("活动晚点：提交 202", r24.status === 202, `got ${r24.status}`);
  const j24 = await api.waitJob(r24.body.jobId);
  check("活动晚点：提示可能错过开场",
    (j24.plan?.warnings ?? []).some((w) => w.includes("测试音乐会") && w.includes("错过开场")),
    JSON.stringify(j24.plan?.warnings));

  // 25：活动漏排 → 告警（与必游地同级的硬约束）
  const r25 = await api.post({ city: "活动漏排测试", days: 3, budget: 3000,
    events: [{ name: "不存在的演出" }] });
  check("活动漏排：提交 202", r25.status === 202, `got ${r25.status}`);
  const j25 = await api.waitJob(r25.body.jobId);
  check("活动漏排：告警未出现在行程中",
    (j25.plan?.warnings ?? []).some((w) => w.includes("不存在的演出") && w.includes("未出现在行程中")),
    JSON.stringify(j25.plan?.warnings));

  // 26：events 超限/非法值 → 400（与 mustVisit 同级的输入防护）
  const r26 = await api.post({ city: "成都", days: 3, budget: 2500,
    events: [{ name: "甲" }, { name: "乙" }, { name: "丙" }, { name: "丁" }] });
  check("活动：超过 3 个 → 400", r26.status === 400, `got ${r26.status}`);
  const r26b = await api.post({ city: "成都", days: 3, budget: 2500,
    events: [{ name: "演出<script>" }] });
  check("活动：名称含特殊字符（防注入）→ 400", r26b.status === 400, `got ${r26b.status}`);
  const r26c = await api.post({ city: "成都", days: 3, budget: 2500,
    events: [{ name: "演出", time: "25:99" }] });
  check("活动：时间格式非法 → 400", r26c.status === 400, `got ${r26c.status}`);
}

// ---------------- 阶段 B：真实模式（高德桩） ----------------

async function phaseB(api) {
  console.log("\n== 高德集成（真实模式走桩，验证官方 API 形状） ==");
  const j = await api.waitJob(
    (await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] })).body.jobId,
  );
  check("任务 done", j.status === "done", JSON.stringify(j).slice(0, 120));
  const plan = j.plan ?? {};
  const days = plan.days ?? [];

  check("verified=true（走了真实高德路径）", plan.verified === true);
  // fixture 每天点数 [7,5,4] → 段数 [6,4,3]；Day1 的「桃花源记」搜不到，
  // 涉及它的 2 段走 30 分钟 fallback，其余 4 段 22 分钟 → 4×22 + 2×30 = 148
  check("Day1 通勤 = 148 分钟（4 段×22 + 2 段 fallback×30）",
    days[0]?.transitMin === 148, `got ${days[0]?.transitMin}`);
  check("Day2 通勤 = 88 分钟（4 段）", days[1]?.transitMin === 88, `got ${days[1]?.transitMin}`);
  check("Day3 通勤 = 66 分钟（3 段）", days[2]?.transitMin === 66, `got ${days[2]?.transitMin}`);
  check("总价 = 1925（每日 cost 汇总正确）",
    plan.totalCostCny === 1925, `got ${plan.totalCostCny}`);
  check("POI 未命中预警（Day1 的桃花源记）",
    (plan.warnings ?? []).some((w) => w.includes("桃花源记") && w.includes("未在高德检索到")),
    JSON.stringify(plan.warnings));
  check("命中项不误报（拙政园不在未命中预警里）",
    !(plan.warnings ?? []).some((w) => w.includes("拙政园") && w.includes("未在高德")),
    JSON.stringify(plan.warnings));

  // ---- 实时定位（逆地理编码）----
  // 真实模式下才跑：MOCK 模式没有高德 key，reverseGeocode 直接返回 null。
  // 覆盖两个实测坑：普通城市的「市」后缀剥离、直辖市的 city 空数组回退。
  const geoNormal = await fetch(`${api.baseUrl}/api/geocode/reverse?lng=104.06&lat=30.57`);
  const gNormal = await geoNormal.json();
  check("定位：普通城市返回裸城市名（剥离「市」后缀）",
    geoNormal.status === 200 && gNormal.city === "成都",
    JSON.stringify(gNormal));
  check("定位：附带区县与完整地址（用于向用户展示定位结果）",
    gNormal.district === "武侯区" && (gNormal.formatted ?? "").includes("成都"),
    JSON.stringify(gNormal));

  const geoMuni = await fetch(`${api.baseUrl}/api/geocode/reverse?lng=116.40&lat=39.90`);
  const gMuni = await geoMuni.json();
  check("定位：直辖市 city 是空数组，回退 province（不能返回空城市名）",
    geoMuni.status === 200 && gMuni.city === "北京",
    JSON.stringify(gMuni));

  const geoBad = await fetch(`${api.baseUrl}/api/geocode/reverse?lng=abc&lat=30`);
  check("定位：非法坐标 → 400", geoBad.status === 400, `got ${geoBad.status}`);
  const geoRange = await fetch(`${api.baseUrl}/api/geocode/reverse?lng=999&lat=30`);
  check("定位：坐标越界 → 400", geoRange.status === 400, `got ${geoRange.status}`);

  // ---- 天气提示（live 模式）----
  // 桩返回 2026-10-10「小雨」的预报，fixture 行程 Day1（10-10）有室外景点
  // → 应触发天气提示。这验证的是完整接线：jobs.ts → fetchWeather → 高德 → warnings。
  const jWx = await api.waitJob(
    (await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] })).body.jobId,
  );
  const wxWarnings = (jWx.plan?.warnings ?? []).filter((w) => w.includes("预报"));
  check("天气：坏天气 + 室外景点 → 生成提示", wxWarnings.length > 0,
    JSON.stringify(jWx.plan?.warnings));
  check("天气：提示点明日期与天气",
    (wxWarnings[0] ?? "").includes("2026-10-10") && (wxWarnings[0] ?? "").includes("小雨"),
    wxWarnings[0]);
  check("天气：提示列出当天室外景点",
    /室外景点/.test(wxWarnings[0] ?? ""), wxWarnings[0]);
  check("天气：只提示不改写（行程结构不变）",
    (jWx.plan?.days ?? []).length === 3, `days=${(jWx.plan?.days ?? []).length}`);

  // ---- 地址自动补全（live 模式走桩）----
  // 验证完整接线：/api/places/suggest → suggestPlaces → 高德 → 多条建议
  const sugCity = await fetch(`${api.baseUrl}/api/places/suggest?q=${encodeURIComponent("成都")}&scope=city`);
  const sugCityBody = await sugCity.json();
  check("补全：城市模式返回多条建议", sugCity.status === 200
    && (sugCityBody.suggestions ?? []).length >= 2,
    JSON.stringify(sugCityBody).slice(0, 120));
  check("补全：建议含名称与详情（展示用）",
    (sugCityBody.suggestions ?? []).every((x) => typeof x.name === "string" && x.name.length > 0),
    JSON.stringify(sugCityBody.suggestions?.[0]));

  const sugPoi = await fetch(`${api.baseUrl}/api/places/suggest?q=${encodeURIComponent("全季")}&scope=poi&city=${encodeURIComponent("成都")}`);
  const sugPoiBody = await sugPoi.json();
  check("补全：POI 模式返回具体地点建议", sugPoi.status === 200
    && (sugPoiBody.suggestions ?? []).length >= 2,
    JSON.stringify(sugPoiBody).slice(0, 120));

  const sugBad = await fetch(`${api.baseUrl}/api/places/suggest?q=`);
  check("补全：空关键词 → 400（不打无谓请求）", sugBad.status === 400, `got ${sugBad.status}`);
}

// ---------------- 阶段 C：登录体系（dev provider） ----------------

async function phaseC(api) {
  console.log("\n== 登录体系（dev provider，验证码 123456）==");

  const me0 = await api.me();
  check("未登录时 loggedIn=false", me0.body.loggedIn === false);

  // 手机号格式校验
  const badPhone = await api.authPost("/api/auth/code", { phone: "123" });
  check("非法手机号 → 400", badPhone.status === 400, `got ${badPhone.status}`);

  // 错误验证码
  const wrong = await api.authPost("/api/auth/verify", { phone: "13800138000", code: "000000" });
  check("错误验证码 → 401", wrong.status === 401, `got ${wrong.status}`);

  // 正确登录（dev provider 固定码）
  const sent = await api.authPost("/api/auth/code", { phone: "13800138000" });
  check("发送验证码 → 200", sent.status === 200, `got ${sent.status}`);
  const ok = await api.authPost("/api/auth/verify", { phone: "13800138000", code: "123456" });
  check("正确验证码 → 200 且下发 cookie", ok.status === 200 && api.jar.cookie.startsWith("tp_session="),
    `status=${ok.status} cookie=${api.jar.cookie.slice(0, 20)}`);

  const me1 = await api.me();
  check("登录后 /api/me 返回手机号", me1.body.loggedIn === true && me1.body.phone === "13800138000");
  check("登录后剩余 = 10（用户配额）", me1.body.remaining === 10, `got ${me1.body.remaining}`);

  // 登录用户配额独立：连提 4 次（桩 LLM 秒回，不等待完成，配额提交即扣）
  for (let i = 0; i < 4; i++) {
    const r = await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] });
    if (r.status !== 202) check(`第 ${i + 1} 次提交应 202`, false, `got ${r.status}`);
  }
  const me2 = await api.me();
  check("登录用户 4 次后剩余 = 6", me2.body.remaining === 6, `got ${me2.body.remaining}`);

  // 另一用户配额独立
  await api.authPost("/api/auth/verify", { phone: "13900139000", code: "123456" });
  const meB = await api.me();
  check("第二个用户独立 quota（=10）", meB.body.remaining === 10, `got ${meB.body.remaining}`);

  // 陌生人仍走 IP 配额（3 次/天）
  const noCookieApi = makeApi(`http://127.0.0.1:${PORTS.auth}`);
  for (let i = 0; i < 3; i++) {
    const r = await noCookieApi.post({ city: "成都", days: 3, budget: 1000, preferences: [] });
    if (r.status !== 202) check(`陌生人第 ${i + 1} 次应 202`, false, `got ${r.status}`);
  }
  const r4 = await noCookieApi.post({ city: "成都", days: 3, budget: 1000, preferences: [] });
  check("陌生人第 4 次 → 429（IP 配额 3）", r4.status === 429, `got ${r4.status}`);
  check("429 文案引导登录", (r4.body.error ?? "").includes("登录"), r4.body.error);

  // 登录不受 IP 配额影响（关键：双轨隔离）
  const r5 = await api.post({ city: "成都", days: 3, budget: 1000, preferences: [] });
  check("IP 被限流后登录用户仍可提交", r5.status === 202, `got ${r5.status}`);

  // 登出
  await api.authPost("/api/auth/logout", {});
  const me3 = await api.me();
  check("登出后 loggedIn=false", me3.body.loggedIn === false);

  // 短信防轰炸：单手机号 5 条/小时（之前已发 1 条，再发 4 条到顶，第 6 条拦截）
  for (let i = 0; i < 4; i++) {
    await api.authPost("/api/auth/code", { phone: "13800138000" });
  }
  const spam = await api.authPost("/api/auth/code", { phone: "13800138000" });
  check("同手机号第 6 条验证码 → 429（5 条/小时）", spam.status === 429, `got ${spam.status}`);
}

// ---------------- 阶段 D：微信 OAuth（桩微信） ----------------

async function phaseD(base) {
  console.log("\n== 微信 OAuth（桩微信，全流程） ==");

  // 1. 发起登录 → 跳转（桩）微信授权页，并下发 wx_state cookie
  // 注：Next 的 NextResponse.redirect 是 307，浏览器同样正常跟随
  const r1 = await fetch(`${base}/api/auth/wechat/login?redirect=/`, { redirect: "manual" });
  check("login → 307/302", r1.status === 307 || r1.status === 302, `got ${r1.status}`);
  const authUrl = new URL(r1.headers.get("location") ?? "");
  check("跳转桩 authorize 且带 appid",
    authUrl.pathname === "/connect/oauth2/authorize" && authUrl.searchParams.get("appid") === "wx_stub",
    authUrl.toString().slice(0, 80));
  const state = authUrl.searchParams.get("state") ?? "";
  const wxCookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
  check("下发 wx_state cookie（CSRF 防护）", wxCookie.startsWith("wx_state="));

  // 2. 模拟「用户在微信点同意」：请求授权页，桩带 code+state 回流本站 callback
  const r2 = await fetch(authUrl.toString(), { redirect: "manual" });
  const cb = new URL(r2.headers.get("location") ?? "");
  check("回流到本站 callback", cb.pathname === "/api/auth/wechat/callback", cb.pathname);

  // 3. 回调（带 wx_state）→ code 换 openid → 302 落地页 + session cookie
  const r3 = await fetch(`${base}${cb.pathname}${cb.search}`, {
    redirect: "manual",
    headers: { Cookie: wxCookie },
  });
  check("callback → 307/302", r3.status === 307 || r3.status === 302, `got ${r3.status}`);
  const sessionCookie = (r3.headers.get("set-cookie") ?? "").split(";")[0];
  check("下发 tp_session", sessionCookie.startsWith("tp_session="));

  // 4. /api/me：微信用户身份
  const meBody = await (await fetch(`${base}/api/me`, { headers: { Cookie: sessionCookie } })).json();
  check("微信用户登录态（wx:stub_openid_001）",
    meBody.loggedIn === true && meBody.phone === "wx:stub_openid_001", JSON.stringify(meBody));

  // 5. 双轨配额对微信 key 生效（用户轨 10 次）
  const r5 = await fetch(`${base}/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    body: JSON.stringify({ city: "成都", startAt: "2026-10-10T10:00",
      endAt: "2026-10-12T18:00", budget: 1000, preferences: [] }),
  });
  check("微信用户可提交 202", r5.status === 202, `got ${r5.status}`);
  const meBody2 = await (await fetch(`${base}/api/me`, { headers: { Cookie: sessionCookie } })).json();
  check("微信用户配额 = 9（提交 1 次后）", meBody2.remaining === 9, `got ${meBody2.remaining}`);

  // 6. 伪造 state → 400（CSRF 防护真实生效）
  const bad = await fetch(`${base}/api/auth/wechat/callback?code=stub_wx_code&state=forged_state`, {
    redirect: "manual",
    headers: { Cookie: wxCookie },
  });
  check("伪造 state → 400", bad.status === 400, `got ${bad.status}`);
}

// ---------------- 阶段 E：短信 provider（真实实现走桩腾讯云） ----------------

async function phaseE(base, smsStubBase) {
  console.log("\n== 短信 provider（TC3 直签 + 服务端验证码，走桩）==");
  const api = makeApi(base);

  const sent = await api.authPost("/api/auth/code", { phone: "13700137000" });
  check("发送验证码 → 200", sent.status === 200, `got ${sent.status}`);

  // 桩侧收到了 TC3 SendSms 请求，且验证码是 6 位数字（真实随机）
  const last = await (await fetch(`${smsStubBase}/_last_code`)).json();
  check("桩收到 SendSms 请求（TC3 头/负载构造正确）",
    last.action === "SendSms" && last.phone === "+8613700137000",
    JSON.stringify(last));
  check("验证码为 6 位数字随机值", /^\d{6}$/.test(last.code ?? ""), String(last.code));

  const wrong = await api.authPost("/api/auth/verify", { phone: "13700137000", code: "000000" });
  check("错误验证码 → 401", wrong.status === 401, `got ${wrong.status}`);

  const ok = await api.authPost("/api/auth/verify", { phone: "13700137000", code: last.code });
  check("正确验证码（服务端比对）→ 200 + cookie",
    ok.status === 200 && api.jar.cookie.startsWith("tp_session="), `status=${ok.status}`);

  const reuse = await api.authPost("/api/auth/verify", { phone: "13700137000", code: last.code });
  check("同码复用 → 401（一次性消费）", reuse.status === 401, `got ${reuse.status}`);

  const me = await api.me();
  check("登录态正确（13700137000）",
    me.body.loggedIn === true && me.body.phone === "13700137000", JSON.stringify(me.body));
}

// ---------------- 阶段 P：Postgres 实现契约测试（有 DATABASE_URL 才跑） ----------------

async function phaseP(api) {
  console.log("\n== Postgres 实现契约（DATA_STORE=postgres）==");
  const health = await (await fetch(`${api.baseUrl}/api/health`)).json();
  check("health 报告 store=postgres", health.store === "postgres", JSON.stringify(health));

  // 任务持久化：提交 → 完成 → 状态可读
  const r1 = await api.post({ city: "成都", budget: 2000 });
  check("PG：提交 202", r1.status === 202, `got ${r1.status}`);
  const j1 = await api.waitJob(r1.body.jobId);
  check("PG：任务 done（job 落库）", j1.status === "done", JSON.stringify(j1).slice(0, 100));
  check("PG：行程内容完整", (j1.plan?.days ?? []).length === 3);

  // 配额持久化：limit=2，第 3 次必须 429（PG 侧 upsert 计数）
  const r2 = await api.post({ city: "成都", budget: 2000 });
  check("PG：第 2 次提交 202（limit=2）", r2.status === 202, `got ${r2.status}`);
  const r3 = await api.post({ city: "成都", budget: 2000 });
  check("PG：第 3 次提交 429（PG 配额生效）", r3.status === 429, `got ${r3.status}`);
}

// ---------------- 主流程 ----------------

async function main() {
  console.log("启动桩服务与两台测试服务器（MOCK 3103 / 真实 3104）……");
  // 单日响应加延迟：分日流式的核心价值是「逐天出现」，桩若秒回则整个任务
  // 瞬间完成，e2e 无法观测中间状态。注入 1500ms/天，5 天约 7.5 秒——
  // 留足余量是因为 dev server 首次请求要现编译路由，会吃掉几百毫秒，
  // 延迟太窄会让「渐进」观测退化成「只看到 1 或直接 done」。
  spawnCmd("node", ["scripts/stub-llm.mjs", String(STUB_PORT)], { STUB_DAY_DELAY_MS: "1500" });
  spawnCmd("node", ["scripts/amap-stub.mjs", String(AMAP_STUB_PORT)]);
  spawnCmd("node", ["scripts/wechat-stub.mjs", String(WECHAT_STUB_PORT)]);
  spawnCmd("node", ["scripts/sms-stub.mjs", String(SMS_STUB_PORT)]);
  spawnCmd("node", ["node_modules/next/dist/bin/next", "dev", "-p", String(PORTS.mock)], {
    NEXT_DIST_DIR: `.next-t-mock`,
    LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    LLM_API_KEY: "stub-key",
    LLM_MODEL: "step-5-preview",
    DAILY_FREE_LIMIT: "50",
    // 显式清空：Next dev 会自动加载项目根的 .env，若开发机 .env 里配了真实
    // 高德 key，这台本该跑 MOCK 模式的服务器会悄悄进入 live 模式，导致
    // 「MOCK 模式 verified=false」等断言失败。显式空值优先于 .env（已验证）。
    AMAP_WEB_SERVICE_KEY: "",
  });
  spawnCmd("node", ["node_modules/next/dist/bin/next", "dev", "-p", String(PORTS.real)], {
    NEXT_DIST_DIR: `.next-t-real`,
    LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    LLM_API_KEY: "stub-key",
    LLM_MODEL: "step-5-preview",
    AMAP_WEB_SERVICE_KEY: "stub-amap-key",
    AMAP_BASE_URL: `http://127.0.0.1:${AMAP_STUB_PORT}`,
  });
  spawnCmd("node", ["node_modules/next/dist/bin/next", "dev", "-p", String(PORTS.auth)], {
    NEXT_DIST_DIR: `.next-t-auth`,
    LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    LLM_API_KEY: "stub-key",
    LLM_MODEL: "step-5-preview",
    AMAP_WEB_SERVICE_KEY: "", // 隔离 .env 里的真实 key，见上方 mock 服务器的注释
  });
  spawnCmd("node", ["node_modules/next/dist/bin/next", "dev", "-p", String(PORTS.wx)], {
    NEXT_DIST_DIR: `.next-t-wx`,
    LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    LLM_API_KEY: "stub-key",
    LLM_MODEL: "step-5-preview",
    AUTH_PROVIDER: "wechat",
    WECHAT_APPID: "wx_stub",
    WECHAT_SECRET: "stub_secret",
    WECHAT_API_BASE: `http://127.0.0.1:${WECHAT_STUB_PORT}`,
    WECHAT_AUTH_BASE: `http://127.0.0.1:${WECHAT_STUB_PORT}`,
    AMAP_WEB_SERVICE_KEY: "", // 隔离 .env 里的真实 key，见上方 mock 服务器的注释
  });
  if (HAS_PG) {
    // Postgres 实现契约测试（需 DATABASE_URL；表结构由 prisma migrate deploy 建好）
    spawnCmd("node", ["node_modules/next/dist/bin/next", "dev", "-p", String(PORTS.pg)], {
      NEXT_DIST_DIR: `.next-t-pg`,
      DATA_STORE: "postgres",
      DATABASE_URL: process.env.DATABASE_URL,
      LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
      LLM_API_KEY: "stub-key",
      LLM_MODEL: "step-5-preview",
      DAILY_FREE_LIMIT: "2",
      AMAP_WEB_SERVICE_KEY: "", // 隔离 .env 里的真实 key，见上方 mock 服务器的注释
    });
  }
  spawnCmd("node", ["node_modules/next/dist/bin/next", "dev", "-p", String(PORTS.sms)], {
    NEXT_DIST_DIR: `.next-t-sms`,
    LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    LLM_API_KEY: "stub-key",
    LLM_MODEL: "step-5-preview",
    AUTH_PROVIDER: "sms",
    SMS_API_BASE: `http://127.0.0.1:${SMS_STUB_PORT}`,
    SMS_SECRET_ID: "stub_secret_id",
    SMS_SECRET_KEY: "stub_secret_key",
    SMS_APP_ID: "1400000000",
    SMS_SIGN: "测试签名",
    SMS_TEMPLATE_ID: "1000000",
    AMAP_WEB_SERVICE_KEY: "", // 隔离 .env 里的真实 key，见上方 mock 服务器的注释
  });

  const [upA, upB, upC, upD, upE] = await Promise.all([
    waitReady(`${APP("mock")}/`, 150000),
    waitReady(`${APP("real")}/`, 150000),
    waitReady(`${APP("auth")}/`, 150000),
    waitReady(`${APP("wx")}/`, 150000),
    waitReady(`${APP("sms")}/`, 150000),
  ]);
  if (!upA || !upB || !upC || !upD || !upE) {
    console.error(`❌ 测试服务器未就绪（mock=${upA} real=${upB} auth=${upC} wx=${upD} sms=${upE}）`);
    for (const c of children) c.kill("SIGTERM");
    process.exitCode = 1;
    return;
  }

  if (HAS_PG) {
    await waitReady(`${APP("pg")}/`, 150000);
    await phaseP(makeApi(APP("pg")));
  }

  try {
    await phaseA(makeApi(APP("mock")));
    await phaseB(makeApi(APP("real")));
    await phaseC(makeApi(APP("auth")));
    await phaseD(APP("wx"));
    await phaseE(APP("sms"), `http://127.0.0.1:${SMS_STUB_PORT}`);
  } finally {
    for (const c of children) c.kill("SIGTERM");
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  -", f);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
