"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Footprints, Feather, X } from "lucide-react";
import { layoutRoutePoints, ROUTE_HEIGHT, ROUTE_WIDTH } from "@/lib/geo/map-view";
import type { FootprintPosition, LocalArrivals } from "@/lib/trip/trip-file";

import type { JournalPhoto } from "@/lib/trip/journal-photo";
import type { LocalJournalEntry } from "@/lib/trip/local-trips";

type Moment = {
  id: string;
  place: string;
  at?: string;
  note?: LocalJournalEntry;
  position?: FootprintPosition;
};

export function JournalTimeline({
  notes,
  arrivals,
  timeZone,
  onRemove,
  busy = false,
  loadPhoto,
}: {
  notes: LocalJournalEntry[];
  arrivals: LocalArrivals;
  timeZone?: string;
  onRemove: (id: string, kind: "note" | "arrival") => boolean | Promise<boolean>;
  busy?: boolean;
  loadPhoto?: (id: string) => Promise<JournalPhoto | undefined>;
}) {
  const [visibleCount, setVisibleCount] = useState(12);
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState<LocalJournalEntry>();
  const photoButton = useRef<HTMLButtonElement>(null);
  const viewer = useRef<HTMLDialogElement>(null);
  const moments = useMemo(() => {
    const entries: Moment[] = notes.map((note) => ({
      id: note.id,
      place: note.place || "沿途随记",
      at: note.at,
      note,
    }));
    for (const [id, arrival] of Object.entries(arrivals)) entries.push({ id, ...arrival });
    return entries.sort(
      (a, b) => (b.at ? Date.parse(b.at) : -Infinity) - (a.at ? Date.parse(a.at) : -Infinity),
    );
  }, [arrivals, notes]);
  const visibleMoments = useMemo(() => moments.slice(0, visibleCount), [moments, visibleCount]);
  const pins = useMemo(
    () =>
      layoutRoutePoints(
        visibleMoments
          .flatMap(({ id, place, position }) => (position ? [{ id, place, ...position }] : []))
          .slice(0, 8),
      ),
    [visibleMoments],
  );
  const format = useMemo(
    () => ({
      day: new Intl.DateTimeFormat("zh-CN", {
        timeZone,
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      time: new Intl.DateTimeFormat("zh-CN", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    }),
    [timeZone],
  );
  const dayLabel = (at?: string) => (at ? format.day.format(new Date(at)) : "时间未记录");
  return (
    <div className="journal-pages">
      <div className="journal-timeline-heading">
        <h2 id="journey-moments" tabIndex={-1}>
          沿途记录
        </h2>
        <span title={timeZone}>{timeZone ? "目的地时间" : "设备时间"}</span>
      </div>
      {!moments.length && (
        <p className="helper">到达第一站，或写下第一条手记，旅途就从这里开始。</p>
      )}
      {pins.length > 0 && (
        <figure className="footprint-map">
          <div className="route-geography">
            <span className="route-north" aria-label="上方为北">
              ↑ N
            </span>
            {pins.map(({ location, x, y }, i) => (
              <a
                className="route-pin"
                key={location.id}
                href={`#arrival-${location.id}`}
                style={{ left: `${(x / ROUTE_WIDTH) * 100}%`, top: `${(y / ROUTE_HEIGHT) * 100}%` }}
                aria-label={`查看足迹：${location.place}`}
              >
                <span>{pins.length - i}</span>
              </a>
            ))}
          </div>
          <figcaption>足迹方位示意 · 最近 {pins.length} 处已定位的停留</figcaption>
        </figure>
      )}
      {visibleMoments.map(({ id, at, place, note, position }, index) => {
        const key = (note ? "note-" : "arrival-") + id;
        const day = dayLabel(at);
        const newDay = index === 0 || day !== dayLabel(moments[index - 1]?.at);
        const Icon = note ? (note.photo || note.hasPhoto ? Camera : Feather) : Footprints;
        return (
          <Fragment key={key}>
            {newDay && <h3 className="journal-day">{day}</h3>}
            <article className="journal-moment" id={key} tabIndex={-1}>
              <div className="moment-line">
                <Icon size={16} aria-hidden="true" />
                <p className="journal-dateline">
                  {at && <time dateTime={at}>{format.time.format(new Date(at))}</time>}{" "}
                  {note ? "手记" : position ? "到达打卡 · 有定位" : "到达打卡"}
                </p>
              </div>
              <h4>{place}</h4>
              {note && (note.photo || note.hasPhoto) && (
                <JournalPrint
                  noteId={note.id}
                  photo={note.photo}
                  place={place}
                  loadPhoto={loadPhoto}
                  onOpen={(button, photo) => {
                    photoButton.current = button;
                    setExpanded({ ...note, photo });
                    viewer.current?.showModal();
                  }}
                />
              )}
              {note && <p className="journal-entry">{note.text}</p>}
              {confirm === key ? (
                <div className="journal-remove-actions">
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      if (await onRemove(id, note ? "note" : "arrival")) {
                        setConfirm("");
                        setMessage(note ? "手记已移除" : "已撤销到达记录");
                      }
                    }}
                  >
                    确认移除
                  </button>
                  <button className="btn" type="button" onClick={() => setConfirm("")}>
                    取消
                  </button>
                </div>
              ) : (
                <button type="button" className="journal-remove" onClick={() => setConfirm(key)}>
                  {note ? "移除手记" : "撤销打卡"}
                </button>
              )}
            </article>
          </Fragment>
        );
      })}
      {visibleCount < moments.length && (
        <button
          type="button"
          className="btn"
          onClick={() => setVisibleCount((count) => count + 12)}
        >
          查看更早的记录（剩余 {moments.length - visibleCount} 条）
        </button>
      )}
      <p className="helper" role="status">
        {message}
      </p>
      <dialog
        className="journal-viewer"
        ref={viewer}
        aria-label="查看手记照片"
        onClose={() => {
          setExpanded(undefined);
          photoButton.current?.focus({ preventScroll: true });
        }}
      >
        <header>
          <strong>{expanded?.place || "沿途留影"}</strong>
          <form method="dialog">
            <button className="btn" aria-label="关闭照片">
              <X size={20} />
            </button>
          </form>
        </header>
        {expanded?.photo && (
          <img
            src={expanded.photo.src}
            alt={expanded.text}
            width={expanded.photo.width}
            height={expanded.photo.height}
          />
        )}
      </dialog>
    </div>
  );
}

function JournalPrint({
  noteId,
  place,
  photo,
  loadPhoto,
  onOpen,
}: {
  noteId: string;
  place: string;
  photo?: JournalPhoto;
  loadPhoto?: (id: string) => Promise<JournalPhoto | undefined>;
  onOpen: (button: HTMLButtonElement, photo: JournalPhoto) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<JournalPhoto>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (photo || !loadPhoto || !anchor.current) return;
    let active = true;
    const load = () => {
      void loadPhoto(noteId).then(
        (value) => {
          if (!active) return;
          setLoaded(value);
          setUnavailable(!value);
        },
        () => {
          if (active) setUnavailable(true);
        },
      );
    };
    if (typeof IntersectionObserver !== "function") {
      load();
      return () => {
        active = false;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some(({ isIntersecting }) => isIntersecting)) return;
        observer.disconnect();
        load();
      },
      { rootMargin: "300px" },
    );
    observer.observe(anchor.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [loadPhoto, noteId, photo]);

  const thumbnail = photo ?? loaded;
  if (!thumbnail)
    return <div ref={anchor}>{unavailable && <p className="helper">无法读取这张照片。</p>}</div>;
  return (
    <button
      className="journal-print"
      type="button"
      aria-label={`放大${place}的照片`}
      onClick={(event) => onOpen(event.currentTarget, thumbnail)}
    >
      <img
        src={thumbnail.src}
        width={thumbnail.width}
        height={thumbnail.height}
        alt={`${place}的照片`}
        loading="lazy"
        decoding="async"
      />
    </button>
  );
}
