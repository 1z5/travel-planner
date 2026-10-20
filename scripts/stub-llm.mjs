#!/usr/bin/env node
/**
 * 桩 LLM 服务（测试专用）：模拟 LLM 的各种行为。
 *
 * 按请求里「目的地：X」的城市名分支：
 *   含"垃圾" -> 返回非 JSON 文本（测 parse 重试路径）
 *   含"空"   -> 返回空 content（测空返回重试路径）
 *   含"故障" -> 直接 HTTP 500（测上游错误路径）
 *   其他     -> 返回构造好的合法行程（测正常链路 + 体检阈值）
 *
 * 改行程（refine，lib/refine.ts）请求另走一套分支，**先于**上面这些城市名分支判断：
 *   system prompt 含「行程微调」即判定为改行程请求，再按「【任务类型】单点替换 /
 *   单日重排」分流。需与 lib/refine.ts 的 prompt 格式保持同步（那边有注释指向这里）。
 *   从 user prompt 解析：
 *     - 目标：第 N 天                     -> 改哪一天
 *     - 【被替换点】序号 K｜类型 T｜时段 P｜时间 HH:MM-HH:MM｜区域 A｜名称 N
 *                                         -> swap 返回什么 type/period/time/area
 *     - 【用户指令】「...」               -> 用户指令（也承载下面的测试开关）
 *     - 【当天必须保留】X、Y              -> day 模式响应必须原样保留的点
 *   swap 响应：{"spot":{...}}（type/period/time/area 与被替换点一致，名称固定为「替换景点（桩）K」）
 *   day 响应：{"day":{"day":N,"theme":原主题,"spots":[3-4 个合法点]}}（含必须保留的点）
 *   失败/约束路径开关（指令里含这些词时生效，供 e2e 断言错误码）：
 *     - 「故意失败」      -> 返回非 JSON 文本（内容层重试两次后 → 422）
 *     - 「故意删硬约束」  -> day 响应故意漏掉「当天必须保留」的点（→ 422，原行程不变）
 *   以上分支只对「行程微调」请求生效，不影响现有生成链路的分支。
 *   注：swap 的「类型必须延续」纠正重试由单测覆盖（tests/lib/refine.test.ts）；
 *   swap 契约上不带指令，桩无法用指令触发错误类型，故不在 e2e 里造这条路径。
 *
 * 行程管家（copilot，lib/copilot.ts）请求**最先**判定：system prompt 固定含
 * 「行程管家」四个字。返回 {"answer","suggestion"} 的 JSON；因 streamChatRetry
 * 只发一条 user 消息，桩从 user prompt 末尾的「【用户本次问题】」块取最后一条
 * 用户消息（历史里的旧问题不参与意图判定），规则确定性：
 *   含「雨」                    -> fix / rain，day=1
 *   含「赶/来不来得及/顺延」     -> retime，day=1
 *   含「预算」                  -> fix / budget-over，day=1
 *   其它                        -> suggestion=null
 * 该分支先于城市名/refine 分支，不影响既有生成与改行程链路。
 *
 * 用法：node scripts/stub-llm.mjs [port]   （默认 8898）
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.argv[2] || process.env.STUB_PORT || 8898);

// 正常模式返回的真实行程 fixture：来自一次真实生成的「苏州 3 天」结果
// （day.transitMin / dailyCostCny 是 validate 回填字段，LLM 输出层不带）
const CANNED_PLAN = JSON.parse(
  readFileSync(new URL("./fixture-plan.json", import.meta.url), "utf8"),
);

let lastUserMsg = "";

// 从 user 消息解析请求天数（prompt 形如「- 天数：N 天」）。
// planner 现在会核对「输出天数 === 请求天数」，桩不能再一律返回 3 天
// fixture——否则 1 天/4 天的请求会被判结构不符而失败。
// 少于 fixture 天数取前 N 天；多于则循环补齐（桩只测结构，内容复用无妨）。
//
// 同时透传用户请求的城市：fixture 的 city 固定是「苏州」，但 validate 是拿
// **plan.city** 去查高德的——不覆盖的话，请求「境外城市」时高德收到的是
// city=苏州，境外分支永远不命中（实测踩过：预警里只有「桃花源记」miss，
// 看不到无覆盖提示）。真实 LLM 会回应用户请求的城市，桩也要照做。
function requestedCity(userMsg) {
  const m = userMsg.match(/目的地：(\S+)/);
  return m ? m[1] : CANNED_PLAN.city;
}

function planForRequestedDays(userMsg) {
  const city = requestedCity(userMsg);
  const m = userMsg.match(/天数：(\d+)\s*天/);
  const n = m ? Number(m[1]) : CANNED_PLAN.days.length;
  if (!Number.isInteger(n) || n < 1 || n === CANNED_PLAN.days.length) {
    return city === CANNED_PLAN.city ? CANNED_PLAN : { ...CANNED_PLAN, city };
  }
  const days = [];
  for (let i = 0; i < n; i++) {
    const src = CANNED_PLAN.days[Math.min(i, CANNED_PLAN.days.length - 1)];
    days.push({ ...src, day: i + 1, spots: src.spots.map((s) => ({ ...s })) });
  }
  return { ...CANNED_PLAN, city, days };
}

// 乱序 + 跳号响应：数组顺序 [Day2, Day3, Day1]，day 字段 [5, 9, 2]。
// planner 归一化（按 day 排序 + 重编号 1..N）后应还原成与 fixture 完全
// 一致的结果——用来证明乱序/0 基/跳号输出不会被渲染成错乱行程。
function scrambledPlan() {
  return {
    ...CANNED_PLAN,
    days: [
      { ...CANNED_PLAN.days[1], day: 5 },
      { ...CANNED_PLAN.days[2], day: 9 },
      { ...CANNED_PLAN.days[0], day: 2 },
    ],
  };
}

// ---------- 分日流式（≥5 天）的桩响应 ----------
// 两次调用靠 system prompt 区分：大纲调用含「行程大纲」，单日调用含
// 「某一天的时刻表」。天数同样按请求适配（见 planForRequestedDays 注释）。

function outlineForRequestedDays(userMsg) {
  const m = userMsg.match(/天数：(\d+)\s*天/);
  const n = m ? Number(m[1]) : CANNED_PLAN.days.length;
  const days = [];
  for (let i = 0; i < n; i++) {
    const src = CANNED_PLAN.days[Math.min(i, CANNED_PLAN.days.length - 1)];
    days.push({
      day: i + 1,
      theme: src.theme,
      area: src.spots[0]?.area ?? "测试区",
      focus: `第 ${i + 1} 天的安排思路（桩数据）`,
    });
  }
  return {
    city: requestedCity(userMsg),
    summary: CANNED_PLAN.summary,
    days,
    tips: CANNED_PLAN.tips ?? [],
  };
}

function dayForRequested(userMsg) {
  // day prompt 形如「现在生成行程中第 N 天的时刻表（共 M 天，这是第 K 天）」
  const m = userMsg.match(/第 (\d+) 天的时刻表（共 (\d+) 天/);
  const dayNum = m ? Number(m[1]) : 1;
  const src = CANNED_PLAN.days[Math.min(dayNum - 1, CANNED_PLAN.days.length - 1)];
  let spots = src.spots.map((s) => ({ ...s }));
  // 住宿只应出现在第一天：循环补齐时第 4/5 天会复用 fixture 的第 1 天，
  // 把酒店 spot 剔掉，避免桩数据自相矛盾
  if (dayNum > 1) spots = spots.filter((s) => s.type !== "hotel");
  return { day: dayNum, theme: src.theme, spots };
}

// 高区域分散的一天：5 个景点分属 5 个不同区县，确定触发区域分散度预警（阈值 4）。
// fixture 每天最多 3 个景点，靠现有数据到不了阈值，所以这里直接构造。
// 区县前缀必须真的不同——预警是按归一化后的区县计数的。
function scatteredDayForRequested(userMsg) {
  const m = userMsg.match(/第 (\d+) 天的时刻表（共 (\d+) 天/);
  const dayNum = m ? Number(m[1]) : 1;
  const src = CANNED_PLAN.days[Math.min(dayNum - 1, CANNED_PLAN.days.length - 1)];
  const wards = ["东城区", "西城区", "南港区", "北屯区", "和平区"];
  const periods = ["morning", "morning", "lunch", "afternoon", "evening"];
  const spots = wards.map((w, i) => ({
    period: periods[i],
    time: `${9 + i * 2}:00-${10 + i * 2}:00`,
    type: "sight",
    name: `分散景点${i + 1}`,
    area: `${w}测试地段`,
    durationMin: 90,
    costCny: 50,
    reason: "区域分散度测试用景点",
    rainBackup: "室内备选",
  }));
  return { day: dayNum, theme: src.theme, spots };
}

// 单日响应的延迟（毫秒）：分日流式的核心价值是「逐天出现」，桩若秒回，
// 整个任务瞬间完成，e2e 根本无法观测中间状态。测试编排器通过环境变量
// 注入延迟，让渐进式交付可被断言。
const DAY_DELAY_MS = Number(process.env.STUB_DAY_DELAY_MS || 0);
// 活动编排（正常路径）：在 fixture Day1 插入 activity spot，时间排在活动
// 开始之前（19:00 开始 → 18:30 入场）→ 应入行程且不误报
function eventOkDay(userMsg) {
  const m = userMsg.match(/第 (\d+) 天的时刻表（共 (\d+) 天/);
  const dayNum = m ? Number(m[1]) : 1;
  const src = CANNED_PLAN.days[Math.min(dayNum - 1, CANNED_PLAN.days.length - 1)];
  const spots = src.spots.map((x) => ({ ...x }));
  spots.push({
    period: "evening",
    time: "18:30-21:30",
    type: "activity",
    name: "测试音乐会",
    area: src.spots[0]?.area ?? "测试区",
    durationMin: 180,
    costCny: 380,
    reason: "用户指定的重点活动（桩数据），提前 30 分钟入场",
  });
  return { day: dayNum, theme: src.theme, spots };
}

// 活动晚点：在 fixture Day1 插入 activity spot，时间排在活动开始之后
// （活动 19:00 开始，spot 排 21:00）→ 应触发「错过开场」告警
function eventLateDay(userMsg) {
  const m = userMsg.match(/第 (\d+) 天的时刻表（共 (\d+) 天/);
  const dayNum = m ? Number(m[1]) : 1;
  const src = CANNED_PLAN.days[Math.min(dayNum - 1, CANNED_PLAN.days.length - 1)];
  const spots = src.spots.map((x) => ({ ...x }));
  spots.push({
    period: "evening",
    time: "21:00-22:30",
    type: "activity",
    name: "测试音乐会",
    area: src.spots[0]?.area ?? "测试区",
    durationMin: 90,
    costCny: 380,
    reason: "用户指定的重点活动（桩数据）",
  });
  return { day: dayNum, theme: src.theme, spots };
}

// 活动漏排：fixture 原样返回（不含用户指定的活动）→ 应触发漏排告警
function eventMissingDay(userMsg) {
  const m = userMsg.match(/第 (\d+) 天的时刻表（共 (\d+) 天/);
  const dayNum = m ? Number(m[1]) : 1;
  const src = CANNED_PLAN.days[Math.min(dayNum - 1, CANNED_PLAN.days.length - 1)];
  let spots = src.spots.map((x) => ({ ...x }));
  if (dayNum > 1) spots = spots.filter((x) => x.type !== "hotel");
  return { day: dayNum, theme: src.theme, spots };
}

// ---- plan 级包装：单次调用路径（days<5）返回完整 plan ----
// 活动功能与天数无关，两条生成路径都要覆盖。day 级函数返回单日；
// plan 级基于 planForRequestedDays 的完整行程，把活动 spot 插进 Day1。

function withEventSpot(basePlan, time, durationMin, reason) {
  const days = basePlan.days.map((d) => ({ ...d, spots: d.spots.map((x) => ({ ...x })) }));
  if (days.length > 0) {
    days[0].spots.push({
      period: "evening",
      time,
      type: "activity",
      name: "测试音乐会",
      area: days[0].spots[0]?.area ?? "测试区",
      durationMin,
      costCny: 380,
      reason,
    });
  }
  return { ...basePlan, days };
}

function eventResponse(userMsg, isDayCall, time, durationMin, reason) {
  if (isDayCall) {
    return time === "21:00-22:30" ? eventLateDay(userMsg) : eventOkDay(userMsg);
  }
  return withEventSpot(planForRequestedDays(userMsg), time, durationMin, reason);
}

// 必游地别名：模拟真实场景——用户写「成都大熊猫基地」（简称），模型落成
// 规范全称「成都大熊猫繁育研究基地」。全字符串 includes 匹配不上会误报
// 漏排；nameCovered 的最长公共子串（「成都大熊猫」5 字）要能识别。
const ALIASED_MV_NAME = "成都大熊猫繁育研究基地";

function mvAliasResponse(userMsg, isDayCall) {
  const mk = (dayNum, src) => ({
    day: dayNum,
    theme: src.theme,
    spots: [
      ...src.spots.map((x) => ({ ...x })),
      {
        period: "morning",
        time: "09:00-12:00",
        type: "sight",
        name: ALIASED_MV_NAME,
        area: "成华区",
        durationMin: 180,
        costCny: 55,
        reason: "用户指定的必游地（桩数据），已落成规范全称",
        rainBackup: "成都动物园",
      },
    ],
  });
  const m = userMsg.match(/第 (\d+) 天的时刻表（共 (\d+) 天/);
  const dayNum = m ? Number(m[1]) : 1;
  const src = CANNED_PLAN.days[Math.min(dayNum - 1, CANNED_PLAN.days.length - 1)];
  if (isDayCall) return mk(dayNum, src);
  const base = planForRequestedDays(userMsg);
  const days = base.days.map((d) => ({ ...d, spots: d.spots.map((x) => ({ ...x })) }));
  if (days.length > 0) days[0] = mk(1, CANNED_PLAN.days[0]);
  return { ...base, days };
}

// 漏排：day 级返回单日，plan 级返回完整行程（两者都不含活动名）
function eventMissingResponse(userMsg, isDayCall) {
  return isDayCall ? eventMissingDay(userMsg) : planForRequestedDays(userMsg);
}

// 活动别名：模拟真机场景——用户写「成都川剧变脸演出」，模型正确落成具体
// 场馆「蜀风雅韵川剧变脸演出(琴台路店)」。全字符串匹配会误报漏排，
// nameCovered 的最长公共子串要能识别这是正确执行。
const ALIASED_EVENT_NAME = "蜀风雅韵川剧变脸演出(琴台路店)";

function eventAliasResponse(userMsg, isDayCall, time) {
  const mk = (dayNum, src) => ({
    day: dayNum,
    theme: src.theme,
    spots: [
      ...src.spots.map((x) => ({ ...x })),
      {
        period: "evening",
        time,
        type: "activity",
        name: ALIASED_EVENT_NAME,
        area: src.spots[0]?.area ?? "琴台路",
        durationMin: 90,
        costCny: 380,
        reason: "用户指定的重点活动（桩数据），已落成具体场馆",
      },
    ],
  });
  const m = userMsg.match(/第 (\d+) 天的时刻表（共 (\d+) 天/);
  const dayNum = m ? Number(m[1]) : 1;
  const src = CANNED_PLAN.days[Math.min(dayNum - 1, CANNED_PLAN.days.length - 1)];
  if (isDayCall) return mk(dayNum, src);
  const base = planForRequestedDays(userMsg);
  const days = base.days.map((d) => ({ ...d, spots: d.spots.map((x) => ({ ...x })) }));
  if (days.length > 0) {
    days[0] = mk(1, CANNED_PLAN.days[0]);
  }
  return { ...base, days };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 连接中断模式的命中次数（进程级）：「断流」只掐第 1 次，之后放行，
// 用来验证「瞬时故障重试一次」真的能救回长任务
let terminateHits = 0;

// 「乱序完成」模式：让后面的天比前面的天更早返回（延迟按天数倒数递减）。
// 真实并发下这完全可能发生——第 3 天可能比第 2 天先生成完。这是「前缀发布」
// 必须处理的场景：用户不能看到乱序或跳号的行程。串行时代不可能出现，
// 所以这是本轮并发改造最需要的专项覆盖。
function reversedDayDelayMs(dayNum, totalDays, base) {
  if (base <= 0 || totalDays <= 1) return 0;
  // 第 1 天等最久（totalDays×base），最后一天几乎立即返回（1×base）
  return Math.max(1, (totalDays - dayNum + 1) * base);
}

// ---------------- 改行程（refine）的桩响应 ----------------
// 约定见文件头注释；prompt 格式的定义方在 lib/refine.ts，两处必须同步。

function refineTargetDay(userMsg) {
  const m = userMsg.match(/目标：第 (\d+) 天/);
  return m ? Number(m[1]) : 1;
}

function refineInstruction(userMsg) {
  const m = userMsg.match(/【用户指令】「([^」]*)」/);
  return m ? m[1] : "";
}

function refineSwapBase(userMsg) {
  const m = userMsg.match(
    /【被替换点】序号 (\d+)｜类型 (\w+)｜时段 (\w+)｜时间 ([\d:]+-[\d:]+)｜区域 ([^｜\n]+)｜名称 ([^\n]+)/,
  );
  if (!m)
    return {
      index: 1,
      type: "sight",
      period: "morning",
      time: "09:00-11:00",
      area: "测试区",
      name: "原景点",
    };
  return {
    index: Number(m[1]),
    type: m[2],
    period: m[3],
    time: m[4],
    area: m[5].trim(),
    name: m[6].trim(),
  };
}

function refineKeeps(userMsg) {
  const m = userMsg.match(/【当天必须保留】([^\n]+)/);
  if (!m) return [];
  return m[1]
    .split("、")
    .map((s) => s.trim())
    .filter((s) => s && s !== "（无）");
}

/** 单点替换响应：类型/时段/时间/区域沿用被替换点（refine 会核对这些字段） */
function refineSwapContent(userMsg) {
  const base = refineSwapBase(userMsg);
  const spot = {
    period: base.period,
    time: base.time,
    type: base.type,
    name: `替换景点（桩）${base.index}`,
    area: base.area,
    durationMin: 120,
    costCny: 60,
    reason: "桩数据：改行程单点替换，与原安排同区域同类型",
    rainBackup: "室内备选（桩数据）",
  };
  return JSON.stringify({ spot });
}

/** 单日重排响应：保留「当天必须保留」的点 + 补 2 个桩点，凑够 3-4 个合法点 */
function refineDayContent(userMsg) {
  const day = refineTargetDay(userMsg);
  const instruction = refineInstruction(userMsg);
  const keeps = refineKeeps(userMsg);
  const themeMatch = userMsg.match(/【当天现状】第 \d+ 天 · 主题「([^」]*)」/);
  const theme = themeMatch ? themeMatch[1] : `第 ${day} 天（桩数据）`;
  const spots = [];
  // 「故意删硬约束」：故意漏掉必须保留的点（验证 refine 的硬约束拒绝路径）
  if (!instruction.includes("故意删硬约束")) {
    keeps.slice(0, 2).forEach((name, i) => {
      spots.push({
        period: i === 0 ? "morning" : "afternoon",
        time: `${9 + i * 3}:00-${11 + i * 3}:00`,
        type: "sight",
        name,
        area: "测试区",
        durationMin: 120,
        costCny: 60,
        reason: "桩数据：保留原硬约束",
        rainBackup: "室内备选（桩数据）",
      });
    });
  }
  spots.push({
    period: "afternoon",
    time: "14:00-16:00",
    type: "sight",
    name: `重排新景点（桩）${day}`,
    area: "测试区",
    durationMin: 100,
    costCny: 40,
    reason: "桩数据：改行程单日重排",
    rainBackup: "室内备选（桩数据）",
  });
  spots.push({
    period: "dinner",
    time: "18:00-19:30",
    type: "food",
    name: `重排新餐厅（桩）${day}`,
    area: "测试区",
    durationMin: 90,
    costCny: 80,
    reason: "桩数据：改行程单日重排的晚餐",
  });
  // 目标 3-4 个点：上面只有 2 个时补一个上午景点（prompt 要求完整一天，不是补丁）
  if (!instruction.includes("故意删硬约束") && spots.length < 3) {
    spots.unshift({
      period: "morning",
      time: "09:00-11:00",
      type: "sight",
      name: `重排上午景点（桩）${day}`,
      area: "测试区",
      durationMin: 120,
      costCny: 50,
      reason: "桩数据：改行程单日重排的上午安排",
      rainBackup: "室内备选（桩数据）",
    });
  }
  return JSON.stringify({ day: { day, theme, spots } });
}

/** 改行程请求的总入口：按 system prompt 里的任务类型分流 */
function refineContent(userMsg, systemMsg) {
  if (refineInstruction(userMsg).includes("故意失败")) {
    return "抱歉，我不太明白你的意思。";
  }
  if (systemMsg.includes("单点替换")) return refineSwapContent(userMsg);
  return refineDayContent(userMsg);
}

// ---------------- 行程管家（copilot）的桩响应 ----------------
// 约定见文件头注释；prompt 格式的定义方在 lib/copilot.ts，两处必须同步。
// 关键：streamChatRetry 只发 system + 一条 user。user 里前面是对话历史，
// 真正的「最后一条 user 消息」在末尾【用户本次问题】块——必须只按这一块判意图，
// 否则历史里问过的「下雨」会让现在的「预算」问题也返回 rain。

const COPILOT_QUESTION_MARK = "【用户本次问题】";

function copilotLastQuestion(userMsg) {
  const idx = userMsg.lastIndexOf(COPILOT_QUESTION_MARK);
  return idx === -1 ? userMsg : userMsg.slice(idx + COPILOT_QUESTION_MARK.length).trim();
}

function copilotContent(userMsg) {
  const question = copilotLastQuestion(userMsg);
  let suggestion = null;
  if (question.includes("雨")) {
    suggestion = { kind: "fix", fixKind: "rain", day: 1, label: "改室内" };
  } else if (/赶|来不来得及|顺延/.test(question)) {
    suggestion = { kind: "retime", day: 1, label: "顺延第1天" };
  } else if (question.includes("预算")) {
    suggestion = { kind: "fix", fixKind: "budget-over", day: 1, label: "压预算" };
  }
  return JSON.stringify({
    answer: "（桩）基于你的行程，建议先看当天时间轴与真实路段；如需调整可参考建议按钮。",
    suggestion,
  });
}

/**
 * 「挂起」测试开关（Lead 加，用于验证 planner 的「流式总时长兜底」）：
 * 城市名含「挂起」时只回 SSE 响应头、永远不写 chunk、也不结束响应。
 *
 * 模拟真实故障：上游把连接挂着却不发数据。这种状态下 SDK 的 chunk 级 timeout
 * 永远不会触发（没有 chunk 可等），若没有总时长兜底，任务会永远 running。
 * 配合测试服务器的 LLM_STREAM_DEADLINE_MS=2000，2 秒后应被 abort 成 error。
 */
function hangStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": keep-alive\n\n"); // 合法 SSE 注释行：证明连接已建立，但没有 content chunk
  // 刻意不做任何收尾：**不要**监听 req 的 close——POST body 收完后 req 的 close
  // 就会触发（不是连接断开），在那时 res.end() 会让「挂起」变成「立刻空流」，
  // 测到的是「返回为空」而不是总时长兜底。让响应一直挂着，等客户端 abort。
  res.on("close", () => {
    /* 客户端已 abort；无需处理 */
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 测试用：查看最近一次收到的 user 消息（验证输入确实拼进了 prompt）
  if (req.method === "GET" && url.pathname === "/_last_user") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ user: lastUserMsg }));
    return;
  }

  if (req.method !== "POST" || !url.pathname.includes("/chat/completions")) {
    res.writeHead(404).end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let userMsg = "";
    let systemMsg = "";
    let isStream = false;
    try {
      const parsed = JSON.parse(body);
      userMsg =
        parsed.messages
          ?.filter((m) => m.role === "user")
          .map((m) => m.content)
          .join("\n") ?? "";
      systemMsg =
        parsed.messages
          ?.filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n") ?? "";
      lastUserMsg = userMsg;
      isStream = parsed.stream === true;
    } catch {
      /* 空 body 按 valid 处理 */
    }

    // 「挂起」测试城市：只握手不吐 chunk，验证 planner 的「流式总时长兜底」。
    // 必须放在所有 mode 分流之前——它连 JSON 都不返回。
    if (userMsg.includes("挂起")) {
      hangStream(req, res);
      return;
    }

    // 四类调用靠 system prompt 区分：行程管家 / 改行程 / 大纲 / 单日。
    // 行程管家必须最先判断（其 system 含「行程管家」标记，且不应落入下面按
    // 城市名切换的生成分支）；改行程的 system prompt 含「行程微调」标记。
    const isCopilotCall = systemMsg.includes("行程管家");
    const isRefineCall = !isCopilotCall && systemMsg.includes("行程微调");
    const isOutlineCall = !isCopilotCall && !isRefineCall && systemMsg.includes("行程大纲");
    const isDayCall = !isCopilotCall && !isRefineCall && systemMsg.includes("某一天的时刻表");

    let mode = "valid";
    if (isCopilotCall) mode = "copilot";
    else if (isRefineCall) mode = "refine";
    else if (userMsg.includes("垃圾")) mode = "garbage";
    else if (userMsg.includes("空")) mode = "empty";
    else if (userMsg.includes("故障")) mode = "http500";
    else if (userMsg.includes("编号乱序")) mode = "scrambled";
    else if (userMsg.includes("天数错")) mode = "wrongdays";
    // 单日阶段故障：第 2 天起返回垃圾（测「已生成几天后中途失败 → 任务 error + 退还配额」）。
    // 触发词刻意避开「故障」——那个词会被上面的 http500 模式先截走，
    // 导致大纲阶段就失败，测不到「中途」失败。
    else if (isDayCall && userMsg.includes("单日坏")) {
      const dm = userMsg.match(/第 (\d+) 天的时刻表/);
      if (dm && Number(dm[1]) >= 2) mode = "garbage";
    }
    // 连接中断两种（测 LlmError 的瞬时故障重试）：
    //   「持续断流」每次都掐 → 重试也救不回来，验证失败信息带进度
    //   「断流」只掐第一次   → 重试后恢复，验证长任务不被一次抖动全废
    // 注意「持续断流」含「断流」，必须先判断，否则被后者截走。
    else if (isDayCall && userMsg.includes("持续断流")) mode = "terminate-forever";
    else if (isDayCall && userMsg.includes("断流")) {
      const dm = userMsg.match(/第 (\d+) 天的时刻表/);
      if (dm && Number(dm[1]) >= 2) mode = "terminate";
    }
    // 「乱序完成」：让后面的天比前面的天更早返回，专门考验并发下的前缀发布。
    // 触发词用「逆序」而非「乱序」——后者含「序」会和上面的「编号乱序」冲突。
    else if (isDayCall && userMsg.includes("逆序完成")) mode = "reversed";
    // 「区域散」：当天的景点跨 5 个不同区县，确定触发区域分散度预警。
    // fixture 每天最多 3 个景点，到不了阈值 4，所以这里直接构造。
    else if (isDayCall && userMsg.includes("区域散")) mode = "scattered";
    // 活动晚点：把活动排在开始时间之后（测「错过开场」告警）
    else if (userMsg.includes("活动编排")) mode = "event-ok";
    // 活动别名：用户写简称，模型落成场馆全称（真机踩过的假预警场景）
    else if (userMsg.includes("活动别名")) mode = "event-alias";
    // 必游地别名：同一类坑的另一处（用户写简称、模型落成规范全称）
    else if (userMsg.includes("必游地别名")) mode = "mv-alias";
    else if (userMsg.includes("活动晚点")) mode = "event-late";
    // 活动漏排：整个行程不含该活动（测漏排告警）
    else if (userMsg.includes("活动漏排")) mode = "event-missing";
    const refineKind = isRefineCall ? (systemMsg.includes("单点替换") ? " (swap)" : " (day)") : "";
    console.log(
      `[stub] ${mode}${refineKind}${isOutlineCall ? " (outline)" : ""}${isDayCall ? " (day)" : ""}${isStream ? " (stream)" : ""}`,
    );

    if (mode === "http500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub internal error" } }));
      return;
    }

    // 连接中断：直接销毁 socket，不写任何响应——fetch 会抛 "terminated"，
    // 与真实上游掐连接的行为一致。「terminate」只掐第一次（之后放行），
    // 用来验证重试能救回来；「terminate-forever」每次都掐。
    if (mode === "terminate" || mode === "terminate-forever") {
      terminateHits += 1;
      const shouldCut = mode === "terminate-forever" || terminateHits === 1;
      if (shouldCut) {
        console.log(`[stub] terminate（销毁 socket，第 ${terminateHits} 次）`);
        res.socket.destroy();
        return;
      }
      console.log(`[stub] terminate 第 ${terminateHits} 次：放行（重试已生效）`);
    }

    // 单日响应走延迟：让渐进式交付在 e2e 里可被观测（见 DAY_DELAY_MS 注释）。
    // 「reversed」模式按天数倒数设延迟（第 1 天最慢、最后一天最快），人为制造
    // 「后面的天先完成」——真实并发下完全可能，专门考验前缀发布不乱序。
    if (isDayCall && DAY_DELAY_MS > 0 && mode !== "garbage") {
      let delay = DAY_DELAY_MS;
      if (mode === "reversed") {
        const dm = userMsg.match(/第 (\d+) 天的时刻表（共 (\d+) 天/);
        if (dm) delay = reversedDayDelayMs(Number(dm[1]), Number(dm[2]), DAY_DELAY_MS);
      }
      await sleep(delay);
    }
    const content =
      // 行程管家优先：它的响应结构（answer/suggestion）与所有生成分支不同
      mode === "copilot"
        ? copilotContent(userMsg)
        : // 改行程其次：它的响应结构（spot/day）与整份生成完全不同，不能落到下面分支
          mode === "refine"
          ? refineContent(userMsg, systemMsg)
          : mode === "garbage"
            ? "抱歉，我不知道怎么回答这个问题。"
            : mode === "empty"
              ? ""
              : mode === "scrambled"
                ? JSON.stringify(scrambledPlan())
                : // 无视请求天数，恒返回 3 天：测「结构不符 → 带纠正指令重试 → 仍不符 → 明确报错」
                  mode === "wrongdays"
                  ? JSON.stringify(CANNED_PLAN)
                  : isOutlineCall
                    ? JSON.stringify(outlineForRequestedDays(userMsg))
                    : mode === "scattered"
                      ? JSON.stringify(scatteredDayForRequested(userMsg))
                      : mode === "event-ok"
                        ? JSON.stringify(
                            eventResponse(
                              userMsg,
                              isDayCall,
                              "18:30-21:30",
                              180,
                              "用户指定的重点活动（桩数据），提前 30 分钟入场",
                            ),
                          )
                        : mode === "event-late"
                          ? JSON.stringify(
                              eventResponse(
                                userMsg,
                                isDayCall,
                                "21:00-22:30",
                                90,
                                "用户指定的重点活动（桩数据）",
                              ),
                            )
                          : mode === "event-missing"
                            ? JSON.stringify(eventMissingResponse(userMsg, isDayCall))
                            : mode === "event-alias"
                              ? JSON.stringify(
                                  eventAliasResponse(userMsg, isDayCall, "18:30-20:00"),
                                )
                              : mode === "mv-alias"
                                ? JSON.stringify(mvAliasResponse(userMsg, isDayCall))
                                : isDayCall
                                  ? JSON.stringify(dayForRequested(userMsg))
                                  : JSON.stringify(planForRequestedDays(userMsg));

    if (isStream) {
      // SSE：模拟真实流式（role 帧 → 内容分两帧 → 结束帧带 usage）
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunk = (delta, finishReason, usage) => {
        const payload = {
          id: "stub-1",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
        };
        if (usage) payload.usage = usage;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      chunk({ role: "assistant" }, null);
      if (content) {
        const mid = Math.floor(content.length / 2);
        chunk({ content: content.slice(0, mid) }, null);
        chunk({ content: content.slice(mid) }, null);
      }
      chunk({}, "stop", {
        prompt_tokens: 10,
        completion_tokens: content.length,
        total_tokens: 20 + content.length,
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "stub-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[stub] listening on http://127.0.0.1:${PORT}`);
});
