"use client";

import { useState, type FormEvent } from "react";
import type { Plan, PlanSpot } from "@/lib/types";
import { addDays, parseTimeRange } from "@/lib/plan/time";
import { findCityPack, type CityPack } from "@/lib/geo/city-packs";

export function LocalPlanEditor({
  plan,
  onSave,
  onUndo,
  busy = false,
}: {
  plan: Plan;
  onSave: (plan: Plan) => Promise<boolean>;
  busy?: boolean;
  onUndo?: () => void;
}) {
  const cityPack = plan.cities?.length ? undefined : findCityPack(plan.city);

  function updateDay(index: number, spots: Plan["days"][number]["spots"]) {
    const dailyCostCny = spots.reduce((total, spot) => total + spot.costCny, 0);
    return onSave({
      ...plan,
      totalCostCny: plan.days.reduce(
        (total, day, i) => total + (i === index ? dailyCostCny : day.dailyCostCny),
        0,
      ),
      days: plan.days.map((day, i) =>
        i === index
          ? {
              ...day,
              spots,
              dailyCostCny,
              legs: undefined,
              transitMin: 0,
              transitKnown: false,
            }
          : day,
      ),
    });
  }

  return (
    <section className="companion-local-form" aria-label="编辑本机计划">
      <h1>{plan.city} · 编辑计划</h1>
      {onUndo && (
        <button type="button" className="btn" onClick={onUndo} disabled={busy}>
          撤销上次编辑
        </button>
      )}
      {plan.days.map((day, index) => (
        <section className="card card-body" key={index}>
          <h2>第 {index + 1} 天</h2>
          <ol className="companion-local-stops">
            {day.spots.map((spot, i) => (
              <li key={spot.stopId ?? i}>
                <span className="companion-local-stop-time">{spot.time}</span>
                <strong>{spot.name}</strong>
                <div className="companion-local-stop-actions">
                  <button
                    className="btn"
                    type="button"
                    aria-label={`上移${spot.name}`}
                    disabled={i === 0 || busy}
                    onClick={() => {
                      const spots = [...day.spots];
                      [spots[i - 1], spots[i]] = [spots[i]!, spots[i - 1]!];
                      updateDay(index, spots);
                    }}
                  >
                    上移
                  </button>
                  <button
                    className="btn"
                    type="button"
                    aria-label={`移除${spot.name}`}
                    disabled={busy}
                    onClick={() =>
                      updateDay(
                        index,
                        day.spots.filter((_, j) => j !== i),
                      )
                    }
                  >
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <LocalStopForm
            cityPack={cityPack}
            disabled={day.spots.length >= 100 || busy}
            onAdd={(spot) => updateDay(index, [...day.spots, spot])}
          />
        </section>
      ))}
      <button
        type="button"
        className="btn"
        disabled={plan.days.length >= 30 || busy}
        onClick={() => {
          const day = plan.days.length + 1;
          onSave({
            ...plan,
            endDate: plan.startDate ? addDays(plan.startDate, day - 1) : undefined,
            days: [
              ...plan.days,
              {
                day,
                theme: `第 ${day} 天`,
                spots: [],
                dailyCostCny: 0,
                transitMin: 0,
                transitKnown: false,
              },
            ],
          });
        }}
      >
        添加一天
      </button>
    </section>
  );
}

function LocalStopForm({
  cityPack,
  disabled,
  onAdd,
}: {
  cityPack?: CityPack;
  disabled: boolean;
  onAdd: (spot: PlanSpot) => Promise<boolean>;
}) {
  const [placeId, setPlaceId] = useState("");
  const place = cityPack?.places.find(({ id }) => id === placeId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const name = place?.name ?? String(fields.get("name") ?? "").trim();
    const time = `${fields.get("start")}-${fields.get("end")}`;
    const range = parseTimeRange(time);
    if (disabled || !name || !range || range.end <= range.start) return;
    const saved = await onAdd({
      stopId: crypto.randomUUID(),
      name,
      time,
      area: place?.area ?? "",
      navigationQuery: place?.navigationQuery,
      placeSource: place?.placeSource,
      openingHoursNote: place?.openingHoursNote,
      period: "morning",
      type: "sight",
      reason: "",
      costCny: 0,
      durationMin: range.end - range.start,
    });
    if (saved) {
      form.reset();
      setPlaceId("");
    }
  }

  return (
    <form className="companion-local-form" onSubmit={submit}>
      {cityPack && (
        <label>
          从{cityPack.city}城市包添加
          <select value={placeId} onChange={(event) => setPlaceId(event.target.value)}>
            <option value="">手动填写</option>
            {cityPack.places.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!place && (
        <label>
          站点名称
          <input name="name" required maxLength={120} />
        </label>
      )}
      <label>
        开始时间
        <input name="start" type="time" required />
      </label>
      <label>
        结束时间
        <input name="end" type="time" required />
      </label>
      <button className="btn" disabled={disabled}>
        添加站点
      </button>
    </form>
  );
}
