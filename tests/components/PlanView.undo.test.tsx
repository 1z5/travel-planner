import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanView } from "@/components/PlanView";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// 撤销这次修改（A4 延伸）：改坏了能退回上一版，且撤销走服务端（落成新版本）。

const WARNING = "第 3 天有 1 段「时间接不上」：…可用「一键顺延」重排当天时间轴";

describe("PlanView 撤销这次修改", () => {
  it("顺延成功后的横幅里有撤销按钮；点撤销 → POST /api/plan/restore（带修改前那一版）", async () => {
    const before = { ...SAMPLE_PLAN, warnings: [WARNING] };
    const after = { ...SAMPLE_PLAN, warnings: [] as string[] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ plan: after, revision: 2 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ plan: before, revision: 3 }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlanView plan={before} shareId="share_undo1" editable />);
    await userEvent.click(screen.getByText("一键顺延"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const undoBtn = await screen.findByRole("button", { name: /撤销这次修改/ });
    await userEvent.click(undoBtn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/api/plan/restore");
    const body = JSON.parse(String(init.body));
    expect(body.shareId).toBe("share_undo1");
    // 撤销载荷必须是「修改前那一版」（含原来的预警），不是当前版
    expect(body.plan.warnings).toEqual([WARNING]);

    // 撤销成功：提示「已撤销」+ 版本号更新
    expect(await screen.findByText("已撤销，回到修改前的版本")).toBeInTheDocument();
    expect(screen.getByText(/已更新 · 第 3 版/)).toBeInTheDocument();
  });
});
