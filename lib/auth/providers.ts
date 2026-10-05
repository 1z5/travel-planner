import "server-only";
import type { AuthProvider } from "./types";

// ============================================================
// Provider 实现：
// - none：开发/测试用，固定验证码 123456，不发真实短信
// - sms：骨架，待接入阿里云/腾讯云短信（见 DEPLOY.md 的配置说明）
// - wechat：骨架，微信网页 OAuth2 需 appid/secret + 回调域名
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
    // TODO(M3): 接入短信服务商。以腾讯云为例：
    //   const client = new tencentcloud.sms.v20210111.Client({...});
    //   await client.SendSms({ PhoneNumberSet: [`+86${phone}`],
    //     TemplateId: process.env.SMS_TEMPLATE_ID, SignName: process.env.SMS_SIGN,
    //     TemplateParamSet: [code], SmsSdkAppId: process.env.SMS_APP_ID });
    // 未配置环境变量时抛错，避免静默失败
    if (!process.env.SMS_APP_ID || !process.env.SMS_TEMPLATE_ID || !process.env.SMS_SIGN) {
      return { ok: false, error: "短信服务未配置（SMS_APP_ID / SMS_TEMPLATE_ID / SMS_SIGN）" };
    }
    void phone;
    return { ok: false, error: "短信 provider 骨架待接入" };
  }

  async verifyCode(phone: string, code: string) {
    // TODO(M3): 真机验证应改为「服务端下发 + 服务端校验」，
    // 即发送时把 code 存 Redis（phone -> code, 5 分钟过期），此处比对后删除
    void phone;
    void code;
    return false;
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
