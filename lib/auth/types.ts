import "server-only";

// ============================================================
// 认证层：面向陌生人的账号体系地基。
//
// 设计要点：
// - Provider 抽象（lib/auth/providers.ts），环境变量 AUTH_PROVIDER 切换：
//   none（默认，本地开发）→ sms（短信，骨架待填厂商 SDK）→ wechat（骨架）
// - Session 用自签 HMAC cookie（无数据库、无额外依赖），7 天有效
// - 登录是「可选增强」不是门槛：未登录按 IP 计数（3 次/天），
//   登录后按用户计数（10 次/天）——陌生人可先用后注册
// ============================================================

export interface SessionPayload {
  p: string; // phone
  i: number; // issuedAt (ms)
  e: number; // expiresAt (ms)
}

export interface SendCodeResult {
  ok: boolean;
  error?: string;
}

export interface AuthProvider {
  readonly id: "none" | "sms" | "wechat";
  /** 发送验证码（dev provider 固定返回 123456） */
  sendCode(phone: string): Promise<SendCodeResult>;
  /** 校验验证码 */
  verifyCode(phone: string, code: string): Promise<boolean>;
}
