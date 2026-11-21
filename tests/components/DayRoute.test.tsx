import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { DayRoute } from "@/components/DayRoute";
import { tokyoLocalTrip } from "../../demo/fixtures/tokyo-local";

it("按坐标显示可选站点，缺坐标的站仍能从索引打开", () => {
  const [first, second] = tokyoLocalTrip().days[0]!.spots;
  const spots = [
    { ...first!, location: "139.8,35.7" },
    { ...second!, location: "" },
  ];
  render(<DayRoute spots={spots} day={1} current={0} distanceFor={() => null} />);
  expect(screen.getByText(/1\/2 站有坐标/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("查看路线站点"), { target: { value: "1" } });
  expect(screen.getByRole("link", { name: "查看本站安排" })).toHaveAttribute(
    "href",
    "#day-1-stop-2",
  );
  fireEvent.click(screen.getByRole("button", { name: "查看第 1 站 浅草寺" }));
  expect(screen.getByRole("link", { name: "查看本站安排" })).toHaveAttribute(
    "href",
    "#day-1-stop-1",
  );
});

it("无坐标时按顺序选站，未定位时不显示距离", () => {
  const spots = tokyoLocalTrip().days[0]!.spots;
  render(<DayRoute spots={spots} day={2} distanceFor={() => null} />);
  fireEvent.click(screen.getByRole("button", { name: /隅田公园/ }));
  expect(screen.getByLabelText("查看路线站点")).toHaveValue("1");
  expect(screen.queryByText(/距定位点/)).not.toBeInTheDocument();
});
