import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PosterCover } from "@/components/PosterCover";
import type { Plan, PlanDay, PlanSpot, SpotType } from "@/lib/types";

// CloneCTA（切片2）用 useRouter 做完成后跳转——jsdom 里没有 App Router
// 上下文会抛 invariant。这里 mock 掉路由：本测试钉的是海报自身的契约，
// 克隆交互由 tests/components/CloneCTA.test.tsx 覆盖。
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// 切片1 · 海报级分享页：封面海报组件测试。
//
// 钉住的契约（与任务规格的验收标准一一对应）：
// 1. 数据齐全 → 全部 4 枚徽章（天数 / 站点 / 人均总花费 / 预算使用率）；
// 2. 缺 budgetCny → 使用率徽章整枚不出现（不猜使用率）；
// 3. MOCK 行程（无坐标）→ 地图块整块不渲染（海报不做示意图降级）；
// 4. 有坐标（验真命中）→ 地图块渲染（RealMap）；
// 5. 站点数按名称去重（同一家酒店连住 3 天算一站）；
// 6. 纯增量接口：旅行报告链接指向 /r/<shareId>；CloneCTA 已挂载（见切片2）。

function spot(name: string, type: SpotType | string, costCny: number, location?: string): PlanSpot {
  return {
    period: "morning",
    time: "09:00-10:00",
    type: type as SpotType,
    name,
    area: "测试区",
    durationMin: 60,
    costCny,
    reason: "单测用",
    ...(location ? { location } : {}),
  };
}

function makePlan(opts: { budgetCny?: number; located?: boolean; zeroCost?: boolean } = {}): Plan {
  const loc = (suffix: string) => (opts.located ? `120.62${suffix},31.32${suffix}` : undefined);
  const day1: PlanDay = {
    day: 1,
    theme: "姑苏园林古韵",
    spots: [
      spot("拙政园", "sight", opts.zeroCost ? 0 : 90, loc("1")),
      spot("苏州博物馆", "sight", 0, loc("2")),
    ],
    transitMin: 0,
    dailyCostCny: opts.zeroCost ? 0 : 90,
  };
  const day2: PlanDay = {
    day: 2,
    theme: "天平山间古镇",
    spots: [spot("天平山", "sight", opts.zeroCost ? 0 : 30)],
    transitMin: 0,
    dailyCostCny: opts.zeroCost ? 0 : 30,
  };
  return {
    city: "苏州",
    summary: "测试行程",
    days: [day1, day2],
    totalCostCny: opts.zeroCost ? 0 : 120,
    tips: [],
    warnings: [],
    verified: opts.located ?? false,
    ...(opts.budgetCny !== undefined ? { budgetCny: opts.budgetCny } : {}),
  };
}

describe("PosterCover", () => {
  it("数据齐全：城市大标题 + 副题四要素 + 全部 4 枚徽章 + 报告链接", () => {
    const { container } = render(
      <PosterCover plan={makePlan({ budgetCny: 150, located: true })} shareId="share_test001" />,
    );

    // 城市大标题（衬线大字）
    expect(container.querySelector(".poster-city")?.textContent).toBe("苏州");

    // 副题：N 天 · M 站 · 人均 ¥X · 主题（主题用「、」连接，与「·」分隔符不混淆）
    const sub = container.querySelector(".poster-sub")?.textContent ?? "";
    expect(sub).toContain("2 天");
    expect(sub).toContain("3 站"); // 拙政园 + 苏州博物馆 + 天平山（去重后）
    expect(sub).toContain("人均 ¥120");
    expect(sub).toContain("姑苏园林古韵、天平山间古镇");

    // 4 枚徽章：天数 2 / 站点 3 / 人均 ¥120 / 预算使用率 80%（120/150）
    expect(container.querySelectorAll(".poster-badge")).toHaveLength(4);
    expect(container.textContent).toContain("人均总花费");
    expect(container.textContent).toContain("预算使用率");
    expect(container.textContent).toContain("80%");

    // 有坐标 → 渲染地图块（RealMap 懒加载：jsdom 无 IntersectionObserver 直接 armed）
    expect(container.querySelector(".poster-map-wrap")).not.toBeNull();

    // 旅行报告链接（切片4 在建，链接先就位）
    const report = screen.getByText("旅行报告").closest("a");
    expect(report?.getAttribute("href")).toBe("/r/share_test001");
  });

  it("缺 budgetCny：使用率徽章不出现，其余徽章照常", () => {
    const { container } = render(<PosterCover plan={makePlan()} shareId="share_test002" />);
    expect(container.querySelectorAll(".poster-badge")).toHaveLength(3);
    expect(container.textContent).not.toContain("预算使用率");
    // 副题同样不出使用率相关数字
    expect(container.querySelector(".poster-sub")?.textContent).not.toContain("%");
  });

  it("MOCK 行程（无坐标）：地图块整块不渲染——海报不做示意图降级", () => {
    const { container } = render(<PosterCover plan={makePlan()} shareId="share_test003" />);
    expect(container.querySelector(".poster-map-wrap")).toBeNull();
  });

  it("坐标不足 2 个：地图块同样不渲染（画不出路线就不画）", () => {
    const plan = makePlan({ located: true });
    // 只保留第一个点有坐标
    plan.days[0].spots[1].location = undefined;
    const { container } = render(<PosterCover plan={plan} shareId="share_test004" />);
    expect(container.querySelector(".poster-map-wrap")).toBeNull();
  });

  it("无花费数据（total=0）：人均花费徽章与副题段都不出现（不渲染 ¥0）", () => {
    const { container } = render(
      <PosterCover plan={makePlan({ budgetCny: 150, zeroCost: true })} shareId="share_test005" />,
    );
    expect(container.textContent).not.toContain("人均总花费");
    expect(container.querySelector(".poster-sub")?.textContent).not.toContain("人均");
  });

  it("站点数按名称去重：同一酒店住两晚只算一站", () => {
    const plan = makePlan();
    plan.days[1].spots.push(spot("苏州博物馆", "sight", 0)); // 第 2 天重复出现同一景点
    const { container } = render(<PosterCover plan={plan} shareId="share_test006" />);
    expect(container.querySelector(".poster-sub")?.textContent).toContain("3 站");
  });

  it("主题超过 3 天：副题截断并补「等」（截断必须可辨识）", () => {
    const plan = makePlan();
    for (let i = 3; i <= 5; i++) {
      plan.days.push({
        day: i,
        theme: `第 ${i} 天主题`,
        spots: [spot(`点${i}`, "sight", 10)],
        transitMin: 0,
        dailyCostCny: 10,
      });
    }
    const { container } = render(<PosterCover plan={plan} shareId="share_test007" />);
    const sub = container.querySelector(".poster-sub")?.textContent ?? "";
    expect(sub).toContain("姑苏园林古韵、天平山间古镇、第 3 天主题等");
    expect(sub).not.toContain("第 5 天主题");
  });
});
