import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TripCheckPlayground } from "@/components/TripCheckPlayground";
import type { TripCheckRepairResponse } from "@/components/TripCheckReport";
import { verifyDocument } from "@/lib/verify/engine";
import { repairDocument } from "@/lib/verify/repair";
import { TRIP_CHECK_SAMPLES } from "@/lib/verify/samples";
import type { TripCheckCredential, TripCheckReport } from "@/lib/verify/types";

// /verify 体检台的组件测试：示例 → 提交 → 两轴报告 + 凭据；
// 以及确定性修复（/api/verify/repair）：before→after、已修/修不了、前后凭据链、
// changed=false、错误分支。fetch 一律 stub，不触网；报告与修复结果都用真实纯函数生成
// （engine / repair），避免手写假数据掩盖契约漂移。

const NOW = new Date("2026-10-28T10:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const CREDENTIAL: TripCheckCredential = {
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

/** 修复前的凭据（输入文档） */
const PARENT_CREDENTIAL: TripCheckCredential = {
  ...CREDENTIAL,
  id: "tc_parent0123456789abcdef0123456789",
  inputHash: "b".repeat(64),
};

/** 修复后的凭据（修复后文档） */
const AFTER_CREDENTIAL: TripCheckCredential = {
  ...CREDENTIAL,
  id: "tc_after9876543210fedcba9876543210",
  inputHash: "c".repeat(64),
};

/** 用真实引擎算一份示例的报告，再补上 API 签发的凭据 */
function reportOfSample(index: number): TripCheckReport {
  const sample = TRIP_CHECK_SAMPLES[index];
  const report = verifyDocument(sample.document, {}, NOW) as TripCheckReport;
  return { ...report, credential: CREDENTIAL };
}

/** 用真实修复器算示例的修复结果，再补上 API 层语义字段与前后凭据链 */
function repairResponseOfSample(index: number): TripCheckRepairResponse {
  const sample = TRIP_CHECK_SAMPLES[index];
  const result = repairDocument(sample.document, {}, NOW);
  return {
    ...result,
    changed: result.applied.length > 0,
    persisted: false,
    source: "document",
    parentCredential: PARENT_CREDENTIAL,
    credential: AFTER_CREDENTIAL,
  };
}

function requestOf(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch 未被调用");
  const [url, init] = call as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TripCheckPlayground", () => {
  it("载入示例：填充文本域，并明说示例营业时间不是真实承诺", async () => {
    const user = userEvent.setup();
    render(<TripCheckPlayground />);

    const textarea = screen.getByLabelText(/行程 JSON/);
    expect(textarea).toHaveValue("");

    await user.click(screen.getByRole("button", { name: /已核验行程（苏州 2 天）/ }));

    expect((textarea as HTMLTextAreaElement).value).toContain("拙政园");
    expect((textarea as HTMLTextAreaElement).value).toContain("trip-check/0.1");
    // 示例区必须与按钮同屏声明「示意数据、不构成真实营业时间承诺」
    expect(screen.getByText(/示例营业时间为示意数据，不构成真实营业时间承诺/)).toBeInTheDocument();
  });

  it("点体检：POST 文档到 /api/verify，展示结构等级与凭据", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(reportOfSample(0)));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TripCheckPlayground />);

    await user.click(screen.getByRole("button", { name: /已核验行程（苏州 2 天）/ }));
    await user.click(screen.getByRole("button", { name: "开始体检" }));

    // 结构轴：A 级 + 分数
    const gradeLine = await screen.findByText(/等级 A · 可执行/);
    expect(gradeLine.closest(".tc-axis")?.textContent).toContain("评分 100 / 100");
    // 事实轴：覆盖率与来源独立展示（不折成分数）
    const factsAxis = screen.getByRole("heading", { name: "事实核验" }).closest(".tc-axis");
    expect(factsAxis?.textContent).toContain("5 / 5 已核验");
    expect(factsAxis?.textContent).toContain("高德 × 5");
    // 凭据：ID 直接可见
    expect(screen.getByTestId("tc-credential-id")).toHaveTextContent(CREDENTIAL.id);
    expect(
      screen.getByText("同一文档 + 同版本引擎 → 同一凭据 ID，可独立复算。"),
    ).toBeInTheDocument();

    // 请求契约：document 路径、默认口径不传 options（避免无意改变凭据输入哈希）
    const { url, init, body } = requestOf(fetchMock);
    expect(url).toBe("/api/verify");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect((body.document as { specVersion: string }).specVersion).toBe("trip-check/0.1");
    expect(body.options).toBeUndefined();
  });

  it("400：把服务端的 errors[].path 逐条展示，不合并成一句「格式错误」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: "invalid_request",
            errors: [
              { path: "days.0.spots.0.time", message: "时间不能为空" },
              { path: "specVersion", message: 'specVersion 必须是 "trip-check/0.1"' },
            ],
          },
          400,
        ),
      ),
    );
    const user = userEvent.setup();
    render(<TripCheckPlayground />);

    await user.click(screen.getByRole("button", { name: /未核验行程（杭州 1 天）/ }));
    await user.click(screen.getByRole("button", { name: "开始体检" }));

    expect(await screen.findByText("请求不合法（400）")).toBeInTheDocument();
    expect(screen.getByText("days.0.spots.0.time")).toBeInTheDocument();
    expect(screen.getByText("时间不能为空")).toBeInTheDocument();
    expect(screen.getByText("specVersion")).toBeInTheDocument();
    expect(screen.getByText(/specVersion 必须是/)).toBeInTheDocument();
    // 失败时不得渲染报告（不能拿旧结果冒充这次结论）
    expect(screen.queryByTestId("tc-credential-id")).not.toBeInTheDocument();
  });

  it("空输入：不发请求，给出本地提示", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TripCheckPlayground />);

    await user.click(screen.getByRole("button", { name: "开始体检" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("还没有行程内容")).toBeInTheDocument();
  });

  it("?share=：带初始分享 ID 时自动体检一次，body 只提交 shareId", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(reportOfSample(0)));
    vi.stubGlobal("fetch", fetchMock);
    render(<TripCheckPlayground initialShareId="share_abcdefgh1234" />);

    // 分享 ID 模式：没有 JSON 文本域，输入框已填好
    expect(screen.queryByLabelText(/行程 JSON/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/分享行程 ID/)).toHaveValue("share_abcdefgh1234");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requestOf(fetchMock).body).toEqual({ shareId: "share_abcdefgh1234" });
    expect(await screen.findByText(/等级 A · 可执行/)).toBeInTheDocument();
  });

  it("换输入后清空旧报告：旧结论不能看起来像新输入的结论", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(reportOfSample(0))),
    );
    const user = userEvent.setup();
    render(<TripCheckPlayground />);

    await user.click(screen.getByRole("button", { name: /已核验行程（苏州 2 天）/ }));
    await user.click(screen.getByRole("button", { name: "开始体检" }));
    expect(await screen.findByTestId("tc-credential-id")).toBeInTheDocument();

    // 载入另一份示例 = 换了输入，旧报告必须消失（而不是留在原处误导）
    await user.click(screen.getByRole("button", { name: /有问题的行程（闭馆\/重叠）/ }));
    expect(screen.queryByTestId("tc-credential-id")).not.toBeInTheDocument();
    expect(screen.queryByText(/等级 A · 可执行/)).not.toBeInTheDocument();
  });

  it("确定性修复：before→after、已修清单、凭据链，并沿用同一份输入", async () => {
    const repairPayload = repairResponseOfSample(1); // 闭馆/重叠示例：可修 C102
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/verify/repair" ? jsonResponse(repairPayload) : jsonResponse(reportOfSample(1)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TripCheckPlayground />);

    await user.click(screen.getByRole("button", { name: /有问题的行程（闭馆\/重叠）/ }));
    await user.click(screen.getByRole("button", { name: "开始体检" }));

    const repairRegion = await screen.findByRole("region", { name: "确定性修复" });
    await user.click(within(repairRegion).getByRole("button", { name: "确定性修复" }));

    expect(await within(repairRegion).findByText(/已修复 · 结论改善/)).toBeInTheDocument();
    // before → after 的分数/等级来自响应里的两次真实判定
    const compare = within(repairRegion).getByRole("group", { name: "修复前后对比" });
    const before = repairPayload.before.verdict.consistency;
    const after = repairPayload.after.verdict.consistency;
    expect(compare.textContent).toContain(`等级 ${before.grade} ·`);
    expect(compare.textContent).toContain(`等级 ${after.grade} ·`);
    expect(compare.textContent).toContain(`评分 ${before.score} / 100`);
    expect(compare.textContent).toContain(`评分 ${after.score} / 100`);
    expect(compare.textContent).toContain(`阻断 ${repairPayload.before.stats.blocking}`);
    expect(compare.textContent).toContain(`阻断 ${repairPayload.after.stats.blocking}`);
    expect(before.grade).not.toBe(after.grade);

    // 已修明细 + 修不了的显眼区块
    for (const item of repairPayload.applied) {
      expect(within(repairRegion).getByText(item.detail)).toBeInTheDocument();
    }
    expect(within(repairRegion).getByText(/修不了的问题（/)).toBeInTheDocument();
    expect(within(repairRegion).getByText(/修复器不编造地点/)).toBeInTheDocument();

    // 前后凭据链 + 新文档动作
    expect(within(repairRegion).getByTestId("tc-repair-parent-credential")).toHaveTextContent(
      PARENT_CREDENTIAL.id,
    );
    expect(within(repairRegion).getByTestId("tc-repair-credential")).toHaveTextContent(
      AFTER_CREDENTIAL.id,
    );
    expect(
      within(repairRegion).getByText(/前后两张凭据都可复算，能对账改了哪些/),
    ).toBeInTheDocument();
    expect(within(repairRegion).getByRole("button", { name: /复制文档 JSON/ })).toBeInTheDocument();
    expect(within(repairRegion).getByRole("button", { name: /下载 \.json/ })).toBeInTheDocument();

    // 修复请求 = 同一份输入（与体检请求体完全一致），且命中修复端点
    const verifyCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const repairCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(verifyCall[0]).toBe("/api/verify");
    expect(repairCall[0]).toBe("/api/verify/repair");
    expect(JSON.parse(String(repairCall[1].body))).toEqual(JSON.parse(String(verifyCall[1].body)));

    // 换输入后报告与修复结果一起作废
    await user.click(screen.getByRole("button", { name: /未核验行程（杭州 1 天）/ }));
    expect(screen.queryByRole("region", { name: "确定性修复" })).not.toBeInTheDocument();
  });

  it("修复 changed=false：明确说「没有可机械修复的问题」，不虚构改动", async () => {
    const noopPayload: TripCheckRepairResponse = {
      ...repairResponseOfSample(0), // 已核验示例：修复器无事可做
      // 文档没变 → 前后凭据 ID 相同（同一输入 + 同一版本）
      parentCredential: CREDENTIAL,
      credential: CREDENTIAL,
    };
    expect(noopPayload.changed).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/verify/repair" ? jsonResponse(noopPayload) : jsonResponse(reportOfSample(0)),
      ),
    );
    const user = userEvent.setup();
    render(<TripCheckPlayground />);

    await user.click(screen.getByRole("button", { name: /已核验行程（苏州 2 天）/ }));
    await user.click(screen.getByRole("button", { name: "开始体检" }));
    const repairRegion = await screen.findByRole("region", { name: "确定性修复" });
    await user.click(within(repairRegion).getByRole("button", { name: "确定性修复" }));

    expect(await within(repairRegion).findByText("没有可机械修复的问题")).toBeInTheDocument();
    expect(
      within(repairRegion).getByText(/文档没有变化，所以前后凭据 ID 相同/),
    ).toBeInTheDocument();
    // changed=false 不展示「修复后的文档 / 下载」，避免暗示文档被改过
    expect(
      within(repairRegion).queryByRole("button", { name: /下载 \.json/ }),
    ).not.toBeInTheDocument();
    expect(within(repairRegion).queryByText(/已修复/)).not.toBeInTheDocument();
  });

  it("修复错误：429 复用统一错误展示，原体检报告不被清掉", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/verify/repair"
          ? jsonResponse({ error: "rate_limited", limit: 120 }, 429)
          : jsonResponse(reportOfSample(0)),
      ),
    );
    const user = userEvent.setup();
    render(<TripCheckPlayground />);

    await user.click(screen.getByRole("button", { name: /已核验行程（苏州 2 天）/ }));
    await user.click(screen.getByRole("button", { name: "开始体检" }));
    const repairRegion = await screen.findByRole("region", { name: "确定性修复" });
    await user.click(within(repairRegion).getByRole("button", { name: "确定性修复" }));

    expect(await within(repairRegion).findByText("请求太频繁（429）")).toBeInTheDocument();
    expect(within(repairRegion).getByText(/每小时 120 次/)).toBeInTheDocument();
    // 修复失败不应让体检报告消失
    expect(screen.getByTestId("tc-credential-id")).toBeInTheDocument();
  });
});
