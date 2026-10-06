import "server-only";
import crypto from "node:crypto";

// ============================================================
// 腾讯云短信（TC3-HMAC-SHA256 签名，直接签名调 API，不引 SDK ~50MB 依赖）
// 端点/区域可配（SMS_API_BASE / SMS_REGION），测试时可指向本地桩。
// ============================================================

const HOST = "sms.tencentcloudapi.com";
const SERVICE = "sms";
const ACTION = "SendSms";
const VERSION = "2021-01-11";

function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function hmac256(key: string | Buffer, msg: string): Buffer {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest();
}

/** TC3 签名：返回请求头（Authorization / X-TC-*） */
export function tc3Headers(secretId: string, secretKey: string, payload: object): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const hashedPayload = sha256hex(JSON.stringify(payload));

  const httpRequest = [
    "POST", "/", "",
    `content-type:application/json; charset=utf-8`,
    `host:${HOST}`, "",
    "content-type;host",
    hashedPayload,
  ].join("\n");

  const stringToSign = [
    "TC3-HMAC-SHA256", timestamp, credentialScope, sha256hex(httpRequest),
  ].join("\n");

  const secretDate = hmac256(`TC3${secretKey}`, date);
  const secretService = hmac256(secretDate, SERVICE);
  const secretSigning = hmac256(secretService, "tc3_request");
  const signature = hmac256(secretSigning, stringToSign).toString("hex");

  return {
    "Content-Type": "application/json; charset=utf-8",
    Authorization:
      `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
      `SignedHeaders=content-type;host, Signature=${signature}`,
    Host: HOST,
    "X-TC-Action": ACTION,
    "X-TC-Version": VERSION,
    "X-TC-Timestamp": String(timestamp),
    "X-TC-Region": process.env.SMS_REGION || "ap-guangzhou",
  };
}

/** 发送验证码短信。返回是否成功；失败时带腾讯云错误信息。 */
export async function sendSmsCode(phone: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const secretId = process.env.SMS_SECRET_ID;
  const secretKey = process.env.SMS_SECRET_KEY;
  const sdkAppId = process.env.SMS_APP_ID;
  const sign = process.env.SMS_SIGN;
  const templateId = process.env.SMS_TEMPLATE_ID;
  if (!secretId || !secretKey || !sdkAppId || !sign || !templateId) {
    return { ok: false, error: "短信未配置（SMS_SECRET_ID / SMS_SECRET_KEY / SMS_APP_ID / SMS_SIGN / SMS_TEMPLATE_ID）" };
  }

  const payload = {
    SmsSdkAppId: sdkAppId,
    SignName: sign,
    TemplateId: templateId,
    TemplateParamSet: [code],
    PhoneNumberSet: [`+86${phone}`],
  };
  const base = process.env.SMS_API_BASE || `https://${HOST}`;
  try {
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: tc3Headers(secretId, secretKey, payload),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    const err = data?.Response?.Error;
    if (err) {
      return { ok: false, error: `短信发送失败: ${err.Message ?? err.Code}（${err.Code ?? ""}）` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `短信接口异常: ${(e as Error).message}` };
  }
}

// ---- 服务端验证码存储（5 分钟有效，发送后才存在；一次性消费）----
// 挂 globalThis：dev 下各路由模块实例可能编译成多份（同 jobs/quota 的教训）
const CODE_TTL_MS = 5 * 60 * 1000;

const g = globalThis as typeof globalThis & {
  __travelSmsCodes?: Map<string, { code: string; expiresAt: number }>;
};
const codes: Map<string, { code: string; expiresAt: number }> = (g.__travelSmsCodes ??= new Map());

export function storeCode(phone: string, code: string): void {
  codes.set(phone, { code, expiresAt: Date.now() + CODE_TTL_MS });
}

export function checkCode(phone: string, code: string): boolean {
  const entry = codes.get(phone);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    codes.delete(phone);
    return false;
  }
  const ok = entry.code === code;
  if (ok) codes.delete(phone); // 一次性
  return ok;
}

export function randomCode(): string {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}
