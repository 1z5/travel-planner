import "server-only";
import OpenAI from "openai";
import { z } from "zod";
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
      area: z.string(),        // 当天主战场，如 "姑苏区古城带"
      focus: z.string(),       // 一句话说明这天怎么安排，如 "以园林为主，午后转平江路"
    }),
  ),
  tips: z.array(z.string()),
});

const DaySchema = z.object({
  day: z.number(),
  theme: z.string(),
  spots: z.array(
    z.object({
      period: z.enum(["morning", "lunch", "afternoon", "dinner", "evening"]),
      time: z.string(),
      type: z.enum(["sight", "food", "hotel", "transport", "shopping", "activity"]),
      name: z.string(),
      area: z.string(),
      durationMin: z.number(),
      costCny: z.number(),
      reason: z.string(),
      rainBackup: z.string().optional(),
    }),
  ),
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
      spots: z.array(
        z.object({
          period: z.enum(["morning", "lunch", "afternoon", "dinner", "evening"]),
          time: z.string(),
          type: z.enum(["sight", "food", "hotel", "transport", "shopping", "activity"]),
          name: z.string(),
          area: z.string(),
          durationMin: z.number(),
          costCny: z.number(),
          reason: z.string(),
          rainBackup: z.string().optional(),
        }),
      ),
    }),
  ),
  totalCostCny: z.number(),
  tips: z.array(z.string()),
});

const SYSTEM_PROMPT = `你是资深国内旅行行程规划师，为单人旅行者做「不踩坑、不绕路、节奏合理」的行程。

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

用户约束（若提供，优先级高于上述默认规则）：
- 住所：用户已指定住宿地点。全程以此为基地：第一天入住的酒店 spot 必须直接使用用户指定的住所（不要替换成其他酒店），后续每天的交通 spot 从该住所出发组织（如「住所→景点」）。住宿总价按该住所档次计入 costCny。
- 期望必游地：列出的地点**必须全部出现**在行程中（按所在区域分配到各天，与你的推荐融合排期）。不得以任何理由静默丢弃；若某必游地你判断不存在或明显无法安排（如闭馆），放在 tips 里显式说明，不要假装安排了。
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
const OUTLINE_SYSTEM_PROMPT = `你是资深国内旅行行程规划师，为多日旅行先做「行程大纲」。

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
const DAY_SYSTEM_PROMPT = `你是资深国内旅行行程规划师，现在生成多日行程中某一天的时刻表。

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
- 住宿只在这一天安排：行程第一天，且只此一次（type=hotel，用具体酒店名）。
- 不要输出 totalCostCny 和 tips——那是整个行程层面的，由大纲负责。
`;

function client(): OpenAI {
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
  constructor(message: string, readonly retryable: boolean) {
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
  try {
    const stream = await llm.chat.completions.create({
      model: process.env.LLM_MODEL || "step-5-preview",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: Number(process.env.LLM_MAX_TOKENS || 64000),
      reasoning_effort: (process.env.LLM_REASONING_EFFORT as "low" | "medium" | "high") || "low",
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) content += delta;
      if (chunk.usage) totalTokens = chunk.usage.total_tokens ?? 0;
    }
  } catch (e) {
    const msg = (e as Error).message ?? "";
    console.log(`[llm] ${city} ${tag}异常: ${msg}`);
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
 */
async function streamChatRetry(
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

const PACE_RULES: Record<NonNullable<PlanInput["pace"]>, string> = {
  relaxed: "轻松：每天 1~3 个主景点 + 午餐 + 晚餐，午饭后留咖啡/闲逛/休息的时间，当天净游玩时间不超过 8 小时。",
  balanced: "适中：每天 2~4 个主景点 + 午餐 + 晚餐，当天净游玩时间不超过 10 小时。",
  packed: "紧凑：每天 3~5 个主景点 + 午餐 + 晚餐，能看则看，当天净游玩时间不超过 13 小时。",
};

/**
 * 用户约束的公共描述：三条生成路径（单次 / 大纲 / 分日）共用。
 * 抽出来是为了避免同一份约束在三处各写一遍——曾经踩过「改了一处漏两处」
 * 导致 prompt 与实际行为漂移的坑。
 */
function baseLines(input: PlanInput): string[] {
  const lines = [
    `- 目的地：${input.city}`,
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
      lines.push("- 第一天的安排从抵达时间之后开始（不要安排抵达前的内容）；最后一天在离开时间前收尾。");
    }
  }
  if (input.hotel?.trim()) {
    lines.push(`- 我的住所（已定好，全程以此为基地，不要换成别的酒店）：${input.hotel.trim()}`);
  }
  if (input.mustVisit?.length) {
    lines.push(`- 期望必游地（必须全部安排进行程）：${input.mustVisit.join("、")}`);
  }
  return lines;
}

function buildUserPrompt(input: PlanInput, correction?: string): string {
  const lines = [
    "请规划行程：",
    ...baseLines(input),
  ];
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
  // 预算目标：把「贴近预算」落成具体数值区间，与单日提示词的锚点区间同源。
  // 这是分日锚点的上游——大纲不定调，后面每天只能各自为政。
  // 同样只用锚点（区间），不让模型做算术题（见 buildDayPrompt 的教训注释）。
  const totalLow = Math.max(1, Math.round(input.budget * 0.8));
  lines.push(
    `- 全程人均总花费应落在 ${totalLow}-${input.budget} 元之间：不要大幅低于预算（低于 ${totalLow} 元说明体验排得太省），也不要超出 ${input.budget} 元。`,
  );
  return lines.join("\n");
}

// 单日：注入大纲上下文（当天主题/区域/思路 + 其他天主题供错开），
// 以及当天预算提示（总额按天分摊，首日另含全程住宿）
function buildDayPrompt(
  input: PlanInput,
  outline: Outline,
  dayIdx: number,
  correction?: string,
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
  const perDay = Math.max(1, Math.round(input.budget / input.days));
  const low = Math.max(1, Math.round(perDay * 0.8));
  const high = Math.max(low + 1, Math.round(perDay * 1.05));
  const hotelNote =
    input.hotel?.trim() && dayIdx === 0
      ? `；第一天的酒店 spot 必须直接使用用户住所「${input.hotel.trim()}」`
      : "";
  // 首日区间明确标注「含全程住宿总价」——否则模型会理解成 perDay 之外
  // 再加住宿，各天累计起来超出预算（原提示词的「约 X 元；住宿另计入」
  // 就有这个歧义）。
  const budgetHint =
    dayIdx === 0 && input.days > 1
      ? `当天人均总花费建议落在 ${low}-${high} 元（含全程住宿总价：晚均价 250-500 元 × ${input.days - 1} 晚，计入酒店 spot 的 costCny${hotelNote}）`
      : `当天人均总花费建议落在 ${low}-${high} 元（不含住宿）`;

  const lines = [
    `现在生成行程中第 ${day.day} 天的时刻表（共 ${input.days} 天，这是第 ${dayIdx + 1} 天）。`,
    "",
    `【整个行程的概览】${outline.summary}`,
    `【当天的安排思路】${day.theme} —— ${day.focus}`,
    `【当天的主战场区域】${day.area}（当天景点必须落在这个区域，不要跨区折返）`,
    others ? `【其他天的主题，供你错开安排，不要重复】${others}` : "",
    "",
    "【本次请求的约束】",
    ...baseLines(input),
    `- ${budgetHint}`,
  ];
  if (correction) {
    lines.push(
      `- 上一次输出不符合要求：${correction}。本次必须输出第 ${day.day} 天，day 字段为 ${day.day}，且至少 1 个行程点。`,
    );
  }
  return lines.filter((l) => l !== "").join("\n");
}

function extractJson(text: string): unknown {
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

export async function generatePlan(input: PlanInput): Promise<Plan> {
  const llm = client();
  // 重试纠正指令：跨 attempt 保留（声明在循环外，否则第一次的纠正会在
  // 第二次迭代时被重置丢掉）
  let correction: string | undefined;

  // 两次机会：空返回 / JSON 不合法 / 结构不符，都带原因重试一次
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { content, tokens: totalTokens } = await streamChatRetry(
      llm,
      input.scope === "region" ? `${SYSTEM_PROMPT}\n${REGION_RULES}` : SYSTEM_PROMPT,
      buildUserPrompt(input, correction),
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
      `[llm] ${input.city} ${input.days}天 第${attempt}次尝试 tokens=${totalTokens || "?"}`,
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
      console.log(`[llm] ${input.city} 结构不符（${problem}），带纠正指令重试`);
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
      input.scope === "region" ? `${OUTLINE_SYSTEM_PROMPT}\n${REGION_RULES}` : OUTLINE_SYSTEM_PROMPT,
      buildOutlinePrompt(input, correction),
      input.city,
      `大纲 第${attempt}次`,
    );
    if (!content.trim()) {
      if (attempt === 2) throw new Error("LLM 大纲返回为空，请稍后重试");
      continue;
    }
    console.log(`[llm] ${input.city} 大纲 第${attempt}次 tokens=${tokens || "?"}`);

    let outline: Outline;
    try {
      const parsed = OutlineSchema.parse(extractJson(content));
      // 归一化：按 day 排序 + 重编号为连续 1..N（与路径 1 同规格）
      outline = {
        ...parsed,
        days: [...parsed.days]
          .sort((a, b) => a.day - b.day)
          .map((d, i) => ({ ...d, day: i + 1 })),
      };
    } catch (e) {
      if (attempt === 2) throw new Error(`LLM 大纲不是合法 JSON（${(e as Error).message}）`);
      continue;
    }

    const problem = outlineProblem(outline, input);
    if (problem) {
      if (attempt === 2) throw new Error(`LLM 大纲结构与请求不符（${problem}）`);
      correction = problem;
      console.log(`[llm] ${input.city} 大纲结构不符（${problem}），带纠正指令重试`);
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
): Promise<DayPlan> {
  const llm = client();
  const expectedDay = dayIdx + 1;
  let correction: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { content, tokens } = await streamChatRetry(
      llm,
      input.scope === "region" ? `${DAY_SYSTEM_PROMPT}\n${REGION_RULES}` : DAY_SYSTEM_PROMPT,
      buildDayPrompt(input, outline, dayIdx, correction),
      input.city,
      `第${expectedDay}天 第${attempt}次`,
    );
    if (!content.trim()) {
      if (attempt === 2) throw new Error(`第 ${expectedDay} 天生成返回为空，请稍后重试`);
      continue;
    }
    console.log(`[llm] ${input.city} 第${expectedDay}天 第${attempt}次 tokens=${tokens || "?"}`);

    let day: DayPlan;
    try {
      day = DaySchema.parse(extractJson(content));
    } catch (e) {
      if (attempt === 2) throw new Error(`第 ${expectedDay} 天输出不是合法 JSON（${(e as Error).message}）`);
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
