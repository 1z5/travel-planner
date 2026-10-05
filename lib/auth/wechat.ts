import "server-only";

// ============================================================
// 微信网页 OAuth2 登录（snsapi_base：静默拿 openid，不弹授权页）
// 流程：/api/auth/wechat/login → 跳转微信 → 回调 /api/auth/wechat/callback
//       → 服务端用 code 换 openid → 签发与手机号登录同款的 session
// 用户标识为 wx:<openid>，配额双轨按 u:wx:<openid> 计数。
// ============================================================

const AUTH_BASE = process.env.WECHAT_AUTH_BASE || "https://open.weixin.qq.com";

export function wechatLoginUrl(callbackUrl: string, state: string): string {
  const params = new URLSearchParams({
    appid: process.env.WECHAT_APPID ?? "",
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "snsapi_base",
    state,
  });
  return `${AUTH_BASE}/connect/oauth2/authorize?${params.toString()}#wechat_redirect`;
}

export async function wechatExchange(code: string): Promise<string> {
  if (!process.env.WECHAT_APPID || !process.env.WECHAT_SECRET) {
    throw new Error("微信登录未配置（WECHAT_APPID / WECHAT_SECRET）");
  }
  const apiBase = process.env.WECHAT_API_BASE || "https://api.weixin.qq.com";
  const url = new URL(`${apiBase}/sns/oauth2/access_token`);
  url.searchParams.set("appid", process.env.WECHAT_APPID);
  url.searchParams.set("secret", process.env.WECHAT_SECRET);
  url.searchParams.set("code", code);
  url.searchParams.set("grant_type", "authorization_code");

  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.errcode || !data.openid) {
    throw new Error(`微信授权失败（${data.errmsg ?? data.errcode ?? "unknown"}）`);
  }
  return data.openid as string;
}
