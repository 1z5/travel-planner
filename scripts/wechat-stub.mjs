#!/usr/bin/env node
/**
 * 桩微信服务（测试专用）：模拟微信 OAuth2 两端行为。
 *
 *   GET /connect/oauth2/authorize → 302 回我们自己的 callback，
 *       带上 code=stub_wx_code 和原样带回的 state（模拟用户在微信里点同意）
 *   GET /sns/oauth2/access_token?code=... → {openid: "stub_openid_001"}
 *
 * 用法：node scripts/wechat-stub.mjs [port]   （默认 8900）
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || process.env.WECHAT_STUB_PORT || 8900);

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/connect/oauth2/authorize") {
    // 模拟「用户同意」：带着 code 和 state 跳回业务方 callback
    const state = url.searchParams.get("state") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const target = new URL(redirectUri);
    target.searchParams.set("code", "stub_wx_code");
    target.searchParams.set("state", state);
    console.log(`[wechat-stub] authorize → ${target.toString().slice(0, 80)}...`);
    res.writeHead(302, { Location: target.toString() });
    res.end();
    return;
  }

  if (url.pathname === "/sns/oauth2/access_token") {
    const code = url.searchParams.get("code");
    if (code !== "stub_wx_code") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errcode: 40029, errmsg: "invalid code" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      access_token: "stub_token",
      expires_in: 7200,
      refresh_token: "stub_refresh",
      openid: "stub_openid_001",
      scope: "snsapi_base",
    }));
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[wechat-stub] listening on http://127.0.0.1:${PORT}`);
});
