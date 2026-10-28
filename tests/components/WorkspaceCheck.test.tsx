import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  WorkspaceCheck,
  type PlanCheckResponse,
  type PlanRepairPreview,
} from "@/components/WorkspaceCheck";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import { verifyDocument } from "@/lib/verify/engine";
import type { TripCheckCredential, TripCheckDocument, TripCheckReport } from "@/lib/verify/types";

// 工作台「体检」镜头：体检渲染（两轴/规则证据/凭据/开放体检台链接）、
// 修复两段式（先预览不写库 → 确认写入第 N+1 版 → onPlanChange + 刷新 + 历史）、
// changed=false、404 与 409。fetch 全 mock；报告用真实引擎生成，避免假数据掩盖契约。

const NOW = new Date("2026-10-28T10:00:00.000Z");

const CRED: TripCheckCredential = {
  id: "tc_0123456789abcdef0123456789abcdef",
  algorithm: "sha256",
  inputHash: "a".repeat(64),
  specVersion: "trip-check/0.1",
  engineVersion: "0.2.0",
  rulesetVersion: "2026-10-28.1",
  issuedAt: "2026-10-28T10:00:00.000Z",
  basis:
    "sha256(specVersion|engineVersion|rulesetVersion|sha256(canonical-json({document,options})))",
};
const PARENT_CRED: TripCheckCredential = {
  ...CRED,
  id: "tc_parent0123456789abcdef0123456789",
  inputHash: "b".repeat(64),
};
const AFTER_CRED: TripCheckCredential = {
  ...CRED,
  id: "tc_after9876543210fedcba9876543210",
  inputHash: "c".repeat(64),
};

function doc(times: [string, string]): TripCheckDocument {
  return {
    specVersion: "trip-check/0.1",
    city: "苏州",
    days: [
      {
        day: 1,
        spots: [
          { name: "拙政园", time: times[0], type: "sight", durationMin: 120, costCny: 80 },
          { name: "平江路", time: times[1], type: "sight", durationMin: 90, costCny: 60 },
        ],
      },
    ],
  };
}

// 09:00-11:00 与 10:30-12:00 重叠 → TC-C102 blocking → D 级；修好后 A 级
const before = verifyDocument(doc(["09:00-11:00", "10:30-12:00"]), {}, NOW) as TripCheckReport;
const after = verifyDocument(doc(["09:00-11:00", "11:00-12:30"]), {}, NOW) as TripCheckReport;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function checkResponse(overrides: Partial<PlanCheckResponse> = {}): PlanCheckResponse {
  return {
    shareId: "share_ws01",
    planRevision: 1,
    report: { ...before, credential: CRED },
    credential: CRED,
    tripCheck: null,
    ...overrides,
  };
}

function previewResponse(overrides: Partial<PlanRepairPreview> = {}): PlanRepairPreview {
  return {
    changed: true,
    persisted: false,
    planRevision: 1,
    before,
    after,
    applied: [
      {
        ruleId: "TC-C102",
        day: 1,
        spot: "平江路",
        detail: "第 1 天「平江路」时间 10:30-12:00 → 11:00-12:30（顺延 30 分钟，消除重叠）",
      },
    ],
    unrepairable: [
      {
        ruleId: "TC-F201",
        reason: "地点未核验，需要补事实来源或换点；修复器不编造事实。",
      },
    ],
    parentCredential: PARENT_CRED,
    credential: AFTER_CRED,
    ...overrides,
  };
}

function confirmedResponse(): Record<string, unknown> {
  return {
    changed: true,
    persisted: true,
    revision: 2,
    plan: { ...SAMPLE_PLAN, summary: "修复后：时间轴不再重叠" },
    before,
    after,
    applied: previewResponse().applied,
    unrepairable: previewResponse().unrepairable,
    parentCredential: PARENT_CRED,
    credential: AFTER_CRED,
  };
}

interface Handlers {
  check: () => Response | Promise<Response>;
  repair: (body: Record<string, unknown>) => Response | Promise<Response>;
}

function installFetch(handlers: Handlers) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/plan/check") return handlers.check();
    if (url === "/api/plan/repair") {
      return handlers.repair(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callBody(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch 调用 ${index} 不存在`);
  const [url, init] = call as unknown as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkspaceCheck", () => {
  it("挂载即体检：两轴、规则证据、凭据与开放体检台链接", async () => {
    const fetchMock = installFetch({
      check: () => jsonResponse(checkResponse()),
      repair: () => jsonResponse(previewResponse()),
    });
    render(<WorkspaceCheck plan={SAMPLE_PLAN} shareId="share_ws01" onPlanChange={vi.fn()} />);

    // 结构轴（D 级）+ 事实轴（未核验）并列
    expect(await screen.findByText(/等级 D · 待优化/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "结构自洽性" })).toBeInTheDocument();
    const factsAxis = screen.getByRole("heading", { name: "事实核验" }).closest(".tc-axis");
    expect(factsAxis?.textContent).toContain("未核验");
    expect(factsAxis?.textContent).toContain("地点存在性");

    // 规则级证据：ruleId + title + detail + 证据 + 修复方向
    const issue = before.issues.find((item) => item.ruleId === "TC-C102");
    expect(issue).toBeTruthy();
    expect(screen.getByText("TC-C102")).toBeInTheDocument();
    if (issue) {
      expect(screen.getByText(issue.title)).toBeInTheDocument();
      expect(screen.getByText(issue.detail)).toBeInTheDocument();
      if (issue.fixHint)
        expect(screen.getByText(new RegExp(issue.fixHint.slice(0, 12)))).toBeInTheDocument();
    }
    expect(screen.getByText("时间差 -30 分钟")).toBeInTheDocument();

    // 凭据与开放体检台链接
    expect(screen.getByTestId("tc-ws-check-credential-id")).toHaveTextContent(CRED.id);
    expect(screen.getByRole("link", { name: /在开放体检台查看/ })).toHaveAttribute(
      "href",
      "/verify?share=share_ws01",
    );

    // 无修复历史时不显示数字
    expect(screen.getByText(/还没有已确认写入的修复记录/)).toBeInTheDocument();

    // 请求契约
    const { url, body } = callBody(fetchMock, 0);
    expect(url).toBe("/api/plan/check");
    expect(body).toEqual({ shareId: "share_ws01" });
  });

  it("修复两段式：预览不写库，确认后写入第 N+1 版并刷新报告与历史", async () => {
    const onPlanChange = vi.fn();
    let checkCalls = 0;
    const refreshed = checkResponse({
      planRevision: 2,
      report: { ...after, credential: AFTER_CRED },
      credential: AFTER_CRED,
      tripCheck: {
        credentialId: AFTER_CRED.id,
        parentCredentialId: PARENT_CRED.id,
        repairedAt: NOW.getTime(),
        repairCount: 1,
        applied: 1,
      },
    });
    const fetchMock = installFetch({
      check: () => {
        checkCalls += 1;
        return jsonResponse(checkCalls === 1 ? checkResponse() : refreshed);
      },
      repair: (body) =>
        body.confirm ? jsonResponse(confirmedResponse()) : jsonResponse(previewResponse()),
    });
    const user = userEvent.setup();
    render(<WorkspaceCheck plan={SAMPLE_PLAN} shareId="share_ws01" onPlanChange={onPlanChange} />);

    await screen.findByText(/等级 D · 待优化/);
    await user.click(screen.getByRole("button", { name: /先预览修复/ }));

    expect(await screen.findByText("预览：确认后才写入")).toBeInTheDocument();
    const compare = screen.getByRole("group", { name: "修复前后对比" });
    expect(compare.textContent).toContain(`等级 ${before.verdict.consistency.grade} ·`);
    expect(compare.textContent).toContain(`等级 ${after.verdict.consistency.grade} ·`);
    expect(compare.textContent).toContain(`评分 ${before.verdict.consistency.score} / 100`);
    expect(compare.textContent).toContain(`评分 ${after.verdict.consistency.score} / 100`);

    const preview = previewResponse();
    expect(screen.getByText(preview.applied[0].detail)).toBeInTheDocument();
    expect(screen.getByText(/修不了的问题（1 条）/)).toBeInTheDocument();
    expect(screen.getByText(preview.unrepairable[0].reason)).toBeInTheDocument();
    expect(screen.getByTestId("tc-ws-check-parent-credential")).toHaveTextContent(PARENT_CRED.id);
    expect(screen.getByTestId("tc-ws-check-repair-credential")).toHaveTextContent(AFTER_CRED.id);

    // 预览请求：confirm:false（不写库）
    const previewCall = callBody(fetchMock, 1);
    expect(previewCall.url).toBe("/api/plan/repair");
    expect(previewCall.body).toEqual({ shareId: "share_ws01", confirm: false });
    expect(onPlanChange).not.toHaveBeenCalled();

    // 确认写入：confirm:true + expectedRevision=体检返回的 planRevision(1)
    await user.click(screen.getByRole("button", { name: "确认写入第 2 版" }));
    await waitFor(() => expect(onPlanChange).toHaveBeenCalledTimes(1));
    expect(onPlanChange.mock.calls[0][0]).toEqual(
      expect.objectContaining({ summary: "修复后：时间轴不再重叠" }),
    );
    const confirmCall = callBody(fetchMock, 2);
    expect(confirmCall.body).toEqual({
      shareId: "share_ws01",
      confirm: true,
      expectedRevision: 1,
    });

    // 成功提示 + 刷新后的报告/历史（以服务端为准）
    expect(await screen.findByText(/已写入第 2 版/)).toBeInTheDocument();
    expect(await screen.findByTestId("tc-ws-check-history-credential")).toHaveTextContent(
      AFTER_CRED.id,
    );
    expect(screen.getByText("1 次")).toBeInTheDocument();
    await waitFor(() => expect(checkCalls).toBe(2));
    expect(await screen.findByText(/等级 A · 可执行/)).toBeInTheDocument();
    expect(screen.queryByText("预览：确认后才写入")).not.toBeInTheDocument();
  });

  it("预览 changed=false：明确没有可机械修复的问题，且不提供写入", async () => {
    installFetch({
      check: () =>
        jsonResponse(
          checkResponse({
            report: { ...after, credential: CRED },
            planRevision: 2,
          }),
        ),
      repair: () =>
        jsonResponse(
          previewResponse({ changed: false, before: after, after, applied: [], unrepairable: [] }),
        ),
    });
    const user = userEvent.setup();
    render(<WorkspaceCheck plan={SAMPLE_PLAN} shareId="share_ws01" onPlanChange={vi.fn()} />);

    await screen.findByText(/等级 A · 可执行/);
    await user.click(screen.getByRole("button", { name: /先预览修复/ }));

    expect(await screen.findByText("没有可机械修复的问题")).toBeInTheDocument();
    expect(screen.getByText(/没有可写入的变更/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /确认写入/ })).not.toBeInTheDocument();
  });

  it("旧版只读链接（planRevision=null）：体检可用，但修复入口改为只读说明", async () => {
    installFetch({
      check: () => jsonResponse(checkResponse({ planRevision: null })),
      repair: () => jsonResponse(previewResponse()),
    });
    render(<WorkspaceCheck plan={SAMPLE_PLAN} shareId="share_ws01" onPlanChange={vi.fn()} />);

    await screen.findByText(/等级 D · 待优化/);
    expect(screen.getByText(/旧版分享（只读）/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /先预览修复/ })).not.toBeInTheDocument();
  });

  it("体检 404：明确说没找到行程，并给重试入口", async () => {
    installFetch({
      check: () => jsonResponse({ error: "not_found" }, 404),
      repair: () => jsonResponse(previewResponse()),
    });
    render(<WorkspaceCheck plan={SAMPLE_PLAN} shareId="share_ws01" onPlanChange={vi.fn()} />);

    expect(await screen.findByText("没找到这份行程（404）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试体检" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /先预览修复/ })).not.toBeInTheDocument();
  });

  it("确认写入 409：提示版本冲突并刷新后重新预览", async () => {
    let checkCalls = 0;
    const fetchMock = installFetch({
      check: () => {
        checkCalls += 1;
        return jsonResponse(checkResponse());
      },
      repair: (body) =>
        body.confirm
          ? jsonResponse({ error: "revision_conflict", revision: 3 }, 409)
          : jsonResponse(previewResponse()),
    });
    const user = userEvent.setup();
    render(<WorkspaceCheck plan={SAMPLE_PLAN} shareId="share_ws01" onPlanChange={vi.fn()} />);

    await screen.findByText(/等级 D · 待优化/);
    await user.click(screen.getByRole("button", { name: /先预览修复/ }));
    await screen.findByText("预览：确认后才写入");
    await user.click(screen.getByRole("button", { name: "确认写入第 2 版" }));

    expect(await screen.findByText("版本冲突（409）")).toBeInTheDocument();
    expect(screen.getByText(/到第 3 版/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "刷新体检后重新预览" }));

    await waitFor(() => expect(checkCalls).toBe(2));
    expect(screen.queryByText("预览：确认后才写入")).not.toBeInTheDocument();
    // check(1) + preview(2) + confirm 409(3) + 刷新 check(4)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
