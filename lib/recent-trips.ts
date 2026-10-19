// 「最近行程」本地索引：把用户生成过的行程记在浏览器里，下次回来能一键打开。
//
// 为什么存在：行程本身已经持久化在服务端（Plan 聚合，带持久分享 token），
// 但「未登录用户」没有账号维度可查询——总不能让用户把每一次的分享链接
// 自己收藏。浏览器 localStorage 正好是「这台设备上的我的行程」这个语义，
// 不需要登录就能兑现，也不引入任何隐私风险（token 本来就只发放给生成者）。
//
// 边界约定（都是踩过坑的常见故障，必须兜住）：
// 1. SSR 下没有 window：所有函数在服务端都返回空/静默，调用方在 useEffect 里用
// 2. localStorage 可能被禁用/写满/quota 异常：读写全程 try-catch，失败即降级为空
// 3. 历史数据可能是旧结构/脏数据：逐条字段校验，坏条目直接丢弃而不是整表崩
// 4. 无上限会越积越多：保留最近 20 条（按打开时间倒序），去重按 shareId

const STORAGE_KEY = "tp.recent-trips.v1";
const MAX_ENTRIES = 20;

/** 一条「最近行程」索引。刻意只存展示用的轻量字段，完整行程在服务端。 */
export interface RecentTrip {
  shareId: string;      // 分享 token（服务端 Plan 主键）
  city: string;
  days: number;
  startDate?: string;   // "YYYY-MM-DD"，用于展示日期与排序兜底
  summary?: string;     // 一句话概览（列表里给点上下文）
  createdAt: number;    // 首次生成/打开的毫秒时间戳
}

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** 单条记录校验：字段类型不对就当脏数据丢弃（历史版本可能结构不同） */
function isRecentTrip(v: unknown): v is RecentTrip {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.shareId === "string" && r.shareId.length >= 6 && r.shareId.length <= 64
    && typeof r.city === "string" && r.city.length > 0 && r.city.length <= 40
    && typeof r.days === "number" && Number.isFinite(r.days) && r.days >= 1 && r.days <= 30
    && (r.startDate === undefined || (typeof r.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.startDate)))
    && (r.summary === undefined || typeof r.summary === "string")
    && typeof r.createdAt === "number" && Number.isFinite(r.createdAt)
  );
}

/** 读取最近行程（新的在前）。任何异常都降级为空列表，绝不抛给 UI。 */
export function loadRecentTrips(): RecentTrip[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentTrip).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function persist(list: RecentTrip[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    // 隐私模式/配额满：索引写不进去不影响主流程，静默降级
  }
}

/**
 * 写入/更新一条最近行程。
 *
 * 同一 shareId 再次打开时不新增，而是把 createdAt 刷新（列表按「最近用过」
 * 排序更符合直觉）；新条目插到最前。
 */
export function saveRecentTrip(trip: RecentTrip): RecentTrip[] {
  const clean: RecentTrip = {
    shareId: trip.shareId,
    city: trip.city,
    days: trip.days,
    startDate: trip.startDate,
    summary: trip.summary,
    createdAt: Date.now(),
  };
  const next = [clean, ...loadRecentTrips().filter((x) => x.shareId !== clean.shareId)];
  persist(next);
  return next;
}

/** 删除一条（用户在「最近行程」里显式移除；不动服务端行程，只清本地索引） */
export function removeRecentTrip(shareId: string): RecentTrip[] {
  const next = loadRecentTrips().filter((x) => x.shareId !== shareId);
  persist(next);
  return next;
}

/** 判断某 token 是否属于本机生成过的行程（决定分享页是否允许「继续编辑」） */
export function ownsRecentTrip(shareId: string): boolean {
  return loadRecentTrips().some((x) => x.shareId === shareId);
}

/** 列表展示用的日期文案："3 天 · 10月10日"；无 startDate 时只给天数 */
export function recentTripLabel(t: RecentTrip): string {
  const dayPart = `${t.days} 天`;
  if (!t.startDate) return dayPart;
  const [, m, d] = t.startDate.split("-");
  const num = (s: string) => String(Number(s));
  return `${dayPart} · ${num(m)}月${num(d)}日`;
}
