import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { AddressInput } from "@/components/AddressInput";

/**
 * 受控组件测试包装。
 *
 * AddressInput 是受控组件 value + onChange. 测试若直接传 value="" 加 vi.fn()
 * 输入框的值永远不会变 -- userEvent.type 触发 onChange 后没有 state 更新
 * value 仍是空 于是 输入后拉取建议 的逻辑根本不触发
 * 用这个包装提供真实 state 才能测到真实行为
 */
function Harness(props: {
  scope: "city" | "poi";
  city?: string;
  onSubmit?: () => void;
  onValue?: (v: string) => void;
}) {
  const [v, setV] = useState("");
  return (
    <AddressInput
      label="测试输入"
      scope={props.scope}
      city={props.city}
      value={v}
      onSubmit={props.onSubmit}
      onChange={(next) => {
        setV(next);
        props.onValue?.(next);
      }}
    />
  );
}

// 补全组件的关键行为验证。用户原本可自由填写地址，打错一个字就会让 POI
// 验真失败——这个组件把输入约束在真实地点内，所以「真的能调 API、展示建议、
// 选中回填」必须被测，而不只是「输入框还能打字」。

const SUGGESTIONS = [
  { name: "成都市", detail: "四川省", city: "成都", isCity: true },
  { name: "成都双流国际机场", detail: "双流区 · 双流县", city: "成都", isCity: false },
  { name: "成都东站", detail: "成华区", city: "成都", isCity: false },
];

function mockSuggest(response: unknown = { suggestions: SUGGESTIONS }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => response } as unknown as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AddressInput 补全组件", () => {
  it("输入后防抖调用建议接口，并带上 scope 与关键词", async () => {
    const calls = mockSuggest();
    render(<Harness scope="city" />);

    const input = screen.getByRole("combobox", { name: "测试输入" });
    await userEvent.type(input, "成都");

    await waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(calls[0]).toContain("/api/places/suggest");
    expect(calls[0]).toContain("q=" + encodeURIComponent("成都"));
    expect(calls[0]).toContain("scope=city");
  });

  it("POI 模式把当前城市传给接口（收窄范围，避免全国重名）", async () => {
    const calls = mockSuggest();
    render(<Harness scope="poi" city="成都" />);

    await userEvent.type(screen.getByRole("combobox", { name: "测试输入" }), "全季");

    await waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(calls[0]).toContain("scope=poi");
    expect(calls[0]).toContain("city=" + encodeURIComponent("成都"));
  });

  it("展示下拉建议，点击后回填输入框", async () => {
    const onChange = vi.fn();
    mockSuggest();
    render(<AddressInput label="目的地城市" scope="city" value="成都" onChange={onChange} />);

    const input = screen.getByRole("combobox", { name: "目的地城市" });
    await userEvent.click(input); // focus 触发拉取

    const option = await screen.findByRole("option", { name: /成都双流国际机场/ });
    await userEvent.click(option);

    expect(onChange).toHaveBeenCalledWith("成都双流国际机场");
    // 选中后下拉关闭
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("键盘可用：↓ 高亮、Enter 选中（无障碍红线）", async () => {
    const onValue = vi.fn();
    mockSuggest();
    render(<Harness scope="city" onValue={onValue} />);

    const input = screen.getByRole("combobox", { name: "测试输入" });
    await userEvent.click(input);
    await userEvent.type(input, "成都");
    const options = await screen.findAllByRole("option");

    await userEvent.keyboard("{ArrowDown}");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{Enter}");
    expect(onValue).toHaveBeenCalledWith("成都市");
  });

  it("有高亮项时回车是「选中」而不是提交表单", async () => {
    const onValue = vi.fn();
    const onSubmit = vi.fn();
    mockSuggest();
    render(<Harness scope="poi" onValue={onValue} onSubmit={onSubmit} />);

    const input = screen.getByRole("combobox", { name: "测试输入" });
    await userEvent.click(input);
    await userEvent.type(input, "成都");
    await screen.findAllByRole("option");

    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onValue).toHaveBeenCalledWith("成都市");
    expect(onSubmit).not.toHaveBeenCalled(); // 回车被「选中」消费掉
  });

  it("无高亮项时回车交给 onSubmit（添加为标签）", async () => {
    const onSubmit = vi.fn();
    mockSuggest();
    render(<AddressInput label="期望必游地" scope="poi" value="自定义地名" onChange={() => {}} onSubmit={onSubmit} />);

    await userEvent.type(screen.getByRole("combobox", { name: "期望必游地" }), "x");
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalled();
  });

  it("Esc 关闭下拉", async () => {
    mockSuggest();
    render(<AddressInput label="目的地城市" scope="city" value="成都" onChange={() => {}} />);

    await userEvent.click(screen.getByRole("combobox", { name: "目的地城市" }));
    await screen.findByRole("listbox");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("接口失败时静默降级：不展示下拉，但输入框仍可正常打字", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) } as unknown as Response)));
    const onChange = vi.fn();
    render(<AddressInput label="目的地城市" scope="city" value="" onChange={onChange} />);

    const input = screen.getByRole("combobox", { name: "目的地城市" });
    await userEvent.type(input, "成都");

    // 等防抖窗口过去，确认没有下拉、也没有报错抛出
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("空输入不发起请求（不打无谓的接口）", async () => {
    const calls = mockSuggest();
    render(<AddressInput label="目的地城市" scope="city" value="" onChange={() => {}} />);
    await userEvent.click(screen.getByRole("combobox", { name: "目的地城市" }));
    await new Promise((r) => setTimeout(r, 500));
    expect(calls).toHaveLength(0);
  });
});
