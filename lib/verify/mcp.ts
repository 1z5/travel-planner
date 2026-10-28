// ============================================================
// Trip Check 的 MCP 端点（JSON-RPC 2.0 · 无状态 · 只实现 tools 能力）
//
// 为什么协议层单独一层纯逻辑：
// 1) 解包/方法分发/工具参数校验与 HTTP 传输解耦——单测不需要起服务器，也不需要
//    store：分享行程的读取通过注入的 resolveShare 完成（route 层注入 plan-repo），
//    避免这个文件 import server-only 的 plan-repo。注入的是「读 Plan」这个动作，
//    不是「把 store 塞进来」——引擎层（engine.ts）仍然是 client-safe 的纯函数。
//    （凭据计算复用 credential.ts；它顶部 import "server-only" 是为了别被浏览器
//     打包，MCP 端点本身只在服务端运行，这里复用是为了让哈希口径只有一份实现。）
// 2) 无状态单消息：不做 session（Mcp-Session-Id）、不做 SSE（GET 由 route 回 405）、
//    不做 resources/prompts/sampling/logging —— capabilities 里只诚实声明 tools。
// 3) 错误分两层（MCP 约定）：
//    - 协议层错误用 JSON-RPC error：-32700 parse / -32600 invalid request /
//      -32601 method not found / -32602 invalid params（含未知工具、入参不合 schema）/
//      -32603 internal；
//    - 工具执行层的业务结果用 result { content, isError: true }：分享行程 404、
//      未知规则 id 之类「工具跑了但没拿到结果」，不是协议错误。
//
// 协议版本口径（诚实边界）：
// - initialize 时客户端给了字符串 protocolVersion 就回显（当前 tools 能力在已知
//   版本上语义一致；未知未来版本我们按现有语义执行，不做假承诺）；
// - 客户端没给字符串时回 "2025-06-18"；
// - 真正的版本承诺写在 initialize 的 instructions 与 mcp/README.md 里。
// ============================================================

import type { Plan } from "../types";
import { planToDocument } from "./adapt";
import { credentialOf } from "./credential";
import { verifyDocument } from "./engine";
import { RULES, RULE_ORDER } from "./rules";
import { TRIP_CHECK_JSON_SCHEMA, TRIP_CHECK_SCHEMA_VERSION } from "./schema";
import { parseTripCheckDocument, TripCheckOptionsSchema } from "./validate";
import {
  TRIP_CHECK_ENGINE_NAME,
  TRIP_CHECK_ENGINE_VERSION,
  TRIP_CHECK_LIMITS,
  TRIP_CHECK_RULESET_VERSION,
  TRIP_CHECK_SPEC_VERSION,
  type TripCheckOptions,
} from "./types";

// ============================================================
// 契约常量（导出给 route / 单测 / 文档共用，避免各写一份漂移）
// ============================================================

/** 默认 MCP 协议版本（客户端 initialize 未给字符串时回这个） */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** serverInfo：名字复用引擎名（同一实现），版本跟引擎版本走 */
export const MCP_SERVER_INFO = {
  name: TRIP_CHECK_ENGINE_NAME,
  version: TRIP_CHECK_ENGINE_VERSION,
} as const;

/** JSON-RPC 2.0 错误码（-32000 起为服务自定义区间，stdio 桥的 -32001 在 mcp/stdio.mjs） */
export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** 依赖注入：读一份本平台分享行程（route 传 plan-repo.resolvePlan；单测传 fake） */
export interface McpDeps {
  resolveShare: (id: string) => Promise<unknown>;
  /**
   * 可选：注入「现在」。只影响 report.checkedAt / credential.issuedAt（展示与签发时间），
   * 不参与任何判定——单测传固定时间可让整份报告逐字节可复现；route 不传则用真实时钟。
   */
  now?: () => Date;
}

/** handleMcpMessage 的返回：body 缺省 = 空 body（通知的 202） */
export interface McpHttpResult {
  status: number;
  body?: unknown;
}

// ============================================================
// 工具定义（tools/list 的返回；描述面向「另一个模型/agent」，只写行为与边界）
// ============================================================

interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

/**
 * document 参数的内联 schema：直接把 schema.ts 的 document schema 摊进工具入参，
 * 并把 `$defs` 提升到工具 inputSchema 的根——`$ref: "#/$defs/day"` 这类引用是
 * 相对「schema 根」解析的，留在 document 节点里会解析失败（工具 schema 自带
 * `$defs` 也是合法的 JSON Schema，客户端可独立校验）。
 *
 * 为什么内联而不手写一份精简版：对外契约只有 schema.ts 一个权威。手写精简版
 * 一旦字段漂移，agent 会在提交前「校验通过」却在服务端被 zod 拒掉。
 */
const DOCUMENT_PROPERTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["specVersion", "days"],
  additionalProperties: true,
  properties: TRIP_CHECK_JSON_SCHEMA.properties as Record<string, unknown>,
};

const OPTIONS_PROPERTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description: "判定口径。口径不同结论可以不同，且会被写进凭据输入哈希，必须与分享方一致才能对账。",
  properties: {
    pace: {
      type: "string",
      enum: ["relaxed", "balanced", "packed"],
      description:
        "行程节奏，决定当天净游玩时长上限：relaxed=轻松 / balanced=适中（默认）/ packed=紧凑。",
    },
  },
};

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

/** 所有工具都是只读判定：不会改行程、不写库、不碰外部系统 */
const READ_ONLY_ANNOTATIONS: Record<string, unknown> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const MCP_TOOLS = [
  {
    name: "verify_itinerary",
    title: "行程体检（开放文档）",
    description:
      "对一份 Trip Check v0.1 开放行程文档做确定性体检，返回可对账报告：结构自洽性（时间轴/节奏/预算，0-100 分 + A-D 等级）、事实核验覆盖（点位存在性/营业时间/路程的三态覆盖，不折成分数）、按严重度排序的规则级问题与证据、以及可复算凭据 credential。只判定不改行程；未核验不等于没问题。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document"],
      properties: {
        document: {
          ...DOCUMENT_PROPERTY_SCHEMA,
          description:
            'Trip Check v0.1 开放文档。specVersion 必须是 "trip-check/0.1"，days 至少 1 天。格式契约可用 get_trip_check_schema 取完整 JSON Schema。',
        },
        options: OPTIONS_PROPERTY_SCHEMA,
      },
      $defs: TRIP_CHECK_JSON_SCHEMA.$defs,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "verify_shared_trip",
    title: "行程体检（本平台分享行程）",
    description:
      "体检本平台的一份已分享行程（把内部 Plan 适配成开放文档后走同一套规则），返回与 verify_itinerary 同构的报告 + credential。shareId 不存在时返回 isError 的工具结果（内容说明 404），不是协议错误。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["shareId"],
      properties: {
        shareId: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: "分享行程 id，来自 /p/<shareId> 分享链接（只填 id，不是完整 URL）。",
        },
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_trip_check_schema",
    title: "取文档格式契约",
    description:
      "返回 Trip Check v0.1 开放文档的 JSON Schema（draft 2020-12）、规范/引擎/规则集版本与输入限额。构造 verify_itinerary 的 document 前可先取它做格式自校验。",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "list_rules",
    title: "列出规则集",
    description:
      "列出当前规则集的全部规则（id、分类、严重度、扣分、标题、说明、修复方向）与 rulesetVersion，用于解释体检结论或做跨实现对账。",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "explain_rule",
    title: "解释单条规则",
    description:
      "返回单条规则的完整元信息（含修复方向 fixHint）。ruleId 来自 list_rules 或报告 issues[].ruleId；未知 ruleId 返回 isError 的工具结果。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ruleId"],
      properties: {
        ruleId: {
          type: "string",
          description: '规则 id，形如 "TC-C104" / "TC-F204"。',
        },
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
] as const satisfies readonly McpToolDefinition[];

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];

export const MCP_TOOL_NAMES: readonly McpToolName[] = MCP_TOOLS.map((tool) => tool.name);

// ============================================================
// JSON-RPC 信封
// ============================================================

type JsonRpcId = string | number | null;

interface McpTextContent {
  type: "text";
  text: string;
}

/** tools/call 的 result（MCP 约定：业务失败也走 200 + isError，不用 JSON-RPC error） */
interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

/** 协议层错误：从工具实现里抛出来，统一在 dispatch 处转成 JSON-RPC error */
class RpcFault extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcFault";
    this.code = code;
    this.data = data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function errorBody(id: JsonRpcId, code: number, message: string, data?: unknown) {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function resultBody(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ============================================================
// 工具实现
// ============================================================

function textResult(payload: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** 工具层失败：isError + 结构化文案（调用方/模型能看懂「为什么没结果」） */
function toolError(message: string, details?: Record<string, unknown>): McpToolResult {
  const payload: Record<string, unknown> = { error: message };
  if (details) Object.assign(payload, details);
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

/** zod 错误 → 带路径的 [{path,message}]（与 /api/verify 的 errors 同构） */
function zodErrors(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
    message: issue.message,
  }));
}

async function verifyItinerary(args: unknown, deps: McpDeps): Promise<McpToolResult> {
  if (!isRecord(args)) {
    throw new RpcFault(
      JSON_RPC_ERRORS.invalidParams,
      "verify_itinerary 需要对象参数 { document, options? }",
    );
  }
  if (args.document === undefined) {
    throw new RpcFault(JSON_RPC_ERRORS.invalidParams, "verify_itinerary 缺少必填参数 document", {
      path: "document",
    });
  }
  // 文档/口径校验失败是「入参不合 inputSchema」→ 协议层 -32602，并带字段路径便于定位
  const doc = parseTripCheckDocument(args.document);
  if (!doc.ok) {
    throw new RpcFault(JSON_RPC_ERRORS.invalidParams, "document 不符合 Trip Check v0.1 格式", {
      errors: doc.errors,
    });
  }
  const options = TripCheckOptionsSchema.safeParse(args.options ?? {});
  if (!options.success) {
    throw new RpcFault(JSON_RPC_ERRORS.invalidParams, "options 不符合判定口径格式", {
      errors: zodErrors(options.error),
    });
  }
  // 凭据必须基于「归一化后的文档 + 同口径 + 同一个 now」计算，才能和 /api/verify 对上账
  const parsedOptions = options.data as TripCheckOptions;
  const now = deps.now ? deps.now() : new Date();
  const report = verifyDocument(doc.value, parsedOptions, now);
  return textResult({ ...report, credential: credentialOf(doc.value, parsedOptions, now) });
}

async function verifySharedTrip(args: unknown, deps: McpDeps): Promise<McpToolResult> {
  if (!isRecord(args) || typeof args.shareId !== "string" || !args.shareId.trim()) {
    throw new RpcFault(
      JSON_RPC_ERRORS.invalidParams,
      "verify_shared_trip 需要非空字符串参数 shareId",
    );
  }
  const shareId = args.shareId.trim();

  let plan: unknown;
  try {
    plan = await deps.resolveShare(shareId);
  } catch (error) {
    // 读存储失败 = 服务端故障（-32603），不能伪装成「行程不存在」
    throw new RpcFault(JSON_RPC_ERRORS.internal, "读取分享行程失败", {
      cause: errorMessage(error),
    });
  }
  if (plan === null || plan === undefined) {
    return toolError(
      `未找到行程（HTTP 404）：shareId「${shareId}」不存在或已被删除。请确认它来自 /p/<shareId> 分享链接。`,
      { shareId, status: 404 },
    );
  }
  if (!isRecord(plan) || !Array.isArray(plan.days)) {
    return toolError(`行程数据不可用：shareId「${shareId}」不是可体检的行程结构。`, {
      shareId,
      status: 422,
    });
  }

  try {
    const document = planToDocument(plan as unknown as Plan, { id: shareId });
    const now = deps.now ? deps.now() : new Date();
    const report = verifyDocument(document, {}, now);
    return textResult({ ...report, credential: credentialOf(document, {}, now) });
  } catch (error) {
    throw new RpcFault(JSON_RPC_ERRORS.internal, "分享行程无法转换为体检文档", {
      cause: errorMessage(error),
    });
  }
}

async function getTripCheckSchema(): Promise<McpToolResult> {
  return textResult({
    specVersion: TRIP_CHECK_SPEC_VERSION,
    schemaVersion: TRIP_CHECK_SCHEMA_VERSION,
    engineVersion: TRIP_CHECK_ENGINE_VERSION,
    rulesetVersion: TRIP_CHECK_RULESET_VERSION,
    limits: TRIP_CHECK_LIMITS,
    schema: TRIP_CHECK_JSON_SCHEMA,
  });
}

async function listRules(): Promise<McpToolResult> {
  return textResult({
    rulesetVersion: TRIP_CHECK_RULESET_VERSION,
    count: RULE_ORDER.length,
    rules: RULE_ORDER.map((id) => RULES[id]),
  });
}

async function explainRule(args: unknown): Promise<McpToolResult> {
  if (!isRecord(args) || typeof args.ruleId !== "string" || !args.ruleId.trim()) {
    throw new RpcFault(JSON_RPC_ERRORS.invalidParams, "explain_rule 需要非空字符串参数 ruleId");
  }
  const ruleId = args.ruleId.trim();
  const rule = RULES[ruleId];
  if (!rule) {
    // 未知规则 id 是业务结果（agent 可能把别的规则集 id 传进来）：用 isError 让模型看到可用清单
    return toolError(`未知规则 id「${ruleId}」。可用规则：${RULE_ORDER.join("、")}`, { ruleId });
  }
  return textResult({ rulesetVersion: TRIP_CHECK_RULESET_VERSION, rule });
}

type ToolHandler = (args: unknown, deps: McpDeps) => Promise<McpToolResult>;

const TOOL_HANDLERS: Record<McpToolName, ToolHandler> = {
  verify_itinerary: (args, deps) => verifyItinerary(args, deps),
  verify_shared_trip: (args, deps) => verifySharedTrip(args, deps),
  get_trip_check_schema: () => getTripCheckSchema(),
  list_rules: () => listRules(),
  explain_rule: (args) => explainRule(args),
};

async function callTool(params: unknown, deps: McpDeps): Promise<McpToolResult> {
  if (!isRecord(params)) {
    throw new RpcFault(
      JSON_RPC_ERRORS.invalidParams,
      "tools/call 需要 params 对象 { name, arguments? }",
    );
  }
  const { name } = params;
  if (typeof name !== "string" || !name) {
    throw new RpcFault(JSON_RPC_ERRORS.invalidParams, "tools/call 缺少非空字符串参数 name", {
      available: MCP_TOOL_NAMES,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name)) {
    throw new RpcFault(JSON_RPC_ERRORS.invalidParams, `未知工具「${name}」`, {
      available: MCP_TOOL_NAMES,
    });
  }
  const handler = TOOL_HANDLERS[name as McpToolName];
  // arguments 缺省视为 {}（get_trip_check_schema / list_rules 无入参）；非对象由各工具自己拒
  const args = params.arguments === undefined ? {} : params.arguments;
  return handler(args, deps);
}

// ============================================================
// initialize
// ============================================================

function initializeResult(params: unknown) {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  const protocolVersion = typeof requested === "string" ? requested : MCP_PROTOCOL_VERSION;
  return {
    protocolVersion,
    // 只声明 tools：没实现的 capabilities 写进来就是骗客户端
    capabilities: { tools: {} },
    serverInfo: { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
    instructions:
      "Trip Check：任何 AI 行程的可执行性体检（只读、确定性、可复算）。" +
      "仅实现 tools 能力，不提供 resources/prompts/sampling。建议顺序：get_trip_check_schema 取文档契约 → verify_itinerary 体检第三方行程；" +
      "本平台分享行程用 verify_shared_trip（shareId 来自 /p/<id>）。报告分两轴看：结构自洽性（分数/等级）与事实核验覆盖（verified/partial/unverified）；" +
      "未核验不等于没问题。结论可用 credential.id 与其 inputHash 独立复算对账（不是数字签名）。",
  };
}

// ============================================================
// 入口：单条 JSON-RPC 消息 → HTTP 语义
// ============================================================

/**
 * 处理一条 MCP 消息。
 *
 * @param input 原始请求（route 传 JSON 文本以保留 -32700 语义；单测可直接传对象）
 * @param deps  读取分享行程的注入依赖（route = plan-repo.resolvePlan）
 * @returns {status, body}：200 成功/协议错误、400 parse/invalid request、202 通知（空 body）
 *
 * 永不抛错：协议层异常都转成 JSON-RPC error，route 只负责序列化。
 */
export async function handleMcpMessage(input: unknown, deps: McpDeps): Promise<McpHttpResult> {
  // 1) 文本入参先 parse：解析失败是 -32700（这条路径独立于任何字段校验）
  let message: unknown = input;
  if (typeof input === "string") {
    try {
      message = JSON.parse(input);
    } catch {
      return {
        status: 400,
        body: errorBody(null, JSON_RPC_ERRORS.parse, "Parse error：请求体不是合法 JSON"),
      };
    }
  }

  // 2) 信封校验。协议规定「检测不到 id」时错误响应 id 用 null
  if (!isRecord(message)) {
    return {
      status: 400,
      body: errorBody(
        null,
        JSON_RPC_ERRORS.invalidRequest,
        "请求必须是单个 JSON-RPC 2.0 对象（不支持批量）",
      ),
    };
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id: JsonRpcId = isValidId(message.id) ? message.id : null;

  if (message.jsonrpc !== "2.0") {
    return {
      status: 400,
      body: errorBody(hasId ? id : null, JSON_RPC_ERRORS.invalidRequest, 'jsonrpc 必须是 "2.0"'),
    };
  }
  if (typeof message.method !== "string" || !message.method) {
    return {
      status: 400,
      body: errorBody(hasId ? id : null, JSON_RPC_ERRORS.invalidRequest, "method 必须是非空字符串"),
    };
  }
  // 3) 通知（无 id）：按 MCP 约定不回包 → 202 空 body。不认识的通知也沉默（协议允许）
  if (!hasId) return { status: 202 };
  if (!isValidId(message.id)) {
    return {
      status: 400,
      body: errorBody(null, JSON_RPC_ERRORS.invalidRequest, "id 必须是字符串或数字"),
    };
  }

  // 4) 方法分发。只有 parse/invalid request 用 4xx；合法请求的业务/协议错误仍走 200
  try {
    switch (message.method) {
      case "initialize":
        return { status: 200, body: resultBody(id, initializeResult(message.params)) };
      case "ping":
        return { status: 200, body: resultBody(id, {}) };
      case "tools/list":
        return { status: 200, body: resultBody(id, { tools: MCP_TOOLS }) };
      case "tools/call": {
        const toolResult = await callTool(message.params, deps);
        return { status: 200, body: resultBody(id, toolResult) };
      }
      default:
        return {
          status: 200,
          body: errorBody(id, JSON_RPC_ERRORS.methodNotFound, `未知方法「${message.method}」`),
        };
    }
  } catch (error) {
    if (error instanceof RpcFault) {
      return { status: 200, body: errorBody(id, error.code, error.message, error.data) };
    }
    return {
      status: 200,
      body: errorBody(id, JSON_RPC_ERRORS.internal, "内部错误：处理请求时发生未预期异常", {
        cause: errorMessage(error),
      }),
    };
  }
}
