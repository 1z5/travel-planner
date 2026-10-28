# Trip Check MCP

把 Trip Check 的行程体检与确定性修复能力接到任意 MCP 客户端（Claude Desktop / Cursor / 自写 agent）。

- 服务端：`POST /api/mcp`（Next.js Route Handler，JSON-RPC 2.0、**无状态单消息**）
- 本地桥：`mcp/stdio.mjs`（零依赖 Node 脚本，把 stdin 的换行分隔 JSON-RPC 转发到上面的 HTTP 端点）
- 协议实现范围：**只有 `tools` 能力**（见文末「诚实边界」）

## 快速开始

```bash
# 终端 1：起服务（默认 http://127.0.0.1:3000）
npm run dev

# 终端 2：手动冒烟（每行一条 JSON-RPC，响应也是一行一条）
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_rules"}}' \
  | node mcp/stdio.mjs
```

环境变量：

| 变量                    | 默认                    | 说明                                                     |
| ----------------------- | ----------------------- | -------------------------------------------------------- |
| `TRIP_CHECK_URL`        | `http://127.0.0.1:3000` | 服务基址；也可直接给完整 `.../api/mcp`                   |
| `TRIP_CHECK_TIMEOUT_MS` | `60000`                 | 单请求超时（首次访问时 `next dev` 要按需编译，给足余量） |

## 接到 MCP 客户端

以 Claude Desktop / Cursor 这类「stdio 起子进程」的客户端为例（路径换成本机绝对路径）：

```json
{
  "mcpServers": {
    "trip-check": {
      "command": "node",
      "args": ["<你的仓库路径>/mcp/stdio.mjs"],
      "env": { "TRIP_CHECK_URL": "http://127.0.0.1:3000" }
    }
  }
}
```

HTTP 客户端（支持 Streamable HTTP 的 agent）可以直接 `POST /api/mcp`，无需桥：

```bash
curl -s http://127.0.0.1:3000/api/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 工具

| 工具                    | 入参                     | 返回                                                                                                        |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `verify_itinerary`      | `{ document, options? }` | Trip Check 报告（两轴结论 + 规则级问题 + `credential`）                                                     |
| `repair_itinerary`      | `{ document, options? }` | 修复后文档 + `applied` / `unrepairable` / `before` / `after` / `delta` / `changed` + 前后两张凭据（见下节） |
| `verify_shared_trip`    | `{ shareId }`            | 同上（输入是本平台已分享行程；`shareId` 来自 `/p/<id>`）                                                    |
| `get_trip_check_schema` | `{}`                     | 文档 JSON Schema（draft 2020-12）+ 版本/限额                                                                |
| `list_rules`            | `{}`                     | 规则集全部规则元信息 + `rulesetVersion`                                                                     |
| `explain_rule`          | `{ ruleId }`             | 单条规则元信息（含 `fixHint`）                                                                              |

`options.pace` = `relaxed | balanced | packed`（默认 `balanced`），决定日净游玩时长上限。
**口径不同结论可以不同**，也会写进凭据输入哈希——对账时必须和分享方用同一口径。

### repair_itinerary：只做机械修复

```bash
curl -s http://127.0.0.1:3000/api/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"repair_itinerary","arguments":{"document":{ /* 开放文档 */ }}}}'
```

返回的 JSON 是 `RepairResult` 加上三个对账字段：

```jsonc
{
  "document": {/* 修复后的新文档（可继续交给 verify_itinerary） */},
  "applied": [
    {
      "ruleId": "TC-C102",
      "day": 1,
      "spot": "平江路",
      "detail": "…时间 10:30-12:00 → 11:00-12:30…",
    },
  ],
  "unrepairable": [
    { "ruleId": "TC-C104", "day": 1, "reason": "缺少真实路段耗时，修复器不能编造通勤时间。" },
  ],
  "before": {/* TripCheckReport */},
  "after": {/* TripCheckReport（同一套引擎、同一个 now 重算） */},
  "delta": {
    "score": 45,
    "gradeFrom": "D",
    "gradeTo": "A",
    "blockingReduced": 1,
    "improved": true,
  },
  "changed": true,
  "parentCredential": { "id": "tc_…" }, // 修复前文档的凭据
  "credential": { "id": "tc_…" }, // 修复后文档的凭据
}
```

- **只做两种机械变换**：顺延时间轴（消除 `TC-C102` 重叠 / `TC-C103` 接不上）、删除同一天重复的同名点位（`TC-C109`）。
  不改日期、不加地点、不改营业时间、不补路段耗时、不按 0 补齐——**不编造事实**；24:00 边界整日回滚，不做半截修复。
- **修不了的必须说**：缺数据 / 预算 / 节奏 / 分散 / 事实问题逐条进 `unrepairable`，不静默改语义。
  `changed=false` + `applied=[]` 表示「本来就没得修」，不是失败。
- **不写回任何存储**：修复在内存里完成，返回新文档且不修改入参；要把修复结果保存下来由调用方自己决定。
- **凭据自洽**：`parentCredential` = 修复前文档的凭据（与直接 `verify_itinerary` 原文档的 ID 一致）；
  `credential` = 修复后文档的凭据（把返回的 `document` 再交给 `verify_itinerary`，应得到同一个 ID）。

工具的返回结构遵循 MCP 约定：

```json
{ "content": [{ "type": "text", "text": "<JSON 字符串：报告/规则/错误说明>" }] }
```

业务失败（分享行程不存在、未知规则 id）用 `isError: true` 的 tool result 表达，不是 JSON-RPC error：

```json
{
  "content": [{ "type": "text", "text": "{\"error\":\"未找到行程（HTTP 404）…\",\"status\":404}" }],
  "isError": true
}
```

## 传输与错误码

| 情况                                                     | HTTP | body                                               |
| -------------------------------------------------------- | ---- | -------------------------------------------------- |
| 正常请求                                                 | 200  | JSON-RPC result                                    |
| 通知（消息无 `id`）                                      | 202  | 空                                                 |
| 非法 JSON                                                | 400  | JSON-RPC error `-32700`                            |
| 非法请求（非对象/批量/缺 `method`/`jsonrpc` 不是 `2.0`） | 400  | JSON-RPC error `-32600`                            |
| 未知方法                                                 | 200  | JSON-RPC error `-32601`                            |
| 入参不合法（未知工具、缺/错参数、document 不合 schema）  | 200  | JSON-RPC error `-32602`（带 `data.errors[].path`） |
| 服务内部故障（如读存储失败）                             | 200  | JSON-RPC error `-32603`                            |
| body > 256 KiB                                           | 413  | JSON-RPC error（传输层拒绝）                       |
| `GET /api/mcp`                                           | 405  | 说明不提供 SSE/GET（只实现 POST）                  |

stdio 桥在连不上服务 / 响应不是 JSON 时输出 `-32001`（服务自定义区间）：
`{"jsonrpc":"2.0","id":<原请求 id 或 null>,"error":{"code":-32001,"message":"…"}}`。

## 协议版本与能力：诚实边界

- **协议版本**：`initialize` 时客户端给了字符串 `params.protocolVersion` 就**回显**，否则回
  `2025-06-18`。已知版本的 `tools` 语义一致；未做严格版本协商——未来版本若改变工具语义，
  需要先升级本服务再声称支持。
- **能力**：只声明 `capabilities.tools`。**没有** resources / prompts / sampling / logging /
  completion；`initialize` 的 `instructions` 里也这么写。
- **无状态**：不做 session（`Mcp-Session-Id`）、不提供 GET/SSE 服务端推送；stdio 桥串行转发，
  同一时刻最多 1 个在途请求。
- **公开、无鉴权、按 IP 限流**：端点面向公开演示与本地开发，已按 `MCP_HOURLY_LIMIT`（默认
  120 次/小时/IP）限流；`verify_shared_trip` 只能读到不可猜测的分享 token。生产环境仍建议在
  前面加网关/鉴权（例如企业客户只允许内网调用），并注意 `verify_shared_trip` 的分享 token
  本身就是能力凭据。
- **只读、不写库**：所有工具都不写任何存储、不改站内行程；`repair_itinerary` 在内存里生成新文档并返回
  （入参不变、不落库），是否采用由调用方决定。`credential.id` 是可复算哈希，不是数字签名。

## 相关文档

- 开放标准与报告字段：`docs/TRIP-CHECK-STANDARD.md`
- HTTP API：`POST /api/verify`、`POST /api/verify/repair`（`docs/API.md` 的 Trip Check 章节）、`GET /api/verify/schema`
- 引擎实现（纯函数，可直接复算）：`lib/verify/`（判定 `engine.ts`、修复 `repair.ts`）；协议层：`lib/verify/mcp.ts`
