// 旅行档案（Travel DNA）：让产品记得用户——体力 / 忌口 / 作息 / 通勤耐受 / 推断偏好。
//
// 为什么这是一等资产：生成能力会商品化（任何大模型都能写行程），事实层
// （高德 POI/营业时间/通勤）已经建好，而「这个用户体力只够轻松节奏、
// 他海鲜过敏、他早起」这种**跨行程的记忆**竞品抄不走——它随使用次数
// 复利变厚，用得越久，生成的行程越「就是我要的」。
//
// 三条诚实红线（与 AGENTS.md 核心原则同源，全部落在实现里）：
// 1. **每条偏好可溯源、可手改、可删除**：档案不是黑箱画像。5 个显式字段
//    由冷启动引导显式填写；推断偏好必须标注「根据你上次的行程推测」，
//    且能删能改——黑箱画像比没有画像更让人不安。
// 2. **无档案时全链路行为零变化**：DEFAULT_PROFILE 只是表单初值与解析
//    兜底，**不会**在用户没填过档案时被自动启用（store 返回 null →
//    请求不带 profile → planner/validate 看到没有档案，一行档案行都不加）。
// 3. **值都过字符白名单**：diet 与推断文案会进 LLM prompt，与 city/hotel
//    同等防注入——换行、指令句式、超长一律拒绝/丢弃。
//
// client-safe 纯函数（与 lib/budget.ts 同风格）：结果页组件直接调用，
// 不 import "server-only"。

/** 体力上限：用户每天能承受的强度。
 *
 * 与「行程节奏 pace」是两个独立维度——pace 是**这次请求**的密度，
 * stamina 是**用户身体**的事实。用户完全可能请求紧凑节奏但体力只够
 * 适中，此时按 stamina 收紧体检上限，才能同时尊重两者。 */
export type Stamina = "relaxed" | "balanced" | "packed";

/** 作息：早起型还是夜猫型。影响每天动线的时间分布（主景点排在上午还是下午晚上） */
export type Schedule = "early" | "late";

/**
 * 一条推断偏好。三个字段各司其职：
 * - text：偏好陈述本身（会进 prompt，所以有白名单）
 * - source：溯源——根据什么推出来的（UI 展示给用户看的证据，不进 prompt）
 * - editable：是否允许手改（推断项一律可改可删——这是红线）
 */
export interface InferredPref {
  text: string;
  source: string;
  editable: boolean;
}

/** 旅行档案。5 个显式字段 + 推断偏好列表——刻意不做 20 个字段：
 * 字段越多越没人填，先 5 个跑通「存→读→用→改」飞轮。 */
export interface TravelProfile {
  stamina: Stamina;
  diet: string[]; // 忌口/饮食约束，如 ["海鲜过敏", "不吃辣"]
  schedule: Schedule;
  maxCommuteMin: number; // 单段通勤可接受上限（分钟）
  inferred: InferredPref[];
}

/**
 * 居中默认值（不猜用户）：
 * - stamina "balanced"：正中间档，不替用户收紧或放宽；
 * - diet []：**不编忌口**——空就是空，没有约束；
 * - schedule "early"：二选一无「居中」，取早起是行程规划的常识前提
 *   （景点多在白天开放、上午光线好），真正的值由冷启动引导显式询问；
 * - maxCommuteMin 60：市内单段通勤的真实中位约 15-40 分钟，60 是
 *   「跨城区也愿意走一趟」的档，居中偏宽，不替用户收紧；
 * - inferred []：v1 **不做自动推断引擎**（见 inferDeferred 注释）。
 *
 * 用途：引导表单的初值 + 解析兜底。注意它**不是**「默认档案」——
 * 用户没填过档案时 store 返回 null，全链路看不到档案（红线 2）。
 */
export const DEFAULT_PROFILE: TravelProfile = {
  stamina: "balanced",
  diet: [],
  schedule: "early",
  maxCommuteMin: 60,
  inferred: [],
};

/** v1 不自动生成推断偏好的原因：推断需要「上次的行程」做原料，且要有去重 /
 * 衰减 / 冲突策略（推断和显式填写矛盾时听谁的）。在治理契约（可标注、
 * 可溯源、可删）做实之前上引擎，产出的就是用户删不掉也看不懂的黑箱——
 * 那正是本模块要避免的东西。类型与 UI 先就位，引擎是下一迭代的事。 */
export const INFERENCE_DEFERRED_NOTE = "我们不会悄悄分析你。档案里的每一条都可以随时改掉或删掉。";

// ---------- 校验（脏数据 / 防注入） ----------

/**
 * 偏好文案的字符白名单（与 app/api/plan/route.ts 的 city/hotel 同口径）。
 *
 * 为什么必须有：diet 与推断文案会原样拼进 LLM prompt，用户输入（以及
 * localStorage 里被篡改的数据）就是注入面。允许中英文数字、常见中文
 * 标点（含全角冒号/分号——溯源文案「上次行程：苏州 3 天」天然需要），
 * **不含换行/制表符**——一行一条是防注入的底线（换行可以伪造
 * prompt 结构，指令句式可以劫持模型）。
 */
const TEXT_RE = /^[\u4e00-\u9fa5A-Za-z0-9·、，。（）()：；\/\-\s]{1,30}$/;

/** 忌口条数上限：超出的忌口基本是误输入，且 prompt 会变噪音 */
const MAX_DIET = 8;
/** 推断偏好条数上限：同上，且推断项没有引擎生产，人为上限足够 */
const MAX_INFERRED = 10;
/** 推断文案比忌口长（是一句陈述不是标签），单独放宽 */
const INFERRED_TEXT_RE = /^[\u4e00-\u9fa5A-Za-z0-9·、，。（）()：；\/\-\s]{1,60}$/;
/** 单段通勤可接受上限的合法区间（分钟）：10 分钟≈同城区步行/短驳，240 分钟≈跨城 */
const MIN_COMMUTE_MIN = 10;
const MAX_COMMUTE_MIN = 240;

/**
 * 单条文案清洗：白名单外的字符一律拒绝（返回 null）。
 *
 * 导出原因：抽屉 UI 的「添加忌口」输入框要用**同一个**校验——
 * UI 层与存储层口径不一致时，用户输入在 UI 里合法、保存时被悄悄丢掉，
 * 是最伤信任的一类 bug（「我明明加了，怎么没有」）。
 */
export function sanitizePrefText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t || t.length > max) return null;
  // 换行/制表符先挡：TEXT_RE 里的 \s 含换行，但换行是注入面，必须显式拒绝
  if (/[\n\r\t]/.test(t)) return null;
  const re = max > 30 ? INFERRED_TEXT_RE : TEXT_RE;
  return re.test(t) ? t : null;
}

function isStamina(v: unknown): v is Stamina {
  return v === "relaxed" || v === "balanced" || v === "packed";
}

function isSchedule(v: unknown): v is Schedule {
  return v === "early" || v === "late";
}

function cleanDietList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const t = sanitizePrefText(item, 30);
    if (t && !out.includes(t)) out.push(t); // 去重：同一条忌口写两遍没有意义
    if (out.length >= MAX_DIET) break;
  }
  return out;
}

function cleanInferredList(raw: unknown): InferredPref[] {
  if (!Array.isArray(raw)) return [];
  const out: InferredPref[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const text = sanitizePrefText(r.text, 60);
    // text 缺失 = 这条推断没有内容，整条丢弃（不猜它想说什么）
    if (!text) continue;
    const source = sanitizePrefText(r.source, 40);
    out.push({
      text,
      // source 缺失时给兜底文案而不是留空：溯源是红线，宁可给通用标注
      // 也不能让一条没有依据的推断进入展示
      source: source ?? "根据你上次的行程推测",
      // 默认 true：推断项生来就可改可删（红线）；显式 false 也尊重
      editable: r.editable !== false,
    });
    if (out.length >= MAX_INFERRED) break;
  }
  return out;
}

/**
 * 档案校验 + 归一化：脏数据 → 可用档案；彻底不像对象的 → null。
 *
 * 为什么逐字段回退默认值而不是整档拒绝：localStorage 可能是旧版本结构
 * 或被人为篡改，为一个坏字段丢掉用户辛苦填的全部档案更糟；回退值全部是
 * 「不表达偏好」的中性档（balanced / 早 / 60 分钟），等于这一项回到
 * 引导前的状态，而不是替用户猜一个新偏好（不猜不假装）。
 *
 * 服务端（app/api/plan/route.ts）也用它校验客户端传来的档案：
 * 档案会进 prompt，白名单不可省，校验失败走 400。
 */
export function validateProfile(raw: unknown): TravelProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const maxCommuteMin =
    typeof r.maxCommuteMin === "number" &&
    Number.isInteger(r.maxCommuteMin) &&
    r.maxCommuteMin >= MIN_COMMUTE_MIN &&
    r.maxCommuteMin <= MAX_COMMUTE_MIN
      ? r.maxCommuteMin
      : DEFAULT_PROFILE.maxCommuteMin;
  return {
    stamina: isStamina(r.stamina) ? r.stamina : DEFAULT_PROFILE.stamina,
    diet: cleanDietList(r.diet),
    schedule: isSchedule(r.schedule) ? r.schedule : DEFAULT_PROFILE.schedule,
    maxCommuteMin,
    inferred: cleanInferredList(r.inferred),
  };
}

// ---------- 展示标签（prompt 与抽屉共用同一份口径） ----------

/** 体力档位选项：抽屉的分段控件与 prompt 都渲染这份，避免两处说法漂移 */
export const STAMINA_OPTIONS: readonly { value: Stamina; label: string; desc: string }[] = [
  { value: "relaxed", label: "偏轻松", desc: "每天少安排，多留休息" },
  { value: "balanced", label: "适中", desc: "每天 2-4 个主景点" },
  { value: "packed", label: "偏紧凑", desc: "能多看就多看，接受赶路" },
];

/** 作息选项：同上，抽屉与 prompt 共用 */
export const SCHEDULE_OPTIONS: readonly { value: Schedule; label: string; desc: string }[] = [
  { value: "early", label: "早起型", desc: "习惯上午出门，上午安排主景点" },
  { value: "late", label: "夜猫型", desc: "习惯下午晚上活动，接受夜游" },
];

export function staminaLabel(v: Stamina): string {
  return STAMINA_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

export function scheduleLabel(v: Schedule): string {
  return SCHEDULE_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

/**
 * stamina 对体检节奏阈值的调整系数（lib/validate.ts 引用，抽屉展示也用它）。
 *
 * 为什么放在 client-safe 的 profile.ts 而不是 validate.ts：抽屉要向用户
 * 说明「体力会怎样影响体检」，系数是产品口径的一部分，两端必须同一个
 * 定义——放进 server-only 的 validate.ts 会让前端只能复制一份，
 * 两处漂移就是「体检说一套、UI 说一套」。
 *
 * 取值：relaxed ×0.8（收紧）/ balanced ×1（保持现阈值）/ packed ×1.2（放宽）。
 * 无档案时 validate 侧系数恒为 1，行为与切片 3 之前完全一致。
 */
export const STAMINA_PACE_FACTOR: Record<Stamina, number> = {
  relaxed: 0.8,
  balanced: 1,
  packed: 1.2,
};

// ---------- prompt 渲染 ----------

/**
 * 把档案渲染成 prompt 行（给 lib/planner.ts 的 baseLines 用）。
 *
 * 措辞上的两个刻意选择：
 * 1. 体力行不带小时数：具体上限由体检按 pace×stamina 算，prompt 里写死
 *    数字会和 pace 规则（PACE_RULES 的 8/10/13 小时）打架；
 * 2. 推断行自带「根据你上次的行程推测」标注：这是红线，同时告诉模型
 *    「这是提示不是硬约束」——别拿一条过期推测当圣旨。
 */
export function renderProfileLines(profile: TravelProfile): string[] {
  const stamina = STAMINA_OPTIONS.find((o) => o.value === profile.stamina);
  const schedule = SCHEDULE_OPTIONS.find((o) => o.value === profile.schedule);
  const lines: string[] = [];
  lines.push(
    `- 我的体力上限：${stamina?.label ?? profile.stamina}（${stamina?.desc ?? "每天 2-4 个主景点"}）`,
  );
  if (profile.diet.length) {
    // 忌口是硬约束措辞：模型必须全程避开，措辞里写死「必须」
    lines.push(`- 饮食忌口：${profile.diet.join("、")}（全程餐饮安排必须避开这些）`);
  }
  lines.push(
    `- 我的作息：${schedule?.label ?? profile.schedule}（${schedule?.desc ?? "按上午优先安排"}），每天的动线时间分布按这个来`,
  );
  lines.push(
    `- 单段通勤可接受上限：${profile.maxCommuteMin} 分钟（安排动线时尽量不超过，超过就换更近的点）`,
  );
  for (const p of profile.inferred) {
    lines.push(`- ${p.text}（根据你上次的行程推测，仅供参考）`);
  }
  return lines;
}
