"use client";

import { useEffect, useState } from "react";
import { Check, IdCard, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  DEFAULT_PROFILE,
  INFERENCE_DEFERRED_NOTE,
  SCHEDULE_OPTIONS,
  STAMINA_OPTIONS,
  sanitizePrefText,
  type TravelProfile,
} from "@/lib/profile";
import { clearProfile, loadProfile, saveProfile } from "@/lib/profile-store";

// ============================================================
// 我的档案抽屉（切片3 · 旅行档案）——「让产品记得用户」的入口。
//
// 产品语义：档案是复利资产（体力/忌口/作息/通勤耐受，用得越久越准），
// 竞品抄不走。这个抽屉同时承担两件事：
// 1. **冷启动引导**：第一次打开时 banner 说清「30 秒、存在本机、可改可删」，
//    表单预填中性默认（DEFAULT_PROFILE）——不猜用户，等用户显式确认；
// 2. **长期治理**：每条偏好（含推断偏好）都能手改、能删除。推断项强制带
//    「根据你上次的行程推测」徽章与来源——黑箱画像比没有画像更让人不安。
//
// 集成方式（给 lead 的说明也写在任务报告里）：组件自包含，home-client 里
// 一行 <ProfileDrawer /> 即可；生成请求时把 loadProfile() 的结果放进
// POST body 的 profile 字段（服务端校验后透传，见 app/api/plan/route.ts）。
// 挂载点建议：首页表单区右上或 hero 下方，与「最近行程」同级。
//
// 保存语义：草稿态（组件内）→ 点「保存档案」才落 localStorage。不清空
// 不自动保存——用户没点保存就关抽屉，存储里的档案不变（避免误触丢失）。
// ============================================================

/** 滑杆档位（分钟）：15 分钟起步到 3 小时，步长 15——分钟级对滑杆太碎 */
const COMMUTE_MIN = 15;
const COMMUTE_MAX = 180;
const COMMUTE_STEP = 15;

type EditTarget = { kind: "diet" | "inferred"; index: number } | null;

function sameProfile(a: TravelProfile | null, b: TravelProfile): boolean {
  // JSON 比较足够：两个对象都来自 validateProfile 归一化，字段顺序稳定
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

export function ProfileDrawer() {
  // 档案只在客户端读（localStorage 在 SSR 不存在）：首屏一律当「没填过」，
  // 挂载后 effect 里再读——与 home-client 的「最近行程」同一范式。
  const [saved, setSaved] = useState<TravelProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TravelProfile>(DEFAULT_PROFILE);
  const [newDiet, setNewDiet] = useState("");
  const [dietError, setDietError] = useState("");
  const [editing, setEditing] = useState<EditTarget>(null);
  const [editText, setEditText] = useState("");
  const [flash, setFlash] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    setSaved(loadProfile());
  }, []);

  // Esc 关抽屉（模态基础交互）；打开时才监听
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function openDrawer() {
    // 每次打开都从「已保存」重建草稿：丢弃上次未保存的改动（诚实：
    // 没点保存就是没保存，不假装记住了）
    setDraft(saved ?? DEFAULT_PROFILE);
    setNewDiet("");
    setDietError("");
    setEditing(null);
    setFlash("");
    setConfirmClear(false);
    setOpen(true);
  }

  const dirty = !sameProfile(saved, draft);

  function onSave() {
    const next = saveProfile(draft);
    if (!next) {
      // 隐私模式/配额满：如实说没记住，不假装保存成功
      setFlash("没能保存（浏览器可能处于隐私模式或存储已满）——档案没有改动");
      return;
    }
    setSaved(next);
    setDraft(next);
    setFlash("已保存。以后的规划都会带上这份档案；每条偏好随时能改、能删。");
  }

  function onClear() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    clearProfile();
    setSaved(null);
    setDraft(DEFAULT_PROFILE);
    setConfirmClear(false);
    setFlash("档案已清空。下次规划不再带上任何偏好。");
  }

  function addDiet() {
    const t = sanitizePrefText(newDiet, 30);
    if (!t) {
      // 白名单口径与存储层同一个 sanitizePrefText——UI 报错文案就是
      // 校验规则的直译，不让用户猜「为什么加不上」
      setDietError("忌口只能中英文、数字与常见标点，最多 30 字");
      return;
    }
    if (draft.diet.includes(t)) {
      setDietError("这条忌口已经在列表里了");
      return;
    }
    setDraft({ ...draft, diet: [...draft.diet, t] });
    setNewDiet("");
    setDietError("");
  }

  function removeDiet(index: number) {
    setDraft({ ...draft, diet: draft.diet.filter((_, i) => i !== index) });
  }

  function removeInferred(index: number) {
    setDraft({ ...draft, inferred: draft.inferred.filter((_, i) => i !== index) });
  }

  function startEdit(kind: "diet" | "inferred", index: number, text: string) {
    setEditing({ kind, index });
    setEditText(text);
    setFlash("");
  }

  function commitEdit() {
    if (!editing) return;
    const t = sanitizePrefText(editText, editing.kind === "diet" ? 30 : 60);
    if (!t) {
      setFlash("内容不合规：仅中英文、数字与常见标点（忌口 30 字内 / 推断 60 字内）");
      return;
    }
    if (editing.kind === "diet") {
      setDraft({ ...draft, diet: draft.diet.map((x, i) => (i === editing.index ? t : x)) });
    } else {
      setDraft({
        ...draft,
        inferred: draft.inferred.map((x, i) => (i === editing.index ? { ...x, text: t } : x)),
      });
    }
    setEditing(null);
    setFlash("已修改，记得点「保存档案」。");
  }

  return (
    <>
      {/* 悬浮入口：fixed 定位不依赖挂载位置；未填过档案时用暖橙主按钮引导
          （冷启动红线：显式引导，不等「系统自己学会」） */}
      <div className="profile-fab-wrap">
        <button
          type="button"
          className={saved === null ? "profile-fab is-new" : "profile-fab"}
          onClick={openDrawer}
        >
          <IdCard size={16} />
          {saved === null ? "设置我的偏好" : "我的旅行档案"}
        </button>
        {saved === null && <p className="profile-fab-hint">30 秒 · 以后每次规划都记得</p>}
      </div>

      {open && (
        <div className="profile-overlay" role="presentation" onClick={() => setOpen(false)}>
          <aside
            className="profile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="我的旅行档案"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="profile-head">
              <div>
                <h2>我的旅行档案</h2>
                <p className="profile-sub">
                  体力 · 忌口 · 作息 · 通勤耐受——存在本机，以后的每次规划自动带上
                </p>
              </div>
              <button
                type="button"
                className="profile-icon-btn"
                aria-label="关闭"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </header>

            {saved === null ? (
              // 冷启动引导（30 秒）：说清三件事——花多久、存哪、能不能改
              <div className="profile-banner">
                <strong>30 秒，让以后的行程更懂你</strong>
                <span>
                  下面 5
                  项选一下就行（都有中性默认，不确定就保持原样）。档案只存在这台设备的浏览器里，不登录也能用；每条偏好随时能改、能删。
                </span>
              </div>
            ) : (
              <div className="profile-banner is-saved">
                <Check size={15} />
                <span>档案已就绪。改完点下面的「保存档案」生效。</span>
              </div>
            )}

            <div className="profile-body">
              {/* 1) 体力上限：与「行程节奏」是两个独立维度——pace 是这次请求的
                  密度，stamina 是用户的身体事实。两者都告诉模型，它才知道
                  「请求紧凑但体力只够适中」时怎么排。 */}
              <fieldset className="profile-field">
                <legend>体力上限</legend>
                <div className="profile-seg" role="group" aria-label="体力上限">
                  {STAMINA_OPTIONS.map((o) => (
                    <button
                      type="button"
                      key={o.value}
                      className={draft.stamina === o.value ? "on" : ""}
                      aria-pressed={draft.stamina === o.value}
                      onClick={() => setDraft({ ...draft, stamina: o.value })}
                    >
                      <strong>{o.label}</strong>
                      <small>{o.desc}</small>
                    </button>
                  ))}
                </div>
                <p className="profile-note">
                  体力会同时影响生成密度与体检的节奏阈值（偏轻松收紧 20% / 偏紧凑放宽 20%）
                </p>
              </fieldset>

              {/* 2) 作息：影响动线的时间分布（主景点上午还是下午晚上） */}
              <fieldset className="profile-field">
                <legend>作息</legend>
                <div className="profile-seg" role="group" aria-label="作息">
                  {SCHEDULE_OPTIONS.map((o) => (
                    <button
                      type="button"
                      key={o.value}
                      className={draft.schedule === o.value ? "on" : ""}
                      aria-pressed={draft.schedule === o.value}
                      onClick={() => setDraft({ ...draft, schedule: o.value })}
                    >
                      <strong>{o.label}</strong>
                      <small>{o.desc}</small>
                    </button>
                  ))}
                </div>
              </fieldset>

              {/* 3) 忌口：全程餐饮必须避开——硬约束措辞，进 prompt 的也是
                  「必须避开」的语气。字符白名单与存储层同一个函数。 */}
              <fieldset className="profile-field">
                <legend>忌口 / 饮食约束</legend>
                {draft.diet.length === 0 ? (
                  <p className="profile-empty">还没有忌口。不填 = 没有约束（不替你猜）。</p>
                ) : (
                  <ul className="profile-list">
                    {draft.diet.map((item, i) =>
                      editing?.kind === "diet" && editing.index === i ? (
                        <li key={item} className="profile-edit-row">
                          <input
                            value={editText}
                            autoFocus
                            aria-label="修改忌口"
                            onChange={(e) => setEditText(e.target.value)}
                          />
                          <button
                            type="button"
                            className="profile-icon-btn"
                            aria-label="保存修改"
                            onClick={commitEdit}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            className="profile-icon-btn"
                            aria-label="取消修改"
                            onClick={() => setEditing(null)}
                          >
                            <X size={14} />
                          </button>
                        </li>
                      ) : (
                        <li key={item}>
                          <span>{item}</span>
                          <button
                            type="button"
                            className="profile-icon-btn"
                            aria-label={`修改「${item}」`}
                            onClick={() => startEdit("diet", i, item)}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="profile-icon-btn"
                            aria-label={`删除「${item}」`}
                            onClick={() => removeDiet(i)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </li>
                      ),
                    )}
                  </ul>
                )}
                <div className="profile-add-row">
                  <input
                    value={newDiet}
                    placeholder="如：海鲜过敏、不吃辣、清真"
                    aria-label="添加忌口"
                    onChange={(e) => {
                      setNewDiet(e.target.value);
                      setDietError("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDiet();
                      }
                    }}
                  />
                  <button type="button" className="profile-add-btn" onClick={addDiet}>
                    <Plus size={14} />
                    添加
                  </button>
                </div>
                {dietError && <p className="profile-error">{dietError}</p>}
              </fieldset>

              {/* 4) 通勤耐受：滑杆（分钟级对滑杆太碎，步长 15） */}
              <fieldset className="profile-field">
                <legend>单段通勤可接受上限</legend>
                <input
                  type="range"
                  className="profile-slider"
                  min={COMMUTE_MIN}
                  max={COMMUTE_MAX}
                  step={COMMUTE_STEP}
                  value={draft.maxCommuteMin}
                  aria-label="单段通勤可接受上限（分钟）"
                  onChange={(e) => setDraft({ ...draft, maxCommuteMin: Number(e.target.value) })}
                />
                <p className="profile-note">
                  {draft.maxCommuteMin >= COMMUTE_MAX
                    ? `≥ ${COMMUTE_MAX} 分钟`
                    : `${draft.maxCommuteMin} 分钟`}
                  ：动线安排尽量不超过这个时长，超过就换更近的点
                </p>
              </fieldset>

              {/* 5) 推断偏好：强制标注「根据你上次的行程推测」+ 来源——
                  溯源红线。v1 没有推断引擎（见 lib/profile.ts 的
                  INFERENCE_DEFERRED_NOTE），空态明说「不悄悄分析你」。 */}
              <fieldset className="profile-field">
                <legend>推断偏好</legend>
                {draft.inferred.length === 0 ? (
                  <p className="profile-empty">{INFERENCE_DEFERRED_NOTE}</p>
                ) : (
                  <ul className="profile-list">
                    {draft.inferred.map((p, i) =>
                      editing?.kind === "inferred" && editing.index === i ? (
                        <li key={`${p.text}-${i}`} className="profile-edit-row">
                          <input
                            value={editText}
                            autoFocus
                            aria-label="修改推断偏好"
                            onChange={(e) => setEditText(e.target.value)}
                          />
                          <button
                            type="button"
                            className="profile-icon-btn"
                            aria-label="保存修改"
                            onClick={commitEdit}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            className="profile-icon-btn"
                            aria-label="取消修改"
                            onClick={() => setEditing(null)}
                          >
                            <X size={14} />
                          </button>
                        </li>
                      ) : (
                        <li key={`${p.text}-${i}`}>
                          <div className="profile-inferred">
                            <span className="profile-badge">根据你上次的行程推测</span>
                            <span>{p.text}</span>
                            <small className="profile-source">来源：{p.source}</small>
                          </div>
                          <button
                            type="button"
                            className="profile-icon-btn"
                            aria-label={`删除推断偏好「${p.text}」`}
                            onClick={() => removeInferred(i)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </fieldset>
            </div>

            <footer className="profile-foot">
              {flash && <p className="profile-flash">{flash}</p>}
              <div className="profile-actions">
                <button type="button" className="profile-save" onClick={onSave} disabled={!dirty}>
                  保存档案
                </button>
                {confirmClear ? (
                  <>
                    {/* 二次确认：清空是不可逆操作，不搞窗口 confirm（不可测） */}
                    <button type="button" className="profile-clear is-armed" onClick={onClear}>
                      确认清空？
                    </button>
                    <button
                      type="button"
                      className="profile-clear"
                      onClick={() => setConfirmClear(false)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button type="button" className="profile-clear" onClick={onClear}>
                    清空档案
                  </button>
                )}
                {dirty && <span className="profile-dirty">有未保存的修改</span>}
              </div>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}
