// ============================================================
// Trip Check 的 OpenAPI 3.1 契约（机器可读的公开 API 描述）
//
// 为什么需要它（而不是只有 API.md）：
// 1) 开放层的调用方是**代码/agent**（第三方前端、MCP 客户端、SDK 生成器）；
//    人读的 Markdown 无法被工具消费，OpenAPI 可以直接生成 client、做契约测试、
//    接进 API 网关/目录。
// 2) 为什么是 3.1 而不是 3.0：3.1 的 schema 方言就是 JSON Schema 2020-12，因此
//    `TRIP_CHECK_JSON_SCHEMA`（公开文档格式的**唯一**契约）可以原样内嵌，不需要
//    再手抄一份副本——副本一定会漂移，一漂移「第三方照文档提交却被服务端拒」。
//    （`$id: urn:trip-check:document:0.1` 会把 base URI 固定到该 schema 资源，
//    所以 document 里 `#/$defs/...` 的相对引用在 OpenAPI 文档内仍然自洽。）
// 3) 为什么 info.version 用引擎版本：契约随实现（判定/修复逻辑）演进；文档格式
//    版本 specVersion 是另一条轴，写在 x-trip-check 扩展里，两者不能混。
// 4) 为什么 servers 用相对路径：部署域名不写死——同一份契约同时服务 localhost、
//    演示站、私有部署；OpenAPI 允许相对 server url（相对当前文档地址解析）。
//
// 单一事实来源：document schema 直接引用 schema.ts 的常量（同一对象），
// 其余 report/credential/repair 结构是**响应**契约（由 types.ts 的接口定义约束，
// 这里手写镜像；tests/lib/verify/openapi.test.ts 守住必填字段与版本同源）。
// ============================================================

import { TRIP_CHECK_JSON_SCHEMA } from "./schema";
import {
  TRIP_CHECK_ENGINE_NAME,
  TRIP_CHECK_ENGINE_VERSION,
  TRIP_CHECK_RULESET_VERSION,
  TRIP_CHECK_SPEC_VERSION,
} from "./types";

/** OpenAPI 文档的最小类型（只声明本文件会顶层的键，避免 any 漏出） */
export interface OpenApiDocument extends Record<string, unknown> {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Record<string, unknown>> };
  "x-trip-check": { spec: string; engine: string; ruleset: string };
}

// ---------- 小工具（减少重复，错误结构必须到处一致） ----------

/** JSON 请求体（OpenAPI 3.1 的 requestBody 形状） */
function jsonBody(schemaRef: string, description: string) {
  return {
    required: true,
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaRef}` },
      },
    },
  };
}

/** JSON 响应（可选 headers 用于缓存/版本头等跨切面约定） */
function jsonResponse(
  schemaRef: string,
  description: string,
  headers: Record<string, { description: string; schema: Record<string, unknown> }> = {},
) {
  return {
    description,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaRef}` },
      },
    },
  };
}

/** 统一错误响应（错误体永远可解析：{error, errors?, limit?, revision?}） */
function errorResponse(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
      },
    },
  };
}

/** 空响应（OPTIONS 预检 204 / MCP 通知 202） */
function emptyResponse(description: string) {
  return { description };
}

/** 缓存头（schema/openapi 这类纯常量工件允许 CDN 缓存 1 小时） */
const CACHE_HEADERS = {
  "Cache-Control": {
    description: "公共缓存 1 小时（纯常量工件，无隐私/用户态）",
    schema: { type: "string" },
  },
  "X-Trip-Check-Spec": {
    description: "实现所遵循的开放规范版本（如 trip-check/0.1）",
    schema: { type: "string" },
  },
};

const ERROR_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "统一错误体。调用方是代码/agent，因此错误永远是 JSON（不是框架 HTML 错误页），且指出能否重试/怎么修。",
  required: ["error"],
  additionalProperties: true,
  properties: {
    error: {
      type: "string",
      description:
        "错误码或可读原因。固定码：invalid_json / invalid_request / not_found / payload_too_large / rate_limited / method_not_allowed / internal_error。",
    },
    errors: {
      type: "array",
      description: "invalid_request 时的逐字段错误（path 如 days.0.spots.0.name）",
      items: {
        type: "object",
        required: ["path", "message"],
        properties: {
          path: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    limit: {
      type: "number",
      description: "payload_too_large 的字节上限 / rate_limited 的小时额度",
    },
    revision: { type: "integer", description: "409 版本冲突时的当前 Plan 版本号" },
  },
};

/** 两轴报告（镜像 lib/verify/types.ts 的 TripCheckReport；只约束对外可见的必填结构） */
const REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "Trip Check 两轴报告。结构自洽性（consistency：只靠文档可判）与事实核验（facts：取决于文档声明的来源与三态）**刻意不合并成一个分数**。",
  required: [
    "specVersion",
    "engine",
    "document",
    "verdict",
    "issues",
    "stats",
    "ruleset",
    "checkedAt",
  ],
  additionalProperties: true,
  properties: {
    specVersion: { type: "string", const: TRIP_CHECK_SPEC_VERSION },
    engine: {
      type: "object",
      required: ["name", "version", "rulesetVersion"],
      properties: {
        name: { type: "string", const: TRIP_CHECK_ENGINE_NAME },
        version: { type: "string", example: TRIP_CHECK_ENGINE_VERSION },
        rulesetVersion: { type: "string", example: TRIP_CHECK_RULESET_VERSION },
      },
    },
    document: {
      type: "object",
      description: "报告对象的摘要（不是全文，全文回显由调用方自己保存）",
      required: ["days", "spots"],
      properties: {
        id: { type: "string" },
        city: { type: "string" },
        days: { type: "integer", minimum: 0 },
        spots: { type: "integer", minimum: 0 },
        budgetCny: { type: "number" },
      },
    },
    verdict: {
      type: "object",
      required: ["consistency", "facts", "overall", "summary"],
      properties: {
        consistency: {
          type: "object",
          required: ["score", "grade", "gradeLabel", "summary"],
          properties: {
            score: { type: "integer", minimum: 0, maximum: 100 },
            grade: { type: "string", enum: ["A", "B", "C", "D"] },
            gradeLabel: { type: "string" },
            summary: { type: "string" },
          },
        },
        facts: {
          type: "object",
          required: ["state", "summary", "coverage", "sources"],
          properties: {
            state: {
              type: "string",
              enum: ["verified", "partial", "unverified", "inconclusive"],
              description:
                "verified 才代表「查过且没问题」；unverified 是「不知道」而不是「没问题」",
            },
            summary: { type: "string" },
            coverage: {
              type: "object",
              required: [
                "poiTotal",
                "poiChecked",
                "poiHit",
                "poiMiss",
                "poiError",
                "poiNotChecked",
                "hoursChecked",
                "routesTotal",
                "routesChecked",
              ],
              properties: {
                poiTotal: { type: "integer" },
                poiChecked: { type: "integer" },
                poiHit: { type: "integer" },
                poiMiss: { type: "integer" },
                poiError: { type: "integer" },
                poiNotChecked: { type: "integer" },
                hoursChecked: { type: "integer" },
                routesTotal: { type: "integer" },
                routesChecked: { type: "integer" },
              },
            },
            sources: {
              type: "object",
              description: "出现过的来源 → 点位数（谁的数据一眼可查）",
              additionalProperties: { type: "integer" },
            },
          },
        },
        overall: { type: "string", enum: ["ok", "warnings", "blocking", "unverified"] },
        summary: { type: "string" },
      },
    },
    issues: {
      type: "array",
      items: { $ref: "#/components/schemas/VerifyIssue" },
    },
    stats: {
      type: "object",
      required: ["blocking", "warnings", "infos", "total"],
      properties: {
        blocking: { type: "integer" },
        warnings: { type: "integer" },
        infos: { type: "integer" },
        total: { type: "integer" },
      },
    },
    ruleset: {
      type: "object",
      required: ["version", "ruleIds"],
      properties: {
        version: { type: "string" },
        ruleIds: { type: "array", items: { type: "string" } },
      },
    },
    checkedAt: { type: "string", format: "date-time" },
    credential: { $ref: "#/components/schemas/TripCheckCredential" },
  },
};

const ISSUE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["ruleId", "category", "severity", "title", "detail", "evidence"],
  properties: {
    ruleId: { type: "string", example: "TC-C104" },
    category: { type: "string", enum: ["consistency", "facts"] },
    severity: { type: "string", enum: ["blocking", "warning", "info"] },
    title: { type: "string" },
    detail: { type: "string", description: "人话说明，含真实数字（证据优先）" },
    evidence: {
      type: "object",
      description: "可对账的结构化证据（day/spot/from/to/minutes/count/names…）",
      additionalProperties: true,
    },
    fixHint: { type: "string", description: "修复方向（不是自动修）" },
    suggestion: {
      type: "string",
      description: "基于文档自带事实算出的具体建议（拿不到数据就没有这个字段，不猜）",
    },
  },
};

const CREDENTIAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "可复算凭据。ID = tc_ + sha256(specVersion|engineVersion|rulesetVersion|sha256(canonicalJson({document,options})))[0:32]；同一输入 + 同一口径 + 同一版本 → 同一 ID（与签发时间无关）。**它不是数字签名**：只证明结论可被任何人重跑核对。",
  required: [
    "id",
    "algorithm",
    "inputHash",
    "specVersion",
    "engineVersion",
    "rulesetVersion",
    "issuedAt",
    "basis",
  ],
  properties: {
    id: { type: "string", pattern: "^tc_[0-9a-f]{32}$" },
    algorithm: { type: "string", const: "sha256" },
    inputHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    specVersion: { type: "string", const: TRIP_CHECK_SPEC_VERSION },
    engineVersion: { type: "string" },
    rulesetVersion: { type: "string" },
    issuedAt: { type: "string", format: "date-time" },
    basis: { type: "string", description: "ID 计算口径（公开文档里写死，任意语言可复算）" },
  },
};

const REPAIR_APPLIED_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["ruleId", "day", "detail"],
  properties: {
    ruleId: { type: "string", enum: ["TC-C102", "TC-C103", "TC-C109"] },
    day: { type: "integer", minimum: 1 },
    spot: { type: "string" },
    spotIndex: {
      type: "integer",
      minimum: 0,
      description: "被修复点在输入文档当天 spots 数组里的原始下标（产品侧按此套回 Plan）",
    },
    from: { type: "string", description: "时间类修复：原时刻" },
    to: { type: "string", description: "时间类修复：新时刻" },
    detail: { type: "string" },
  },
};

const REPAIR_UNREPAIRABLE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["ruleId", "reason"],
  properties: {
    ruleId: { type: "string" },
    day: { type: "integer" },
    spot: { type: "string" },
    reason: { type: "string", description: "为什么修不了 + 下一步方向（不编造、不替用户取舍）" },
  },
};

const REPAIR_DELTA_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["score", "gradeFrom", "gradeTo", "blockingReduced", "improved"],
  properties: {
    score: { type: "integer", description: "修复后 - 修复前（结构分）" },
    gradeFrom: { type: "string", enum: ["A", "B", "C", "D"] },
    gradeTo: { type: "string", enum: ["A", "B", "C", "D"] },
    blockingReduced: {
      type: "integer",
      description: "修复前阻断数 - 修复后阻断数（正数 = 减少了）",
    },
    improved: { type: "boolean" },
  },
};

/** 生成请求体（/api/verify 与 /api/verify/repair 共用：document 或 shareId 二选一 + options） */
const VERIFY_REQUEST_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "体检/修复请求。`document` 与 `shareId` **必须且只能提供一个**（先按字节量 body，>256 KiB → 413）。",
  additionalProperties: true,
  properties: {
    document: { $ref: "#/components/schemas/TripCheckDocument" },
    shareId: {
      type: "string",
      pattern: "^share_[A-Za-z0-9_-]{8,64}$",
      description: "站内分享行程 token（旧 jobId 链接在任务 TTL 内也可解析，但只读）",
    },
    options: { $ref: "#/components/schemas/TripCheckOptions" },
  },
  oneOf: [{ required: ["document"] }, { required: ["shareId"] }],
};

const OPTIONS_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "判定口径。不同口径结论可以不同，且会写进凭据输入哈希（对账时必须一致）。",
  additionalProperties: true,
  properties: {
    pace: {
      type: "string",
      enum: ["relaxed", "balanced", "packed"],
      description: "行程节奏，决定当天净游玩时长上限（默认 balanced）",
    },
  },
};

/** /api/verify 的 200：报告 + 凭据（凭据挂在报告上，兼容 report.credential） */
const REPORT_WITH_CREDENTIAL_SCHEMA: Record<string, unknown> = {
  allOf: [
    { $ref: "#/components/schemas/TripCheckReport" },
    {
      type: "object",
      required: ["credential"],
      properties: { credential: { $ref: "#/components/schemas/TripCheckCredential" } },
    },
  ],
};

const OPEN_REPAIR_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "开放修复结果（/api/verify/repair）：只返回建议，**不写回任何存储**（persisted 恒为 false）。",
  required: [
    "document",
    "applied",
    "remainingRuleIds",
    "unrepairable",
    "before",
    "after",
    "changed",
    "persisted",
    "source",
    "parentCredential",
    "credential",
  ],
  properties: {
    document: { $ref: "#/components/schemas/TripCheckDocument" },
    applied: { type: "array", items: { $ref: "#/components/schemas/RepairApplied" } },
    remainingRuleIds: { type: "array", items: { type: "string" } },
    unrepairable: { type: "array", items: { $ref: "#/components/schemas/RepairUnrepairable" } },
    before: { $ref: "#/components/schemas/TripCheckReport" },
    after: { $ref: "#/components/schemas/TripCheckReport" },
    delta: { $ref: "#/components/schemas/RepairDelta" },
    changed: { type: "boolean" },
    persisted: { type: "boolean", const: false },
    source: { type: "string", enum: ["document", "share"] },
    parentCredential: { $ref: "#/components/schemas/TripCheckCredential" },
    credential: { $ref: "#/components/schemas/TripCheckCredential" },
  },
};

const PLAN_CHECK_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "产品内体检结果。与开放端点同一套判定；额外给 planRevision（写回/撤销的并发基准）与 tripCheck（修复历史）。",
  required: ["shareId", "planRevision", "report", "credential", "tripCheck"],
  properties: {
    shareId: { type: "string" },
    planRevision: {
      type: ["integer", "null"],
      minimum: 1,
      description: "持久化 Plan 的版本号；旧 jobId 链接没有版本 → null（此时不可修复写回）",
    },
    report: { $ref: "#/components/schemas/TripCheckReport" },
    credential: { $ref: "#/components/schemas/TripCheckCredential" },
    tripCheck: {
      type: ["object", "null"],
      description: "最近一次修复历史；没修过为 null（不编造）",
      properties: {
        credentialId: { type: "string" },
        parentCredentialId: { type: "string" },
        checkedAt: { type: "integer" },
        repairedAt: { type: "integer" },
        repairCount: { type: "integer" },
        applied: { type: "integer" },
      },
    },
  },
};

const PLAN_CHECK_REQUEST_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["shareId"],
  properties: {
    shareId: {
      type: "string",
      pattern: "^[A-Za-z0-9_-]{6,64}$",
      description: "分享 token（旧 jobId 链接可只读体检，但不支持修复写回）",
    },
  },
};

const PLAN_REPAIR_REQUEST_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["shareId"],
  properties: {
    shareId: { type: "string", pattern: "^[A-Za-z0-9_-]{6,64}$" },
    confirm: {
      type: "boolean",
      description: "缺省/false = 只预览（不写库）；true = 写回新版本（revision+1）",
    },
    expectedRevision: {
      type: "integer",
      minimum: 1,
      description: "并发基准：与当前 Plan 版本不符 → 409（不覆盖别人的修改）",
    },
  },
};

const PLAN_REPAIR_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "产品内修复结果。预览（confirm 缺省）返回 persisted:false + planRevision；确认写入成功返回 persisted:true + revision + plan；没有可机械修复的问题时 changed:false 且不写。",
  required: [
    "changed",
    "persisted",
    "before",
    "after",
    "applied",
    "unrepairable",
    "parentCredential",
    "credential",
  ],
  properties: {
    changed: { type: "boolean" },
    persisted: { type: "boolean" },
    planRevision: { type: "integer", description: "预览/无改动时的当前版本" },
    revision: { type: "integer", description: "写入成功后的新版本（旧版本 + 1）" },
    plan: { $ref: "#/components/schemas/Plan" },
    before: { $ref: "#/components/schemas/TripCheckReport" },
    after: { $ref: "#/components/schemas/TripCheckReport" },
    applied: { type: "array", items: { $ref: "#/components/schemas/RepairApplied" } },
    unrepairable: { type: "array", items: { $ref: "#/components/schemas/RepairUnrepairable" } },
    parentCredential: { $ref: "#/components/schemas/TripCheckCredential" },
    credential: { $ref: "#/components/schemas/TripCheckCredential" },
  },
};

const TRIP_CHECK_HISTORY_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "Plan.tripCheck：产品内确定性修复历史（用于分享页/工作台展示修复链）",
  required: ["credentialId", "checkedAt"],
  properties: {
    credentialId: { type: "string" },
    parentCredentialId: { type: "string" },
    checkedAt: { type: "integer" },
    repairedAt: { type: "integer" },
    repairCount: { type: "integer" },
    applied: { type: "integer" },
  },
};

/** Plan 只声明与 Trip Check 相关的字段（完整 Plan Schema 见 API.md），避免契约与实现漂移 */
const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "站内持久化行程（完整字段见 API.md「Plan Schema」；这里只描述 Trip Check 写入的扩展）",
  additionalProperties: true,
  properties: {
    city: { type: "string" },
    days: { type: "array", items: { type: "object", additionalProperties: true } },
    tripCheck: { $ref: "#/components/schemas/TripCheckHistory" },
  },
};

const MCP_REQUEST_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "MCP JSON-RPC 2.0 单条消息（stateless，不维护会话；通知无 id → 202 空 body）。支持的方法：initialize / ping / tools/list / tools/call。",
  required: ["jsonrpc", "method"],
  additionalProperties: true,
  properties: {
    jsonrpc: { type: "string", const: "2.0" },
    id: { type: ["string", "number", "null"] },
    method: { type: "string" },
    params: { type: "object", additionalProperties: true },
  },
};

const MCP_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "JSON-RPC 2.0 响应（result 或 error 二选一）；通知不返回 body（202）",
  required: ["jsonrpc"],
  properties: {
    jsonrpc: { type: "string", const: "2.0" },
    id: { type: ["string", "number", "null"] },
    result: { type: "object", additionalProperties: true },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "integer", example: -32602 },
        message: { type: "string" },
        data: { type: "object", additionalProperties: true },
      },
    },
  },
};

const SERVICE_INFO_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "服务元信息（机器可发现：规范/引擎/规则版本 + schema/docs 指针）",
  required: ["name", "specVersion", "engineVersion", "rulesetVersion", "schema", "docs"],
  properties: {
    name: { type: "string", const: TRIP_CHECK_ENGINE_NAME },
    specVersion: { type: "string", const: TRIP_CHECK_SPEC_VERSION },
    engineVersion: { type: "string" },
    rulesetVersion: { type: "string" },
    schema: { type: "string", example: "/api/verify/schema" },
    docs: { type: "string", example: "/verify" },
  },
};

export const TRIP_CHECK_OPENAPI: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Trip Check API",
    version: TRIP_CHECK_ENGINE_VERSION,
    description:
      "行程可执行性核验与确定性修复的开放 API（Trip Check 开放标准 v0.1）。判定是确定性纯函数：不调模型、当前时间只用于时间戳；同一输入 + 同一口径 + 同一引擎/规则版本 → 同一凭据 ID，可被任何一方独立复算。开放端点无状态、不落库；产品内端点用分享 token 认行程，修复需 confirm 才写回。完整规范见 GitHub 仓库 docs/TRIP-CHECK-STANDARD.md。",
  },
  // 相对 server：契约跟着部署走（不要把演示域名写死进公开契约）
  servers: [{ url: "/", description: "当前部署（相对路径）" }],
  tags: [
    { name: "service", description: "服务发现：版本/契约/元信息" },
    { name: "verify", description: "无状态体检（任意开放文档或站内分享行程）" },
    { name: "repair", description: "确定性修复（只顺延时间/删同日重复，不编造事实）" },
    { name: "plan", description: "产品内入口（分享 token 即凭据；修复需确认写回）" },
    { name: "mcp", description: "MCP（JSON-RPC 2.0、stateless）" },
  ],
  paths: {
    "/api/verify": {
      get: {
        operationId: "getServiceInfo",
        tags: ["service"],
        summary: "服务元信息（规范/引擎/规则版本 + schema/docs 指针）",
        responses: {
          200: jsonResponse("ServiceInfo", "服务元信息"),
        },
      },
      post: {
        operationId: "verifyTripCheckDocument",
        tags: ["verify"],
        summary: "体检一份开放行程文档或站内分享行程（无状态、不落库）",
        requestBody: jsonBody("VerifyRequest", "document 或 shareId 二选一（+ 可选 options）"),
        responses: {
          200: jsonResponse("TripCheckReportWithCredential", "两轴报告 + 可复算凭据"),
          400: errorResponse("invalid_json / invalid_request（errors[].path 定位到具体字段）"),
          404: errorResponse("not_found：shareId 不存在"),
          413: errorResponse("payload_too_large：body > 256 KiB（按 UTF-8 字节算）"),
          429: errorResponse("rate_limited：超过 VERIFY_HOURLY_LIMIT（默认 120/小时/IP）"),
          500: errorResponse("internal_error：服务端异常（返回 JSON，不是 HTML 错误页）"),
        },
      },
      options: {
        operationId: "verifyCorsPreflight",
        tags: ["service"],
        summary: "CORS 预检（204，无 body）",
        responses: { 204: emptyResponse("预检通过（Access-Control-* 头齐全）") },
      },
    },
    "/api/verify/schema": {
      get: {
        operationId: "getTripCheckDocumentSchema",
        tags: ["service"],
        summary: "开放文档 JSON Schema（draft 2020-12，公开契约）",
        responses: {
          200: jsonResponse(
            "TripCheckDocument",
            "文档格式契约（可直接用于提交前自校验）",
            CACHE_HEADERS,
          ),
        },
      },
    },
    "/api/verify/repair": {
      post: {
        operationId: "repairTripCheckDocument",
        tags: ["repair"],
        summary: "确定性修复（只顺延时间/删同日重复；返回建议，不写回任何存储）",
        requestBody: jsonBody("VerifyRequest", "document 或 shareId 二选一（+ 可选 options）"),
        responses: {
          200: jsonResponse(
            "OpenRepairResult",
            "修复后文档 + 前后报告 + 前后两张凭据（persisted 恒 false）",
          ),
          400: errorResponse("invalid_json / invalid_request"),
          404: errorResponse("not_found：shareId 不存在"),
          413: errorResponse("payload_too_large：body > 256 KiB"),
          429: errorResponse("rate_limited：VERIFY_HOURLY_LIMIT"),
          500: errorResponse("internal_error"),
        },
      },
    },
    "/api/plan/check": {
      post: {
        operationId: "checkPlan",
        tags: ["plan"],
        summary: "产品内体检（分享 token 即凭据；返回版本号与修复历史）",
        requestBody: jsonBody("PlanCheckRequest", "站内行程 shareId（旧 jobId 链接可只读体检）"),
        responses: {
          200: jsonResponse("PlanCheckResponse", "报告 + 凭据 + planRevision + tripCheck"),
          400: errorResponse("invalid_json / invalid_request"),
          404: errorResponse("not_found：行程不存在或已被删除"),
          429: errorResponse("rate_limited：PLAN_CHECK_HOURLY_LIMIT（默认 120/小时/IP）"),
          500: errorResponse("internal_error"),
        },
      },
    },
    "/api/plan/repair": {
      post: {
        operationId: "repairPlan",
        tags: ["plan"],
        summary: "产品内确定性修复：预览（默认）或确认写回新版本（confirm:true，revision+1）",
        description:
          "只允许持久化 Plan（旧 jobId 链接 404）。预览不写库；confirm:true 且 changed:true 时把机械修复套回 Plan、刷新时间轴/营业时间预警、写入 plan.tripCheck 凭据链并 revision+1。expectedRevision 与当前版本不符 → 409。",
        requestBody: jsonBody("PlanRepairRequest", "shareId + confirm? + expectedRevision?"),
        responses: {
          200: jsonResponse(
            "PlanRepairResponse",
            "预览：persisted:false；写回成功：persisted:true + revision + plan；无机械修复：changed:false",
          ),
          400: errorResponse("invalid_json / invalid_request"),
          404: errorResponse("not_found：行程不存在 / 旧 jobId 链接只读不可修"),
          409: errorResponse("版本冲突：expectedRevision 与当前 Plan 版本不符（带当前 revision）"),
          429: errorResponse("rate_limited：REPAIR_HOURLY_LIMIT（默认 30/小时/IP）"),
          500: errorResponse("internal_error（不写回半截结果，退还限流名额）"),
        },
      },
    },
    "/api/mcp": {
      post: {
        operationId: "mcpJsonRpc",
        tags: ["mcp"],
        summary: "MCP 端点（JSON-RPC 2.0 stateless）：initialize / ping / tools/list / tools/call",
        description:
          "工具：verify_itinerary / repair_itinerary / verify_shared_trip / get_trip_check_schema / list_rules / explain_rule。只实现 tools 能力（不提供 resources/prompts/sampling）；通知（无 id）→ 202 空 body。",
        requestBody: jsonBody("McpRequest", "单条 JSON-RPC 2.0 消息（不支持批量）"),
        responses: {
          200: jsonResponse(
            "McpResponse",
            "JSON-RPC 结果或协议错误（-32700/-32600/-32601/-32602）",
          ),
          202: emptyResponse("JSON-RPC 通知：无响应体"),
          400: errorResponse("JSON 解析失败（-32700）或信封非法（-32600）"),
          413: errorResponse("payload_too_large：body > 256 KiB"),
          405: errorResponse("method_not_allowed：只支持 POST（不实现 GET/SSE 推送）"),
        },
      },
    },
  },
  components: {
    schemas: {
      // 直接引用公开文档契约常量（单一事实来源；不要在 OpenAPI 里手抄一份）
      TripCheckDocument: TRIP_CHECK_JSON_SCHEMA as Record<string, unknown>,
      TripCheckOptions: OPTIONS_SCHEMA,
      VerifyRequest: VERIFY_REQUEST_SCHEMA,
      TripCheckReport: REPORT_SCHEMA,
      TripCheckReportWithCredential: REPORT_WITH_CREDENTIAL_SCHEMA,
      TripCheckCredential: CREDENTIAL_SCHEMA,
      VerifyIssue: ISSUE_SCHEMA,
      RepairApplied: REPAIR_APPLIED_SCHEMA,
      RepairUnrepairable: REPAIR_UNREPAIRABLE_SCHEMA,
      RepairDelta: REPAIR_DELTA_SCHEMA,
      OpenRepairResult: OPEN_REPAIR_RESULT_SCHEMA,
      PlanCheckRequest: PLAN_CHECK_REQUEST_SCHEMA,
      PlanCheckResponse: PLAN_CHECK_RESPONSE_SCHEMA,
      PlanRepairRequest: PLAN_REPAIR_REQUEST_SCHEMA,
      PlanRepairResponse: PLAN_REPAIR_RESPONSE_SCHEMA,
      TripCheckHistory: TRIP_CHECK_HISTORY_SCHEMA,
      Plan: PLAN_SCHEMA,
      McpRequest: MCP_REQUEST_SCHEMA,
      McpResponse: MCP_RESPONSE_SCHEMA,
      ServiceInfo: SERVICE_INFO_SCHEMA,
      Error: ERROR_SCHEMA,
    },
  },
  // 机器可读的三条版本轴：规范（文档格式）/ 引擎（判定实现）/ 规则集（阈值与规则）
  // 分开是因为它们各自独立演进——对账时必须同时比对（见 docs/TRIP-CHECK-STANDARD.md §8）。
  "x-trip-check": {
    spec: TRIP_CHECK_SPEC_VERSION,
    engine: TRIP_CHECK_ENGINE_VERSION,
    ruleset: TRIP_CHECK_RULESET_VERSION,
  },
};
