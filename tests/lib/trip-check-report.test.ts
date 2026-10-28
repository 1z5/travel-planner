import { describe, expect, it } from "vitest";
import { verifyDocument } from "@/lib/verify/engine";
import {
  buildCheckPosterModel,
  issueGroupTitle,
  reportHeadline,
  reportPlainText,
} from "@/lib/trip-check-report";
import { getSample } from "@/lib/verify/samples";

const NOW = new Date("2026-10-28T10:00:00.000Z");

function reportOf(id: "verified" | "blocked" | "unverified") {
  return verifyDocument(getSample(id)!.document, {}, NOW);
}

describe("Trip Check 报告工件模型", () => {
  it("headline：一行说清城市/天数/结构等级/事实状态/总体结论", () => {
    expect(reportHeadline(reportOf("verified"))).toBe(
      "苏州 2 天 · 结构 A/100 · 事实已核验 · 未发现阻断",
    );
    expect(reportHeadline(reportOf("blocked"))).toContain("结构 D/55");
    expect(reportHeadline(reportOf("blocked"))).toContain("有阻断问题");
    expect(reportHeadline(reportOf("unverified"))).toContain("事实未核验");
  });

  it("plain text：两轴 + 覆盖 + 分组问题 + 凭据与「不是签名」声明", () => {
    const text = reportPlainText(reportOf("blocked"), {
      url: "https://example.com/check",
      credentialId: "tc_" + "a".repeat(32),
    });
    expect(text).toContain("行程体检报告 · Trip Check trip-check/0.1");
    expect(text).toContain("结构自洽性：D（55/100）");
    expect(text).toContain("阻断问题（按文档数据走不通）");
    expect(text).toContain("[TC-C102]");
    expect(text).toContain("凭据：tc_");
    expect(text).toContain("可复算，不是签名");
    expect(text).toContain("在线报告：https://example.com/check");
  });

  it("plain text：问题带 suggestion 时一并输出（建议与方向分开）", () => {
    // blocked 示例里苏州博物馆周一闭馆：营业时间原文可解析 → 应无窗口建议（闭馆日），
    // 用自定义文档验证「有窗口时给出可安排时段」
    const doc = {
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          date: "2026-11-03", // 周二
          spots: [
            {
              name: "苏州博物馆",
              time: "07:00-09:00", // 早于 09:00 开门
              type: "sight" as const,
              durationMin: 120,
              costCny: 0,
              hours: { openTime: "周二至周日 09:00-17:00" },
              verification: {
                source: "amap" as const,
                existence: "hit" as const,
                hours: "hit" as const,
              },
            },
          ],
        },
      ],
    };
    const r = verifyDocument(doc, {}, NOW);
    const issue = r.issues.find((i) => i.ruleId === "TC-F204");
    expect(issue?.suggestion).toContain("当天营业 09:00-17:00");
    expect(issue?.suggestion).toContain("09:00-11:00");
    expect(issue?.suggestion).toContain("不改你的行程");
    expect(reportPlainText(r)).toContain("建议：当天营业 09:00-17:00");
  });

  it("海报模型：只取阻断/微调问题并截断；溢出数量如实", () => {
    const m = buildCheckPosterModel(reportOf("blocked"), { credentialId: "tc_" + "b".repeat(32) });
    expect(m.grade).toBe("D");
    expect(m.factsLabel).toBe("部分核验");
    expect(m.issues.length).toBeGreaterThan(0);
    expect(m.issues.every((i) => i.detail.length <= 46)).toBe(true);
    expect(m.credentialId).toMatch(/^tc_/);
    expect(m.engineLine).toContain("trip-check/0.1");
    // blocked 示例有 3 阻断 + 0 微调，maxIssues=4 → 无溢出
    expect(m.issueOverflow).toBe(0);
  });

  it("海报模型：干净报告 → 无问题条目，facts 状态如实", () => {
    const m = buildCheckPosterModel(reportOf("verified"));
    expect(m.issues).toHaveLength(0);
    expect(m.factsLabel).toBe("已核验");
  });

  it("分组标题与 UI 口径一致", () => {
    expect(issueGroupTitle("blocking")).toContain("走不通");
    expect(issueGroupTitle("warning")).toContain("微调");
    expect(issueGroupTitle("info")).toContain("不知道");
  });
});
