import { beforeEach, describe, expect, it, vi } from "vitest";

// 意愿按钮：点一次上报一次（不重复刷），失败静默不阻断。
vi.mock("@/lib/track", () => ({ track: vi.fn() }));
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntentButton } from "@/components/IntentButton";
import { track } from "@/lib/track";

const mockedTrack = vi.mocked(track);

beforeEach(() => {
  mockedTrack.mockClear();
});

describe("IntentButton", () => {
  it("点击上报 upgrade_intent（meta.tier），按钮变「已记录，谢谢」", async () => {
    render(<IntentButton tier="deep-check" />);
    await userEvent.click(screen.getByRole("button", { name: /我想要这个/ }));
    expect(mockedTrack).toHaveBeenCalledWith("upgrade_intent", { meta: { tier: "deep-check" } });
    expect(screen.getByText("已记录，谢谢")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /已记录你的意愿/ })).toBeDisabled();
  });

  it("重复点击不重复上报（避免把意愿分布刷歪）", async () => {
    render(<IntentButton tier="reminders" />);
    const btn = screen.getByRole("button", { name: /我想要这个/ });
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(mockedTrack).toHaveBeenCalledTimes(1);
  });
});
