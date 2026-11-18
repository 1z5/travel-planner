import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/journey/[id]/route";
import { createSession } from "@/lib/auth/session";
import { getSharedPlan, replacePlan } from "@/lib/plan/plan-repo";
import { memoryStore } from "@/lib/store/memory";
import type { PlanRecord } from "@/lib/store/types";
import { DEMO_FIXTURES } from "@/demo/fixtures";

const owner = "13800138000";
const other = "13800138001";

function req(id: string, phone?: string, body?: object, crossSite = false) {
  return new NextRequest(`http://localhost/api/journey/${id}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(phone ? { cookie: `tp_session=${createSession(phone).token}` } : {}),
      ...(crossSite ? { "sec-fetch-site": "cross-site" } : {}),
    },
    body: body && JSON.stringify(body),
  });
}

async function fixture(demo = false) {
  const id = `share_${randomUUID()}`;
  const storedPlan = structuredClone(DEMO_FIXTURES[0].plan);
  const stopId = randomUUID();
  storedPlan.demo = demo;
  storedPlan.days[0].spots[0].stopId = stopId;
  const record: PlanRecord = {
    id,
    ownerKey: `u:${owner}`,
    plan: storedPlan,
    input: DEMO_FIXTURES[0].input,
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await memoryStore.plans.save(record);
  const context = { params: Promise.resolve({ id }) };
  const command = { stopId, commandId: randomUUID(), action: "arrived", planRevision: 1 };
  return { command, context, record };
}

beforeEach(() => vi.stubEnv("DATA_STORE", "memory"));
afterEach(() => vi.unstubAllEnvs());

describe("私有行中记录", () => {
  it("并发重试只保存一次，主人能读回，分享工件没有实际访问", async () => {
    const { record, context, command } = await fixture();
    const responses = await Promise.all([
      POST(req(record.id, owner, command), context),
      POST(req(record.id, owner, command), context),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const [first, second] = await Promise.all(responses.map((response) => response.json()));
    expect(first.mark).toEqual(second.mark);
    const read = await GET(req(record.id, owner), context);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    expect(await read.json()).toEqual({ revision: 1, marks: [first.mark] });
    expect(await getSharedPlan(record.id)).toEqual(record.plan);
  });

  it("访客和另一个账号无法读写，demo 只读，跨站写入被拒绝", async () => {
    const { record, context, command } = await fixture();
    expect((await GET(req(record.id), context)).status).toBe(401);
    expect((await POST(req(record.id, undefined, command), context)).status).toBe(401);
    expect((await GET(req(record.id, other), context)).status).toBe(404);
    expect((await POST(req(record.id, other, command), context)).status).toBe(404);
    expect((await POST(req(record.id, owner, command, true), context)).status).toBe(403);
    const demo = await fixture(true);
    expect((await POST(req(demo.record.id, owner, demo.command), demo.context)).status).toBe(404);
  });

  it("拦截过时版本、客户端地点与同站冲突，允许在当前版本明确跳过", async () => {
    const { record, context, command } = await fixture();
    await replacePlan(record.id, record.plan);
    expect((await POST(req(record.id, owner, command), context)).status).toBe(409);
    const fresh = { ...command, action: "skipped", planRevision: 2 };
    expect(
      (await POST(req(record.id, owner, { ...fresh, name: "客户端地点" }), context)).status,
    ).toBe(400);
    const saved = await POST(req(record.id, owner, fresh), context);
    expect(saved.status).toBe(201);
    expect((await saved.json()).mark).toMatchObject({
      action: "skipped",
      name: record.plan.days[0].spots[0].name,
    });
    expect(
      (await POST(req(record.id, owner, { ...fresh, action: "arrived" }), context)).status,
    ).toBe(409);
    expect(
      (await POST(req(record.id, owner, { ...fresh, commandId: randomUUID() }), context)).status,
    ).toBe(409);
  });
});
