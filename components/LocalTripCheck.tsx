"use client";

import { useState } from "react";
import type { Plan } from "@/lib/types";
import { verifyDocument } from "@/lib/verify/engine";
import { localPlanCheckInput } from "@/lib/verify/local-plan";
import { TripCheckReport } from "./TripCheckReport";

export function LocalTripCheck({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false);
  const input = open ? localPlanCheckInput(plan) : null;

  return (
    <details
      className="card card-body companion-local-check"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>离线行程体检</summary>
      {input && (
        <>
          <p className="helper">
            事实核验使用本机内置城市包。开放时间以城市包记录为准，临时调整请查场所公告。
          </p>
          {input.references.length > 0 && (
            <ul className="helper">
              {input.references.map(
                ({ id, name, placeSource }) =>
                  placeSource && (
                    <li key={id}>
                      {name} ·{" "}
                      <a href={placeSource.url} target="_blank" rel="noopener noreferrer">
                        {placeSource.name}
                      </a>
                    </li>
                  ),
              )}
            </ul>
          )}
          <TripCheckReport report={verifyDocument(input.document)} />
        </>
      )}
    </details>
  );
}
