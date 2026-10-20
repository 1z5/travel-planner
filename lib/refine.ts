import "server-only";
import { z } from "zod";
import { baseLines, client, extractJson, LlmError, SpotSchema, streamChatRetry } from "./planner";
import { nameCovered, validatePlan } from "./validate";
import type { Plan, PlanDay, PlanInput, PlanSpot } from "./types";

// ============================================================
// 行程微调（「跟 AI 说一句」改一天 / 单点「换一个」）。
//
// 产品定位：把行程从「一次性生成器」变成「可共编的工作台」——用户不必为改
// 一个点重跑 3-4 分钟、扣一次生成配额、还丢掉原来满意的结果。
//
// 诚实红线（贯穿本文件）：
// 1. 只改用户点名的那一天/那个点。其他天在结构上引用原对象，模型根本没机会
//    重写它们；prompt 里也明确「其余一行都不许动」。
// 2. 硬约束不可通过微调删除：必游地、重点活动（以及用户指定住所）是用户当初
//    的硬要求，模型想删就拒绝并告诉他原因，而不是默默删掉。
// 3. 改完必须重跑体检（lib/validate.ts）：新的 POI 要验真、通勤要重算、
//    预算/节奏要重新判定。返回的 Plan 是「带最新体检结果」的，不假装改完就好了。
// 4. 失败不返回半成品：所有校验通过才返回新 Plan，否则抛错让路由回 4xx/5xx。
// ============================================================

/** 微调动作：单点替换 / 单日重排 */
export type RefineAction =
  | { kind: "swap"; day: number; spotIndex: number }
  | { kind: "day"; day: number; instruction?: string };

/**
 * 微调请求对这份行程不适用（映射 HTTP 400）。
 * 例：要改的天不存在、该天没有第 K 个点、想替换必游地/重点活动/住宿。
 */
export class RefineRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineRejectedError";
  }
}

/**
 * 模型连续两次给出的结果不符合结构或硬约束（映射 HTTP 422）。
 * 与「LLM 调用失败」严格区分：这里模型通了、也返回了 JSON，只是内容不能用。
 */
export class RefineOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineOutputError";
  }
}

/**
 * 模型调用失败（超时/断连/上游不可用，映射 HTTP 502）。
 * 对外只暴露可行动信息，不透出上游原始报错（可能含内部端点/堆栈片段）。
 */
export class RefineLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineLlmError";
  }
}

// ---------- prompt 构造 ----------

/** 桩 LLM（scripts/stub-llm.mjs）靠这个标记区分「改行程」与「整份生成」，改动要同步桩 */
const REFINE_MARK = "行程微调";

const SPOT_SHAPE_DOC = `{
  "period": "morning|lunch|afternoon|dinner|evening",
  "time": "HH:MM-HH:MM",
  "type": "sight|food|hotel|transport|shopping|activity",
  "name": "POI 名称（必须真实存在）",
  "area": "所在商圈/区域",
  "durationMin": 120,
  "costCny": 0,
  "reason": "为什么选这里，一两句人话",
  "rainBackup": "雨天备选（室外景点必填，室内可省略）"
}`;

/**
 * 构造微调的 system prompt。
 *
 * 任务类型写进 system（`【任务类型】`）有两个用途：
 * 1) 让模型明确这一次是「补丁」还是「整天重排」，两者的输出结构完全不同；
 * 2) 桩 LLM 需要从请求里识别改行程、并判断该返回 spot 还是 day。
 */
function refineSystemPrompt(kind: RefineAction["kind"]): string {
  return `你是资深国内旅行行程规划师，现在做「${REFINE_MARK}」：在用户已有的行程上，**只改用户点名的那一天/那一个点**，其余内容一行都不许动。

【任务类型】${kind === "swap" ? "单点替换" : "单日重排"}

【产品诚实红线（违反即失败）】
- 只输出要求的那一小块内容。不要重写整份行程，不要顺手「优化」其他天或当天没点名的点。
- 新地点必须是所给城市里真实存在的 POI，写准确名称；不要编造不存在的场馆/分店/餐厅。
- 不得删除用户指定的必游地与重点活动（含 type=activity 的活动场次）；若用户指令要求删，不要照做，在 reason 里说明「这是硬约束，已保留」。
- 预算与节奏是硬约束：新安排的停留时长与花费要和原安排同一量级，不能把当天排爆或大幅超预算。
- 如果用户的指令本身违反上面的硬约束，优先保住硬约束，不要为了服从指令而删掉必游地/活动。

【输出要求（严格遵守）】
1. 只输出一个合法 JSON 对象，不要输出任何解释文字，不要 markdown 代码围栏。
2. 输出结构：
${kind === "swap" ? '{"spot": { ...完整 spot... }}' : '{"day": {"day": 天序号, "theme": "当天主题", "spots": [ ...完整一天... ]}}'}
3. spot 字段（rainBackup 之外全部必填）：
${SPOT_SHAPE_DOC}
4. ${
    kind === "swap"
      ? "只返回这一个替换点，不要返回整天或整份行程。"
      : "spots 必须是「改完后的完整一天」：按时间顺序、含午餐/晚餐，不是增量补丁；不得少于 1 个点。"
  }`;
}

const TYPE_LABEL: Record<PlanSpot["type"], string> = {
  sight: "景点",
  food: "餐饮",
  hotel: "住宿",
  transport: "交通",
  shopping: "购物",
  activity: "活动",
};

function spotLine(spot: PlanSpot, idx: number): string {
  return ` ${idx + 1}. [${spot.period} ${spot.time}] ${TYPE_LABEL[spot.type]}「${spot.name}」（${spot.area}）¥${spot.costCny} ${spot.durationMin}min`;
}

/**
 * 指令归一化（defense in depth）。
 *
 * 路由层已用字符白名单挡掉引号/换行/花括号/反斜杠（lib/refine 的唯一入口），
 * 这里再做一遍「不信任输入」的清洗：即使将来有别的调用方绕过路由把用户原话
 * 直接喂进来，它也不会变成能伪造 prompt 段落或 JSON 示例的注入。
 * 截断 100 字与路由上限一致（指令是「一句话」，不是小作文）。
 */
export function sanitizeInstruction(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["'`\\{}[\]<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/**
 * 「当天必须保留」的名字清单：用户硬约束（必游地 / 重点活动）+ 当天原有的
 * activity 点 + 用户指定住所对应的酒店点。给 prompt 用，也用于拒绝判定——
 * 两处同源，避免「prompt 要求保留但校验漏了」或反之。
 */
function requiredKeeps(plan: Plan, input: PlanInput, day: PlanDay): string[] {
  const names: string[] = [];
  const dayNames = day.spots.map((s) => s.name);
  for (const mv of input.mustVisit ?? []) {
    if (nameCovered(mv, dayNames)) names.push(mv);
  }
  for (const ev of input.events ?? []) {
    if (nameCovered(ev.name, dayNames)) names.push(ev.name);
  }
  for (const s of day.spots) {
    if (s.type === "activity") names.push(s.name);
  }
  const hotel = input.hotel?.trim();
  if (hotel) {
    for (const s of day.spots) {
      if (s.type !== "hotel") continue;
      // 只有「确实是用户指定住所」的酒店点才是硬约束。若模型生成时落成了另一家
      // 酒店（体检会警告「住所未体现」），不能把「保住那家错酒店」变成改行程的
      // 硬约束——那会让用户永远改不动这一天。
      if (nameCovered(hotel, [s.name, s.area])) names.push(s.name);
    }
  }
  return [...new Set(names)];
}

/**
 * 构造一次微调请求的 prompt。
 *
 * 约束部分直接复用 planner 的 baseLines（城市/天数/预算/偏好/节奏/住所/必游地/
 * 活动）：两处各写一份迟早漂移，而「改行程」必须满足与「生成行程」同一套约束，
 * 否则改完的行程会和用户当初的要求对不上。
 */
export function buildRefinePrompt(
  input: PlanInput,
  plan: Plan,
  action: RefineAction,
  correction?: string,
): { system: string; user: string } {
  const targetDay = plan.days.find((d) => d.day === action.day)!;
  const lines: string[] = [];
  lines.push(`请做一次${REFINE_MARK}：只改一处，其余内容保持原样。`, "");
  lines.push("【行程基础约束】（用户的原始要求，改行程同样必须满足）");
  lines.push(...baseLines(input));
  lines.push("");
  lines.push("【整份行程概览（★ 是本次唯一的改动范围；其他天一行都不许动）】");
  for (const d of plan.days) {
    lines.push(`${d.day === action.day ? "★ " : ""}第 ${d.day} 天：${d.theme}`);
  }
  lines.push("");
  lines.push(`【当天现状】第 ${targetDay.day} 天 · 主题「${targetDay.theme}」`);
  targetDay.spots.forEach((s, i) => lines.push(spotLine(s, i)));
  lines.push("");

  if (action.kind === "swap") {
    const target = targetDay.spots[action.spotIndex]!;
    const todayNames = targetDay.spots.filter((_, i) => i !== action.spotIndex).map((s) => s.name);
    const planNames = [...new Set(plan.days.flatMap((d) => d.spots.map((s) => s.name)))].filter(
      (n) => n !== target.name,
    );
    lines.push("【本次任务】单点替换");
    lines.push(`目标：第 ${action.day} 天`);
    lines.push(
      `【被替换点】序号 ${action.spotIndex + 1}｜类型 ${target.type}｜时段 ${target.period}｜时间 ${target.time}｜区域 ${target.area}｜名称 ${target.name}`,
    );
    lines.push("替换要求：");
    lines.push(
      `- 新点的 type 必须仍是 ${target.type}（${TYPE_LABEL[target.type]}），period 必须仍是 ${target.period}——换景点就换景点，不要把餐厅换成商店。`,
    );
    lines.push(`- 必须落在同一区域：${target.area}（同区域才不会制造跨城折返）。`);
    lines.push(
      `- 必须避开当天已有的其他地点：${todayNames.join("、") || "（无）"}；也不要与整份行程其他天的地点重复：${planNames.join("、") || "（无）"}。`,
    );
    lines.push(`- 时间请落在 ${target.time} 附近，与前后行程点衔接（当天 21:00 前结束）。`);
    lines.push(
      "- 必须给出 costCny（人均，含门票）、durationMin、reason、rainBackup（室外点必填）。",
    );
    lines.push("- 只输出这一个替换点，不要输出整天或整份行程。");
    lines.push("");
    lines.push('【输出】只输出 JSON：{"spot": { ... }}');
  } else {
    const keeps = requiredKeeps(plan, input, targetDay);
    const instruction = action.instruction ? sanitizeInstruction(action.instruction) : "";
    lines.push("【本次任务】单日重排");
    lines.push(`目标：第 ${action.day} 天`);
    lines.push(
      instruction
        ? `【用户指令】「${instruction}」——把它转成当天的具体安排，但不得违反上面的硬约束。`
        : "【用户指令】（未提供：请按当天主题重新安排得更合理，并给出与现在不同的安排。）",
    );
    lines.push(`【当天必须保留】${keeps.length ? keeps.join("、") : "（无）"}`);
    lines.push("重排要求：");
    lines.push(
      `- 只输出第 ${action.day} 天改完后的完整一天，不要输出其他天，也不要在文字里复述它们。`,
    );
    lines.push(`- theme 沿用「${targetDay.theme}」，除非用户指令明确要求换主题。`);
    lines.push(
      "- spots 按时间顺序完整（含午餐/晚餐），不得少于 1 个点；主景点数量与节奏按上面的用户约束。",
    );
    lines.push("- 当天已有的住宿点（如有）保持不变；type=activity 的点原样保留。");
    lines.push("- 不要删除【当天必须保留】里的任何点。");
    lines.push("");
    lines.push(
      '【输出】只输出 JSON：{"day": {"day": ' + action.day + ', "theme": "...", "spots": [...]}}',
    );
  }

  if (correction) {
    lines.push("");
    lines.push(`【上一次输出不符合要求】${correction}`);
    lines.push("本次必须修正后重新输出，仍然只输出 JSON。");
  }

  return { system: refineSystemPrompt(action.kind), user: lines.join("\n") };
}

// ---------- 响应解析与结构核对 ----------

const SwapResponseSchema = z.object({ spot: SpotSchema });

const DayResponseSchema = z.object({
  day: z.object({
    day: z.number(),
    theme: z.string(),
    // 至少 1 个点：把「改完变成空的一天」挡在 zod 层
    spots: z.array(SpotSchema).min(1),
  }),
});

const normName = (s: string) => s.replace(/\s+/g, "").trim();

function planSpotNames(plan: Plan): string[] {
  return plan.days.flatMap((d) => d.spots.map((s) => normName(s.name)));
}

/** 单点替换的结构核对与拼装：非法时返回问题描述（作为纠正指令重试），合法时返回新 plan */
function swapCandidate(
  plan: Plan,
  action: Extract<RefineAction, { kind: "swap" }>,
  spot: z.infer<typeof SpotSchema>,
): { candidate: Plan | null; problem: string | null } {
  const day = plan.days.find((d) => d.day === action.day)!;
  const original = day.spots[action.spotIndex]!;
  const problems: string[] = [];
  if (spot.type !== original.type) {
    problems.push(`新点类型应为 ${original.type}，实际 ${spot.type}`);
  }
  if (spot.period !== original.period) {
    problems.push(`新点时段应为 ${original.period}，实际 ${spot.period}`);
  }
  const name = normName(spot.name);
  if (name === normName(original.name)) {
    problems.push(`新点与被替换点同名（「${original.name}」），没有真正替换`);
  }
  // 判重只用「归一化后完全同名」：nameCovered 是模糊匹配（>=3 字公共子串），
  // 会把「苏州博物馆」和「苏州博物馆西馆」这类合理的不同点误判成重复。
  const others = planSpotNames(plan).filter((n) => n !== normName(original.name));
  if (others.includes(name)) {
    problems.push(`新点「${spot.name}」与行程里已有的地点重名，请换一个`);
  }
  if (problems.length) return { candidate: null, problem: problems.join("；") };

  const newDay: PlanDay = {
    ...day,
    // 只替换目标下标，其余 spot 引用原对象（内容一个字都没动）
    spots: day.spots.map((s, i) => (i === action.spotIndex ? spot : s)),
  };
  return {
    candidate: {
      ...plan,
      days: plan.days.map((d) => (d.day === action.day ? newDay : d)),
    },
    problem: null,
  };
}

const spotSig = (s: PlanSpot) =>
  [normName(s.name), s.time, s.period, s.type, String(s.costCny), String(s.durationMin)].join("|");

function sameSpots(a: PlanSpot[], b: PlanSpot[]): boolean {
  return a.length === b.length && a.every((s, i) => spotSig(s) === spotSig(b[i]));
}

/** 单日重排的结构核对与拼装 */
function dayCandidate(
  plan: Plan,
  action: Extract<RefineAction, { kind: "day" }>,
  out: z.infer<typeof DayResponseSchema>["day"],
  input: PlanInput,
): { candidate: Plan | null; problem: string | null } {
  const original = plan.days.find((d) => d.day === action.day)!;
  const problems: string[] = [];
  if (out.day !== action.day) {
    problems.push(`day 字段应为 ${action.day}，实际 ${out.day}`);
  }
  if (out.spots.length === 0) {
    problems.push("这一天没有任何行程点");
  }
  // 硬约束不可丢：原本落在这天的必游地/重点活动/活动场次/住所酒店，改完必须还在
  const keeps = requiredKeeps(plan, input, original);
  const newNames = out.spots.map((s) => s.name);
  const lost = keeps.filter((n) => !nameCovered(n, newNames));
  if (lost.length) {
    problems.push(`改完后这些硬约束不见了：${lost.join("、")}（必游地/重点活动/住所不能删）`);
  }
  // 「重排这一天」返回原样 = 没有兑现对用户的承诺，不能算成功
  if (problems.length === 0 && sameSpots(original.spots, out.spots as PlanSpot[])) {
    problems.push("输出与原来的安排完全相同（没有真正重排），请给出不同且更合理的安排");
  }
  if (problems.length) return { candidate: null, problem: problems.join("；") };

  const newDay: PlanDay = {
    day: original.day,
    // 空主题不算用户可见问题（沿用原主题即可），不值得为它再烧一次 20-90 秒调用
    theme: out.theme.trim() || original.theme,
    spots: out.spots as PlanSpot[],
    transitMin: 0,
    dailyCostCny: 0,
  };
  return {
    candidate: {
      ...plan,
      days: plan.days.map((d) => (d.day === action.day ? newDay : d)),
    },
    problem: null,
  };
}

/** 从模型输出里解析出候选新 plan；zod/JSON 失败会抛错（由 refinePlan 转成纠正重试） */
function candidateFromContent(
  content: string,
  plan: Plan,
  input: PlanInput,
  action: RefineAction,
): { candidate: Plan | null; problem: string | null } {
  const raw = extractJson(content);
  if (action.kind === "swap") {
    const parsed = SwapResponseSchema.parse(raw);
    return swapCandidate(plan, action, parsed.spot);
  }
  const parsed = DayResponseSchema.parse(raw);
  return dayCandidate(plan, action, parsed.day, input);
}

// ---------- 硬约束前置拒绝 ----------

/** 指令里的「删除类」动词：命中且点名了硬约束时，在调模型之前就拒绝 */
const DELETE_WORDS = /删|去掉|去除|取消|不要|别去|不去了|移除/;

/**
 * 用户指令是否直接要求删掉某个硬约束。返回命中的名称，未命中返回 null。
 *
 * 为什么要在调模型之前拦：一次微调 20-90 秒 + 一次限流额度，让用户等完才
 * 被告知「不行」是最差体验；而且「删掉吧」这种指令喂给模型本身就在诱导它
 * 违反硬约束——不如直说。
 */
function deletingHardConstraint(instruction: string, input: PlanInput): string | null {
  const text = sanitizeInstruction(instruction);
  if (!DELETE_WORDS.test(text)) return null;
  const hard = [...(input.mustVisit ?? []), ...(input.events ?? []).map((e) => e.name)];
  for (const name of hard) {
    if (nameCovered(name, [text])) return name;
  }
  return null;
}

/** 单点替换的适用性：行程骨架与硬约束不能被「换一个」掉 */
function swappableProblem(target: PlanSpot, input: PlanInput): string | null {
  if (target.type === "hotel") {
    const hotel = input.hotel?.trim();
    return hotel
      ? `住宿是你指定的住所「${hotel}」，属于硬约束，不能单点替换；如需调整住宿请用「重排这一天」`
      : "住宿是行程骨架（涉及全程住宿预算），不支持单点替换；可用「重排这一天」调整";
  }
  if (target.type === "transport") {
    return "交通段是行程骨架（串联前后行程点），不支持单点替换；可用「重排这一天」调整";
  }
  const eventNames = (input.events ?? []).map((e) => e.name);
  for (const name of input.mustVisit ?? []) {
    if (nameCovered(name, [target.name])) {
      return `「${target.name}」是你指定的必游地，属于硬约束，不能替换；可以替换当天其他点`;
    }
  }
  for (const name of eventNames) {
    if (nameCovered(name, [target.name])) {
      return `「${target.name}」是你指定的重点活动，属于硬约束，不能替换；可以调整它前后的安排`;
    }
  }
  // 注意：不按 type=activity 一刀切拒绝——AI 自己建议的体验项目（如看一场
  // 川剧）应该可以换；只有「用户指定的重点活动」才是硬约束，上面按名称匹配
  // 的循环已经拦住了那种情况。
  return null;
}

// ---------- 重新体检 ----------

/** validatePlan 重写 warnings，但天气提示是 jobs.ts 生成时追加的、本轮不重查（见下） */
const WEATHER_WARNING_RE = /^第 (\d+) 天（\d{4}-\d{2}-\d{2}）/;

/**
 * 改完重跑体检 + 保留未改动天的天气提示。
 *
 * validatePlan 会重算 POI 验真/通勤/预算/硬约束，并把 plan.warnings **整体重写**；
 * 而天气提示是 jobs.ts 在生成收尾时查过天气追加的，本轮**不重查**（编辑不值得再
 * 打一次高德，也避免编辑时刻与生成时刻的预报窗口不同造成前后不一致）。
 *
 * 取舍：只保留「未被改动的那几天」的天气提示。被改那天的气象描述里点名了
 * 当时的室外景点，改完后那段话可能已经不对——按诚实红线，宁可暂时不显示，
 * 也不展示一条已经不准确的预警（用户可在「行中」重新查天气）。
 */
async function revalidate(
  candidate: Plan,
  plan: Plan,
  input: PlanInput,
  editedDay: number,
): Promise<Plan> {
  const preservedWeather = plan.warnings.filter((w) => {
    const m = w.match(WEATHER_WARNING_RE);
    return m !== null && Number(m[1]) !== editedDay;
  });
  // 只对被改的那天重算 legs：其余天的 spot 是原对象引用、坐标没变，legs
  // 重算结果不会变，却要各打一次无缓存的 direction 接口（5 天行程 20+ 次，
  // 全阻塞在这次同步的「换一个」响应里）。
  await validatePlan(candidate, input, [editedDay]);
  for (const w of preservedWeather) {
    if (!candidate.warnings.includes(w)) candidate.warnings.push(w);
  }
  return candidate;
}

// ---------- 主流程 ----------

/** 把上游 LLM 异常翻译成可行动、不漏内部细节的 RefineLlmError */
function translateLlmFailure(e: unknown): RefineLlmError {
  if (e instanceof LlmError) {
    return new RefineLlmError(
      e.retryable
        ? "模型连接中断（已自动重试一次仍失败），请稍后重试"
        : "模型响应超时或中断，请稍后重试",
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("LLM_API_KEY")) {
    return new RefineLlmError("服务端未配置模型服务（LLM_API_KEY），请联系管理员");
  }
  return new RefineLlmError("模型服务暂时不可用，请稍后重试");
}

/** 模型输出里有没有 JSON/字段问题：给纠正指令用的人话原因 */
function reasonOf(e: unknown): string {
  if (e instanceof z.ZodError) {
    const first = e.issues[0];
    return first ? `${first.path.join(".") || "字段"}：${first.message}` : "字段不合规";
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * 微调主流程：调模型 → 解析/校验/结构核对 → 失败带纠正重试 1 次 → 重跑体检。
 *
 * 只返回新 Plan（不落库）：落库由路由在拿到结果后再做，保证「校验通过才持久化」。
 *
 * 错误语义（路由据此映射状态码）：
 *   RefineRejectedError → 400（请求不适用）
 *   RefineOutputError   → 422（模型两次都没给出合格结果）
 *   RefineLlmError      → 502（模型调用失败）
 */
export async function refinePlan(
  plan: Plan,
  input: PlanInput,
  action: RefineAction,
): Promise<Plan> {
  // ---- 1) 前置校验：不烧 token、不占用户等待时间 ----
  const original = plan.days.find((d) => d.day === action.day);
  if (!original) {
    throw new RefineRejectedError(
      `这份行程没有第 ${action.day} 天（共 ${plan.days.length} 天），请刷新页面后重试`,
    );
  }
  if (action.kind === "swap") {
    const target = original.spots[action.spotIndex];
    if (!target) {
      throw new RefineRejectedError(
        `第 ${action.day} 天没有第 ${action.spotIndex + 1} 个行程点，请刷新页面后重试`,
      );
    }
    const problem = swappableProblem(target, input);
    if (problem) throw new RefineRejectedError(problem);
  } else if (action.instruction) {
    const hit = deletingHardConstraint(action.instruction, input);
    if (hit) {
      throw new RefineRejectedError(
        `「${hit}」是你指定的必游地/重点活动，不能删除；可以换成同区域的其他点，或换个说法调整其他安排`,
      );
    }
  }

  let llm;
  try {
    llm = client();
  } catch (e) {
    throw translateLlmFailure(e);
  }

  // ---- 2) 调模型 + 内容层重试（连接层重试在 streamChatRetry 内部已完成）----
  let correction: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { system, user } = buildRefinePrompt(input, plan, action, correction);

    let content = "";
    try {
      const r = await streamChatRetry(
        llm,
        system,
        user,
        input.city,
        `微调 第${action.day}天 第${attempt}次`,
      );
      content = r.content;
      console.log(
        `[llm] ${input.city} ${REFINE_MARK} 第${action.day}天 第${attempt}次 tokens=${r.tokens || "?"}`,
      );
    } catch (e) {
      throw translateLlmFailure(e);
    }

    if (!content.trim()) {
      if (attempt === 2) {
        throw new RefineOutputError(
          "改行程失败：模型连续两次返回空结果，你的原行程没有被改动，请稍后重试",
        );
      }
      correction = "上一次返回为空，必须输出要求的那一小块 JSON。";
      continue;
    }

    let result: { candidate: Plan | null; problem: string | null };
    try {
      result = candidateFromContent(content, plan, input, action);
    } catch (e) {
      if (attempt === 2) {
        throw new RefineOutputError(
          `改行程失败：模型连续两次返回的结果不是要求的 JSON 结构（${reasonOf(e)}），你的原行程没有被改动，请稍后重试`,
        );
      }
      correction = `上一次输出不是合法 JSON 或字段不合规（${reasonOf(e)}），必须严格按要求的 JSON 结构输出。`;
      console.log(`[llm] ${input.city} ${REFINE_MARK} 结构不符（${reasonOf(e)}），带纠正指令重试`);
      continue;
    }

    if (!result.candidate) {
      if (attempt === 2) {
        throw new RefineOutputError(
          `改行程失败：${result.problem}。你的原行程没有被改动，请换个说法重试`,
        );
      }
      correction = result.problem!;
      console.log(
        `[llm] ${input.city} ${REFINE_MARK} 内容不合规（${result.problem}），带纠正指令重试`,
      );
      continue;
    }

    // ---- 3) 校验通过才体检；体检完才返回 ----
    return revalidate(result.candidate, plan, input, action.day);
  }
  throw new Error("unreachable");
}
