"use client";

import { LocateFixed, MapPinPlus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { footprintPosition, type FootprintPosition } from "@/lib/trip/trip-file";

export function StopCapture({
  onRecord,
  onWrite,
  busy = false,
}: {
  onRecord: (place: string, position?: FootprintPosition) => boolean | Promise<boolean>;
  busy?: boolean;
  onWrite: (place: string) => void;
}) {
  const [place, setPlace] = useState("");
  const [position, setPosition] = useState<FootprintPosition>();
  const [locating, setLocating] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [recorded, setRecorded] = useState("");
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  function clearPosition() {
    request.current += 1;
    setLocating(false);
    setPosition(undefined);
    setFeedback("");
  }

  function locate() {
    if (!navigator.geolocation) {
      setFeedback("设备无法定位，仍可保存地点名称。");
      return;
    }
    const ticket = ++request.current;
    setFeedback("");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (ticket !== request.current) return;
        setLocating(false);
        const point = footprintPosition.safeParse({
          lat: coords.latitude,
          lng: coords.longitude,
          accuracy: coords.accuracy,
        });
        if (point.success) setPosition(point.data);
        else setFeedback("没有收到可用的位置，仍可保存地点名称。");
      },
      ({ code }) => {
        if (ticket !== request.current) return;
        setLocating(false);
        setFeedback(
          code === 1 ? "定位权限未开启，仍可保存地点名称。" : "暂时无法定位，仍可保存地点名称。",
        );
      },
      { enableHighAccuracy: false, maximumAge: 0, timeout: 8000 },
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = place.trim();
    if (!name || busy || !(await onRecord(name, position))) return;
    setRecorded(name);
    setPlace("");
    clearPosition();
  }

  return (
    <form className="stop-capture" onSubmit={submit}>
      <label htmlFor="footprint-place">地点名称</label>
      <input
        id="footprint-place"
        type="text"
        value={place}
        readOnly={busy}
        maxLength={160}
        placeholder="例如，河边的旧书店"
        onChange={(event) => setPlace(event.target.value)}
      />
      <div className="stop-capture-actions">
        <button className="btn btn-primary" disabled={!place.trim() || busy} type="submit">
          <MapPinPlus size={16} aria-hidden="true" />
          记录停留
        </button>
        {position || locating ? (
          <button className="btn" type="button" onClick={clearPosition}>
            {locating ? "取消定位" : "移除位置"}
          </button>
        ) : (
          <button className="btn" type="button" onClick={locate}>
            <LocateFixed size={16} aria-hidden="true" />
            附上此刻位置
          </button>
        )}
      </div>
      <p className="helper" role="status">
        {position
          ? `已附位置 · 误差约 ${Math.ceil(position.accuracy)} 米`
          : locating
            ? "正在获取这一刻的位置，可先只保存地点名称。"
            : feedback || "位置可选，仅存本机与私人备份。"}
      </p>
      {recorded && (
        <div className="stop-capture-receipt">
          <p role="status">已记下 · {recorded}</p>
          <button className="btn" type="button" onClick={() => onWrite(recorded)}>
            为这里写手记
          </button>
        </div>
      )}
    </form>
  );
}
