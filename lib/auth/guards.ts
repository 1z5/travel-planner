import "server-only";

// ============================================================
// 生产配置守卫（纯函数，只读传入的 env，不碰 process.env）
//
// 为什么需要：身份体系此前是 fail-open —— AUTH_PROVIDER 缺省 none 时
// DevProvider 用固定验证码 123456 放行任意手机号；SESSION_SECRET 缺省公开
// 常量，任何人都能伪造 session。照默认配置上线 = 任意手机号可登录。
//
// 这里把「什么算生产误配」收敛成一组纯函数：
// - providers.ts / session.ts 在运行时用它 fail-closed；
// - 单测直接注入 env 对象即可覆盖三种环境，不必改全局 process.env.NODE_ENV
//   （vitest 同进程共享 env，改完不还原会污染其他用例）。
//
// 约定：npm run preflight / check:env 在部署期做同样的判定（mjs 侧独立实现，
// 不做 TS import）；两边规则必须保持一致，改这里记得同步脚本。
// ============================================================

export type AuthProviderId = "none" | "sms" | "wechat";

/** 允许注入的 env 形状：单测传对象，运行时代码传 process.env */
export type GuardEnv = Record<string, string | undefined>;

/** session 的公开开发默认值（写在源码与文档里 = 等于没签名），生产必须换掉 */
export const DEV_SESSION_SECRET = "dev-only-insecure-secret";

const PROVIDER_IDS: readonly AuthProviderId[] = ["none", "sms", "wechat"];

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** 是否为生产环境（只有严格等于 production 才算，e2e 的 next dev 不受影响） */
export function isProductionEnv(env: GuardEnv = process.env): boolean {
  return trimmed(env.NODE_ENV) === "production";
}

/**
 * AUTH_PROVIDER 归一化：缺省/拼错一律回落到 none。
 * 回落本身是 fail-open 的老行为，所以生产环境必须再交给
 * isProductionAuthMisconfigured 拦截，不能只看这个函数的返回值。
 */
export function resolveAuthProviderId(env: GuardEnv = process.env): AuthProviderId {
  const raw = trimmed(env.AUTH_PROVIDER) as AuthProviderId;
  return PROVIDER_IDS.includes(raw) ? raw : "none";
}

/**
 * 显式允许生产使用 dev provider 的逃生开关（预发/内部演示，明确知情才设）。
 * 不设它时，生产 AUTH_PROVIDER=none 一律视为误配。
 */
export function isDevAuthExplicitlyAllowed(env: GuardEnv = process.env): boolean {
  return trimmed(env.ALLOW_DEV_AUTH) === "1";
}

/** SESSION_SECRET 是否可用：存在且不是源码里的公开默认值 */
export function hasUsableSessionSecret(env: GuardEnv = process.env): boolean {
  const secret = trimmed(env.SESSION_SECRET);
  return secret !== "" && secret !== DEV_SESSION_SECRET;
}

/**
 * 生产身份体系是否误配（providers 层的 fail-closed 判定入口）：
 * - AUTH_PROVIDER=none 且未用 ALLOW_DEV_AUTH=1 显式知情；
 * - SESSION_SECRET 缺失或仍是开发默认值。
 *
 * 非 production 恒为 false：e2e phase C/D/E 用 next dev（NODE_ENV=development）
 * 跑 dev/微信/短信三条登录链路，必须保持原行为。
 */
export function isProductionAuthMisconfigured(env: GuardEnv = process.env): boolean {
  if (!isProductionEnv(env)) return false;
  const devAuthNotAllowed =
    resolveAuthProviderId(env) === "none" && !isDevAuthExplicitlyAllowed(env);
  return devAuthNotAllowed || !hasUsableSessionSecret(env);
}

/**
 * session 层专用：生产且 secret 不可用 → 不签发也不接受 session。
 * 单独一个函数是为了让 session.ts 的失败面最小：只要 secret 弱就拒绝，
 * 与 provider 是否启用无关（sms/wechat 也需要可靠的签名密钥）。
 */
export function isProductionSessionMisconfigured(env: GuardEnv = process.env): boolean {
  return isProductionEnv(env) && !hasUsableSessionSecret(env);
}
