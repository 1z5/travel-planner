# 变更日志

记录这个项目从 0 到「可上线就绪」的关键工程决策。倒序（新→旧），每条都是实测踩坑后的结论。

## 2026-10 可上线就绪状态

**部署与运维**
- `npm start` 与 `output: standalone` 不兼容，必须 `node .next/standalone/server.js`；standalone 不读 `.env`，环境变量必须显式注入
- 新增 `npm run preflight`：部署日 GO/NO-GO 自检（Node 版本/密钥/密钥默认值/高德模式/配额/.gitignore/构建产物）
- `/api/health` 探针 + 成本模型文档（配额即成本闸门）

**正确性修复**
- **LLM 改流式**：非流式撞 undici `headersTimeout`（默认 300s，比 SDK 420s 先炸），推理模型 3-5 分钟生成间歇被杀。流式后消失，顺带获得真实 usage
- **双轨配额 remaining 实时计算**：原快照在失败路径不刷新（用户看到错误剩余数）
- **SDK 超时要配 `maxRetries: 0`**：实测 timeout 按「尝试次数 × timeout」才抛（30s 超时 91s 才报）
- **预算 prompt 用锚点不用计算题**：百分比分配规则让 reasoning 从 ~1.3 万涨到 4 万+字符，生成 250s→600s+ 超时；改「晚均价按预算档位取 250-500」后恢复
- **dev 模块多实例**：jobs Map / 配额 Map / 窗口 Map 三度因模块级状态在请求间丢失，全部改挂 globalThis（跨 HMR、跨路由编译实例共享）

**范围决策**
- 天数收紧为 3-4 天：实测 5 天单次生成必爆 token（跑满 16 分钟仍超时）
- 「大纲+分日并行」提速尝试证伪（320s > 单次 253s），单次调用 + 异步任务模式胜出

## 功能建设

**M3 登录体系**：provider 抽象（none/sms/wechat）；自签 HMAC session cookie（7 天，零依赖）；双轨配额（IP 3 次/天、用户 10 次/天，IP 限流不影响登录用户）；短信防轰炸（单号 5/h、单 IP 20/h）；微信 OAuth2 全流程（state cookie 防 CSRF、防开放重定向、code→openid→session）。

**M1-M2 核心**：step-5 zod 约束生成结构化行程；高德按官方文档集成（`/v3/place/text` 验真 + `/v5/direction/driving` 通勤——**距离接口只收坐标，地名必须先解析**，且 v3/distance 已不在文档内）；体检治理（绕路/节奏/预算/未验真）；异步任务（202+轮询+秒表+失败退还）。

**框架坑记录**：Next 重定向是 307 不是 302；手动 `headers.set("Set-Cookie")` 与 `cookies.set()` 混用会丢 cookie；route 文件导出非 HTTP 方法/配置会构建失败（type error 藏在 build 阶段，管道 tail 会吞退出码，必须 `set -o pipefail`）。

## 测试体系

66 条自包含断言（`npm test`）：输入边界 14（含 prompt 注入用例）+ 故障注入 5 + 高德集成 9（官方 API 形状）+ 登录 36（含微信 OAuth 15）。三套桩服务（LLM/高德/微信）让故障与集成测试秒级完成。真实生成 6 case 回归（西安/苏州/成都/杭州/厦门，prod standalone 亦验证）。
