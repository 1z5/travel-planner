import "server-only";
import type { AuthProvider } from "./types";
import { checkCode, randomCode, sendSmsCode, storeCode } from "./sms";
import { isProductionAuthMisconfigured, resolveAuthProviderId, type GuardEnv } from "./guards";

// ============================================================
// Provider 实现：
// - none：开发/测试用，固定验证码 123456，不发真实短信
// - sms：腾讯云短信（TC3 直签，无需 SDK），验证码服务端存储校验
// - wechat：OAuth 跳转型，不走验证码，走网页授权入口
// - disabled：生产配置误配时的兜底（见 getAuthProvider）
// ============================================================

const DEV_CODE = "123456";

class DevProvider implements AuthProvider {
  readonly id = "none" as const;
  async sendCode(phone: string) {
    console.log(`[auth/dev] 验证码发送（模拟）: ${phone} -> ${DEV_CODE}`);
    return { ok: true };
  }
  async verifyCode(_phone: string, code: string) {
    return code === DEV_CODE;
  }
}

class SmsProvider implements AuthProvider {
  readonly id = "sms" as const;

  async sendCode(phone: string) {
    // 限流已在 /api/auth/code 处理（单号 5/h、单 IP 20/h），这里只管发送
    const code = randomCode();
    const result = await sendSmsCode(phone, code);
    if (!result.ok) return result;
    await storeCode(phone, code); // 发送成功才落库，供 verify 比对
    return { ok: true };
  }

  async verifyCode(phone: string, code: string) {
    return checkCode(phone, code);
  }
}

class WeChatProvider implements AuthProvider {
  readonly id = "wechat" as const;

  async sendCode(phone: string) {
    void phone;
    return { ok: false, error: "微信登录是 OAuth 跳转流程，不走验证码，请走网页授权入口" };
  }

  async verifyCode(phone: string, code: string) {
    void phone;
    void code;
    return false;
  }
}

/**
 * 生产误配兜底：登录整体关闭。
 *
 * 为什么不能回落 DevProvider：DevProvider 接受固定码 123456，等于把
 * 「任意手机号可登录」直接暴露给公网。误配时的正确行为是**关掉登录入口**
 * 而不是退回一个更宽松的实现——宁可用户暂时不能登录，也不能冒充他人。
 * id 沿用 "none"：AuthProvider 契约（types.ts）只有三个合法值，禁用态
 * 不需要扩散成新的对外类型。
 */
class DisabledProvider implements AuthProvider {
  readonly id = "none" as const;
  async sendCode(_phone: string) {
    return { ok: false, error: "登录未启用" };
  }
  async verifyCode(_phone: string, _code: string) {
    return false;
  }
}

/**
 * 取当前生效的 provider。
 *
 * @param env 默认 process.env；单测传对象即可模拟三种环境，无需改全局 env。
 */
export function getAuthProvider(env: GuardEnv = process.env): AuthProvider {
  // 生产 fail-closed：AUTH_PROVIDER=none / SESSION_SECRET 仍是默认值 → 关闭登录。
  // 开发/测试（NODE_ENV!=production）行为不变：e2e phase C/D/E 用 next dev 跑，
  // 依赖 none→DevProvider 的固定码流程与 sms/wechat 的真实桩链路。
  if (isProductionAuthMisconfigured(env)) return new DisabledProvider();

  const id = resolveAuthProviderId(env);
  if (id === "sms") return new SmsProvider();
  if (id === "wechat") return new WeChatProvider();
  return new DevProvider();
}
