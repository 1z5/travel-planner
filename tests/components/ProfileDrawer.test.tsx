import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileDrawer } from "@/components/ProfileDrawer";

// 切片3 · 旅行档案的抽屉组件测试。
//
// 钉住的契约（与任务规格的验收标准一一对应）：
// 1. 冷启动引导：未填过档案时按钮引导文案 + 打开后的引导 banner；
// 2. 5 个字段全部可改（体力/作息/忌口/通勤滑杆 + 推断偏好治理）；
// 3. 每条偏好可手改、可删除；推断项必须带「根据你上次的行程推测」徽章
//    与来源（红线：黑箱画像比没有画像更让人不安）；
// 4. 保存才落盘：关抽屉不丢存储里的档案（未保存的改动在重开时丢弃）；
// 5. 清空走两步确认。

const KEY = "tp.travel-profile.v1";

function seed(profile: Record<string, unknown>) {
  window.localStorage.setItem(KEY, JSON.stringify(profile));
}

function stored(): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("ProfileDrawer · 入口按钮", () => {
  it("未填过档案：暖橙引导按钮 + 30 秒提示（冷启动显式引导）", () => {
    render(<ProfileDrawer />);
    expect(screen.getByRole("button", { name: /设置我的偏好/ })).toBeInTheDocument();
    expect(screen.getByText(/30 秒 · 以后每次规划都记得/)).toBeInTheDocument();
  });

  it("已填过档案：中性按钮文案（不重复推销）", () => {
    seed({ stamina: "packed" });
    render(<ProfileDrawer />);
    expect(screen.getByRole("button", { name: "我的旅行档案" })).toBeInTheDocument();
    expect(screen.queryByText(/30 秒 · 以后每次规划都记得/)).not.toBeInTheDocument();
  });
});

describe("ProfileDrawer · 抽屉内容", () => {
  it("冷启动（无档案）：引导 banner + 5 个字段 + 推断空态", async () => {
    const user = userEvent.setup();
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: /设置我的偏好/ }));

    expect(screen.getByRole("dialog", { name: "我的旅行档案" })).toBeInTheDocument();
    expect(screen.getByText(/30 秒，让以后的行程更懂你/)).toBeInTheDocument();
    // 体力三档 + 作息两档
    expect(screen.getByRole("button", { name: /偏轻松/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /适中/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /偏紧凑/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /早起型/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /夜猫型/ })).toBeInTheDocument();
    // 推断空态：明说「不悄悄分析你」
    expect(screen.getByText(/不会悄悄分析你/)).toBeInTheDocument();
    // 冷启动下保存可用（用户可以「确认中性默认」——保存即建档）；
    // 「没有改动就不给点」的禁用规则只对已有档案生效（见下）
    expect(screen.getByRole("button", { name: "保存档案" })).toBeEnabled();
  });

  it("已有档案且没做改动：保存按钮禁用（没有改动就不给点）", async () => {
    const user = userEvent.setup();
    seed({ stamina: "relaxed" });
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: "我的旅行档案" }));
    expect(screen.getByRole("button", { name: "保存档案" })).toBeDisabled();
    // 改一个字段即解锁
    await user.click(screen.getByRole("button", { name: /偏紧凑/ }));
    expect(screen.getByRole("button", { name: "保存档案" })).toBeEnabled();
  });

  it("已就绪（有档案）：绿色就绪 banner 而不是引导 banner", async () => {
    const user = userEvent.setup();
    seed({ stamina: "relaxed" });
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: "我的旅行档案" }));
    expect(screen.getByText(/档案已就绪/)).toBeInTheDocument();
    expect(screen.queryByText(/30 秒，让以后的行程更懂你/)).not.toBeInTheDocument();
  });

  it("Esc 关闭抽屉", async () => {
    const user = userEvent.setup();
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: /设置我的偏好/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ProfileDrawer · 体力与作息", () => {
  it("选体力 + 保存 → 落盘（localStorage 内容一致）", async () => {
    const user = userEvent.setup();
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: /设置我的偏好/ }));
    await user.click(screen.getByRole("button", { name: /偏紧凑/ }));
    expect(screen.getByRole("button", { name: /偏紧凑/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "保存档案" }));

    expect(stored()).toMatchObject({ stamina: "packed" });
    expect(screen.getByText(/已保存/)).toBeInTheDocument();
  });

  it("未保存的改动在重开抽屉时丢弃（保存语义：没点保存就是没保存）", async () => {
    const user = userEvent.setup();
    seed({ stamina: "balanced" });
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: "我的旅行档案" }));
    await user.click(screen.getByRole("button", { name: /偏紧凑/ }));
    // 不点保存，直接关掉
    await user.click(screen.getByRole("button", { name: "关闭" }));
    // 重开：草稿从已保存档案重建，改动已丢弃
    await user.click(screen.getByRole("button", { name: "我的旅行档案" }));
    expect(screen.getByRole("button", { name: /适中/ })).toHaveAttribute("aria-pressed", "true");
    expect(stored()).toMatchObject({ stamina: "balanced" });
  });

  it("作息选夜猫型并保存", async () => {
    const user = userEvent.setup();
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: /设置我的偏好/ }));
    await user.click(screen.getByRole("button", { name: /夜猫型/ }));
    await user.click(screen.getByRole("button", { name: "保存档案" }));
    expect(stored()).toMatchObject({ schedule: "late" });
  });
});

describe("ProfileDrawer · 忌口", () => {
  it("添加合法忌口 → 进列表；保存后落盘", async () => {
    const user = userEvent.setup();
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: /设置我的偏好/ }));
    await user.type(screen.getByLabelText("添加忌口"), "海鲜过敏");
    await user.click(screen.getByRole("button", { name: /添加/ }));
    expect(screen.getByText("海鲜过敏")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存档案" }));
    expect(stored()).toMatchObject({ diet: ["海鲜过敏"] });
  });

  it("非法忌口（超长/特殊字符）→ 错误文案且不加进列表", async () => {
    const user = userEvent.setup();
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: /设置我的偏好/ }));
    // 注：换行注入面无法从这里测——浏览器对 text input 的 value 会剥离
    // 换行（HTML value 净化算法），注入不到组件。换行拒绝由
    // sanitizePrefText 的单测直接覆盖（tests/lib/profile.test.ts）。
    // 这里测同一条校验链的两个可达路径：超长与非法字符。
    fireEvent.change(screen.getByLabelText("添加忌口"), { target: { value: "忌".repeat(31) } });
    await user.click(screen.getByRole("button", { name: /添加/ }));
    expect(screen.getByText(/忌口只能中英文/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("添加忌口"), { target: { value: '辣"quotes"' } });
    await user.click(screen.getByRole("button", { name: /添加/ }));
    expect(screen.getByText(/忌口只能中英文/)).toBeInTheDocument();
    // 输入框仍保留用户输入（报错不吞掉用户打了什么）
    expect(screen.getByLabelText("添加忌口")).toHaveValue('辣"quotes"');
  });

  it("手改一条忌口（铅笔按钮 → 改 → 勾）", async () => {
    const user = userEvent.setup();
    seed({ diet: ["海鲜过敏"] });
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: "我的旅行档案" }));
    await user.click(screen.getByRole("button", { name: /修改「海鲜过敏」/ }));
    const input = screen.getByLabelText("修改忌口");
    await user.clear(input);
    await user.type(input, "海鲜与花生过敏");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    expect(screen.getByText("海鲜与花生过敏")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存档案" }));
    expect(stored()).toMatchObject({ diet: ["海鲜与花生过敏"] });
  });

  it("删除一条忌口（垃圾桶按钮）", async () => {
    const user = userEvent.setup();
    seed({ diet: ["海鲜过敏", "不吃辣"] });
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: "我的旅行档案" }));
    await user.click(screen.getByRole("button", { name: /删除「海鲜过敏」/ }));
    expect(screen.queryByText("海鲜过敏")).not.toBeInTheDocument();
    expect(screen.getByText("不吃辣")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存档案" }));
    expect(stored()).toMatchObject({ diet: ["不吃辣"] });
  });
});

describe("ProfileDrawer · 通勤滑杆", () => {
  it("拖动滑杆 → 保存 → 值落盘", async () => {
    const user = userEvent.setup();
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: /设置我的偏好/ }));
    fireEvent.change(screen.getByLabelText("单段通勤可接受上限（分钟）"), {
      target: { value: "90" },
    });
    expect(screen.getByText(/90 分钟/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存档案" }));
    expect(stored()).toMatchObject({ maxCommuteMin: 90 });
  });
});

describe("ProfileDrawer · 推断偏好治理（红线）", () => {
  const inferredProfile = {
    stamina: "balanced",
    inferred: [{ text: "更偏好步行游览", source: "上次行程：苏州 3 天", editable: true }],
  };

  it("推断项必须带「根据你上次的行程推测」徽章 + 来源（可溯源）", async () => {
    const user = userEvent.setup();
    seed(inferredProfile);
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: "我的旅行档案" }));
    expect(screen.getByText("根据你上次的行程推测")).toBeInTheDocument();
    expect(screen.getByText("更偏好步行游览")).toBeInTheDocument();
    expect(screen.getByText(/来源：上次行程：苏州 3 天/)).toBeInTheDocument();
  });

  it("推断项可删除（删掉后保存，落盘不含它）", async () => {
    const user = userEvent.setup();
    seed(inferredProfile);
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: "我的旅行档案" }));
    await user.click(screen.getByRole("button", { name: /删除推断偏好/ }));
    expect(screen.queryByText("更偏好步行游览")).not.toBeInTheDocument();
    expect(screen.getByText(/不会悄悄分析你/)).toBeInTheDocument(); // 回到空态
    await user.click(screen.getByRole("button", { name: "保存档案" }));
    expect(stored()).toMatchObject({ inferred: [] });
  });
});

describe("ProfileDrawer · 清空档案", () => {
  it("两步确认：第一次点击进入待确认态，确认才真正清空", async () => {
    const user = userEvent.setup();
    seed({ stamina: "packed" });
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: "我的旅行档案" }));

    // 第一步：点「清空档案」→ 变成「确认清空？」（不直接删，防误触）
    await user.click(screen.getByRole("button", { name: "清空档案" }));
    expect(stored()).not.toBeNull();
    // 第二步：确认
    await user.click(screen.getByRole("button", { name: "确认清空？" }));
    expect(stored()).toBeNull();
    expect(screen.getByText(/档案已清空/)).toBeInTheDocument();
    // 按钮回到引导态（冷启动入口重新出现）
    expect(screen.getByRole("button", { name: /设置我的偏好/ })).toBeInTheDocument();
  });

  it("待确认态可以取消", async () => {
    const user = userEvent.setup();
    seed({ stamina: "packed" });
    render(<ProfileDrawer />);
    await user.click(screen.getByRole("button", { name: "我的旅行档案" }));
    await user.click(screen.getByRole("button", { name: "清空档案" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(stored()).not.toBeNull();
    expect(screen.getByRole("button", { name: "清空档案" })).toBeInTheDocument();
  });
});
