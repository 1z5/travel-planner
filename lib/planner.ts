import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import type { Plan, PlanInput, PlanSpot } from "./types";

// ============================================================
// 单次调用生成完整行程。
//
// 演进记录：曾改为「大纲 + 分日并行」（约 320s），实测比单次
// （约 253s）更慢——推理模型的单日调用继承了大部分复杂度，
// 且 16000 token 的单日额度偏紧会触发空返回重试。故回退单次调用，
// 慢的问题用「异步任务 + 进度轮询」的 UX 方案解决（见 lib/jobs.ts）。
// ============================================================

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

function buildUserPrompt(input: PlanInput): string {
  const lines = [
    "请规划行程：",
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
  return lines.join("\n");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLM 未返回 JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

export async function generatePlan(input: PlanInput): Promise<Plan> {
  const llm = client();

  // 两次机会：空返回或 JSON 不合法就原样重试一次
  for (let attempt = 1; attempt <= 2; attempt++) {
    let content = "";
    let totalTokens = 0;
    try {
      // 流式：推理模型生成要 3-5 分钟，非流式会撞上 Node fetch 的
      // undici headersTimeout（默认 300s，响应头迟迟不来就被掐断，
      // 比我们的 420s 超时先炸）。流式下 header 立即返回、chunk 持续流动。
      const stream = await llm.chat.completions.create({
        model: process.env.LLM_MODEL || "step-5-preview",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) },
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
      console.log(`[llm] ${input.city} 第${attempt}次异常: ${msg}`);
      if (/timed out|timeout/i.test(msg)) {
        // 流式下 SDK 超时约束的是「chunk 间隔」而非总时长（实测 496s 的任务
        // 也未被 420s 掐断），所以这里触发时是断流/连接问题，不是“到点没返回”
        throw new Error("生成中断或连接超时，请稍后重试（可减少天数或换个城市）");
      }
      throw e;
    }

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
    try {
      const parsed = PlanSchema.parse(extractJson(content));
      return {
        ...parsed,
        days: parsed.days.map((d) => ({
          ...d,
          spots: d.spots as PlanSpot[],
          transitMin: 0,
          dailyCostCny: 0,
        })),
        warnings: [],
        verified: false,
      } as Plan;
    } catch (e) {
      if (attempt === 2) throw new Error(`LLM 输出不是合法 JSON（${(e as Error).message}）`);
    }
  }
  throw new Error("unreachable");
}
