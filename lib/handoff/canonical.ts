// 规范化 JSON：对象键排序、忽略 undefined、数组保序。
// 口径与 lib/verify/credential.ts:32-48 完全一致，但那一份带 server-only，
// 浏览器不能引；这里独立一份，保证「同一份单子在任何环境重跑得同一个 ID」。
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return "undefined";
}
