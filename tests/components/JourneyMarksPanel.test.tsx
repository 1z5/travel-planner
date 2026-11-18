import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JourneyMarksPanel } from "@/components/JourneyMarksPanel";
import { DEMO_FIXTURES } from "@/demo/fixtures";

afterEach(() => vi.unstubAllGlobals());

it("展开后读取私人记录，先显示跳过按钮，确认保存后显示已跳过", async () => {
  const spot = { ...DEMO_FIXTURES[0].plan.days[0].spots[0], stopId: crypto.randomUUID() };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ revision: 2, marks: [] }))
    .mockResolvedValueOnce(Response.json({ mark: { stopId: spot.stopId, action: "skipped" } }));
  vi.stubGlobal("fetch", fetch);

  render(<JourneyMarksPanel shareId="share_test" spots={[spot]} />);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "记录今天的进展" }));
  fireEvent.click(await screen.findByRole("button", { name: `跳过${spot.name}` }));

  expect(await screen.findByText("已跳过")).toBeInTheDocument();
  expect(fetch).toHaveBeenNthCalledWith(1, "/api/journey/share_test", { cache: "no-store" });
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({
    action: "skipped",
    stopId: spot.stopId,
    planRevision: 2,
  });
});
