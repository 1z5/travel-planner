// 想去清单（产品线 B3）：把「看别人的行程心动」变成「这台设备上的愿望」。
//
// 为什么需要：竞品调研里「收藏/愿望清单」是旅行产品最低成本的留存钩子——Airbnb
// 心愿单、Google Maps Saved 都是这套逻辑。我们的分享页有「克隆」，但克隆是
// 「现在就排」，缺一个「先记下来，以后再说」的中间态；而旅行决策天然有「种草 →
// 比价 → 定档期」的滞后，少了这一层，分享链接看完就流失了。
//
// 存储选 localStorage（与「最近行程」同源）：
// - 未登录用户没有账号维度（陌生人可用是产品前提）；
// - 愿望是轻数据，跨设备同步等登录体系补齐后再做（与北极星已知局限一致）。
//
// 三条红线：
// 1. **不编愿望**：只存用户主动点星的行程，不根据浏览行为自动加入；
// 2. **脏数据不炸**：逐字段校验，坏条目丢弃而不是整表崩；
// 3. **有上限**：最多 100 条（超出丢最旧），防止长驻 localStorage 无限膨胀。

const STORAGE_KEY = "tp.wishlist.v1";
const MAX_ENTRIES = 100;

export interface WishlistTrip {
  /** 行程分享 token（/p/<shareId>） */
  shareId: string;
  city: string;
  days: number;
  /** 行程首日 "YYYY-MM-DD"（旧数据/分享可能缺） */
  startDate?: string;
  summary?: string;
  /** 加入时间（ms），列表按它倒序 */
  addedAt: number;
}

function hasStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isWishlistTrip(v: unknown): v is WishlistTrip {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.shareId === "string" &&
    r.shareId.length >= 6 &&
    r.shareId.length <= 64 &&
    typeof r.city === "string" &&
    r.city.length > 0 &&
    r.city.length <= 40 &&
    typeof r.days === "number" &&
    Number.isInteger(r.days) &&
    r.days >= 1 &&
    r.days <= 30 &&
    (r.startDate === undefined || typeof r.startDate === "string") &&
    (r.summary === undefined || typeof r.summary === "string") &&
    typeof r.addedAt === "number"
  );
}

/** 读取想去清单（坏数据静默降级为空，不影响使用） */
export function loadWishlist(): WishlistTrip[] {
  if (!hasStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWishlistTrip).sort((a, b) => b.addedAt - a.addedAt);
  } catch {
    return [];
  }
}

function writeWishlist(list: WishlistTrip[]): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    /* 隐私模式/写满：愿望只在本机丢，不影响行程本身 */
  }
}

/** 是否已加入想去 */
export function isWished(shareId: string): boolean {
  return loadWishlist().some((t) => t.shareId === shareId);
}

/** 加入想去（幂等：已在清单里则保持原样，不刷新 addedAt） */
export function addWish(
  trip: Omit<WishlistTrip, "addedAt">,
  at: number = Date.now(),
): WishlistTrip[] {
  const list = loadWishlist();
  if (list.some((t) => t.shareId === trip.shareId)) return list;
  const next = [{ ...trip, addedAt: at }, ...list].slice(0, MAX_ENTRIES);
  writeWishlist(next);
  return next;
}

/** 从想去清单移除；返回更新后的列表 */
export function removeWish(shareId: string): WishlistTrip[] {
  const next = loadWishlist().filter((t) => t.shareId !== shareId);
  writeWishlist(next);
  return next;
}

/** 切换想去状态；返回 { list, wished } */
export function toggleWish(
  trip: Omit<WishlistTrip, "addedAt">,
  at: number = Date.now(),
): { list: WishlistTrip[]; wished: boolean } {
  if (isWished(trip.shareId)) {
    return { list: removeWish(trip.shareId), wished: false };
  }
  return { list: addWish(trip, at), wished: true };
}
