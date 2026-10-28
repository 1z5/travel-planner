import { describe, expect, it } from "vitest";
import { canonicalJson, credentialOf, inputHashOf } from "@/lib/verify/credential";
import { getSample } from "@/lib/verify/samples";

const FIXED = new Date("2026-10-28T10:00:00.000Z");

describe("canonicalJson · 跨语言可复算的规范化", () => {
  it("对象键排序，嵌套同样排序", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("数组保序；undefined 键省略，数组内 undefined 按 JSON 语义变 null", () => {
    expect(canonicalJson({ x: undefined, list: [1, undefined, "a"] })).toBe(
      '{"list":[1,null,"a"]}',
    );
  });

  it("非有限数字按 JSON 语义变 null（不让 NaN 造成不稳定哈希）", () => {
    expect(canonicalJson({ n: Number.NaN })).toBe('{"n":null}');
  });

  it("原始类型稳定", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("汉字")).toBe('"汉字"');
    expect(canonicalJson(true)).toBe("true");
  });
});

describe("credentialOf · 可复算凭据", () => {
  const doc = getSample("verified")!.document;

  it("同一文档 + 同一口径 → 同一 ID（与时间无关）", () => {
    const a = credentialOf(doc, {}, FIXED);
    const b = credentialOf(doc, {}, new Date("2027-06-01T00:00:00.000Z"));
    expect(a.id).toBe(b.id);
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.issuedAt).not.toBe(b.issuedAt); // 签发时间不同，但 ID 不变
  });

  it("ID 格式：tc_ + 32 位十六进制；inputHash 是 64 位 sha256", () => {
    const c = credentialOf(doc);
    expect(c.id).toMatch(/^tc_[0-9a-f]{32}$/);
    expect(c.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.algorithm).toBe("sha256");
    expect(c.specVersion).toBe("trip-check/0.1");
    expect(c.rulesetVersion).toBeTruthy();
  });

  it("换口径（pace）→ 不同 ID（同一文档可以因口径不同得出不同结论）", () => {
    const relaxed = credentialOf(doc, { pace: "relaxed" }, FIXED);
    const packed = credentialOf(doc, { pace: "packed" }, FIXED);
    expect(relaxed.id).not.toBe(packed.id);
    expect(relaxed.inputHash).not.toBe(packed.inputHash);
  });

  it("文档内容变化 → 不同 ID", () => {
    const changed = { ...doc, city: "无锡" };
    expect(credentialOf(changed, {}, FIXED).id).not.toBe(credentialOf(doc, {}, FIXED).id);
  });

  it("inputHash 与 credentialOf 的计算一致（可被第三方独立复算）", () => {
    const c = credentialOf(doc, {}, FIXED);
    expect(c.inputHash).toBe(inputHashOf(doc, {}));
  });
});
