"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { BookOpen, Camera, Feather, ArrowDown, Pencil } from "lucide-react";
import type { Plan } from "@/lib/types";
import {
  MAX_JOURNAL_ENTRIES,
  MAX_WALK_TITLE_LENGTH,
  type FootprintPosition,
  type LocalArrivals,
} from "@/lib/trip/trip-file";
import { prepareJournalPhoto, type JournalPhoto } from "@/lib/trip/journal-photo";
import { JournalTimeline } from "./JournalTimeline";
import type { JournalDraft, LocalJournalEntry } from "@/lib/trip/local-trips";
import { StopCapture } from "./StopCapture";

export type { JournalDraft } from "@/lib/trip/local-trips";

export function TripJournal({
  plan,
  arrivals,
  notes,
  onSave,
  onSaved,
  draft,
  draftStatus,
  onDraft,
  onForgetArrival,
  onRecordArrival,
  walk = false,
  captureOpen,
  title,
  onRename,
  busy = false,
  loadPhoto,
}: {
  plan: Plan;
  arrivals: LocalArrivals;
  notes: LocalJournalEntry[];
  draft: JournalDraft;
  draftStatus?: "idle" | "saving" | "saved" | "failed";
  onDraft: Dispatch<SetStateAction<JournalDraft>>;
  onSaved?: () => void;
  onSave: (notes: LocalJournalEntry[]) => boolean | Promise<boolean>;
  onForgetArrival: (id: string) => boolean | Promise<boolean>;
  onRecordArrival?: (place: string, position?: FootprintPosition) => boolean | Promise<boolean>;
  walk?: boolean;
  captureOpen?: boolean;
  title?: string;
  onRename?: (title: string) => boolean | Promise<boolean>;
  busy?: boolean;
  loadPhoto?: (id: string) => Promise<JournalPhoto | undefined>;
}) {
  const { text, place, photo } = draft;
  const [message, setMessage] = useState("");
  const [processing, setProcessing] = useState(false);
  const request = useRef(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const full = notes.length >= MAX_JOURNAL_ENTRIES;
  const arrived = Object.keys(arrivals).length;

  async function choosePhoto(file: File) {
    const current = ++request.current;
    setProcessing(true);
    setMessage("");
    try {
      const prepared = await prepareJournalPhoto(file);
      if (current === request.current) onDraft((prev) => ({ ...prev, photo: prepared }));
    } catch (error) {
      if (current === request.current)
        setMessage(error instanceof Error ? error.message : "照片读取失败，请重新选择。");
    } finally {
      if (current === request.current) setProcessing(false);
    }
  }

  return (
    <section className="field-journal" aria-labelledby="journal-title">
      <header>
        <p className="field-label">
          <BookOpen size={16} aria-hidden="true" /> 旅行手记
        </p>
        <h1 id="journal-title">{title || (walk ? "随走手记" : `${plan.city}的旅途片刻`)}</h1>
        <div className="journal-summary">
          <p>
            已到达 {arrived} 站 · {notes.length} 条手记
          </p>
          {(arrived > 0 || notes.length > 0) && (
            <a href="#journey-moments" className="journal-jump">
              回看记录 <ArrowDown size={14} aria-hidden="true" />
            </a>
          )}
        </div>
        {onRename && (
          <details className="journal-title-editor">
            <summary>
              <Pencil size={15} aria-hidden="true" /> {title ? "修改标题" : "命名手记"}
            </summary>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const name = String(new FormData(form).get("title") ?? "").trim();
                if (!name) {
                  form.querySelector("input")?.focus();
                  return;
                }
                if (!busy && (await onRename(name))) {
                  setMessage("手记标题已保存到本机");
                  const details = form.closest("details");
                  if (details) {
                    details.open = false;
                    details.querySelector("summary")?.focus();
                  }
                }
              }}
            >
              <label htmlFor="walk-title">手记标题</label>
              <div>
                <input
                  type="text"
                  name="title"
                  id="walk-title"
                  required
                  defaultValue={title}
                  maxLength={MAX_WALK_TITLE_LENGTH}
                  placeholder="例如，沿着隅田川看晚霞"
                />
                <button className="btn" type="submit" disabled={busy}>
                  保存标题
                </button>
              </div>
            </form>
          </details>
        )}
      </header>
      <div className="journal-spread">
        <div className="journal-tools">
          {onRecordArrival && (
            <details className="journal-capture" open={walk || captureOpen || undefined}>
              <summary>记下停留</summary>
              <StopCapture
                busy={busy}
                onRecord={onRecordArrival}
                onWrite={(place) => {
                  if (!text && !photo) onDraft((prev) => ({ ...prev, place }));
                  editor.current?.focus();
                }}
              />
            </details>
          )}
          <form
            className="journal-composer"
            onSubmit={async (event) => {
              event.preventDefault();
              if ((!text.trim() && !photo) || full || processing || busy) return;
              const entry = {
                id: crypto.randomUUID(),
                at: new Date().toISOString(),
                text: text.trim() || "沿途留影",
                ...(photo ? { photo } : {}),
                ...(place.trim() ? { place: place.trim() } : {}),
              };
              if (await onSave([entry, ...notes])) {
                if (onSaved) onSaved();
                else onDraft({ text: "", place: "" });
                setMessage("这一刻已保存到本机");
              } else {
                setMessage("本条内容仍在编辑框中。");
              }
            }}
          >
            <label htmlFor="journal-note">
              <Feather size={18} aria-hidden="true" />
              记下这一刻
            </label>
            <textarea
              id="journal-note"
              ref={editor}
              readOnly={busy}
              rows={3}
              maxLength={1000}
              value={text}
              onChange={(e) => {
                onDraft({ ...draft, text: e.target.value });
                setMessage("");
              }}
              placeholder="街角的气味、偶遇的人，或今天想记住的一件事…"
            />
            <label htmlFor="journal-place">关联地点</label>
            <input
              type="text"
              id="journal-place"
              list="journal-stops"
              readOnly={busy}
              maxLength={160}
              autoComplete="off"
              placeholder="选一站，或写下途中遇见的地方"
              value={place}
              onChange={(e) => onDraft({ ...draft, place: e.target.value })}
            />
            <datalist id="journal-stops">
              {[...new Set(plan.days.flatMap((day) => day.spots.map((spot) => spot.name)))].map(
                (name) => (
                  <option key={name} value={name} />
                ),
              )}
            </datalist>
            {photo && (
              <div className="journal-photo-draft">
                <img
                  src={photo.src}
                  width={photo.width}
                  height={photo.height}
                  alt="待保存的手记照片"
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    request.current++;
                    setProcessing(false);
                    onDraft({ ...draft, photo: undefined });
                  }}
                >
                  移除照片
                </button>
              </div>
            )}
            <label className="journal-pick">
              <Camera size={17} aria-hidden="true" />
              {processing ? "正在处理照片…" : photo ? "更换照片" : "添加照片"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void choosePhoto(file);
                }}
              />
            </label>
            <p className="helper">照片在本机缩小保存，随含进展的备份带走。</p>
            {draftStatus && draftStatus !== "idle" && (text || photo) && (
              <p className="helper" role="status">
                {draftStatus === "saved"
                  ? "草稿已保存在本机"
                  : draftStatus === "failed"
                    ? "草稿暂时无法保存，请留在此页或重试。"
                    : "正在保存草稿…"}
              </p>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={(!text.trim() && !photo) || processing || full || busy}
            >
              保存手记
            </button>
            <span role="status">{full ? "手记已满，可先备份并移除旧记录。" : message}</span>
          </form>
        </div>
        <JournalTimeline
          notes={notes}
          arrivals={arrivals}
          timeZone={plan.timeZone}
          busy={busy}
          loadPhoto={loadPhoto}
          onRemove={(id, kind) =>
            kind === "arrival"
              ? onForgetArrival(id)
              : onSave(notes.filter((note) => note.id !== id))
          }
        />
      </div>
    </section>
  );
}
