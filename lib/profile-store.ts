// 旅行档案的本地存储：把用户填过的档案记在浏览器里，每次生成行程时带上。
//
// 为什么存在：未登录用户没有账号可同步（「陌生人可用」是产品前提——
// 不能为了记忆强制注册），localStorage 正好是「这台设备上的我」这个
// 语义。登录后的跨设备同步留给服务端（本模块只做客户端，接口保持干净，
// 未来换服务端 store 时调用方无感——先不做服务端同步，避免为这一个
// 字段动 lib/store 四件套 + Prisma schema，那是 v3 级别的工程）。
//
// 边界约定（照 lib/recent-trips.ts 的踩坑范式，逐条兜住）：
// 1. SSR 下没有 window：所有函数在服务端返回空/静默，调用方在 useEffect 里用
// 2. localStorage 可能被禁用/写满/quota 异常：读写全程 try-catch，失败即降级
// 3. 历史数据可能是旧结构/脏数据：过 validateProfile 归一化，不像对象的
//    整档当「没填过」（返回 null），而不是把脏数据当档案用
// 4. 档案只有一份，没有列表上限问题

import { validateProfile, type TravelProfile } from "./profile";

const STORAGE_KEY = "tp.travel-profile.v1";

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/**
 * 读取档案。null = 没填过（或存坏了）——**不是**返回默认值。
 *
 * 为什么坏数据返回 null 而不是 DEFAULT_PROFILE：把脏数据「修」成默认档
 * 等于悄悄替用户做了选择，用户下次打开会看到一份他没填过的档案。
 * 返回 null 让引导重新出现，用户重新填——多一步，但不骗人。
 */
export function loadProfile(): TravelProfile | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return validateProfile(parsed);
  } catch {
    // 隐私模式/解析失败：当作没填过，UI 走冷启动引导
    return null;
  }
}

/**
 * 写入档案（先校验再存）。
 *
 * 存的是校验后的归一化结果而不是原始对象：写入时收敛一次，读取时
 * （loadProfile）再兜一次，两层校验保证「存进去的」和「读出来的」
 * 永远是干净的——脏数据只可能在中间环节存在。
 */
export function saveProfile(profile: TravelProfile): TravelProfile | null {
  const clean = validateProfile(profile);
  if (!clean) return null;
  if (!hasWindow()) return clean;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // 隐私模式/配额满：写不进去就是没记住——返回 null 让 UI 如实说
    // 「这次没能记住」，而不是假装保存成功（不猜不假装）
    return null;
  }
  return clean;
}

/** 清空档案（用户在抽屉里显式删除；同时让冷启动引导重新出现） */
export function clearProfile(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 删不掉也降级：下次读取还是旧档案的可能性由调用方展示决定，
    // 这里不抛错（删档案不是关键路径，写失败多见于极端环境）
  }
}
