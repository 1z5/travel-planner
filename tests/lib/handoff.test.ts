import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@/lib/handoff/canonical";
import { sha256Hex } from "@/lib/handoff/sha256";
import { sliceSource, HANDOFF_MAX_CLAIMS } from "@/lib/handoff/slice";
import {
  applyDecision,
  applyMark,
  countByStatus,
  createReceipt,
  finalizeReceipt,
  verifyReceipt,
} from "@/lib/handoff/receipt";
import { serializeReceipt, toTextCard } from "@/lib/handoff/format";
import { HANDOFF_NOTICE, HANDOFF_FORMAT_VERSION } from "@/lib/handoff/types";

const SAMPLE = [
  "苏州 3 天，人均预算 2000 元",
  "第 1 天",
  "09:00-11:00 拙政园，需提前预约。",
  "11:30-13:00 苏州博物馆，周一闭馆。",
  "第 2 天：上午 虎丘，下午 留园，晚上 山塘街",
].join("\n");

describe("sha256Hex：环境无关的同步实现", () => {
  it("标准向量", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("与 node:crypto 逐条交叉验证（含中文、多行、超 64 字节）", () => {
    const cases = [
      "苏州 3 天",
      "上午逛拙政园，下午去留园；晚上山塘街",
      SAMPLE,
      "x".repeat(1000),
      "🧳 emoji 与 中文 混排 → 第二站",
    ];
    for (const s of cases) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
});

describe("canonicalJson", () => {
  it("键排序、忽略 undefined、数组保序", () => {
    expect(canonicalJson({ b: 1, a: 2, z: undefined })).toBe('{"a":2,"b":1}');
    expect(canonicalJson([1, { d: 3, c: 4 }])).toBe('[1,{"c":4,"d":3}]');
  });
});

describe("sliceSource：断言就是原文片段", () => {
  it("每条 text 都能按 span 从原文精确取回，且默认全部未核", () => {
    const { claims } = sliceSource(SAMPLE);
    expect(claims.length).toBeGreaterThan(3);
    for (const c of claims) {
      expect(SAMPLE.slice(c.span[0], c.span[1])).toBe(c.text);
      expect(c.status).toBe("unchecked");
    }
    // 分节标题不是可核的事实断言
    expect(claims.some((c) => c.text === "第 1 天")).toBe(false);
  });

  it("超过上限如实记录截断，id 仍连续", () => {
    const text = Array.from(
      { length: HANDOFF_MAX_CLAIMS + 9 },
      (_, i) => `第 ${i + 1} 站去某个地方。`,
    ).join("\n");
    const { claims, truncated } = sliceSource(text);
    expect(claims).toHaveLength(HANDOFF_MAX_CLAIMS);
    expect(truncated).toBe(9);
    expect(claims.map((c) => c.id)).toEqual(
      Array.from({ length: HANDOFF_MAX_CLAIMS }, (_, i) => `c${i + 1}`),
    );
  });

  it("空文本不编造任何断言", () => {
    expect(sliceSource("  \n \n").claims).toHaveLength(0);
  });
});

describe("交接单：append-only 事件链与离线复算", () => {
  it("新建时全未核、有版本与诚实声明", () => {
    const r = createReceipt(SAMPLE, new Date("2026-11-08T06:30:00.000Z"));
    expect(r.v).toBe(HANDOFF_FORMAT_VERSION);
    expect(r.notice).toBe(HANDOFF_NOTICE);
    expect(countByStatus(r).unchecked).toBe(r.claims.length);
    expect(r.id).toMatch(/^hr_[0-9a-f]{32}$/);
    expect(r.actions).toHaveLength(0);
    expect(r.chain).toHaveLength(1);
    expect(verifyReceipt(r).ok).toBe(true);
  });

  it("时刻进链：同一原文在不同时刻签，编号必须不同", () => {
    const a = createReceipt(SAMPLE, new Date("2026-11-08T06:30:00.000Z"));
    const b = createReceipt(SAMPLE, new Date("2026-11-09T06:30:00.000Z"));
    expect(a.id).not.toBe(b.id);
  });

  it("表态只追加动作，状态可由动作推导，链逐段增长", () => {
    let r = createReceipt(SAMPLE, new Date("2026-11-08T06:30:00.000Z"));
    const first = r.claims[0]!.id;
    const second = r.claims[1]!.id;
    r = applyMark(r, first, "verified", {
      basis: "官网",
      at: "2026-11-08T06:31:00.000Z",
    });
    r = applyMark(r, second, "changed", {
      note: "改成下午去",
      at: "2026-11-08T06:32:00.000Z",
    });
    r = applyDecision(r, "先按这版走，周一晚上重新核闭馆。", "2026-11-08T06:33:00.000Z");

    expect(r.actions).toHaveLength(3);
    expect(r.chain).toHaveLength(4);
    expect(r.decision).toContain("周一晚上");
    const n = countByStatus(r);
    expect(n.verified).toBe(1);
    expect(n.changed).toBe(1);
    expect(verifyReceipt(r).ok).toBe(true);
  });

  it("JSON 文件自包含：脱离服务端 round-trip 后仍能离线复核", () => {
    let r = createReceipt(SAMPLE);
    r = applyMark(r, r.claims[0]!.id, "trusted", { note: "没来得及查" });
    const restored = JSON.parse(serializeReceipt(r)) as typeof r;
    expect(verifyReceipt(restored).ok).toBe(true);
    expect(restored.id).toBe(r.id);
  });

  it("四种篡改都能被离线复核抓到", () => {
    let r = createReceipt(SAMPLE);
    r = applyMark(r, r.claims[0]!.id, "verified", { basis: "官网" });

    const changedText = { ...r, source: { ...r.source, text: r.source.text + "改一个字" } };
    expect(verifyReceipt(changedText).ok).toBe(false);

    const badSpan = {
      ...r,
      claims: r.claims.map((c, i) => (i === 0 ? { ...c, span: [0, 3] as [number, number] } : c)),
    };
    expect(verifyReceipt(badSpan).ok).toBe(false);

    const badStatus = {
      ...r,
      claims: r.claims.map((c, i) => (i === 0 ? { ...c, status: "trusted" as const } : c)),
    };
    expect(verifyReceipt(badStatus).ok).toBe(false);

    const badChain = { ...r, chain: [...r.chain.slice(0, -1), "0".repeat(64)] };
    expect(verifyReceipt(badChain).ok).toBe(false);
  });

  it("finalize 是幂等的", () => {
    const r = createReceipt(SAMPLE);
    const again = finalizeReceipt(r);
    expect(again.id).toBe(r.id);
    expect(again.chain).toEqual(r.chain);
  });
});

describe("toTextCard：能带走、且不许自称核验过", () => {
  it("呈现三种表态与决定，并原样带上诚实声明", () => {
    let r = createReceipt(SAMPLE);
    r = applyMark(r, r.claims[0]!.id, "verified", { basis: "官网" });
    r = applyMark(r, r.claims[1]!.id, "changed", { note: "改下午" });
    r = applyMark(r, r.claims[2]!.id, "trusted");
    r = applyDecision(r, "先按这版走。");
    const card = toTextCard(r);
    expect(card).toContain("我核过");
    expect(card).toContain("我改了");
    expect(card).toContain("先信着");
    expect(card).toContain("我的决定：先按这版走。");
    expect(card).toContain(HANDOFF_NOTICE);
    expect(card).not.toContain("已核验通过");
    expect(card).not.toContain("可执行性");
  });
});
