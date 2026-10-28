import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TripCheckShareActions } from "@/components/TripCheckShareActions";
import { verifyDocument } from "@/lib/verify/engine";
import type { TripCheckCredential, TripCheckReport } from "@/lib/verify/types";

// 体检报告的传播动作：复制纯文本（含在线报告 URL + 凭据 ID）、复制 JSON、
// 下载失败/剪贴板失败的兜底（展开可手动复制的 details）、海报链接。
// clipboard/下载都在测试里 mock，不触浏览器权限。

const NOW = new Date("2026-10-28T10:00:00.000Z");

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

function makeReport(): TripCheckReport {
  const report = verifyDocument(
    {
      specVersion: "trip-check/0.1",
      city: "苏州",
      days: [
        {
          day: 1,
          spots: [
            { name: "拙政园", time: "09:00-11:00", type: "sight", durationMin: 120 },
            { name: "平江路", time: "10:30-12:00", type: "sight", durationMin: 90 },
          ],
        },
      ],
    },
    {},
    NOW,
  ) as TripCheckReport;
  // 页面/分享页传入的是「已附加凭据」的报告（stampPlan 的 report + credential）
  return { ...report, credential: CREDENTIAL };
}

function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TripCheckShareActions", () => {
  it("复制纯文本报告：包含两轴、规则 ID、凭据与在线报告 URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const report = makeReport();
    render(
      <TripCheckShareActions
        report={report}
        credentialId={CREDENTIAL.id}
        shareId="share_test01"
        reportUrl="https://example.com/p/share_test01/check"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /复制纯文本报告/ }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = String(writeText.mock.calls[0][0]);
    expect(text).toContain("行程体检报告 · Trip Check trip-check/0.1");
    expect(text).toContain("结构自洽性：D（55/100）");
    expect(text).toContain("[TC-C102]");
    expect(text).toContain(`凭据：${CREDENTIAL.id}`);
    expect(text).toContain("在线报告：https://example.com/p/share_test01/check");
    expect(screen.getByRole("button", { name: /已复制纯文本/ })).toBeInTheDocument();
  });

  it("复制报告 JSON：内容就是页面这份报告（含凭据）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const report = makeReport();
    render(
      <TripCheckShareActions report={report} credentialId={CREDENTIAL.id} shareId="share_test01" />,
    );

    await userEvent.click(screen.getByRole("button", { name: /复制报告 JSON/ }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(writeText.mock.calls[0][0])) as Record<string, unknown>;
    expect(payload).toEqual(report);
    expect((payload.credential as { id: string }).id).toBe(CREDENTIAL.id);
    expect(screen.getByRole("button", { name: /已复制 JSON/ })).toBeInTheDocument();
  });

  it("下载失败：明确提示，并保留可手动复制的 JSON details", async () => {
    // jsdom 没有可用的 Blob URL 下载能力：显式模拟成不支持，验证兜底文案
    const original = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", { value: undefined, configurable: true });
    try {
      const report = makeReport();
      render(
        <TripCheckShareActions
          report={report}
          credentialId={CREDENTIAL.id}
          shareId="share_test01"
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: /下载 \.json/ }));

      expect(screen.getByText(/当前浏览器不支持直接下载/)).toBeInTheDocument();
      expect(screen.getByText("报告 JSON（可手动复制）")).toBeInTheDocument();
      expect(screen.getAllByText(/"specVersion": "trip-check\/0.1"/).length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(URL, "createObjectURL", { value: original, configurable: true });
    }
  });

  it("剪贴板失败：指出原因并给出手动复制入口", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const report = makeReport();
    render(
      <TripCheckShareActions report={report} credentialId={CREDENTIAL.id} shareId="share_test01" />,
    );

    await userEvent.click(screen.getByRole("button", { name: /复制纯文本报告/ }));

    expect(screen.getByText(/浏览器不允许写剪贴板/)).toBeInTheDocument();
    expect(screen.getByText("纯文本报告（可手动复制）")).toBeInTheDocument();
  });

  it("保存体检海报：链到 /p/<id>/check/poster 并新开窗口", () => {
    const report = makeReport();
    render(
      <TripCheckShareActions report={report} credentialId={CREDENTIAL.id} shareId="share_test01" />,
    );

    const poster = screen.getByRole("link", { name: /保存体检海报/ });
    expect(poster).toHaveAttribute("href", "/p/share_test01/check/poster");
    expect(poster).toHaveAttribute("target", "_blank");
  });
});
