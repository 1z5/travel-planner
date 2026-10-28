import { afterEach, describe, expect, it, vi } from "vitest";

// CloneCTA 用 useRouter 做克隆后跳转——jsdom 里没有 App Router 上下文
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => searchParams,
}));
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TripWorkspace } from "@/components/TripWorkspace";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import { verifyDocument } from "@/lib/verify/engine";
import type { TripCheckCredential, TripCheckReport } from "@/lib/verify/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 工作台「体检」镜头挂载时会 POST /api/plan/check；这里给一份最小合法响应 */
function stubCheckFetch() {
  const report = verifyDocument(
    {
      specVersion: "trip-check/0.1",
      city: "苏州",
      days: [{ day: 1, spots: [{ name: "拙政园", time: "09:00-10:00" }] }],
    },
    {},
    new Date("2026-10-28T10:00:00.000Z"),
  ) as TripCheckReport;
  const credential: TripCheckCredential = {
    id: "tc_wscheck0123456789abcdef0123456",
    algorithm: "sha256",
    inputHash: "d".repeat(64),
    specVersion: "trip-check/0.1",
    engineVersion: "0.2.0",
    rulesetVersion: "2026-10-28.1",
    issuedAt: "2026-10-28T10:00:00.000Z",
    basis:
      "sha256(specVersion|engineVersion|rulesetVersion|sha256(canonical-json({document,options})))",
  };
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          shareId: "share_ws01",
          planRevision: 1,
          report: { ...report, credential },
          credential,
          tripCheck: null,
        }),
      }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Trip Workspace：一个行程五个镜头。这里只钉「壳」的契约——镜头可切换、
// 默认在规划、地图镜头按天给点位、今日镜头渲染行中视图、体检镜头深链可用。
// PlanView/TodayView/WorkspaceCheck 自身的行为由它们各自的测试覆盖。

describe("Trip Workspace", () => {
  it("默认进入规划镜头，Header 带城市/天数/核验状态", () => {
    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);

    expect(
      screen.getByRole("heading", { level: 1, name: `${SAMPLE_PLAN.city} · 3 天行程` }),
    ).toBeInTheDocument();
    // SAMPLE_PLAN 没有 verification 字段：不谎称已核验
    expect(screen.getByText("核验状态未知")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /规划/ })).toHaveAttribute("aria-selected", "true");
  });

  it("切到地图镜头：可按天切换，并列出当天点位", async () => {
    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);

    await userEvent.click(screen.getByRole("tab", { name: /地图/ }));
    expect(screen.getByRole("tab", { name: /地图/ })).toHaveAttribute("aria-selected", "true");

    // 默认第 1 天：列表里应出现第 1 天的点位（地图降级示意图也会渲染站名，
    // 所以用 getAllByText 而不是 getByText）
    expect(screen.getAllByText("拙政园").length).toBeGreaterThan(0);

    // 切到第 3 天：出现第 3 天的点位（同里古镇）
    await userEvent.click(screen.getByRole("button", { name: /Day 3/ }));
    expect(screen.getAllByText("同里古镇").length).toBeGreaterThan(0);
  });

  it("切到今日镜头：渲染行中模式", async () => {
    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);
    await userEvent.click(screen.getByRole("tab", { name: /今日/ }));
    expect(screen.getAllByText("行中模式").length).toBeGreaterThan(0);
  });

  it("深链 ?view=map 直接落到地图镜头（不执行自动 heuristic）", () => {
    searchParams = new URLSearchParams("view=map");
    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);
    expect(screen.getByRole("tab", { name: /地图/ })).toHaveAttribute("aria-selected", "true");
    searchParams = new URLSearchParams();
  });

  it("复制链接：写入剪贴板并反馈已复制", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);
    await userEvent.click(screen.getByRole("button", { name: /复制链接/ }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("/p/share_ws01");
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });

  it("第五镜头「体检」：切过去会拉取并渲染体检报告", async () => {
    const fetchMock = stubCheckFetch();
    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);

    await userEvent.click(screen.getByRole("tab", { name: /体检/ }));
    expect(screen.getByRole("tab", { name: /体检/ })).toHaveAttribute("aria-selected", "true");

    expect(await screen.findByText("这份行程能不能照着走")).toBeInTheDocument();
    expect(screen.getByTestId("tc-ws-check-credential-id")).toBeInTheDocument();
    // 工作台挂载时还会 fire-and-forget 上报 plan_opened（/api/events），只筛体检请求
    const checkCalls = fetchMock.mock.calls.filter((call) => call[0] === "/api/plan/check");
    expect(checkCalls).toHaveLength(1);
  });

  it("深链 ?view=check 直接落到体检镜头", async () => {
    stubCheckFetch();
    searchParams = new URLSearchParams("view=check");
    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);

    expect(screen.getByRole("tab", { name: /体检/ })).toHaveAttribute("aria-selected", "true");
    await waitFor(() =>
      expect(screen.getByTestId("tc-ws-check-credential-id")).toBeInTheDocument(),
    );
    searchParams = new URLSearchParams();
  });

  it("demo 行程：Header 只读徽章 + 全镜头提示，规划镜头隐藏写入口", () => {
    const demoPlan = { ...SAMPLE_PLAN, demo: true };
    const { container } = render(<TripWorkspace plan={demoPlan} shareId="share_ws01" />);

    expect(container.querySelector(".tc-demo-badge")).toHaveTextContent("示例行程 · 只读");
    expect(screen.getByRole("note", { name: "示例行程只读提示" })).toBeInTheDocument();
    // PlanView editable=false：重排/一句话改/一键修复入口都不渲染
    expect(screen.queryByText("重排这天")).not.toBeInTheDocument();
    expect(screen.queryByText("一句话改")).not.toBeInTheDocument();
    // 克隆入口保留（demo 允许克隆成自己的行程）
    expect(screen.getByText(/克隆成你的行程后即可编辑/)).toBeInTheDocument();
  });

  it("demo 行程：调整镜头按钮禁用 + 拖拽关闭，并说明原因", async () => {
    const demoPlan = { ...SAMPLE_PLAN, demo: true };
    const { container } = render(<TripWorkspace plan={demoPlan} shareId="share_ws01" />);

    await userEvent.click(screen.getByRole("tab", { name: /调整/ }));
    expect(screen.getByText(/顺序与时间轴不可调整/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /顺延时间轴/ })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /上移/ })[0]).toBeDisabled();
    expect(container.querySelector(".arrange-item")).toHaveAttribute("draggable", "false");
  });

  it("demo 行程：体检镜头只读（修复卡由只读锁隐藏），体检报告仍可看", async () => {
    stubCheckFetch();
    const demoPlan = { ...SAMPLE_PLAN, demo: true };
    const { container } = render(<TripWorkspace plan={demoPlan} shareId="share_ws01" />);

    await userEvent.click(screen.getByRole("tab", { name: /体检/ }));
    expect(await screen.findByText("这份行程能不能照着走")).toBeInTheDocument();
    // 跨组件写入口（确定性修复卡）由 .tc-demo-lock 在样式层隐藏
    expect(container.querySelector(".tc-demo-lock")).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "示例行程只读提示" })).toBeInTheDocument();
  });

  it("非 demo 行程：没有只读徽章/提示，调整入口保持可用（负向断言）", async () => {
    const { container } = render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);

    expect(container.querySelector(".tc-demo-badge")).toBeNull();
    expect(screen.queryByRole("note", { name: "示例行程只读提示" })).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: /调整/ }));
    expect(screen.getByRole("button", { name: /顺延时间轴/ })).not.toBeDisabled();
    expect(container.querySelector(".arrange-item")).toHaveAttribute("draggable", "true");
  });
});
