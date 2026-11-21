"use client";

import { useEffect, useRef, useState, type SetStateAction } from "react";
import { readLocalDraft, writeLocalDraft, type JournalDraft } from "@/lib/trip/local-trips";

const EMPTY: JournalDraft = { text: "", place: "" };
type DraftState = {
  key: string;
  draft: JournalDraft;
  status: "idle" | "saving" | "saved" | "failed";
};

export function useJournalDraft(key?: string) {
  const [state, setState] = useState<DraftState>();
  const current = useRef<DraftState | undefined>(undefined);

  useEffect(() => {
    if (key === undefined) return;
    let active = true;
    function load(draft: JournalDraft | undefined, failed = false) {
      if (!active || key === undefined) return;
      const entry: DraftState = {
        key,
        draft: draft ?? EMPTY,
        status: failed ? "failed" : draft ? "saved" : "idle",
      };
      current.current = entry;
      setState(entry);
    }
    void readLocalDraft(key).then(load, () => load(undefined, true));
    return () => {
      active = false;
    };
  }, [key]);

  function onDraft(update: SetStateAction<JournalDraft>) {
    const previous = current.current;
    if (!key || previous?.key !== key) return;
    const draft = typeof update === "function" ? update(previous.draft) : update;
    const pending: DraftState = { key, draft, status: "saving" };
    current.current = pending;
    setState(pending);

    function finish(status: "saved" | "failed") {
      if (current.current !== pending) return;
      const updated: DraftState = {
        ...pending,
        status: draft.text || draft.photo ? status : "idle",
      };
      current.current = updated;
      setState(updated);
    }
    void writeLocalDraft(key, draft).then(
      () => finish("saved"),
      () => finish("failed"),
    );
  }

  function resetDraft() {
    if (!key || current.current?.key !== key) return;
    const entry: DraftState = { key, draft: EMPTY, status: "idle" };
    current.current = entry;
    setState(entry);
  }

  const active = key !== undefined && state?.key === key ? state : undefined;
  return {
    draft: active?.draft ?? EMPTY,
    ready: !!active,
    status: active?.status ?? "idle",
    onDraft,
    resetDraft,
  };
}
