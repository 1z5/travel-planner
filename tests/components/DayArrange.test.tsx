import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DayArrange } from "@/components/DayArrange";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// 调整镜头：直接操纵 + 确定性重算 + 失败回滚。
// 只验证交互契约（顺序/请求体/错误回滚），不验证 retimeDay 本身（schedule 单测覆盖）。

const day = SAMPLE_PLAN.days[0];

function mockAdjust(handler: (body: Record<string, unknown>) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    return handler(body);
  });
}

// jsdom 的 fetch 桩只需 ok/status/json 三件套；类型上断言成 Response
const ok = (body: Record<string, unknown> = {}) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ plan: SAMPLE_PLAN, revision: 3, changed: true, notes: [], ...body }),
  }) as unknown as Response;

describe("DayArrange 调整镜头", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("按当前顺序渲染当天点位", () => {
    mockAdjust(() => ok());
    render(<DayArrange shareId="share_arr01" day={day} onPlanChange={() => {}} />);

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(day.spots[0].name);
    expect(items[1]).toHaveTextContent(day.spots[1].name);
  });

  it("点「下移」：乐观换序 + 调 reorder，成功后回填 revision", async () => {
    const calls: Array<Record<string, unknown>> = [];
    mockAdjust((body) => {
      calls.push(body);
      return ok();
    });
    const onPlanChange = vi.fn();
    render(<DayArrange shareId="share_arr01" day={day} onPlanChange={onPlanChange} />);

    await userEvent.click(screen.getByRole("button", { name: `下移 ${day.spots[0].name}` }));

    // 请求体：op=reorder + 当天 + 0 与 1 互换的置换
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({ shareId: "share_arr01", op: "reorder", day: day.day });
    expect(calls[0].order).toEqual([1, 0, ...day.spots.slice(2).map((_, i) => i + 2)]);

    // 乐观 UI：第一个位置已是原来的第二个点
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent(day.spots[1].name);
    // 成功回填：onPlanChange + revision 展示
    await waitFor(() => expect(onPlanChange).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/revision 3/)).toBeInTheDocument();
  });

  it("保存失败：回滚顺序并给出可行动错误", async () => {
    mockAdjust(
      () =>
        ({
          ok: false,
          status: 422,
          json: async () => ({ error: "这份行程缺少真实路段数据，无法自动顺延时间轴" }),
        }) as unknown as Response,
    );
    render(<DayArrange shareId="share_arr01" day={day} onPlanChange={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: `下移 ${day.spots[0].name}` }));

    expect(await screen.findByRole("alert")).toHaveTextContent("缺少真实路段数据");
    // 回滚：顺序恢复原样
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent(day.spots[0].name);
  });

  it("「顺延时间轴」走 op=retime（确定性，不占生成配额）", async () => {
    const calls: Array<Record<string, unknown>> = [];
    mockAdjust((body) => {
      calls.push(body);
      return ok({ notes: ["第 1 天有 1 段缺少真实路段数据，顺延时按 0 分钟衔接"] });
    });
    render(<DayArrange shareId="share_arr01" day={day} onPlanChange={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: /顺延时间轴/ }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({ op: "retime", day: day.day });
    // notes 原样展示（缺数据就说缺，不假装整条链都真实）
    expect(screen.getByText(/缺少真实路段数据/)).toBeInTheDocument();
  });

  it("「撤销上一步」：用上一版顺序再排一次（落库生效，不是本地假撤销）", async () => {
    const calls: Array<Record<string, unknown>> = [];
    mockAdjust((body) => {
      calls.push(body);
      return ok();
    });
    render(<DayArrange shareId="share_arr01" day={day} onPlanChange={() => {}} />);

    // 先撤销不可用（没有上一步）
    expect(screen.getByRole("button", { name: /撤销上一步/ })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: `下移 ${day.spots[0].name}` }));
    await waitFor(() => expect(calls.length).toBe(1));

    await userEvent.click(screen.getByRole("button", { name: /撤销上一步/ }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].order).toEqual(day.spots.map((_, i) => i)); // 回到原顺序
  });
});
