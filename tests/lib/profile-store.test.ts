import { beforeEach, describe, expect, it } from "vitest";
import { clearProfile, loadProfile, saveProfile } from "@/lib/profile-store";
import { DEFAULT_PROFILE, type TravelProfile } from "@/lib/profile";

// 切片3 · 旅行档案的本地存储：照 lib/recent-trips.ts 的踩坑范式守四类
// 真实故障——脏数据不炸、写入失败降级、清空可逆、坏数据当「没填过」。

const KEY = "tp.travel-profile.v1";

function profile(over: Partial<TravelProfile> = {}): TravelProfile {
  return { ...DEFAULT_PROFILE, ...over };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("loadProfile", () => {
  it("空存储 → null（没填过 = 没有档案，不返回默认档骗人）", () => {
    expect(loadProfile()).toBeNull();
  });

  it("损坏的 JSON 不抛错，当作没填过（冷启动引导会重新出现）", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(loadProfile()).toBeNull();
  });

  it("非对象 JSON（字符串/数组）→ null", () => {
    window.localStorage.setItem(KEY, JSON.stringify("档案"));
    expect(loadProfile()).toBeNull();
    window.localStorage.setItem(KEY, JSON.stringify([DEFAULT_PROFILE]));
    expect(loadProfile()).toBeNull();
  });

  it("读回保存过的档案（含推断偏好，逐字段一致）", () => {
    const p = profile({
      stamina: "packed",
      diet: ["海鲜过敏"],
      schedule: "late",
      maxCommuteMin: 90,
      inferred: [{ text: "偏好步行游览", source: "上次行程：苏州 3 天", editable: true }],
    });
    saveProfile(p);
    expect(loadProfile()).toEqual(p);
  });

  it("脏字段读回时归一化（坏字段回退中性默认，好字段保留）", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ stamina: "超人", diet: ["清真", "x".repeat(40)] }),
    );
    const p = loadProfile();
    expect(p).not.toBeNull();
    expect(p!.stamina).toBe("balanced");
    expect(p!.diet).toEqual(["清真"]);
  });
});

describe("saveProfile", () => {
  it("新档案写入后 loadProfile 读回一致", () => {
    const p = profile({ stamina: "relaxed", diet: ["不吃辣"] });
    expect(saveProfile(p)).toEqual(p);
    expect(loadProfile()).toEqual(p);
  });

  it("非法档案返回 null（调用方据此如实告知用户）", () => {
    // validateProfile 对非对象返回 null（数组也挡）
    expect(saveProfile([] as unknown as TravelProfile)).toBeNull();
    expect(loadProfile()).toBeNull(); // 没有写入
  });

  it("隐私模式 / 配额满导致写入抛错时不炸调用方，且如实返回 null", () => {
    // 为什么整体替换 window.localStorage 而不是 mock setItem：jsdom 的
    // Storage 是 Proxy 实现，Object.defineProperty(localStorage, "setItem")
    // 不生效（实测静默无效——桩根本不会被调用，测试会假绿）。
    // 整体替换 window.localStorage 是 jsdom 下唯一可靠的注入方式。
    const original = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        setItem: () => {
          throw new Error("QuotaExceededError"); // Safari 隐私模式的真实故障形状
        },
        getItem: () => null,
        removeItem: () => {},
      },
    });
    // 不抛错（不打断用户的填写动作），且返回值让 UI 说「没能记住」
    expect(() => saveProfile(profile())).not.toThrow();
    expect(saveProfile(profile())).toBeNull();
    Object.defineProperty(window, "localStorage", { configurable: true, value: original });
    // 写失败 = 没记住：读回来还是空的，不是「假保存成功」
    expect(loadProfile()).toBeNull();
  });

  it("重复保存同一档案是幂等的（归一化结果稳定）", () => {
    const p = profile({ stamina: "packed", maxCommuteMin: 45 });
    saveProfile(p);
    saveProfile(p);
    expect(loadProfile()).toEqual(p);
  });
});

describe("clearProfile", () => {
  it("清空后 loadProfile 返回 null（冷启动引导重新出现）", () => {
    saveProfile(profile());
    expect(loadProfile()).not.toBeNull();
    clearProfile();
    expect(loadProfile()).toBeNull();
  });

  it("没有档案时清空不抛错", () => {
    expect(() => clearProfile()).not.toThrow();
  });
});
