import { beforeEach, describe, expect, it } from "vitest";
import {
  loadRecentTrips,
  saveRecentTrip,
  removeRecentTrip,
  ownsRecentTrip,
  recentTripLabel,
  type RecentTrip,
} from "@/lib/recent-trips";

// 「最近行程」本地索引：行程已持久化在服务端（持久分享 token），
// 但未登录用户没有账号可查，只能靠浏览器记住「这台设备生成过哪些」。
// 这里守住四类真实故障：脏数据不炸、去重刷新、上限、隐私模式写失败降级。

const KEY = "tp.recent-trips.v1";

function base(over: Partial<RecentTrip> = {}): RecentTrip {
  return { shareId: "share_abc123", city: "成都", days: 3, createdAt: Date.now(), ...over };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("loadRecentTrips", () => {
  it("空存储返回空数组", () => {
    expect(loadRecentTrips()).toEqual([]);
  });

  it("损坏的 JSON 不抛错，降级为空", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(loadRecentTrips()).toEqual([]);
  });

  it("JSON 不是数组时降级为空（历史版本结构防御）", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ shareId: "x" }));
    expect(loadRecentTrips()).toEqual([]);
  });

  it("逐条过滤脏数据，好条目保留", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        base({ shareId: "share_good1" }),
        { shareId: "too_short" }, // shareId 太短
        { ...base(), days: "3" }, // days 类型错
        { ...base(), city: "" }, // 空城市
        { ...base(), createdAt: "yesterday" }, // 时间戳类型错
        base({ shareId: "share_good2" }),
      ]),
    );
    const list = loadRecentTrips();
    expect(list.map((x) => x.shareId)).toEqual(["share_good1", "share_good2"]);
  });
});

describe("saveRecentTrip", () => {
  it("新条目插到最前", () => {
    saveRecentTrip(base({ shareId: "share_first", city: "成都" }));
    const list = saveRecentTrip(base({ shareId: "share_second", city: "苏州" }));
    expect(list.map((x) => x.shareId)).toEqual(["share_second", "share_first"]);
    expect(loadRecentTrips()).toHaveLength(2);
  });

  it("同一 shareId 再保存不重复，只刷新时间", () => {
    const first = saveRecentTrip(base({ shareId: "share_same" }));
    const t0 = first[0].createdAt;
    const second = saveRecentTrip(base({ shareId: "share_same", city: "成都改" }));
    expect(second).toHaveLength(1);
    expect(second[0].city).toBe("成都改");
    expect(second[0].createdAt).toBeGreaterThanOrEqual(t0);
  });

  it("最多保留 20 条（超出丢最旧）", () => {
    for (let i = 0; i < 25; i++) {
      saveRecentTrip(base({ shareId: `share_${String(i).padStart(4, "0")}`, city: `城市${i}` }));
    }
    const list = loadRecentTrips();
    expect(list).toHaveLength(20);
    // 最新的在最前，最旧的 5 条被挤出去
    expect(list[0].city).toBe("城市24");
    expect(list.some((x) => x.city === "城市4")).toBe(false);
  });

  it("隐私模式 / 配额满导致写入抛错时不炸调用方", () => {
    const original = window.localStorage.setItem;
    // 模拟 QuotaExceededError
    Object.defineProperty(window.localStorage, "setItem", {
      configurable: true,
      value: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => saveRecentTrip(base())).not.toThrow();
    Object.defineProperty(window.localStorage, "setItem", {
      configurable: true,
      value: original,
    });
  });
});

describe("removeRecentTrip / ownsRecentTrip", () => {
  it("删除指定条目后列表不含它", () => {
    saveRecentTrip(base({ shareId: "share_a" }));
    saveRecentTrip(base({ shareId: "share_b" }));
    const list = removeRecentTrip("share_a");
    expect(list.map((x) => x.shareId)).toEqual(["share_b"]);
    expect(loadRecentTrips().map((x) => x.shareId)).toEqual(["share_b"]);
  });

  it("ownsRecentTrip 只认本机保存过的 token（决定分享页是否可继续编辑）", () => {
    saveRecentTrip(base({ shareId: "share_mine" }));
    expect(ownsRecentTrip("share_mine")).toBe(true);
    expect(ownsRecentTrip("share_someone_else")).toBe(false);
  });
});

describe("recentTripLabel", () => {
  it("带 startDate → 「3 天 · 10月10日」", () => {
    expect(recentTripLabel(base({ days: 3, startDate: "2026-10-10" }))).toBe("3 天 · 10月10日");
  });

  it("无 startDate 只给天数（不编日期）", () => {
    expect(recentTripLabel(base({ days: 5 }))).toBe("5 天");
  });
});
