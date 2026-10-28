# ADR-016: 安全加固基线——能力凭据、请求边界与「可信证据不可伪造」

## 状态

已接受（2026-10-28，安全审计后首轮加固）

## 背景

[安全审计 2026-10-28](../SECURITY-AUDIT-2026-10-28.md) 对「公开匿名产品 + 分享 token 即能力」
的底座做了一轮只读审计：**无 Critical**，但给出 2 个 High（12 个端点裸读 body、MCP 线上无限流）
和 4 个 Medium（jobId 弱随机 + 旧链接读回、DEMO_SEED 公开 token 可被改写、restore 信任客户端
富字段导致「已核验/已修复」徽章可伪造、海报/OG 零限流 CPU 放大）。其中「可信证据可伪造」
直接击穿产品定位，必须处理。

## 决策

1. **统一请求边界**：所有 JSON 端点走 `lib/http-body.ts` 的 `readJsonBody`（普通 16–64 KiB，
   开放核验/MCP 保持 256 KiB）。超限 413、畸形 400；不再有裸 `req.json()`。
2. **jobId 改成密码学随机**：`job_` + `crypto.randomBytes(16)`（128 bit）。旧 job 链接的
   「读兜底」保留（2h TTL、兼容历史链接），但 id 本身不可枚举；`/api/plan/status` 与
   `/api/plan/ics` 加按 IP 限流，ics 响应 `Cache-Control: private, no-store`。
3. **演示行程只读**：`DEMO_SEED` 注入的 Plan 打 `demo: true`；refine / restore / repair /
   adjust 对 demo 行程一律 403（克隆允许——它产出新 Plan）。演示 token 写在 DEMO.md 是公开的，
   不能再有写权限。
4. **可信字段不接受客户端回传**：`/api/plan/restore` 落库前剥离 `tripCheck` / `verified` /
   `verification` / `verifiedAt` / `grounding` / `verificationReport`，`warnings` 用
   `refreshTimeWarnings` 服务端重算，整份行程标记为未核验。代价是「撤销修改」后核验徽章会
   消失（诚实：服务端没有重新核过，就不能沿用旧徽章）。
   **残余风险（明确接受）**：持有分享 token 的人仍可编辑点位内容（spot 名称/时间），
   这是「token 即能力」模型的固有面；本次堵的是「伪造我们的核验结论」，不是「伪造行程内容」。
5. **浏览器写保护**：`lib/http-origin.ts` 的 `crossSiteWriteError` 应用到状态变更端点
   （无 Origin 的 curl/agent 放行；有 Origin 必须同源；`Sec-Fetch-Site: cross-site` 拒绝）。
   这是纵深防御，不是唯一防线（写操作仍靠 URL/body 里的 token 授权）。
6. **CPU 放大面收口**：海报（1080×1920 Satori）与 OG 图按 IP 小时桶限流，海报响应允许
   CDN 缓存 1 小时；MCP 端点加 120/h 限流（并把 README 里「不要挂公网」改成「公开 + 限流」的
   事实口径）。
7. **私有工件不落长期缓存/索引**：`/p /t /w /r` 响应加 `X-Robots-Tag: noindex, noarchive`；
   Service Worker 只缓存 `/t` 导航（`/p` 的 URL 是能力凭据，SW 会忽略 `no-store` 把它永久
   留在设备上）；私页缓存口径维持 `private, no-store`。
8. **安全头补齐**：`Strict-Transport-Security`（仅 HTTPS 环境）、`Cross-Origin-Opener-Policy`、
   `Cross-Origin-Resource-Policy`、关闭 `X-Powered-By`。
9. **部署验收增加安全探针**：安全响应头存在、超大 body → 413、演示行程写 → 403、
   MCP 限流配置可读；这些与功能冒烟一起跑，避免「加固只活在代码里」。

## 后果

- 公开站被大 body 打爆内存/被脚本刷海报的风险被收敛；「核验徽章」不再能被一次 restore 伪造。
- 撤销修改后行程会显示「未核验」——这是可接受的诚实代价；后续若需要，可改成服务端保存历史
  版本（当前不做：需要存储迁移，收益 < 成本）。
- 演示站仍用 `memory + DEMO_SEED`（重启丢数据），这是演示取舍；真实上线前的 `DATA_STORE=postgres`
  与 `check:env` BLOCK 仍是硬前置（见 R7，本轮不改变）。
- 剩余已接受风险：分享 token 即能力、开放核验/MCP 无鉴权、凭据非签名、CSP `unsafe-inline`、
  `fast-uri` 上游 moderate（无 fix）、XFF 两跳取信未实测。完整清单见审计 §4/§5。

## 替代方案（为什么没选）

| 方案                                            | 否决理由                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| 为分享链接加登录/账号                           | 产品前提是「陌生人点开就能用」；未上账号体系前会毁掉分享/共编        |
| 独立编辑凭据（owner token 与 share token 分离） | 真正解法但要动分享/编辑/克隆全链路与 UI；demo 风险可用「只读」先堵住 |
| restore 改成服务端保存历史版本                  | 需要存储迁移与版本清理；当前先剥离受信字段，够堵伪造                 |
| 把 body 上限交给反代/平台                       | Render 默认不限制应用层 body；不能依赖平台行为                       |
| 禁止 MCP 公网部署                               | 与「开放标准/MCP 分发」战略冲突；限流 + 只读工具更合理               |

## 参考

- 审计报告：[docs/SECURITY-AUDIT-2026-10-28.md](../SECURITY-AUDIT-2026-10-28.md)
- 实现：`lib/http-body.ts`、`lib/http-origin.ts`、`next.config.ts`、`public/sw.js`、
  `app/api/**`、`app/p/[id]/{poster,check/poster}`、`lib/demo-seed.ts`、`lib/plan-restore.ts`
- 相关 ADR：[ADR-014](014-trip-check-in-product.md)（分享 token 即能力）、
  [ADR-015](015-shareable-trip-check-report.md)（报告/海报工件）
