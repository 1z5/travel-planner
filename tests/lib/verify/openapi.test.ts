import { describe, expect, it } from "vitest";
import { TRIP_CHECK_OPENAPI, type OpenApiDocument } from "@/lib/verify/openapi";
import { TRIP_CHECK_JSON_SCHEMA } from "@/lib/verify/schema";
import {
  TRIP_CHECK_ENGINE_VERSION,
  TRIP_CHECK_RULESET_VERSION,
  TRIP_CHECK_SPEC_VERSION,
} from "@/lib/verify/types";

// 契约测试：OpenAPI 文档是**对外机读契约**，这里守住四件容易漂移的事：
// 1) 版本三条轴与常量同源（info.version 跟引擎版本；spec/ruleset 写在 x-trip-check）；
// 2) paths 覆盖全部开放端点（少一个，SDK/网关就看不见）；
// 3) 所有 $ref 都能解析（悬空引用 = 契约坏了，但 JSON 仍然合法，最难发现）；
// 4) 文档格式直接引用 schema.ts 的常量（同一对象）——不允许手抄副本。

type JsonRecord = Record<string, unknown>;

const schemas = TRIP_CHECK_OPENAPI.components.schemas;
const paths = TRIP_CHECK_OPENAPI.paths;

function operation(path: string, method: string): JsonRecord {
  const item = paths[path] as JsonRecord | undefined;
  return ((item?.[method] as JsonRecord | undefined) ?? {}) as JsonRecord;
}

/** 递归收集文档里所有 $ref 字符串 */
function collectRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as JsonRecord)) {
      if (key === "$ref" && typeof child === "string") out.push(child);
      else collectRefs(child, out);
    }
  }
  return out;
}

function requiredOf(schema: JsonRecord): string[] {
  const required = schema.required;
  return Array.isArray(required) ? required.filter((x): x is string => typeof x === "string") : [];
}

describe("OpenAPI 契约 · 顶层与版本", () => {
  it("是 OpenAPI 3.1 文档，标题/版本/相对 server 符合契约", () => {
    expect(TRIP_CHECK_OPENAPI.openapi).toBe("3.1.0");
    expect(TRIP_CHECK_OPENAPI.info.title).toBe("Trip Check API");
    expect(TRIP_CHECK_OPENAPI.info.version).toBe(TRIP_CHECK_ENGINE_VERSION);
    expect(TRIP_CHECK_OPENAPI.servers).toHaveLength(1);
    expect(TRIP_CHECK_OPENAPI.servers[0]?.url).toBe("/");
  });

  it("x-trip-check 写清三条独立版本轴，且与 types.ts 常量同源", () => {
    const ext = TRIP_CHECK_OPENAPI["x-trip-check"];
    expect(ext.spec).toBe(TRIP_CHECK_SPEC_VERSION);
    expect(ext.engine).toBe(TRIP_CHECK_ENGINE_VERSION);
    expect(ext.ruleset).toBe(TRIP_CHECK_RULESET_VERSION);
    // info.version 跟引擎版本（契约随实现演进）；规范版本不能在 info.version 里混用
    expect(TRIP_CHECK_OPENAPI.info.version).toBe(ext.engine);
  });

  it("文档可 JSON 序列化（路由直接返回它；不能有函数/循环引用）", () => {
    const json = JSON.stringify(TRIP_CHECK_OPENAPI);
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json) as OpenApiDocument;
    expect(parsed.openapi).toBe("3.1.0");
    expect(Object.keys(parsed.paths)).toHaveLength(6);
  });
});

describe("OpenAPI 契约 · 端点覆盖", () => {
  it("覆盖 6 个端点的全部方法：verify(get/post)、schema(get)、verify/repair(post)、plan/check(post)、plan/repair(post)、mcp(post)", () => {
    const expected: Record<string, string[]> = {
      "/api/verify": ["get", "post"],
      "/api/verify/schema": ["get"],
      "/api/verify/repair": ["post"],
      "/api/plan/check": ["post"],
      "/api/plan/repair": ["post"],
      "/api/mcp": ["post"],
    };
    expect(Object.keys(paths).sort()).toEqual(Object.keys(expected).sort());
    for (const [path, methods] of Object.entries(expected)) {
      for (const method of methods) {
        const op = operation(path, method);
        expect(op.operationId, `${method.toUpperCase()} ${path} 缺 operationId`).toBeTypeOf(
          "string",
        );
        expect(op.summary, `${method.toUpperCase()} ${path} 缺 summary`).toBeTypeOf("string");
        expect(op.responses, `${method.toUpperCase()} ${path} 缺 responses`).toBeTypeOf("object");
      }
    }
  });

  it("operationId 唯一（SDK 生成器按它命名，重复会互相覆盖）", () => {
    const ids: string[] = [];
    for (const item of Object.values(paths)) {
      for (const [method, op] of Object.entries(item as JsonRecord)) {
        if (["get", "post", "put", "patch", "delete", "options", "head"].includes(method)) {
          const id = (op as JsonRecord).operationId;
          if (typeof id === "string") ids.push(id);
        }
      }
    }
    expect(ids.length).toBeGreaterThanOrEqual(7);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("体检/修复端点声明了文档要求的错误码（400/404/413/429；产品内修复另有 409）", () => {
    const verifyPost = operation("/api/verify", "post");
    const verifyResponses = verifyPost.responses as JsonRecord;
    for (const code of ["400", "404", "413", "429"]) {
      expect(verifyResponses[code], `POST /api/verify 缺 ${code}`).toBeDefined();
    }
    const repairResponses = operation("/api/verify/repair", "post").responses as JsonRecord;
    for (const code of ["400", "404", "413", "429"]) {
      expect(repairResponses[code], `POST /api/verify/repair 缺 ${code}`).toBeDefined();
    }
    const planCheckResponses = operation("/api/plan/check", "post").responses as JsonRecord;
    for (const code of ["400", "404", "429"]) {
      expect(planCheckResponses[code], `POST /api/plan/check 缺 ${code}`).toBeDefined();
    }
    const planRepairResponses = operation("/api/plan/repair", "post").responses as JsonRecord;
    for (const code of ["400", "404", "409", "429"]) {
      expect(planRepairResponses[code], `POST /api/plan/repair 缺 ${code}`).toBeDefined();
    }
    // MCP 通知（无 id）不回 body：202 必须写进契约，否则客户端会等一个永远不来的响应
    expect((operation("/api/mcp", "post").responses as JsonRecord)["202"]).toBeDefined();
  });

  it("所有 JSON 请求体都引用 components.schemas（请求契约可被工具校验）", () => {
    const posts = [
      operation("/api/verify", "post"),
      operation("/api/verify/repair", "post"),
      operation("/api/plan/check", "post"),
      operation("/api/plan/repair", "post"),
      operation("/api/mcp", "post"),
    ];
    for (const post of posts) {
      const body = post.requestBody as JsonRecord | undefined;
      expect(body?.required).toBe(true);
      const content = body?.content as JsonRecord | undefined;
      const schema = (content?.["application/json"] as JsonRecord | undefined)?.schema as
        JsonRecord | undefined;
      expect(schema?.$ref).toMatch(/^#\/components\/schemas\//);
    }
  });
});

describe("OpenAPI 契约 · schemas 与单一事实来源", () => {
  it("document schema 直接引用 TRIP_CHECK_JSON_SCHEMA 常量（同一对象，不是手抄副本）", () => {
    expect(schemas.TripCheckDocument).toBe(TRIP_CHECK_JSON_SCHEMA);
    expect(schemas.TripCheckDocument?.$id).toBe("urn:trip-check:document:0.1");
  });

  it("所有 $ref 都能解析：components 引用存在；document 内部的 #/$defs/* 自洽（$id 固定资源基）", () => {
    const refs = collectRefs(TRIP_CHECK_OPENAPI);
    expect(refs.length).toBeGreaterThan(10);
    const componentRefs = refs.filter((ref) => !ref.startsWith("#/$defs/"));
    for (const ref of componentRefs) {
      expect(ref.startsWith("#/components/schemas/"), `非 components 引用: ${ref}`).toBe(true);
      const name = ref.slice("#/components/schemas/".length);
      expect(schemas[name], `悬空 $ref: ${ref}`).toBeDefined();
    }
    const defs = (TRIP_CHECK_JSON_SCHEMA.$defs ?? {}) as JsonRecord;
    const defRefs = refs.filter((ref) => ref.startsWith("#/$defs/"));
    expect(defRefs.length).toBeGreaterThan(0);
    for (const ref of defRefs) {
      const name = ref.slice("#/$defs/".length);
      expect(defs[name], `document 内部悬空 $ref: ${ref}`).toBeDefined();
    }
  });

  it("report/credential/repair 结构声明了调用方依赖的必填字段", () => {
    const report = requiredOf(schemas.TripCheckReport);
    // 两轴必须都在（合并成一个分数的报告不符合标准）
    expect(report).toEqual(
      expect.arrayContaining(["specVersion", "engine", "verdict", "issues", "stats", "checkedAt"]),
    );
    const verdict = (schemas.TripCheckReport?.properties as JsonRecord).verdict as JsonRecord;
    expect(requiredOf(verdict)).toEqual(
      expect.arrayContaining(["consistency", "facts", "overall", "summary"]),
    );

    const credential = requiredOf(schemas.TripCheckCredential);
    expect(credential).toEqual(
      expect.arrayContaining(["id", "algorithm", "inputHash", "issuedAt", "basis"]),
    );
    const credProps = schemas.TripCheckCredential?.properties as JsonRecord;
    expect((credProps.id as JsonRecord).pattern).toBe("^tc_[0-9a-f]{32}$");
    expect((credProps.algorithm as JsonRecord).const).toBe("sha256");

    const openRepair = requiredOf(schemas.OpenRepairResult);
    expect(openRepair).toEqual(
      expect.arrayContaining([
        "document",
        "applied",
        "before",
        "after",
        "parentCredential",
        "credential",
      ]),
    );
    // 开放修复端点不写库：persisted 恒为 false
    expect(
      ((schemas.OpenRepairResult?.properties as JsonRecord).persisted as JsonRecord).const,
    ).toBe(false);

    const planRepair = requiredOf(schemas.PlanRepairResponse);
    expect(planRepair).toEqual(
      expect.arrayContaining([
        "changed",
        "persisted",
        "before",
        "after",
        "parentCredential",
        "credential",
      ]),
    );
  });
});
