import { describe, expect, it, vi, afterEach } from "vitest";
import { pickCityName } from "@/lib/amap";

// pickCityName 有两个实测踩过的坑（真实高德 key 验证）：
// 1. 直辖市的 addressComponent.city 是**空数组**（city 与 province 被合一）
// 2. 普通城市的 city 带「市」后缀，而应用内约定是裸名
// 这两个坑不钉死，实时定位在直辖市会填入空城市名——用户点了定位却得到空值。

describe("pickCityName 逆地理编码城市名提取", () => {
  it("普通城市：剥离「市」后缀（成都市 → 成都）", () => {
    // 实测：成都坐标返回 city: "成都市"、province: "四川省"
    expect(pickCityName({ city: "成都市", province: "四川省" })).toBe("成都");
  });

  it("直辖市：city 是空数组，回退 province（北京）", () => {
    // 实测：天安门坐标返回 city: []、province: "北京市"
    // 这是本轮最关键的用例——直接取 city 会得到空字符串
    expect(pickCityName({ city: [], province: "北京市" })).toBe("北京");
    expect(pickCityName({ city: [], province: "上海市" })).toBe("上海");
    expect(pickCityName({ city: [], province: "天津市" })).toBe("天津");
    expect(pickCityName({ city: [], province: "重庆市" })).toBe("重庆");
  });

  it("直辖市：city 为 null/undefined 时同样回退 province", () => {
    // 高德对不同版本/区域可能返回 null 而非 []
    expect(pickCityName({ city: null, province: "北京市" })).toBe("北京");
    expect(pickCityName({ city: undefined, province: "北京市" })).toBe("北京");
    expect(pickCityName({ province: "上海市" })).toBe("上海");
  });

  it("city 优先于 province（成都不该返回四川）", () => {
    expect(pickCityName({ city: "杭州市", province: "浙江省" })).toBe("杭州");
  });

  it("剥离其他行政级别后缀", () => {
    expect(pickCityName({ city: "大理白族自治州" })).toBe("大理白族");
    expect(pickCityName({ city: "阿克苏地区" })).toBe("阿克苏");
    expect(pickCityName({ city: "延边朝鲜族自治州", province: "吉林省" })).toBe("延边朝鲜族");
  });

  it("city 与 province 都拿不到时返回 null（调用方据此降级为手动输入）", () => {
    expect(pickCityName({})).toBeNull();
    expect(pickCityName({ city: [], province: [] })).toBeNull();
    expect(pickCityName({ city: "", province: "" })).toBeNull();
    expect(pickCityName({ city: "   ", province: "  " })).toBeNull();
  });

  it("裸城市名原样返回（已无后缀可剥）", () => {
    expect(pickCityName({ city: "北京" })).toBe("北京");
    expect(pickCityName({ city: "成都" })).toBe("成都");
  });

  it("已知局限：自治区只剥后缀不剥民族名（文档化的妥协）", () => {
    // 「广西壮族自治区」→「广西壮族」。极少见（用户极少在自治区首府定位
    // 后还期望裸名），且不影响主流程，接受而非过度设计。
    expect(pickCityName({ city: "南宁市", province: "广西壮族自治区" })).toBe("南宁");
    expect(pickCityName({ province: "广西壮族自治区" })).toBe("广西壮族");
  });

  it("结果可直接用于 CITY_IMAGES 查询（应用内城市名约定是裸名）", () => {
    // 回归保护：若这里返回「成都市」，cityImage 就查不到封面图
    const city = pickCityName({ city: "成都市", province: "四川省" });
    expect(city).not.toContain("市");
    expect(city).not.toContain("省");
  });
});

// reverseGeocode 依赖网络与真实 key，单测里只验证 MOCK 模式的降级行为
describe("reverseGeocode 降级", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("MOCK 模式（未配 key）返回 null，不假装能用定位", async () => {
    // 注意：AMAP_MOCK 在模块加载时由 env 决定，需要在 import 前确保无 key。
    // 这里通过 resetModules + 删 env 再动态 import 来实现。
    const saved = process.env.AMAP_WEB_SERVICE_KEY;
    delete process.env.AMAP_WEB_SERVICE_KEY;
    vi.resetModules();
    const { reverseGeocode } = await import("@/lib/amap");
    const r = await reverseGeocode(116.48, 39.99);
    expect(r).toBeNull();
    if (saved !== undefined) process.env.AMAP_WEB_SERVICE_KEY = saved;
  });
});
