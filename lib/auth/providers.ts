import "server-only";
import type { AuthProvider } from "./types";
import { checkCode, randomCode, sendSmsCode, storeCode } from "./sms";

// ============================================================
// Provider 实现：
// - none：开发/测试用，固定验证码 123456，不发真实短信
// - sms：腾讯云短信（TC3 直签，无需 SDK），验证码服务端存储校验
// - wechat：OAuth 跳转型，不走验证码，走网页授权入口
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
    storeCode(phone, code); // 发送成功才落库，供 verify 比对
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

export function getAuthProvider(): AuthProvider {
  const id = process.env.AUTH_PROVIDER || "none";
  if (id === "sms") return new SmsProvider();
  if (id === "wechat") return new WeChatProvider();
  return new DevProvider();
}
