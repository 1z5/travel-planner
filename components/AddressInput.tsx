"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MapPin } from "lucide-react";

// ============================================================
// 地址自动补全输入框（combobox）。
//
// 为什么不用自由填写：用户打错一个字（「武侯祠」→「武候祠」）就会让 POI
// 验真失败，而验真失败意味着行程质量下降——项目的核心价值正是「把幻觉挡
// 在出发前」。补全把输入约束在真实地点内。
//
// 无障碍要求（WAI-ARIA combobox 模式）：
// - input 有 role="combobox" + aria-expanded + aria-controls + aria-activedescendant
// - 下拉是 role="listbox"，选项是 role="option" + aria-selected
// - 键盘：↓/↑ 移动、Enter 选中、Esc 关闭、Tab 离开
// - 失焦延迟关闭（给 click 留时间，否则鼠标点不中）
// ============================================================

export interface Suggestion {
  name: string;
  detail: string;
  city: string;
  isCity: boolean;
}

export function AddressInput({
  value,
  onChange,
  scope,
  city,
  placeholder,
  label,
  id: providedId,
  maxLength = 40,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  scope: "city" | "poi";
  city?: string;
  placeholder?: string;
  label: string;
  id?: string;
  maxLength?: number;
  /** 按回车且无高亮项时的回调（如「添加为标签」）。不传则回车照常提交表单 */
  onSubmit?: () => void;
}) {
  const reactId = useId();
  const inputId = providedId ?? `addr-${reactId}`;
  const listId = `${inputId}-list`;

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  // 防抖 + 竞态防护：输入停止 250ms 才请求；旧请求的结果直接丢弃
  useEffect(() => {
    const q = value.trim();
    if (!open || q.length < 1) {
      setItems([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/places/suggest?q=${encodeURIComponent(q)}&scope=${scope}` +
            (city ? `&city=${encodeURIComponent(city)}` : ""),
        );
        const d = await r.json();
        if (!cancelled) {
          setItems(d.suggestions ?? []);
          setActive(-1);
        }
      } catch {
        /* 补全失败静默降级：用户仍可自由输入 */
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // city 变化要重新收窄范围，故列入依赖
  }, [value, open, scope, city]);

  // 点击组件外关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  function pick(item: Suggestion) {
    onChange(item.name);
    setOpen(false);
    setItems([]);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      setOpen(true);
      setActive((i) => {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const next = i + dir;
        if (next < 0) return items.length - 1;
        if (next >= items.length) return 0;
        return next;
      });
    } else if (e.key === "Enter") {
      // 有高亮项时阻止提交，改为选中；否则交给 onSubmit（如「添加为标签」）
      // 或照常提交表单
      if (open && active >= 0 && items[active]) {
        e.preventDefault();
        pick(items[active]);
      } else if (onSubmit) {
        e.preventDefault();
        onSubmit();
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
    }
  }

  const showList = open && items.length > 0;

  return (
    <div className="addr-box" ref={boxRef}>
      <div className="addr-field">
        <MapPin size={14} className="addr-icon" aria-hidden="true" />
        <input
          id={inputId}
          type="text"
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          autoComplete="off"
          role="combobox"
          aria-label={label}
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={active >= 0 && items[active] ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          // 失焦延迟关闭：给 click 事件留出触发时间，否则鼠标点不中选项
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      </div>
      {showList && (
        <ul className="addr-list" id={listId} role="listbox" aria-label={`${label}建议`}>
          {items.map((item, i) => (
            <li
              key={`${item.name}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`addr-option ${i === active ? "active" : ""}`}
              onMouseDown={(e) => e.preventDefault() /* 防止 blur 先于 click 触发 */}
              onClick={() => pick(item)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="addr-option-name">{item.name}</span>
              {item.detail && <span className="addr-option-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
