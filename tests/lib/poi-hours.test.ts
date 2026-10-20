import { describe, expect, it } from "vitest";
import { checkOpenHours, formatHoursShort, isTemporarilyClosedName } from "@/lib/poi-hours";

// 本文件里的复杂营业时间文本**全部是 2026-10 用真实高德 key + extensions=all
// 实测拿到的原文**（苏州/成都 POI），原样引用——解析器必须按真机格式设计，
// 不能按想象格式写测试再按想象格式实现（本项目踩过「桩盖住真实数据形状」的坑）。
// 只有第 27、34、35 条等少数用例为覆盖边界手写构造。

const 拙政园 = {
  name: "拙政园",
  openTime2:
    "1月至2月,11月至12月 周一至周日 07:30-17:00 最晚进入16:30；3月至10月 周一至周日 07:30-17:30 最晚进入17:00；周二-周日开放夜游:18:30-21:00（法定节假日21:30），日场和夜游之间将清场。暮游体验以项目购买入场时间为准。",
};

const 苏州博物馆 = {
  name: "苏州博物馆(本馆)",
  openTime2:
    "09/25-09/27 10:00–20:00开放 最晚进入19:00；09/30-10/06 10:00–20:00开放 最晚进入19:00；01/01-09/24 周二–周日 09:00–17:00开放 最晚进入16:00；09/28-09/29 周二–周日 09:00–17:00开放 最晚进入16:00；10/07-12/31 周二–周日 09:00–17:00开放 最晚进入16:00；01/01-09/24 周一 全天不开放；09/28-09/29 周一 全天不开放；10/07-12/31 周一 全天不开放；春节,劳动节,端午节 09:00–17:00开放；夜间开放时间另行公布。如本馆遇有重大活动或重要设备设施维修保养时，可根据需要临时闭馆，届时将告示公众。",
};

const 天平山 = {
  name: "天平山风景名胜区",
  openTime2: "08:00-17:00，16:30停止售检票；2月15日-2月23日:08:00-17:30，17:00停止售检票",
};

const 同里古镇 = {
  name: "苏州同里古镇旅游区",
  openTime: "08:00-17:15",
  openTime2: "周一至周日 08:00-17:15；17:15后同里古镇各子景点闭园，街道免费开放。",
};

const 平江路 = {
  name: "平江路",
  openTime: "24小时营业",
  openTime2:
    "周一至周日 00:00-24:00；游船每天两班，上午10:00和下午14:00各一班（开船前半小时停止换票）",
};

const 石家饭店 = {
  name: "石家饭店(世忠路店)",
  openTime2:
    "周一至周五 10:30-13:30,16:30-21:00；周六至周日 00:00-24:00 10-01至10-07 周一至周日 10:30-13:30,16:30-20:30",
};

const 金沙遗址博物馆 = {
  name: "金沙遗址博物馆(暂停开放)",
  openTime2:
    "9:00-18:00,17:00停止售票(停止入馆)；每周一闭馆(法定节假日和1、2、7、8月除外)。 2025年“五一”假期(5月1日至5日)期间,每日开放,开放时间为:8:30-18:30(17:30停止售票、入馆)",
};

const 武侯祠 = {
  name: "成都武侯祠博物馆",
  openTime: "09:00-18:00",
  openTime2: "周一至周日 09:00-18:00 最晚进入17:00",
};

const 杜甫草堂 = {
  name: "成都杜甫草堂博物馆",
  openTime: "08:30-19:00",
  openTime2: "08:30-19:00(18:00停止售票)",
};

const 七里山塘 = {
  name: "七里山塘景区",
  openTime: "08:00-21:00",
  openTime2: "周一至周日 08:00-21:00",
};

/** 天分钟数 */
const min = (h: number, m = 0) => h * 60 + m;

describe("真实样本：基础窗口与三态", () => {
  it("拙政园 10 月 08:00 到 → open（3月至10月分句 07:30 开门）", () => {
    expect(checkOpenHours(拙政园, "2026-10-20", min(8), min(10))).toEqual({ state: "open" });
  });

  it("拙政园 10 月 06:00 到 → outside，reason 写清「07:30 才开门，你 06:00 到」", () => {
    const r = checkOpenHours(拙政园, "2026-10-20", min(6), min(7));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("07:30 才开门");
    expect(r.reason).toContain("06:00");
  });

  it("拙政园 结束时间超过关门 → outside，reason 写清「17:30 关门，你安排的结束是 18:00」", () => {
    const r = checkOpenHours(拙政园, "2026-10-20", min(16), min(18));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("17:30 关门");
    expect(r.reason).toContain("18:00");
  });

  it("同里古镇 每天 08:00-17:15：白天 open、17:30 到 outside", () => {
    expect(checkOpenHours(同里古镇, "2026-10-12", min(8), min(12))).toEqual({ state: "open" });
    const r = checkOpenHours(同里古镇, "2026-10-12", min(17, 30), min(18));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("17:15");
  });

  it("24 小时营业（open_time 简版）→ 深夜也 open", () => {
    expect(checkOpenHours({ openTime: "24小时营业" }, "2026-10-20", min(23), min(23, 30))).toEqual({
      state: "open",
    });
  });

  it("无任何营业时间数据 → unknown（不猜开/关）", () => {
    expect(checkOpenHours({}, "2026-10-20", min(10), min(11))).toEqual({ state: "unknown" });
  });
});

describe("真实样本：闭馆日", () => {
  it("苏州博物馆 2026-10-19（周一）→ closed，reason 含「周一」「不开放」", () => {
    const r = checkOpenHours(苏州博物馆, "2026-10-19", min(10), min(11));
    expect(r.state).toBe("closed");
    if (r.state !== "closed") throw new Error("应为 closed");
    expect(r.reason).toContain("周一");
    expect(r.reason).toContain("不开放");
  });

  it("苏州博物馆 周二正常 → open；且「09:00 才开门」边界正确（09:00 到 open、08:30 到 outside）", () => {
    expect(checkOpenHours(苏州博物馆, "2026-10-20", min(9), min(11))).toEqual({ state: "open" });
    const early = checkOpenHours(苏州博物馆, "2026-10-20", min(8, 30), min(10));
    expect(early.state).toBe("outside");
    if (early.state !== "outside") throw new Error("应为 outside");
    expect(early.reason).toContain("09:00 才开门");
  });

  it("苏州博物馆 特殊开放期 09/30-10/06：2026-10-05（周一）也 open（日期段优先于周闭馆）", () => {
    expect(checkOpenHours(苏州博物馆, "2026-10-05", min(10), min(11))).toEqual({ state: "open" });
  });

  it("同里古镇在 fixture 的周一（2026-10-12）真实数据是每天开放 → open，不误报闭馆", () => {
    expect(checkOpenHours(同里古镇, "2026-10-12", min(9), min(10))).toEqual({ state: "open" });
  });

  it("金沙遗址博物馆：每周一闭馆，reason 带节假日提示", () => {
    const noStatusName = { ...金沙遗址博物馆, name: "金沙遗址博物馆" };
    const r = checkOpenHours(noStatusName, "2026-10-19", min(10), min(11));
    expect(r.state).toBe("closed");
    if (r.state !== "closed") throw new Error("应为 closed");
    expect(r.reason).toContain("周一闭馆");
    expect(r.reason).toContain("节假日以官方公告为准");
    // 周二（10-20 不在其节假日特殊说明的 2025 年范围内）正常开门
    expect(checkOpenHours(noStatusName, "2026-10-20", min(10), min(11))).toEqual({ state: "open" });
  });
});

describe("真实样本：月份区间（拙政园季节分段）", () => {
  it("1 月至 2 月分句：2026-01-15 08:00 open（07:30 开门）", () => {
    expect(checkOpenHours(拙政园, "2026-01-15", min(8), min(10))).toEqual({ state: "open" });
  });

  it("11 月至 12 月分句也命中：2026-11-15 07:45 open", () => {
    expect(checkOpenHours(拙政园, "2026-11-15", min(7, 45), min(9))).toEqual({ state: "open" });
  });

  it("冬季 17:10 到 → outside（17:00 已关门，夜场 18:30 才开）", () => {
    const r = checkOpenHours(拙政园, "2026-01-15", min(17, 10), min(18));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("17:10");
  });

  it("月份区间与日期段不同：2026-02-28 仍属 1-2 月 → 07:30 开门", () => {
    expect(checkOpenHours(拙政园, "2026-02-28", min(7, 30), min(9))).toEqual({ state: "open" });
  });
});

describe("真实样本：夜游多窗口（日场 / 夜场 / 中间清场）", () => {
  it("周二 19:00 到 → open（夜游 18:30-21:00 窗口被识别）", () => {
    expect(checkOpenHours(拙政园, "2026-10-20", min(19), min(20, 30))).toEqual({ state: "open" });
  });

  it("日场与夜游之间的清场时段 17:45 → outside（不在任何营业时段内）", () => {
    const r = checkOpenHours(拙政园, "2026-10-20", min(17, 45), min(18, 30));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("不在营业时段内");
  });

  it("夜场结束 21:00 后（20:30 到、22:00 结束）→ outside", () => {
    const r = checkOpenHours(拙政园, "2026-10-20", min(20, 30), min(22));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("21:00 关门");
  });

  it("拙政园含「法定节假日」例外 → outside/closed 的 reason 附「节假日以官方公告为准」", () => {
    const r = checkOpenHours(拙政园, "2026-10-20", min(6), min(7));
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("节假日以官方公告为准");
  });
});

describe("真实样本：最晚进入 / 停止售票入馆 / 停止售检票", () => {
  it("苏州博物馆 16:30 到 → outside（最晚进入 16:00）", () => {
    const r = checkOpenHours(苏州博物馆, "2026-10-20", min(16, 30), min(17));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("最晚进入 16:00");
    expect(r.reason).toContain("16:30");
  });

  it("苏州博物馆 16:00 整到 → open（到达时刻等于最后入场时刻仍可进）", () => {
    expect(checkOpenHours(苏州博物馆, "2026-10-20", min(16), min(16, 30))).toEqual({
      state: "open",
    });
  });

  it("苏州博物馆 结束超过 17:00 关门 → outside「17:00 关门，你安排的结束是 18:00」", () => {
    const r = checkOpenHours(苏州博物馆, "2026-10-20", min(16), min(18));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("17:00 关门");
    expect(r.reason).toContain("18:00");
  });

  it("天平山：16:45 到 → outside（16:30 停止售检票 = 最后入场）", () => {
    const r = checkOpenHours(天平山, "2026-10-20", min(16, 45), min(17, 30));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("最晚进入 16:30");
  });

  it("武侯祠 17:30 到 → outside（最晚进入 17:00）；17:00 整到 open", () => {
    const late = checkOpenHours(武侯祠, "2026-10-20", min(17, 30), min(18));
    expect(late.state).toBe("outside");
    if (late.state !== "outside") throw new Error("应为 outside");
    expect(late.reason).toContain("最晚进入 17:00");
    expect(checkOpenHours(武侯祠, "2026-10-20", min(17), min(18))).toEqual({ state: "open" });
  });

  it("杜甫草堂：18:30 到 → outside（18:00 停止售票 = 最后入场）；18:00 整到 open", () => {
    const late = checkOpenHours(杜甫草堂, "2026-10-20", min(18, 30), min(19));
    expect(late.state).toBe("outside");
    if (late.state !== "outside") throw new Error("应为 outside");
    expect(late.reason).toContain("最晚进入 18:00");
    expect(checkOpenHours(杜甫草堂, "2026-10-20", min(18), min(19))).toEqual({ state: "open" });
  });
});

describe("真实样本：中文日期段（天平山 2月15日-2月23日）", () => {
  it("特殊日期段内：2026-02-20 09:00 到、17:20 走 → open（17:30 关门 + 17:00 最后入场前）", () => {
    expect(checkOpenHours(天平山, "2026-02-20", min(9), min(17, 20))).toEqual({ state: "open" });
  });

  it("特殊日期段内：17:15 到 → outside（特殊日最后入场 17:00）", () => {
    const r = checkOpenHours(天平山, "2026-02-20", min(17, 15), min(17, 40));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("最晚进入 17:00");
  });

  it("日期段之外：2026-02-14 17:20 走 → outside（基础规则 17:00 关门）", () => {
    const r = checkOpenHours(天平山, "2026-02-14", min(9), min(17, 20));
    expect(r.state).toBe("outside");
    if (r.state !== "outside") throw new Error("应为 outside");
    expect(r.reason).toContain("17:00 关门");
  });
});

describe("真实样本：周规则 / 多时段 / 跨年日期段", () => {
  it("石家饭店 周二午餐 12:00 open；14:00 落在午休间隙 outside", () => {
    expect(checkOpenHours(石家饭店, "2026-10-20", min(12), min(13))).toEqual({ state: "open" });
    const gap = checkOpenHours(石家饭店, "2026-10-20", min(14), min(15));
    expect(gap.state).toBe("outside");
    if (gap.state !== "outside") throw new Error("应为 outside");
    expect(gap.reason).toContain("不在营业时段内");
  });

  it("石家饭店 周六（2026-10-24）→ open（周末 00:00-24:00，拼在一句里的两条规则被正确拆开）", () => {
    expect(checkOpenHours(石家饭店, "2026-10-24", min(10), min(11))).toEqual({ state: "open" });
  });

  it("七里山塘 20:00 open、22:00 outside（08:00-21:00）", () => {
    expect(checkOpenHours(七里山塘, "2026-10-20", min(20), min(21))).toEqual({ state: "open" });
    expect(checkOpenHours(七里山塘, "2026-10-20", min(22), min(23)).state).toBe("outside");
  });

  it("跨年日期段 11-01至03-15 / 03-16至10-31 的边界两侧都判对", () => {
    const seasonal = {
      openTime2: "11-01至03-15 周一至周日 08:00-16:30；03-16至10-31 周一至周日 07:30-17:00",
    };
    // 冬季段：08:00 才开门、16:30 关门
    expect(checkOpenHours(seasonal, "2026-01-15", min(8), min(10))).toEqual({ state: "open" });
    const winterEarly = checkOpenHours(seasonal, "2026-01-15", min(7, 30), min(9));
    expect(winterEarly.state).toBe("outside");
    if (winterEarly.state !== "outside") throw new Error("应为 outside");
    expect(winterEarly.reason).toContain("08:00 才开门");
    expect(checkOpenHours(seasonal, "2026-03-15", min(16), min(17)).state).toBe("outside");
    // 夏季段：07:30 开门
    expect(checkOpenHours(seasonal, "2026-07-01", min(7, 30), min(9))).toEqual({ state: "open" });
    expect(checkOpenHours(seasonal, "2026-03-16", min(7, 45), min(9))).toEqual({ state: "open" });
  });

  it("无周几的裸时间段（open_time 简版 09:00-17:00）：窗口内 open、窗口外 outside", () => {
    const simple = { openTime: "09:00-17:00" };
    expect(checkOpenHours(simple, "2026-10-20", min(10), min(11))).toEqual({ state: "open" });
    expect(checkOpenHours(simple, "2026-10-20", min(8, 30), min(10)).state).toBe("outside");
    const late = checkOpenHours(simple, "2026-10-20", min(16), min(18));
    expect(late.state).toBe("outside");
    if (late.state !== "outside") throw new Error("应为 outside");
    expect(late.reason).toContain("17:00 关门");
  });
});

describe("解析失败 → unknown（绝不臆测）", () => {
  it("非法日历日期（2026-02-30 / 2026-13-01）→ unknown，且不抛错", () => {
    expect(checkOpenHours(武侯祠, "2026-02-30", min(10), min(11))).toEqual({ state: "unknown" });
    expect(checkOpenHours(武侯祠, "2026-13-01", min(10), min(11))).toEqual({ state: "unknown" });
    expect(checkOpenHours(武侯祠, "not-a-date", min(10), min(11))).toEqual({ state: "unknown" });
  });

  it("非法分钟数（NaN / 负数 / 结束早于开始 / 超 24h）→ unknown", () => {
    expect(checkOpenHours(武侯祠, "2026-10-20", Number.NaN, min(11))).toEqual({ state: "unknown" });
    expect(checkOpenHours(武侯祠, "2026-10-20", -1, min(11))).toEqual({ state: "unknown" });
    expect(checkOpenHours(武侯祠, "2026-10-20", min(11), min(10))).toEqual({ state: "unknown" });
    expect(checkOpenHours(武侯祠, "2026-10-20", min(10), 1441)).toEqual({ state: "unknown" });
  });

  it("今年不在任何日期段内（只有 01/01-03/31 规则）→ unknown", () => {
    const onlySpring = { openTime2: "01/01-03/31 周一至周日 09:00-17:00" };
    expect(checkOpenHours(onlySpring, "2026-07-01", min(10), min(11))).toEqual({
      state: "unknown",
    });
  });

  it("无星期/日期限定的重叠多窗口（open_time 季节拼接「07:30-17:00 08:00-16:30」）→ unknown", () => {
    // 无法区分「午休两段取并集」还是「两季营业时间拼接」——取并集会在冬季多算 1 小时
    expect(
      checkOpenHours(
        { openTime: "07:30-17:00 08:00-16:30" },
        "2026-10-20",
        min(16, 45),
        min(17, 15),
      ),
    ).toEqual({
      state: "unknown",
    });
  });

  it("跨零点营业时间（17:00-02:00）当前不支持 → unknown（不把 02:00 当成当天凌晨）", () => {
    expect(
      checkOpenHours({ openTime2: "周一至周日 17:00-02:00" }, "2026-10-20", min(19), min(20)),
    ).toEqual({
      state: "unknown",
    });
  });

  it("opentime2 存在但读不懂 → unknown，**不回退** open_time（有详细原文读不懂时用简版会丢闭馆信息）", () => {
    expect(
      checkOpenHours(
        { openTime: "09:00-17:00", openTime2: "详见景区公告" },
        "2026-10-20",
        min(10),
        min(11),
      ),
    ).toEqual({ state: "unknown" });
  });

  it("opentime2 为空数组时归一化后回退 open_time", () => {
    expect(
      checkOpenHours(
        { openTime: "09:00-17:00", openTime2: [] as unknown as string },
        "2026-10-20",
        min(10),
        min(11),
      ),
    ).toEqual({ state: "open" });
  });

  it("opentime2 是数组（真实可能形态）：用分号拼回后按分句解析", () => {
    const arrayPoi = {
      openTime2: ["周二至周日 09:00-17:00", "周一 全天不开放"] as unknown as string,
    };
    expect(checkOpenHours(arrayPoi, "2026-10-20", min(10), min(11))).toEqual({ state: "open" });
    const monday = checkOpenHours(arrayPoi, "2026-10-19", min(10), min(11));
    expect(monday.state).toBe("closed");
  });

  it("null / undefined 输入 → unknown", () => {
    expect(checkOpenHours(undefined, "2026-10-20", min(10), min(11))).toEqual({ state: "unknown" });
    expect(checkOpenHours(null, "2026-10-20", min(10), min(11))).toEqual({ state: "unknown" });
  });
});

describe("暂停开放状态", () => {
  it("名称含「(暂停开放)」→ closed，reason 引用名称状态", () => {
    const r = checkOpenHours(金沙遗址博物馆, "2026-10-20", min(10), min(11));
    expect(r.state).toBe("closed");
    if (r.state !== "closed") throw new Error("应为 closed");
    expect(r.reason).toContain("暂停开放");
  });

  it("temporarilyClosed 标记（名称没带状态时）→ closed", () => {
    const r = checkOpenHours(
      { name: "成都某景区", temporarilyClosed: true, openTime2: "周一至周日 09:00-17:00" },
      "2026-10-20",
      min(10),
      min(11),
    );
    expect(r.state).toBe("closed");
    if (r.state !== "closed") throw new Error("应为 closed");
    expect(r.reason).toContain("暂停开放");
  });

  it("isTemporarilyClosedName 只认高德实际使用的三种状态写法", () => {
    expect(isTemporarilyClosedName("金沙遗址博物馆(暂停开放)")).toBe(true);
    expect(isTemporarilyClosedName("某店（暂停营业）")).toBe(true);
    expect(isTemporarilyClosedName("某景区(已关闭)")).toBe(true);
    expect(isTemporarilyClosedName("拙政园")).toBe(false);
    expect(isTemporarilyClosedName("")).toBe(false);
  });
});

describe("formatHoursShort（UI 展示用，拿不准就不显示）", () => {
  it("简单款：同里古镇 → 「08:00-17:15」", () => {
    expect(formatHoursShort(同里古镇)).toBe("08:00-17:15");
  });

  it("24 小时 → 「全天开放」", () => {
    expect(formatHoursShort(平江路)).toBe("全天开放");
    expect(formatHoursShort({ openTime: "24小时营业" })).toBe("全天开放");
  });

  it("含最后入场 → 「09:00-18:00，最晚进入 17:00」", () => {
    expect(formatHoursShort(武侯祠)).toBe("09:00-18:00，最晚进入 17:00");
    expect(formatHoursShort(杜甫草堂)).toBe("08:30-19:00，最晚进入 18:00");
  });

  it("星期限定 + 闭馆日 → 「周二至周日 09:00-17:00，周一全天不开放」（桩数据同款）", () => {
    const stubMuseum = {
      openTime2: "周二至周日 09:00-17:00；周一 全天不开放",
    };
    expect(formatHoursShort(stubMuseum)).toBe("周二至周日 09:00-17:00，周一全天不开放");
  });

  it("复杂季节/日期段规则无法一句话概括 → undefined（不能截成可能失真的人话）", () => {
    expect(formatHoursShort(拙政园)).toBeUndefined();
    expect(formatHoursShort(苏州博物馆)).toBeUndefined();
    expect(formatHoursShort(天平山)).toBeUndefined();
    expect(formatHoursShort(石家饭店)).toBeUndefined();
  });

  it("暂停开放 → 「暂停开放」；无数据/读不懂 → undefined", () => {
    expect(formatHoursShort(金沙遗址博物馆)).toBe("暂停开放");
    expect(formatHoursShort({})).toBeUndefined();
    expect(formatHoursShort({ openTime2: "详见公告" })).toBeUndefined();
    expect(formatHoursShort(null)).toBeUndefined();
  });
});
