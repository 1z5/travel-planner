import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as mcpGET, OPTIONS as mcpOPTIONS, POST as mcpPOST } from "@/app/api/mcp/route";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import {
  JSON_RPC_ERRORS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  MCP_TOOL_NAMES,
  type McpDeps,
  type McpHttpResult,
  handleMcpMessage,
} from "@/lib/verify/mcp";
import { RULE_ORDER } from "@/lib/verify/rules";
import { getSample } from "@/lib/verify/samples";
import { TRIP_CHECK_JSON_SCHEMA } from "@/lib/verify/schema";
import {
  TRIP_CHECK_RULESET_VERSION,
  type RepairResult,
  type TripCheckCredential,
  type TripCheckDocument,
  type TripCheckReport,
} from "@/lib/verify/types";

// 固定「现在」：report.checkedAt / credential.issuedAt 走注入时间，报告可逐字节复现
const FIXED = new Date("2026-10-28T10:00:00.000Z");

interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: JsonRpcErrorBody;
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** fake resolveShare：不读 store、不碰网络；记录调用参数以便断言 */
function depsFor(plan: unknown = null) {
  const resolveShare = vi.fn(async () => plan);
  const deps = { resolveShare, now: () => FIXED } satisfies McpDeps;
  return { deps, resolveShare };
}

function bodyOf(res: McpHttpResult): JsonRpcResponse {
  expect(res.body, "响应应带 JSON body").toBeTruthy();
  return res.body as JsonRpcResponse;
}

function resultOf(res: McpHttpResult): Record<string, unknown> {
  const body = bodyOf(res);
  expect(body.error, `不应是协议错误：${body.error?.message ?? ""}`).toBeUndefined();
  return body.result ?? {};
}

function toolResultOf(res: McpHttpResult): ToolCallResult {
  return resultOf(res) as unknown as ToolCallResult;
}

function payloadOf<T>(res: McpHttpResult): T {
  const result = toolResultOf(res);
  return JSON.parse(result.content[0].text) as T;
}

function errorOf(res: McpHttpResult): JsonRpcErrorBody {
  const body = bodyOf(res);
  expect(body.error, "应为 JSON-RPC error").toBeTruthy();
  return body.error as JsonRpcErrorBody;
}

/** 一次带固定 id 与默认 fake deps 的方法调用 */
async function callMethod(
  method: string,
  params?: unknown,
  deps: McpDeps = depsFor(null).deps,
): Promise<McpHttpResult> {
  return handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) },
    deps,
  );
}

async function callTool(
  name: string,
  args?: unknown,
  deps: McpDeps = depsFor(null).deps,
): Promise<McpHttpResult> {
  return callMethod(
    "tools/call",
    { name, ...(args === undefined ? {} : { arguments: args }) },
    deps,
  );
}

const verifiedSample = () => {
  const sample = getSample("verified");
  if (!sample) throw new Error("sample verified missing");
  return sample.document;
};

describe("MCP · initialize / ping / 通知", () => {
  it("initialize：回显客户端协议版本、只声明 tools、serverInfo 与引擎一致", async () => {
    const res = await callMethod("initialize", { protocolVersion: "2025-06-18" });
    expect(res.status).toBe(200);
    const body = bodyOf(res);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    const result = resultOf(res);
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: {} }); // 没有 resources/prompts/sampling
    expect(result.serverInfo).toEqual({
      name: MCP_SERVER_INFO.name,
      version: MCP_SERVER_INFO.version,
    });
    expect(result.serverInfo).toEqual(MCP_SERVER_INFO);
    expect(String(result.instructions)).toContain("tools");
  });

  it("initialize：客户端没给字符串版本时回默认 2025-06-18", async () => {
    const noParams = resultOf(await callMethod("initialize"));
    expect(noParams.protocolVersion).toBe(MCP_PROTOCOL_VERSION);

    const weird = resultOf(await callMethod("initialize", { protocolVersion: 20250618 }));
    expect(weird.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("ping：返回空对象结果", async () => {
    const res = await callMethod("ping");
    expect(res.status).toBe(200);
    expect(resultOf(res)).toEqual({});
  });

  it("通知（无 id）：202 且空 body；未知通知也沉默（协议允许）", async () => {
    for (const method of ["notifications/initialized", "notifications/whatever"]) {
      const res = await handleMcpMessage({ jsonrpc: "2.0", method }, depsFor(null).deps);
      expect(res.status).toBe(202);
      expect(res.body).toBeUndefined();
    }
  });
});

describe("MCP · 协议层错误", () => {
  it("非法 JSON 文本 → -32700 + HTTP 400，id 为 null", async () => {
    const res = await handleMcpMessage('{"jsonrpc":"2.0",', depsFor(null).deps);
    expect(res.status).toBe(400);
    const body = bodyOf(res);
    expect(body.id).toBeNull();
    expect(errorOf(res).code).toBe(JSON_RPC_ERRORS.parse);
  });

  it("非法请求信封 → -32600 + HTTP 400", async () => {
    const cases: unknown[] = [
      42, // 原始 JSON 值（非对象）
      '"ok"', // 合法 JSON 文本但不是对象
      [], // 空数组
      [{ jsonrpc: "2.0", id: 1, method: "ping" }], // 批量（本端点只收单条）
      {}, // 缺 jsonrpc/method
      { jsonrpc: "1.0", id: 1, method: "ping" }, // 版本不是 2.0
      { jsonrpc: "2.0", id: 1 }, // 缺 method
      { jsonrpc: "2.0", id: true, method: "ping" }, // id 类型非法
    ];
    for (const input of cases) {
      const res = await handleMcpMessage(input, depsFor(null).deps);
      expect(res.status, `输入 ${JSON.stringify(input)}`).toBe(400);
      expect(errorOf(res).code).toBe(JSON_RPC_ERRORS.invalidRequest);
    }
  });

  it("未知方法 → -32601（合法请求，HTTP 仍 200），id 原样回显", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: "req-7", method: "resources/list" },
      depsFor(null).deps,
    );
    expect(res.status).toBe(200);
    const body = bodyOf(res);
    expect(body.id).toBe("req-7");
    expect(errorOf(res).code).toBe(JSON_RPC_ERRORS.methodNotFound);
  });

  it("字符串 id 与数字 id 都原样回显", async () => {
    for (const id of [0, "abc"]) {
      const res = await handleMcpMessage(
        { jsonrpc: "2.0", id, method: "ping" },
        depsFor(null).deps,
      );
      expect(bodyOf(res).id).toBe(id);
    }
  });
});

describe("MCP · tools/list", () => {
  it("恰好 6 个工具，名字与契约一致", async () => {
    const result = resultOf(await callMethod("tools/list"));
    const tools = result.tools as Array<{
      name: string;
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
    expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "verify_itinerary",
      "repair_itinerary",
      "verify_shared_trip",
      "get_trip_check_schema",
      "list_rules",
      "explain_rule",
    ]);
    for (const tool of tools) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
    }
    // 修复工具的 description 必须把边界写清（agent 据此决定要不要调）
    const repair = tools.find((tool) => tool.name === "repair_itinerary");
    expect(repair!.description).toContain("unrepairable");
    expect(repair!.description).toContain("不编造");
    expect(repair!.description).toContain("不写回");
  });

  it("verify_itinerary / repair_itinerary 的 inputSchema 内联文档契约且 $defs 可解析", async () => {
    const result = resultOf(await callMethod("tools/list"));
    const tools = result.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    for (const name of ["verify_itinerary", "repair_itinerary"]) {
      const tool = tools.find((item) => item.name === name);
      expect(tool, name).toBeTruthy();
      const schema = tool!.inputSchema;
      expect(schema.required).toEqual(["document"]);
      // $defs 必须提升到 inputSchema 根：document 里的 $ref "#/$defs/day" 才解析得到
      expect(schema.$defs).toBe(TRIP_CHECK_JSON_SCHEMA.$defs);
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      expect(properties.document.required).toEqual(["specVersion", "days"]);
      const pace = (properties.options.properties as Record<string, Record<string, unknown>>).pace;
      expect(pace.enum).toEqual(["relaxed", "balanced", "packed"]);
    }
  });
});

describe("MCP · tools/call verify_itinerary", () => {
  it("开放文档 → 两轴报告 + credential；同一文档两次的 credential.id 相同", async () => {
    const document = verifiedSample();
    const res = await callTool("verify_itinerary", { document });
    expect(res.status).toBe(200);
    const result = toolResultOf(res);
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const report = payloadOf<TripCheckReport>(res);
    expect(report.specVersion).toBe("trip-check/0.1");
    expect(report.verdict.consistency.grade).toBe("A");
    expect(report.verdict.facts.state).toBe("verified");
    expect(report.checkedAt).toBe(FIXED.toISOString());
    expect(report.credential?.id).toMatch(/^tc_[0-9a-f]{32}$/);
    expect(report.credential?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.credential?.issuedAt).toBe(FIXED.toISOString());

    const again = payloadOf<TripCheckReport>(await callTool("verify_itinerary", { document }));
    expect(again.credential?.id).toBe(report.credential?.id);
  });

  it("options.pace 会传到引擎：packed 不超限，relaxed 超限", async () => {
    // 当天净游玩 360+390+30 = 780 分钟：packed 上限 780（不超），relaxed 上限 480（超）
    const document: TripCheckDocument = {
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          spots: [
            { name: "A", time: "09:00-15:00", durationMin: 360, costCny: 0 },
            { name: "B", time: "15:30-22:00", durationMin: 390, costCny: 0 },
          ],
          legs: [{ from: "A", to: "B", durationMin: 30 }],
        },
      ],
    };
    const packed = payloadOf<TripCheckReport>(
      await callTool("verify_itinerary", { document, options: { pace: "packed" } }),
    );
    expect(packed.issues.some((issue) => issue.ruleId === "TC-C107")).toBe(false);

    const relaxed = payloadOf<TripCheckReport>(
      await callTool("verify_itinerary", { document, options: { pace: "relaxed" } }),
    );
    const issue = relaxed.issues.find((item) => item.ruleId === "TC-C107");
    expect(issue?.evidence.limitMinutes).toBe(480);
  });

  it("有阻断问题的行程是「成功的体检结果」：200 + 报告，不是 isError", async () => {
    const blocked = getSample("blocked")!.document;
    const res = await callTool("verify_itinerary", { document: blocked });
    expect(res.status).toBe(200);
    const result = toolResultOf(res);
    expect(result.isError).toBeUndefined();
    const report = payloadOf<TripCheckReport>(res);
    expect(report.verdict.overall).toBe("blocking");
    expect(report.verdict.consistency.grade).toBe("D");
    expect(report.stats.blocking).toBeGreaterThan(0);
  });

  it("document 不合格式 → -32602（协议层）+ 带 path 的 errors", async () => {
    const res = await callTool("verify_itinerary", {
      document: { specVersion: "trip-check/0.1", days: [] },
    });
    expect(res.status).toBe(200);
    const error = errorOf(res);
    expect(error.code).toBe(JSON_RPC_ERRORS.invalidParams);
    const errors = (error.data as { errors: Array<{ path: string; message: string }> }).errors;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((item) => item.path)).toContain("days");
  });

  it("缺 document / options 非法 → -32602", async () => {
    const missing = errorOf(await callTool("verify_itinerary", {}));
    expect(missing.code).toBe(JSON_RPC_ERRORS.invalidParams);
    expect(missing.message).toContain("document");

    const badOptions = errorOf(
      await callTool("verify_itinerary", {
        document: verifiedSample(),
        options: { pace: "superfast" },
      }),
    );
    expect(badOptions.code).toBe(JSON_RPC_ERRORS.invalidParams);
    const errors = (badOptions.data as { errors: Array<{ path: string }> }).errors;
    expect(errors.map((item) => item.path)).toContain("pace");
  });
});

describe("MCP · tools/call repair_itinerary", () => {
  /** 时间重叠的破损文档：修复器应顺延第二个点并消除 TC-C102 */
  function overlappingDoc(): TripCheckDocument {
    return {
      specVersion: "trip-check/0.1",
      city: "苏州",
      days: [
        {
          day: 1,
          spots: [
            { name: "拙政园", time: "09:00-11:00", durationMin: 120, costCny: 80 },
            { name: "平江路", time: "10:30-12:00", durationMin: 90, costCny: 60 },
          ],
        },
      ],
    };
  }

  interface RepairPayload extends RepairResult {
    changed: boolean;
    parentCredential: TripCheckCredential;
    credential: TripCheckCredential;
  }

  async function repair(document: unknown): Promise<RepairPayload> {
    const res = await callTool("repair_itinerary", { document });
    expect(res.status).toBe(200);
    const result = toolResultOf(res);
    expect(result.isError).toBeUndefined();
    return payloadOf<RepairPayload>(res);
  }

  it("时间重叠 → 修复后文档 + applied/delta；只改时间、不改内容、不修改入参", async () => {
    const broken = overlappingDoc();
    const snapshot = JSON.stringify(broken);
    const payload = await repair(broken);

    expect(payload.changed).toBe(true);
    expect(payload.before.stats.blocking).toBe(1);
    expect(payload.after.stats.blocking).toBe(0);
    expect(payload.delta.improved).toBe(true);
    expect(payload.delta.blockingReduced).toBe(1);
    expect(payload.delta.gradeFrom).toBe("D");
    expect(payload.delta.gradeTo).toBe("A");
    expect(payload.applied).toHaveLength(1);
    expect(payload.applied[0].ruleId).toBe("TC-C102");
    expect(payload.document.days[0].spots[1].time).toBe("11:00-12:30");
    // 只改时间：地点/类型/花费/核验字段都不能被修复器碰（不编造事实）
    expect(payload.document.days[0].spots.map((spot) => spot.name)).toEqual(["拙政园", "平江路"]);
    // 修复器不修改入参（返回新文档）
    expect(JSON.stringify(broken)).toBe(snapshot);
    // 前后报告用同一个注入时间，可复现
    expect(payload.before.checkedAt).toBe(FIXED.toISOString());
    expect(payload.after.checkedAt).toBe(FIXED.toISOString());
  });

  it("前后两张凭据自洽：parent=原文档、child=修复后文档，都能用 verify_itinerary 复算", async () => {
    const broken = overlappingDoc();
    const payload = await repair(broken);
    expect(payload.parentCredential.id).toMatch(/^tc_[0-9a-f]{32}$/);
    expect(payload.credential.id).toMatch(/^tc_[0-9a-f]{32}$/);
    // 文档变了 → 凭据必然不同；inputHash 是可复算的输入指纹
    expect(payload.credential.id).not.toBe(payload.parentCredential.id);
    expect(payload.credential.inputHash).not.toBe(payload.parentCredential.inputHash);

    // ① parent 凭据 = 直接体检原文档得到的凭据
    const original = payloadOf<TripCheckReport>(
      await callTool("verify_itinerary", { document: broken }),
    );
    expect(payload.parentCredential.id).toBe(original.credential?.id);

    // ② child 凭据 = 体检「修复后文档」得到的凭据（返回的 document 可直接继续用）
    const rechecked = payloadOf<TripCheckReport>(
      await callTool("verify_itinerary", { document: payload.document }),
    );
    expect(rechecked.credential?.id).toBe(payload.credential.id);

    // ③ 再体检的报告与 repair 的 after 完全一致（修复前后是同一把尺子量的）
    const reportWithoutCredential: Record<string, unknown> = { ...rechecked };
    delete reportWithoutCredential.credential;
    expect(reportWithoutCredential).toEqual(payload.after);
  });

  it("干净文档：applied 为空、changed=false、不谎报改善，前后凭据相同", async () => {
    const clean = verifiedSample();
    const payload = await repair(clean);
    expect(payload.applied).toEqual([]);
    expect(payload.changed).toBe(false);
    expect(payload.delta.improved).toBe(false);
    expect(payload.delta.score).toBe(0);
    expect(payload.document).toEqual(clean);
    // 文档没变 → 同一份输入指纹 → 同一张凭据
    expect(payload.parentCredential.id).toBe(payload.credential.id);
    expect(payload.unrepairable).toEqual([]);
  });

  it("同一天重复点位 → 删重复（TC-C109），保留第一条", async () => {
    const duplicate: TripCheckDocument = {
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          spots: [
            { name: "西湖", time: "09:00-10:00", durationMin: 60, costCny: 0 },
            { name: "灵隐寺", time: "10:30-11:30", durationMin: 60, costCny: 0 },
            { name: "西湖", time: "13:00-14:00", durationMin: 60, costCny: 0 },
          ],
        },
      ],
    };
    const payload = await repair(duplicate);
    expect(payload.applied.map((item) => item.ruleId)).toContain("TC-C109");
    expect(payload.document.days[0].spots.map((spot) => spot.name)).toEqual(["西湖", "灵隐寺"]);
    expect(payload.after.issues.some((issue) => issue.ruleId === "TC-C109")).toBe(false);
    expect(payload.changed).toBe(true);
  });

  it("修不了的如实列出 unrepairable：缺路段不编造通勤时间（TC-C104）", async () => {
    const noLegs: TripCheckDocument = {
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          spots: [
            { name: "A", time: "09:00-10:00", durationMin: 60, costCny: 10 },
            { name: "B", time: "12:00-13:00", durationMin: 60, costCny: 10 },
          ],
        },
      ],
    };
    const payload = await repair(noLegs);
    expect(payload.changed).toBe(false);
    const missingLeg = payload.unrepairable.find((item) => item.ruleId === "TC-C104");
    expect(missingLeg).toBeTruthy();
    expect(missingLeg?.reason).toContain("编造");
    // 不编造事实：facts 轴仍是「未核验」，不会被修复器洗成 verified
    expect(payload.after.verdict.facts.state).not.toBe("verified");
  });

  it("入参非法（缺 document / 文档不合格式 / options 非法）→ -32602", async () => {
    const missing = errorOf(await callTool("repair_itinerary", {}));
    expect(missing.code).toBe(JSON_RPC_ERRORS.invalidParams);
    expect(missing.message).toContain("repair_itinerary");

    const badDoc = errorOf(
      await callTool("repair_itinerary", {
        document: { specVersion: "trip-check/0.1", days: [] },
      }),
    );
    expect(badDoc.code).toBe(JSON_RPC_ERRORS.invalidParams);
    const errors = (badDoc.data as { errors: Array<{ path: string }> }).errors;
    expect(errors.map((item) => item.path)).toContain("days");

    const badOptions = errorOf(
      await callTool("repair_itinerary", {
        document: verifiedSample(),
        options: { pace: "superfast" },
      }),
    );
    expect(badOptions.code).toBe(JSON_RPC_ERRORS.invalidParams);
  });
});

describe("MCP · tools/call verify_shared_trip", () => {
  it("分享行程 → 开放文档 id=shareId + 报告 + credential", async () => {
    const { deps, resolveShare } = depsFor(SAMPLE_PLAN);
    const res = await callTool("verify_shared_trip", { shareId: "share_demo" }, deps);
    expect(res.status).toBe(200);
    expect(resolveShare).toHaveBeenCalledWith("share_demo");
    const report = payloadOf<TripCheckReport>(res);
    expect(report.document.id).toBe("share_demo");
    expect(report.document.city).toBe("苏州");
    expect(report.document.days).toBe(SAMPLE_PLAN.days.length);
    expect(report.credential?.id).toMatch(/^tc_[0-9a-f]{32}$/);
    expect(report.checkedAt).toBe(FIXED.toISOString());
  });

  it("resolveShare 返回 null → tool result isError（说明 404），不是协议错误", async () => {
    const res = await callTool("verify_shared_trip", { shareId: "share_missing" });
    expect(res.status).toBe(200);
    const result = toolResultOf(res);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      error: string;
      shareId: string;
      status: number;
    };
    expect(payload.status).toBe(404);
    expect(payload.shareId).toBe("share_missing");
    expect(payload.error).toContain("404");
    expect(payload.error).toContain("share_missing");
  });

  it("resolveShare 抛错（存储故障）→ -32603 内部错误，不伪装成「行程不存在」", async () => {
    const deps: McpDeps = {
      resolveShare: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const res = await callTool("verify_shared_trip", { shareId: "share_x" }, deps);
    expect(res.status).toBe(200);
    const error = errorOf(res);
    expect(error.code).toBe(JSON_RPC_ERRORS.internal);
    expect((error.data as { cause: string }).cause).toBe("db down");
  });

  it("shareId 缺失或不是字符串 → -32602", async () => {
    for (const args of [{}, { shareId: "" }, { shareId: 123 }]) {
      const error = errorOf(await callTool("verify_shared_trip", args));
      expect(error.code).toBe(JSON_RPC_ERRORS.invalidParams);
    }
  });
});

describe("MCP · schema / rules 工具", () => {
  it("get_trip_check_schema → JSON Schema + 版本 + 限额", async () => {
    const payload = payloadOf<{
      specVersion: string;
      schemaVersion: string;
      engineVersion: string;
      rulesetVersion: string;
      limits: Record<string, number>;
      schema: Record<string, unknown>;
    }>(await callTool("get_trip_check_schema"));
    expect(payload.specVersion).toBe("trip-check/0.1");
    expect(payload.schemaVersion).toBe("0.1");
    expect(payload.rulesetVersion).toBe(TRIP_CHECK_RULESET_VERSION);
    expect(payload.schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(payload.schema.type).toBe("object");
    expect(payload.limits.maxDays).toBe(30);
  });

  it("list_rules → 全量规则（与注册表一致）+ rulesetVersion", async () => {
    const payload = payloadOf<{
      rulesetVersion: string;
      count: number;
      rules: Array<{ id: string; category: string; severity: string; penalty: number }>;
    }>(await callTool("list_rules"));
    expect(payload.rulesetVersion).toBe(TRIP_CHECK_RULESET_VERSION);
    expect(payload.rules).toHaveLength(RULE_ORDER.length);
    expect(payload.count).toBe(RULE_ORDER.length);
    expect(payload.rules.map((rule) => rule.id)).toEqual(RULE_ORDER);
    expect(payload.rules.some((rule) => rule.id === "TC-C104")).toBe(true);
    expect(payload.rules.some((rule) => rule.id === "TC-F205")).toBe(true);
  });

  it("explain_rule → 单条规则元信息", async () => {
    const payload = payloadOf<{
      rulesetVersion: string;
      rule: { id: string; severity: string; fixHint?: string; description: string };
    }>(await callTool("explain_rule", { ruleId: "TC-C102" }));
    expect(payload.rulesetVersion).toBe(TRIP_CHECK_RULESET_VERSION);
    expect(payload.rule.id).toBe("TC-C102");
    expect(payload.rule.severity).toBe("blocking");
    expect(payload.rule.fixHint).toBeTruthy();
  });

  it("explain_rule 未知 id → isError 工具结果，并列出可用规则", async () => {
    const res = await callTool("explain_rule", { ruleId: "TC-X999" });
    expect(res.status).toBe(200);
    const result = toolResultOf(res);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TC-X999");
    expect(result.content[0].text).toContain("TC-C102");
  });

  it("explain_rule 缺 ruleId → -32602", async () => {
    const error = errorOf(await callTool("explain_rule", {}));
    expect(error.code).toBe(JSON_RPC_ERRORS.invalidParams);
  });
});

describe("MCP · tools/call 参数与未知工具", () => {
  it("未知工具 → -32602，data.available 给出可用工具", async () => {
    const res = await callTool("delete_everything", {});
    expect(res.status).toBe(200);
    const error = errorOf(res);
    expect(error.code).toBe(JSON_RPC_ERRORS.invalidParams);
    expect((error.data as { available: string[] }).available).toEqual([...MCP_TOOL_NAMES]);
  });

  it("缺 name / params 不是对象 → -32602", async () => {
    const missingName = errorOf(await callMethod("tools/call", {}));
    expect(missingName.code).toBe(JSON_RPC_ERRORS.invalidParams);

    const badParams = errorOf(await callMethod("tools/call", "verify_itinerary"));
    expect(badParams.code).toBe(JSON_RPC_ERRORS.invalidParams);
  });
});

// ============================================================
// 路由层：验证 HTTP 语义（CORS / 202 空 body / 405）真的接上了
// 不依赖网络：直接调用 Route Handler；store 用默认 memory。
// ============================================================

function postRequest(body: string): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("POST /api/mcp · 路由层", () => {
  it("initialize → 200 + CORS + 规范版本头", async () => {
    const res = await mcpPOST(
      postRequest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-trip-check-spec")).toBe("trip-check/0.1");
    const body = (await res.json()) as JsonRpcResponse;
    expect((body.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  it("通知 → 202 且 body 为空（不能写 undefined 文本）", async () => {
    const res = await mcpPOST(
      postRequest(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("非法 JSON → 400 + -32700 + CORS（错误路径也带跨域头）", async () => {
    const res = await mcpPOST(postRequest("{oops"));
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as JsonRpcResponse;
    expect((body.error as JsonRpcErrorBody).code).toBe(JSON_RPC_ERRORS.parse);
  });

  it("OPTIONS → 204 空 body + CORS 预检头", async () => {
    const res = await mcpOPTIONS();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
    expect(allowMethods).toContain("POST");
    expect(allowMethods).toContain("OPTIONS");
  });

  it("GET → 405（不提供 SSE 流），Allow 头只列 POST/OPTIONS", async () => {
    const res = await mcpGET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
    expect(await res.text()).toContain("SSE");
  });
});
