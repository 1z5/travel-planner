import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import { renderGroundingPrompt, type Grounding } from "./grounding";
import { renderProfileLines, validateProfile } from "./profile";
import type { Plan, PlanInput, PlanSpot } from "./types";

// ============================================================
// 行程生成。两条路径，按天数分流：
//
// 1) ≤4 天：单次调用生成完整行程（下方 generatePlan）。
//    这是被 124 条 e2e + 多个真实 case 验证过的路径，质量最稳，
//    不动它——避免为长行程改架构时把短行程的质量搞回归。
//
// 2) ≥5 天：大纲 + 分日流式（下方 generateOutline / generateDay）。
//    单次调用在这个长度必爆 token（实测 5 天跑满 16 分钟仍超时），
//    所以拆成「一次小大纲 + 每天一次小调用」。附带收益是渐进式交付：
//    用户不用盯着转圈 8 分钟，天数逐天出现。
//
// 演进记录：曾试过「大纲 + 分日并行」替代单次调用，实测 320s 比单次
// 253s 更慢（推理模型的单日调用继承了大部分复杂度），已回退。所以这里
// 不是「哪个更快用哪个」，而是「单次能扛的用单次，扛不动的才拆分」。
// ============================================================

// ---------- 路径 2 的 schema：大纲与单日 ----------

const OutlineSchema = z.object({
  city: z.string(),
  summary: z.string(),
  // 每天只给主题与区域分配——刻意保持小输出，让这次调用几秒内返回
  days: z.array(
    z.object({
      day: z.number(),
      theme: z.string(),
      area: z.string(), // 当天主战场，如 "姑苏区古城带"
      focus: z.string(), // 一句话说明这天怎么安排，如 "以园林为主，午后转平江路"
    }),
  ),
  tips: z.array(z.string()),
});

/**
 * 单个行程点的 zod schema。
 *
 * 抽出来给「改行程」（lib/refine.ts）复用：那边要校验模型返回的单个 spot /
 * 单日 spots，如果本地照抄一份，就变成两处字段定义——曾经踩过「改一处漏
 * 一处」的坑（见 baseLines 的注释）。这里的字段/可选性与历史行为完全一致。
 */
export const SpotSchema = z.object({
  period: z.enum(["morning", "lunch", "afternoon", "dinner", "evening"]),
  time: z.string(),
  type: z.enum(["sight", "food", "hotel", "transport", "shopping", "activity"]),
  name: z.string(),
  area: z.string(),
  durationMin: z.number(),
  costCny: z.number(),
  reason: z.string(),
  rainBackup: z.string().optional(),
});

const DaySchema = z.object({
  day: z.number(),
  theme: z.string(),
  spots: z.array(SpotSchema),
});

export type Outline = z.infer<typeof OutlineSchema>;
export type DayPlan = z.infer<typeof DaySchema>;

// ---------- 路径 1 的 schema：≤4 天单次调用输出完整行程 ----------

const PlanSchema = z.object({
  city: z.string(),
  summary: z.string(),
  days: z.array(
    z.object({
      day: z.number(),
      theme: z.string(),
      // 复用 SpotSchema（与 DaySchema 同源）：字段/可选性一致，行为与历史完全相同
      spots: z.array(SpotSchema),
    }),
  ),
  totalCostCny: z.number(),
  tips: z.array(z.string()),
});

export const SYSTEM_PROMPT = `你是资深国内旅行行程规划师，为单人旅行者做「不踩坑、不绕路、节奏合理」的行程。

输出要求（严格遵守）：
1. 只输出一个合法 JSON 对象，不要输出任何解释文字，不要 markdown 代码围栏。
2. 结构：
{
  "city": "城市",
  "summary": "一句话行程概览",
  "days": [{
    "day": 1,
    "theme": "当天主题，4-6 字，天与天之间要有差异",
    "spots": [{
      "period": "morning|lunch|afternoon|dinner|evening",
      "time": "HH:MM-HH:MM",
      "type": "sight|food|hotel|transport|shopping|activity",
      "name": "POI 名称（必须真实存在）",
      "area": "所在商圈/区域，如 春熙路",
      "durationMin": 120,
      "costCny": 0,
      "reason": "为什么去，一两句人话",
      "rainBackup": "雨天备选（室外景点必填，室内可省略）"
    }]
  }],
  "totalCostCny": 人均总花费,
  "tips": ["预约/避坑提示"]
}

规划规则：
- 每天 2~4 个主景点 + 午餐 + 晚餐；同一天的景点集中在同一 area，避免跨城折返。
- 每天 21:00 前结束；第一天最后一个景点后安排酒店入住（type=hotel，用具体酒店名，costCny 填全程住宿总价 = 晚均价 × 总晚数；晚均价按预算档位取 250-500 元，预算高取高档）。
- totalCostCny = 全程门票 + 餐饮 + 住宿 + 市内交通，应贴近用户预算（至少用掉 80%）但不超过 105%。

- 室外景点（公园、古镇、步行街类）必须给室内 rainBackup。
- 餐饮选本地人常去、有代表性的店，避开"XX 小吃一条街"这类游客陷阱。
- 每个景点给真实合理的人均花费（含门票），没有门票填 0。
- 每天净游玩时间（景点停留 + 通勤）不超过 10 小时；宁松勿满。

【事实先行 · 有真实素材清单时必须遵守】
当用户消息里附带「真实素材清单」时，那是高德实时数据（名称、位置、营业时间、评分、人均均已核验）：
- 行程点**优先从清单里选**；清单确实满足不了需求时才用清单外的地点，且必须是真实存在的知名地点（仍会照常验真）。
- 清单里标了「某天闭馆」的地点，**不要排到那天**（可以换到它开门的日子）；标了「全程闭馆，不要安排」的地点一律不要排。
- 清单里的营业时间是硬约束：到达时间必须落在营业时段内，且不能晚于最晚进入时间。
- 花费按清单给出的真实人均/票价填，**不要自己编价格**；评分可作为选点理由。

用户约束（若提供，优先级高于上述默认规则）：
- 住所：用户已指定住宿地点。全程以此为基地：第一天入住的酒店 spot 必须直接使用用户指定的住所（不要替换成其他酒店），后续每天的交通 spot 从该住所出发组织（如「住所→景点」）。住宿总价按该住所档次计入 costCny。
- 期望必游地：列出的地点**必须全部出现**在行程中（按所在区域分配到各天，与你的推荐融合排期）。不得以任何理由静默丢弃；若某必游地你判断不存在或明显无法安排（如闭馆），放在 tips 里显式说明，不要假装安排了。
- 重点活动：用户指定的演唱会/赛事/展览等，**必须全部出现**在行程中（type=activity）。编排规则：
  · 给了开始时间的，围绕它倒排：活动前的景点选在场馆附近（避免跨区折返），并预留 30 分钟以上提前到场；
  · 活动本身按开始时间排 spot（如 time 填 "19:00-21:30"），costCny 填票款；散场后安排交通 spot 与场馆附近的夜宵；
  · 活动当天不要再排其他主景点——演出通常 2-3 小时，加上前后通勤已占满；
  · 给的时间不在行程日期范围内的，不要硬排，放在 tips 里说明。
`;

// 区域（环线）模式的追加规则。与城市模式的关键差异：
// - 「同一天集中在同一 area」升级为「同一天集中在同一子区域」，但**跨天必须换宿**——
//   环线是边走边住，不是每天回同一个酒店
// - 跨城交通要显式排（type=transport），否则模型会把 300km 当成市内通勤
// - POI 分散在多个行政区，验真时不能按单一城市框定（见 lib/amap.ts 的 scope）
const REGION_RULES = `
本次规划的目的地是一个**区域/环线**（如川西环线、关西），不是单一城市。请遵守：
- 按地理顺序推进：每天的景点集中在同一个子区域，跨天切换到相邻子区域，不要来回折返。
- 城际/跨区域转移必须显式排一个 spot（type=transport，name 如「成都→四姑娘山」），并给出合理的路上耗时与人均车费；不要把几百公里的跨城移动当成市内通勤。
- 住宿随线路迁移：除第一天外，允许在当天所在的城镇安排酒店 spot（type=hotel，用具体酒店名）。若用户指定了住所，则仍以其为全程基地，不要迁移。
- 行程天数较长，注意收尾：最后一天不要安排需要长时间游览的景点，要留出返回出发地的时间。
- 预算要覆盖跨城交通与多点住宿，不要只按单城市标准估。
`;

// ---------- 路径 2 的提示词 ----------

// 大纲：刻意只输出「主题 + 区域 + 思路」，不排时刻表。
// 输出小 → 这次调用几秒内返回，用户立刻能看到行程骨架。
export const OUTLINE_SYSTEM_PROMPT = `你是资深国内旅行行程规划师，为多日旅行先做「行程大纲」。

输出要求（严格遵守）：
1. 只输出一个合法 JSON 对象，不要输出任何解释文字，不要 markdown 代码围栏。
2. 结构：
{
  "city": "城市",
  "summary": "一句话行程概览",
  "days": [{
    "day": 1,
    "theme": "当天主题，4-6 字，天与天之间要有明显差异",
    "area": "当天主战场区域，要具体到可执行，如 姑苏区古城带",
    "focus": "这天怎么安排，一两句，如 以园林为主，午后转平江路步行街"
  }],
  "tips": ["覆盖整个行程的预约/避坑提示"]
}

规划规则：
- 天数必须严格等于用户要求的天数，day 从 1 连续编号，一天都不能少。
- 相邻两天不要安排在同一区域，按地理顺序推进，减少跨区折返。
- 用户列出的期望必游地要分配到具体某几天，不要全堆在一天，也不要漏。
- 行程较长时注意收尾：最后一天不要安排需要长时间游览的景点（要考虑离开时间）。
`;

// 单日：只生成一天的时刻表。当天景点必须落在大纲指定的区域内。
export const DAY_SYSTEM_PROMPT = `你是资深国内旅行行程规划师，现在生成多日行程中某一天的时刻表。

输出要求（严格遵守）：
1. 只输出一个合法 JSON 对象，不要输出任何解释文字，不要 markdown 代码围栏。
2. 结构：
{
  "day": 天数序号,
  "theme": "当天主题（使用给定主题，不要自创）",
  "spots": [{
    "period": "morning|lunch|afternoon|dinner|evening",
    "time": "HH:MM-HH:MM",
    "type": "sight|food|hotel|transport|shopping|activity",
    "name": "POI 名称（必须真实存在）",
    "area": "所在商圈/区域",
    "durationMin": 120,
    "costCny": 0,
    "reason": "为什么去这里，一两句人话",
    "rainBackup": "雨天备选（室外景点必填，室内可省略）"
  }]
}

规划规则：
- 当天景点必须落在大纲指定的主战场区域内，不要跨区折返。
- 每天 2~4 个主景点 + 午餐 + 晚餐；每天 21:00 前结束。
- 室外景点（公园、古镇、步行街类）必须给室内 rainBackup。
- 餐饮选本地人常去、有代表性的店，避开"XX 小吃一条街"这类游客陷阱。
- 每个景点给真实合理的人均花费（含门票），没有门票填 0。
- 每天净游玩时间（景点停留 + 通勤）不超过用户选定节奏的上限；宁松勿满。
- 【事实先行】若附带「真实素材清单」：优先从清单里选点（清单标了某天闭馆的就别排那天，标了全程闭馆的一律不排）；营业时间是硬约束，到达必须落在营业时段内；花费按清单给的真实人均填，不要自己编。
- 住宿只在这一天安排：行程第一天，且只此一次（type=hotel，用具体酒店名）。
- 不要输出 totalCostCny 和 tips——那是整个行程层面的，由大纲负责。
`;

/**
 * 创建 LLM 客户端。未配 key 时 throw（保持现状：调用方必须能感知「服务没配好」，
 * 而不是拿到一个之后每次都静默失败的假客户端）。
 *
 * 导出原因：「改行程」（lib/refine.ts）复用同一套流式/重试基础设施，不再自建
 * 一份 OpenAI 客户端（超时/重试参数在第二个地方独立演化是事故之源）。
 */
export function client(): OpenAI {
  if (!process.env.LLM_API_KEY) throw new Error("缺少 LLM_API_KEY，请配置 .env");
  return new OpenAI({
    apiKey: process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL || "https://api.stepfun.com/step_plan/v1",
    // 显式超时：默认 10 分钟太长，用户等不起；单次 7 分钟足够（实测 3-4 分钟）
    timeout: 420_000,
    // 关掉 SDK 内置重试：实测 timeout 会按 尝试数×timeout 才抛错
    // （30s 超时 91s 才报），叠加我们自己的空返回重试会放大失控；
    // 且 generatePlan 已有 attempt 2，重试交给它
    maxRetries: 0,
  });
}

/**
 * LLM 调用失败。retryable 标记「瞬时故障」——连接层中断值得重试一次，
 * 而超时/内容问题各有自己的处理路径（见 streamChatRetry 与各生成函数）。
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** 连接层瞬时故障判定：undici socket 销毁 / 连接重置 / fetch 失败。
 *
 * 必须看 cause 链，不能只看顶层 message——实测两种面世方式：
 *   流式中途被掐 → 顶层 "terminated"
 *   连接建立失败 → 顶层 "Connection error."，真正的 "fetch failed" 在 cause 里
 * 只匹配顶层会漏掉后者（第一版就栽在这，被 e2e 的桩抓出来）。 */
function isTransientConnectionError(err: unknown): boolean {
  const PATTERN =
    /terminated|aborted|ECONNRESET|EPIPE|socket hang up|fetch failed|Connection error|UND_ERR_SOCKET|network/i;
  const messages: string[] = [];
  let cur: unknown = err;
  // cause 链最多追 5 层，够了（SDK 包装通常只有一两层）
  for (let depth = 0; depth < 5 && cur; depth++) {
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (msg) messages.push(msg);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return messages.some((m) => PATTERN.test(m));
}

/**
 * 一次流式调用的「整次墙钟」上限（毫秒）。
 *
 * 为什么需要它：SDK 的 timeout 在流式下约束的是 **chunk 间隔**（实测 496s 的
 * 任务不会被 420s 掐断），这本身是对的——推理模型 3-5 分钟很正常。但如果上游
 * 把连接挂着却不发 chunk（实测 2026-10-20 一次真实 3 天生成卡了 11 分钟以上），
 * 既没有 chunk 超时、任务心跳又一直跳（心跳是独立定时器）→ 任务永远 running，
 * 配额不退、用户永远等。这是「僵尸任务」的唯一入口，必须有总时长兜底。
 *
 * 默认 10 分钟：正常最慢的跨境 3 天实测 497s，留足余量；超了就是上游异常。
 * 可用 LLM_STREAM_DEADLINE_MS 覆盖（例如上游明确更慢时）。
 */
function streamDeadlineMs(): number {
  const raw = Number(process.env.LLM_STREAM_DEADLINE_MS);
  // 下限 1s（不是 60s）：e2e 需要把阈值压到秒级来复现「上游挂起」，
  // 真实部署按分钟级配置；非法值回退默认 10 分钟。
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 600_000;
}

/** 总时长兜底触发的错误：写清「已中止 + 下一步」，且明确不是网络问题 */
function streamDeadlineError(deadline: number): LlmError {
  const limitText =
    deadline >= 60_000
      ? `${Math.round(deadline / 60_000)} 分钟`
      : `${Math.round(deadline / 1000)} 秒`;
  return new LlmError(`生成超过 ${limitText}仍未完成，已中止（可稍后重试，或减少天数）`, false);
}

/**
 * 一次流式调用，返回拼接后的正文与 token 统计。
 *
 * 为什么必须流式：推理模型生成要 3-5 分钟，非流式会撞上 Node fetch 的
 * undici headersTimeout（默认 300s，比我们配的 420s SDK 超时先炸）——
 * 响应头迟迟不来就被静默掐断。流式下 header 立即返回、chunk 持续流动，
 * 300 秒天花板消失，顺带拿到真实 usage。
 *
 * 三条生成路径（单次/大纲/分日）共用，避免同一套流式逻辑写三份。
 */
async function streamChat(
  llm: OpenAI,
  system: string,
  user: string,
  city: string,
  tag = "",
): Promise<{ content: string; tokens: number }> {
  let content = "";
  let totalTokens = 0;
  // 总时长兜底（见 streamDeadlineMs 注释）：到点直接 abort 掉这条流，
  // 让上层按「生成失败」结束任务并退还配额，而不是留一个永远 running 的僵尸。
  const deadline = streamDeadlineMs();
  const startedAt = Date.now();
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), deadline);
  deadlineTimer.unref?.();
  try {
    const stream = await llm.chat.completions.create(
      {
        model: process.env.LLM_MODEL || "step-5-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: Number(process.env.LLM_MAX_TOKENS || 64000),
        reasoning_effort: (process.env.LLM_REASONING_EFFORT as "low" | "medium" | "high") || "low",
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: controller.signal },
    );
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) content += delta;
      if (chunk.usage) totalTokens = chunk.usage.total_tokens ?? 0;
    }
    // 关键（实测踩坑）：abort 一条流后，SDK 的 async iterator 是「自然结束」
    // 而**不是**抛错——实测 signal.abort() 后 7ms 流就正常走完 for-await。
    // 不在这里检查，就会把「我们主动中止」误报成「LLM 返回为空」，
    // 用户拿到的是让人去调 token 的错误提示，完全不可行动。
    if (controller.signal.aborted) throw streamDeadlineError(deadline);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[llm] ${city} ${tag}异常（已等 ${elapsed}s）: ${msg}`);
    // 自己到点 abort：这不是上游的错，但要给用户可行动的话，且明确「已中止」
    // （不能用「连接中断」——那会让人以为是网络问题、重试就行）。
    if (controller.signal.aborted) throw streamDeadlineError(deadline);
    if (/timed out|timeout/i.test(msg)) {
      // 流式下 SDK 超时约束的是「chunk 间隔」而非总时长（实测 496s 的任务
      // 也未被 420s 掐断），所以这里触发时是断流/连接问题，不是"到点没返回"
      throw new LlmError("生成中断或连接超时，请稍后重试（可减少天数或换个城市）", false);
    }
    if (isTransientConnectionError(e)) {
      // 连接被上游掐断。这类是瞬时故障：标为可重试，由 streamChatRetry 兜一次。
      // 原样透出 "terminated"/"Connection error." 对用户完全不可行动。
      throw new LlmError("生成连接被中断", true);
    }
    throw e;
  } finally {
    clearTimeout(deadlineTimer);
  }
  return { content, tokens: totalTokens };
}

/**
 * 带瞬时故障重试的流式调用。
 *
 * 为什么需要：分日路径下一个任务要跑十几分钟，第 4 天时一次连接抖动
 * （实测 undici "terminated"）就会让已成功的 3 天全部作废、用户只看到
 * 一个无法行动的词。连接层中断重试一次的成本远小于重跑整个任务。
 *
 * 与各生成函数里的 attempt 循环分工：这里管「连接层瞬时故障」，
 * 那里管「空返回 / JSON 不合法 / 结构不符」这类内容问题。
 *
 * 导出原因：改行程（lib/refine.ts）是同一类「等模型 20-90 秒」的调用，连接层
 * 抖动同样要把已等的时间浪费掉，重试语义必须与生成路径完全一致。
 */
export async function streamChatRetry(
  llm: OpenAI,
  system: string,
  user: string,
  city: string,
  tag = "",
): Promise<{ content: string; tokens: number }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await streamChat(llm, system, user, city, tag);
    } catch (e) {
      if (attempt < 2 && e instanceof LlmError && e.retryable) {
        console.log(`[llm] ${city} ${tag} 连接中断，重试（${attempt}/2）`);
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

function fmtRange(startAt: string, endAt: string): string {
  const fmt = (s: string) => {
    const [date, time = ""] = s.split("T");
    const [, m, d] = date.split("-");
    return `${Number(m)}月${Number(d)}日${time ? ` ${time}` : ""}`;
  };
  return `${fmt(startAt)} – ${fmt(endAt)}`;
}

export const PACE_RULES: Record<NonNullable<PlanInput["pace"]>, string> = {
  relaxed:
    "轻松：每天 1~3 个主景点 + 午餐 + 晚餐，午饭后留咖啡/闲逛/休息的时间，当天净游玩时间不超过 8 小时。",
  balanced: "适中：每天 2~4 个主景点 + 午餐 + 晚餐，当天净游玩时间不超过 10 小时。",
  packed: "紧凑：每天 3~5 个主景点 + 午餐 + 晚餐，能看则看，当天净游玩时间不超过 13 小时。",
};

/**
 * 用户约束的公共描述：三条生成路径（单次 / 大纲 / 分日）共用。
 * 抽出来是为了避免同一份约束在三处各写一遍——曾经踩过「改了一处漏两处」
 * 导致 prompt 与实际行为漂移的坑。
 *
 * 导出原因：改行程（lib/refine.ts）也要把这批约束喂给模型，且必须与生成时
 * 完全同源——否则「改行程」会按一套约束改、「生成」按另一套生成，改出来的
 * 行程和用户当初要求的预算/节奏/必游地对不上。
 */
/**
 * 穷游/低预算判定：预算 0，或日均不足 100 元。
 *
 * 为什么需要：原来的预算约束写死「总花费应落在 80%-100% 预算之间」，
 * 预算 0 时会算出「应落在 1-0 元之间」这种自相矛盾的指令，模型只能瞎编；
 * 低预算同理（「当天不要显著低于 1 元」）。穷游是正当需求（免费景点、
 * 街区漫步、街头小吃），约束要从「贴近预算」切换成「优先免费低价、不凑数」。
 */
/**
 * 跨城行程：第 dayNumber 天属于哪座城市（按 cities 的 days 顺序累计）。
 * 无 cities = 单城市，返回 input.city——所有调用方因此不需要判空。
 */
export function dayCityOf(input: PlanInput, dayNumber: number): string {
  const cities = input.cities;
  if (!cities?.length) return input.city;
  let acc = 0;
  for (const c of cities) {
    acc += c.days;
    if (dayNumber <= acc) return c.city;
  }
  return cities[cities.length - 1].city;
}

/** 跨城行程的「路线」摘要（日志/列表展示用）：深圳2天→香港2天 */
export function citiesRoute(input: PlanInput): string {
  if (!input.cities?.length) return input.city;
  return input.cities.map((c) => `${c.city}${c.days}天`).join("→");
}

function isFrugalBudget(input: PlanInput): boolean {
  return !Number.isFinite(input.budget) || input.budget <= 0 || input.budget < input.days * 100;
}

export function baseLines(input: PlanInput): string[] {
  const lines = [
    `- 目的地：${input.cities?.length ? citiesRoute(input) : input.city}`,
    `- 天数：${input.days} 天`,
    `- 人均预算：${input.budget} 元（不含往返大交通，含当地吃住行玩）`,
    `- 出行偏好：${input.preferences.join("、") || "均衡体验"}`,
    `- 行程节奏：${PACE_RULES[input.pace ?? "balanced"]}`,
  ];
  if (input.startAt && input.endAt) {
    lines.push(`- 行程时间：${fmtRange(input.startAt, input.endAt)}（共 ${input.days} 天）`);
    if (input.days === 1) {
      lines.push("- 当天往返行程：不要安排酒店 spot，预算不含住宿。");
    } else {
      lines.push(
        "- 第一天的安排从抵达时间之后开始（不要安排抵达前的内容）；最后一天在离开时间前收尾。",
      );
    }
  }
  if (input.hotel?.trim()) {
    lines.push(`- 我的住所（已定好，全程以此为基地，不要换成别的酒店）：${input.hotel.trim()}`);
  }
  if (input.mustVisit?.length) {
    lines.push(`- 期望必游地（必须全部安排进行程）：${input.mustVisit.join("、")}`);
  }
  if (input.events?.length) {
    for (const ev of input.events) {
      const when = [ev.date, ev.time].filter(Boolean).join(" ");
      lines.push(
        `- 重点活动（必须编入行程，type=activity）：${ev.name}${when ? `，时间 ${when}` : "（时间未定，由你建议合适场次并说明理由）"}`,
      );
    }
  }
  // 档案行（切片3 · 旅行档案）追加在请求级约束的末尾：档案是「关于这个
  // 人」的长期记忆，本次请求的具体约束（住所/必游地/活动）优先于它。
  // 在 baseLines 里统一读取（而不是让调用方传参）：三条生成路径与
  // refine/copilot 共用本函数，档案骑在 input 上一处读取、所有调用方
  // 同时受益——不会出现「生成带档案、改行程不带」的漂移。
  // 校验再走一遍 validateProfile：档案来自客户端 localStorage，服务端
  // 不信任它（会进 prompt 的用户输入必须有白名单）；undefined/null
  // 与校验失败都返回 null = 当作没有档案，一行都不加——无档案 = 全链路
  // 行为与切片 3 之前完全一致（向后兼容红线）。
  const profile = validateProfile(input.profile);
  if (profile) lines.push(...renderProfileLines(profile));
  // 预算目标行放在 baseLines（而不是只在 buildUserPrompt 里）：改行程
  // （refine）同样受这条约束，否则「生成时贴近预算、改行程时不管预算」会漂移。
  // 穷游/低预算时切换口径：原来的「总花费落在 80%-100% 预算之间」在预算 0 时
  // 会算出「应落在 1-0 元之间」的自相矛盾指令，模型只能瞎编。
  if (isFrugalBudget(input)) {
    lines.push(
      `- 穷游/低预算模式：预算仅 ${input.budget} 元。优先免费与低价项目（免费景点、公园、街区漫步、博物馆免费开放日、街头小吃、公共交通），不为凑预算加项目，也没有「必须花掉预算」的压力；花费如实计算。`,
    );
  } else {
    const totalLow = Math.max(1, Math.round(input.budget * 0.8));
    lines.push(
      `- 全程人均总花费应落在 ${totalLow}-${input.budget} 元之间：不要大幅低于预算（低于 ${totalLow} 元说明体验排得太省），也不要超出 ${input.budget} 元。`,
    );
  }
  // 跨城约束：按天分配城市 + 城际段的口径（诚实第一）
  if (input.cities?.length) {
    const segs: string[] = [];
    let acc = 0;
    for (const c of input.cities) {
      const from = acc + 1;
      acc += c.days;
      segs.push(`第 ${from}${acc === from ? "" : `-${acc}`} 天 ${c.city}`);
    }
    lines.push(`- 跨城行程（按天分配城市）：${segs.join("；")}。每天的点位必须落在当天所属城市。`);
    lines.push(
      "- 跨城当天：上午收尾当前城市，下午前往下一城市，抵达后只安排 1-2 个轻松的点。" +
        "城际交通（高铁/航班/口岸）**以用户提供的班次时间为准**；用户没有提供时，不要写具体通勤分钟数，" +
        "也不要把口岸排队、检录、签注时间算进行程——这些数据我们没有，编造比留空更糟。",
    );
  }
  return lines;
}

function buildUserPrompt(input: PlanInput, correction?: string, grounding?: Grounding): string {
  const lines = ["请规划行程：", ...baseLines(input)];
  // 事实清单放在最后：它是最具体、最不容出错的信息，靠近生成点时模型最容易照做。
  // 没有清单时这一段整体不出现——生成链路与「事实先行」之前完全一致。
  const sheet = grounding ? renderGroundingPrompt(grounding) : "";
  if (sheet) lines.push("", sheet);
  if (correction) {
    lines.push(
      `- 上一次输出不符合要求：${correction}。本次必须严格输出 ${input.days} 天，day 字段从 1 连续编号，每天至少 1 个行程点。`,
    );
  }
  return lines.join("\n");
}

// ---------- 路径 2 的用户提示词 ----------

// 大纲：强调「只出骨架不排时刻表」，并说明分日生成会随后进行
function buildOutlinePrompt(input: PlanInput, correction?: string): string {
  const lines = [
    "请为这次旅行输出行程大纲（只定主题/区域/思路，不排时刻表）：",
    ...baseLines(input),
  ];
  if (correction) {
    lines.push(
      `- 上一次输出不符合要求：${correction}。本次必须严格输出 ${input.days} 天，day 从 1 连续编号，每天都要有主题和区域。`,
    );
  } else {
    lines.push(`- 必须严格输出 ${input.days} 天，day 从 1 连续编号。`);
  }
  // 预算目标行已在 baseLines 里（与 refine 同源）；这里只负责拼装。
  // 分日锚点的上游由大纲负责，见 buildDayPrompt 的锚点区间注释。
  return lines.join("\n");
}

// 单日：注入大纲上下文（当天主题/区域/思路 + 其他天主题供错开），
// 以及当天预算提示（总额按天分摊，首日另含全程住宿）
function buildDayPrompt(
  input: PlanInput,
  outline: Outline,
  dayIdx: number,
  correction?: string,
  grounding?: Grounding,
): string {
  const day = outline.days[dayIdx];
  const others = outline.days
    .filter((_, i) => i !== dayIdx)
    .map((d) => `第 ${d.day} 天：${d.theme}（${d.area}）`)
    .join("；");
  // 锚点区间而非单一点值：给模型花掉预算的空间，对齐 prompt 的
  // 「至少用掉 80%、不超过 105%」契约。严格遵守 CHANGELOG 的教训——
  // 约束用锚点（具体数值区间），不让模型做算术题（百分比分配曾让
  // reasoning 从 1.3 万涨到 4 万+、生成从 250s 恶化到 600s+ 连续超时）。
  const frugal = isFrugalBudget(input);
  const perDay = frugal ? 0 : Math.max(1, Math.round(input.budget / input.days));
  // 下限从 0.8 抬到 0.85：实测原 0.8 让模型可以「合规地保守」——取下限
  // 就达标，而分日路径下某天塌方（京都 5 天 D2 只花 ¥210，另一轮同参数
  // 是 ¥1520）没有跨天机制兜底，直接把全局利用率拉到 58%。
  // 0.85 仍留有余量（不是卡着 100% 逼模型凑数），但显著压缩「合规保守」
  // 的空间。严格遵守 CHANGELOG 的教训：只给数值区间，不让模型做算术题。
  const low = Math.max(1, Math.round(perDay * 0.85));
  const high = Math.max(low + 1, Math.round(perDay * 1.05));
  const hotelNote =
    input.hotel?.trim() && dayIdx === 0
      ? `；第一天的酒店 spot 必须直接使用用户住所「${input.hotel.trim()}」`
      : "";
  // 首日区间明确标注「含全程住宿总价」——否则模型会理解成 perDay 之外
  // 再加住宿，各天累计起来超出预算（原提示词的「约 X 元；住宿另计入」
  // 就有这个歧义）。
  const budgetHint = frugal
    ? `当天人均总花费控制在 ${input.budget} 元以内即可（穷游模式：优先免费/低价项目，不凑数）`
    : dayIdx === 0 && input.days > 1
      ? `当天人均总花费建议落在 ${low}-${high} 元（含全程住宿总价：晚均价 250-500 元 × ${input.days - 1} 晚，计入酒店 spot 的 costCny${hotelNote}）`
      : `当天人均总花费建议落在 ${low}-${high} 元（不含住宿）`;
  // 分日路径的跨天兜底：每天独立生成，某天保守（实测京都 D2 只花 ¥210，
  // 另一轮同参数 ¥1520）会直接拉低全局利用率，而没有任何机制会发现。
  // 在每天提示词里明确「不要显著低于下限」，并给出可执行的补齐方向
  // （加体验项目/提高餐饮住宿档次），而不是让模型自己意会。
  // 穷游模式没有「下限」：逼低预算用户多花钱恰恰是反需求。
  const budgetFloorHint = frugal
    ? ""
    : `当天花费不要显著低于 ${low} 元——预算没用完往往意味着漏掉了本可安排的体验（多一个景点、更好的餐厅、一场演出）。若确实没有值得加的项目，也不必凑数。`;

  // 当天所属城市（跨城行程按天分配）；跨城日单独给口径
  const dayCity = dayCityOf(input, day.day);
  const prevCity = dayIdx > 0 ? dayCityOf(input, dayIdx) : undefined;
  const crossCity = Boolean(input.cities?.length) && prevCity !== undefined && prevCity !== dayCity;

  const lines = [
    `现在生成行程中第 ${day.day} 天的时刻表（共 ${input.days} 天，这是第 ${dayIdx + 1} 天）。`,
    "",
    `【当天所属城市】${dayCity}（当天的点位必须都在 ${dayCity}，不要排到别的城市）`,
    ...(crossCity
      ? [
          `【跨城日】今天从 ${prevCity} 前往 ${dayCity}：上午收尾 ${prevCity}，下午抵达后只安排轻松的点`,
        ]
      : []),
    "",
    `【整个行程的概览】${outline.summary}`,
    `【当天的安排思路】${day.theme} —— ${day.focus}`,
    `【当天的主战场区域】${day.area}（当天景点必须落在这个区域，不要跨区折返）`,
    others ? `【其他天的主题，供你错开安排，不要重复】${others}` : "",
    "",
    "【本次请求的约束】",
    ...baseLines(input),
    `- ${budgetHint}`,
    ...(budgetFloorHint ? [`- ${budgetFloorHint}`] : []),
  ];
  if (correction) {
    lines.push(
      `- 上一次输出不符合要求：${correction}。本次必须输出第 ${day.day} 天，day 字段为 ${day.day}，且至少 1 个行程点。`,
    );
  }
  // 事实清单放在最后（同 buildUserPrompt）：当天要用的事实离生成点最近。
  const sheet = grounding ? renderGroundingPrompt(grounding) : "";
  if (sheet) lines.push("", sheet);
  return lines.filter((l) => l !== "").join("\n");
}

/** 从模型输出里抠出 JSON：容忍 markdown 代码围栏与前后废话。
 *
 * 导出原因：改行程的两种响应（swap/day）各自有自己的 zod schema，但「模型
 * 返回的一定是 JSON 吗」这个现实问题与生成路径一模一样，抠 JSON 的逻辑必须
 * 同源，否则会各踩一遍（例如围栏格式、前后解释文字）。
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLM 未返回 JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * 归一化：按 day 排序，并重编号为连续的 1..N。
 * 模型可能输出 0 基编号、乱序或跳号（day: 1,3,4）——zod 只校验「是 number」，
 * 这些都能通过 schema 并直接渲染成错乱行程，所以在这里强制拉直。
 */
function normalizePlan(parsed: z.infer<typeof PlanSchema>, input: PlanInput): Plan {
  const days = [...parsed.days]
    .sort((a, b) => a.day - b.day)
    .map((d, i) => ({
      ...d,
      day: i + 1,
      spots: d.spots as PlanSpot[],
      transitMin: 0,
      dailyCostCny: 0,
    }));
  return {
    ...parsed,
    startDate: input.startAt?.slice(0, 10),
    endDate: input.endAt?.slice(0, 10),
    startAt: input.startAt,
    endAt: input.endAt,
    days,
    warnings: [],
    verified: false,
  } as Plan;
}

/**
 * 结构核对（zod 之外的语义层）：天数必须等于请求天数；每天至少 1 个行程点、
 * 有主题。返回 null 表示合格，否则返回人类可读的原因——既用作重试时的
 * 纠正指令，也用作重试后仍失败时的报错文案。
 */
function structuralProblem(plan: Plan, input: PlanInput): string | null {
  if (plan.days.length !== input.days) {
    return `输出 ${plan.days.length} 天，请求 ${input.days} 天`;
  }
  const empty = plan.days.filter((d) => d.spots.length === 0).map((d) => d.day);
  if (empty.length) return `第 ${empty.join("、")} 天没有行程点`;
  const noTheme = plan.days.filter((d) => !d.theme.trim()).map((d) => d.day);
  if (noTheme.length) return `第 ${noTheme.join("、")} 天缺少主题`;
  return null;
}

export async function generatePlan(input: PlanInput, grounding?: Grounding): Promise<Plan> {
  const llm = client();
  // 重试纠正指令：跨 attempt 保留（声明在循环外，否则第一次的纠正会在
  // 第二次迭代时被重置丢掉）
  let correction: string | undefined;

  // 两次机会：空返回 / JSON 不合法 / 结构不符，都带原因重试一次
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { content, tokens: totalTokens } = await streamChatRetry(
      llm,
      input.scope === "region" ? `${SYSTEM_PROMPT}\n${REGION_RULES}` : SYSTEM_PROMPT,
      buildUserPrompt(input, correction, grounding),
      input.city,
      `第${attempt}次`,
    );

    if (!content.trim()) {
      if (attempt === 2) {
        throw new Error("LLM 返回为空（推理可能吃满了 token，请调大 LLM_MAX_TOKENS）");
      }
      continue;
    }
    // 成本可见：每次生成的 token 消耗（上线前盯账单用）
    console.log(
      `[llm] ${citiesRoute(input)} ${input.days}天 第${attempt}次尝试 tokens=${totalTokens || "?"}`,
    );

    let plan: Plan;
    try {
      plan = normalizePlan(PlanSchema.parse(extractJson(content)), input);
    } catch (e) {
      if (attempt === 2) throw new Error(`LLM 输出不是合法 JSON（${(e as Error).message}）`);
      continue;
    }

    // 结构核对：不符则把具体原因回灌进 prompt 重试一次（比原样重试更可能救回来）
    const problem = structuralProblem(plan, input);
    if (problem) {
      if (attempt === 2) {
        throw new Error(`LLM 输出的行程结构与请求不符（${problem}），请重试或调整参数`);
      }
      correction = problem;
      console.log(`[llm] ${citiesRoute(input)} 结构不符（${problem}），带纠正指令重试`);
      continue;
    }
    return plan;
  }
  throw new Error("unreachable");
}

// ============================================================
// 路径 2：大纲 + 分日（≥5 天）。
// 单次调用在这个长度必爆 token，所以拆成「一次小大纲 + 每天一次小调用」。
// 每次调用都做与路径 1 同规格的保护：空返回重试、JSON 不合法重试、
// 结构不符带纠正指令重试。
// ============================================================

/** 大纲结构核对：天数必须等于请求天数，每天要有主题和区域 */
function outlineProblem(outline: Outline, input: PlanInput): string | null {
  if (outline.days.length !== input.days) {
    return `输出 ${outline.days.length} 天，请求 ${input.days} 天`;
  }
  const bad = outline.days.filter((d) => !d.theme.trim() || !d.area.trim()).map((d) => d.day);
  if (bad.length) return `第 ${bad.join("、")} 天缺少主题或区域`;
  return null;
}

/**
 * 生成行程大纲。输出刻意保持小（只有主题/区域/思路），所以这次调用
 * 几秒内就能返回——调用方拿到后即可把骨架展示给用户，不用等全量生成。
 */
export async function generateOutline(input: PlanInput): Promise<Outline> {
  const llm = client();
  let correction: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { content, tokens } = await streamChatRetry(
      llm,
      input.scope === "region"
        ? `${OUTLINE_SYSTEM_PROMPT}\n${REGION_RULES}`
        : OUTLINE_SYSTEM_PROMPT,
      buildOutlinePrompt(input, correction),
      input.city,
      `大纲 第${attempt}次`,
    );
    if (!content.trim()) {
      if (attempt === 2) throw new Error("LLM 大纲返回为空，请稍后重试");
      continue;
    }
    console.log(`[llm] ${citiesRoute(input)} 大纲 第${attempt}次 tokens=${tokens || "?"}`);

    let outline: Outline;
    try {
      const parsed = OutlineSchema.parse(extractJson(content));
      // 归一化：按 day 排序 + 重编号为连续 1..N（与路径 1 同规格）
      outline = {
        ...parsed,
        days: [...parsed.days].sort((a, b) => a.day - b.day).map((d, i) => ({ ...d, day: i + 1 })),
      };
    } catch (e) {
      if (attempt === 2) throw new Error(`LLM 大纲不是合法 JSON（${(e as Error).message}）`);
      continue;
    }

    const problem = outlineProblem(outline, input);
    if (problem) {
      if (attempt === 2) throw new Error(`LLM 大纲结构与请求不符（${problem}）`);
      correction = problem;
      console.log(`[llm] ${citiesRoute(input)} 大纲结构不符（${problem}），带纠正指令重试`);
      continue;
    }
    return outline;
  }
  throw new Error("unreachable");
}

/** 单日结构核对：必须有景点点，且 theme 非空 */
function dayProblem(day: DayPlan, expectedDay: number): string | null {
  if (day.spots.length === 0) return "这一天没有行程点";
  if (!day.theme.trim()) return "缺少当天主题";
  if (day.day !== expectedDay) return `day 字段应为 ${expectedDay}，实际 ${day.day}`;
  return null;
}

/**
 * 生成某一天的时刻表。dayIdx 是 0 基索引。
 * 单日调用比整次调用小得多，通常几十秒内完成——调用方每拿到一天就
 * 更新一次任务状态，实现渐进式交付。
 */
export async function generateDay(
  input: PlanInput,
  outline: Outline,
  dayIdx: number,
  grounding?: Grounding,
): Promise<DayPlan> {
  const llm = client();
  const expectedDay = dayIdx + 1;
  let correction: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { content, tokens } = await streamChatRetry(
      llm,
      input.scope === "region" ? `${DAY_SYSTEM_PROMPT}\n${REGION_RULES}` : DAY_SYSTEM_PROMPT,
      buildDayPrompt(input, outline, dayIdx, correction, grounding),
      input.city,
      `第${expectedDay}天 第${attempt}次`,
    );
    if (!content.trim()) {
      if (attempt === 2) throw new Error(`第 ${expectedDay} 天生成返回为空，请稍后重试`);
      continue;
    }
    console.log(
      `[llm] ${citiesRoute(input)} 第${expectedDay}天 第${attempt}次 tokens=${tokens || "?"}`,
    );

    let day: DayPlan;
    try {
      day = DaySchema.parse(extractJson(content));
    } catch (e) {
      if (attempt === 2)
        throw new Error(`第 ${expectedDay} 天输出不是合法 JSON（${(e as Error).message}）`);
      continue;
    }

    const problem = dayProblem(day, expectedDay);
    if (problem) {
      if (attempt === 2) throw new Error(`第 ${expectedDay} 天生成结果不符（${problem}）`);
      correction = problem;
      console.log(`[llm] ${input.city} 第${expectedDay}天 结构不符（${problem}），带纠正指令重试`);
      continue;
    }
    return day;
  }
  throw new Error("unreachable");
}
