import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpotCandidates } from "@/components/SpotCandidates";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// 「多看几个」面板：候选来自服务端真实核验；缺数据不编；替换走服务端。

function stubFetch(routes: {
  get?: unknown;
  post?: unknown;
  getStatus?: number;
  postStatus?: number;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const isPost = (init?.method ?? "GET") === "POST";
    const status = isPost ? (routes.postStatus ?? 200) : (routes.getStatus ?? 200);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (isPost ? routes.post : routes.get),
    } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SpotCandidates", () => {
  it("加载候选：展示名称/评分/通勤；缺通勤时如实说「通勤未知」", async () => {
    stubFetch({
      get: {
        candidates: [
          {
            name: "候选A",
            area: "测试区",
            rating: 4.6,
            avgCostCny: 88,
            transitMin: 12,
            distanceFromPrevM: 800,
          },
          { name: "候选B", area: "测试区", transitMin: null, distanceFromPrevM: 2500 },
        ],
        prevName: "上一站",
      },
    });
    render(
      <SpotCandidates
        shareId="share_c1"
        day={1}
        spotIndex={0}
        currentName="宽窄巷子"
        onApplied={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText("候选A")).toBeInTheDocument();
    expect(screen.getByText(/通勤约 12 分钟/)).toBeInTheDocument();
    expect(screen.getByText("候选B")).toBeInTheDocument();
    expect(screen.getByText(/通勤未知/)).toBeInTheDocument();
  });

  it("点「换成这个」→ POST 只传名字；成功后回调新 plan 并关闭面板", async () => {
    const onApplied = vi.fn();
    const onClose = vi.fn();
    const { calls } = stubFetch({
      get: { candidates: [{ name: "候选A", area: "测试区", transitMin: 10 }], prevName: null },
      post: { plan: SAMPLE_PLAN, revision: 2 },
    });
    render(
      <SpotCandidates
        shareId="share_c1"
        day={1}
        spotIndex={0}
        currentName="宽窄巷子"
        onApplied={onApplied}
        onClose={onClose}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /把宽窄巷子换成候选A/ }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(SAMPLE_PLAN, 2));
    expect(onClose).toHaveBeenCalled();
    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      shareId: "share_c1",
      day: 1,
      spotIndex: 0,
      name: "候选A",
    });
  });

  it("候选查询失败（如 MOCK 模式 503）→ 明说原因，不展示假清单", async () => {
    stubFetch({ get: { error: "未接入高德（MOCK 模式），没有真实候选可对比" }, getStatus: 503 });
    render(
      <SpotCandidates
        shareId="share_c1"
        day={1}
        spotIndex={0}
        currentName="宽窄巷子"
        onApplied={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(/未接入高德/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /换成这个/ })).not.toBeInTheDocument();
  });

  it("没有候选 → 明确说「不拿相似名字凑数」", async () => {
    stubFetch({ get: { candidates: [], prevName: null } });
    render(
      <SpotCandidates
        shareId="share_c1"
        day={1}
        spotIndex={0}
        currentName="宽窄巷子"
        onApplied={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(/没有找到可替换的真实候选/)).toBeInTheDocument();
  });
});
