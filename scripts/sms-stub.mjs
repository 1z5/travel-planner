#!/usr/bin/env node
/**
 * 桩腾讯云短信（测试专用）：接收 TC3 签名的 SendSms 请求，
 * 记录验证码并通过 GET /_last_code 暴露给测试断言（不校验签名——
 * 签名构造由真实路径自己走，桩只验证请求格式与后续链路）。
 *
 * 用法：node scripts/sms-stub.mjs [port]   （默认 8901）
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || process.env.SMS_STUB_PORT || 8901);
const last = { code: null, phone: null, action: null };

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/_last_code") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(last));
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        last.code = p.TemplateParamSet?.[0] ?? null;
        last.phone = p.PhoneNumberSet?.[0] ?? null;
        last.action = req.headers["x-tc-action"] ?? null;
        console.log(`[sms-stub] SendSms action=${last.action} phone=${last.phone} code=${last.code}`);
      } catch {
        console.log("[sms-stub] 收到非 JSON 请求");
      }
      // 腾讯云成功响应形状
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        Response: {
          SendSmsStatusSet: [{ SerialNo: "stub:1", PhoneNumber: last.phone, Fee: 1, SessionContext: "", Code: "Ok", Message: "stub success" }],
          RequestId: "stub-req-1",
        },
      }));
    });
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sms-stub] listening on http://127.0.0.1:${PORT}`);
});
