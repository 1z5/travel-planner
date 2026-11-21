"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

type Status = "checking" | "unprepared" | "update" | "ready" | "failed";

function assetsForPage() {
  const observed = performance.getEntriesByType("resource").map(({ name }) => name);
  const critical = Array.from(
    document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
      "script[src], link[rel=stylesheet]",
    ),
    (node) => (node instanceof HTMLScriptElement ? node.src : node.href),
  );
  const paths = [...critical, ...observed]
    .map((name) => new URL(name, location.origin))
    .filter((url) => url.origin === location.origin && url.pathname.startsWith("/_next/static/"))
    .map((url) => url.pathname);
  return [...new Set(paths)].slice(0, 100);
}

function requestOffline(worker: ServiceWorker, type: "prepare-local" | "local-status") {
  return new Promise<unknown>((resolve) => {
    const channel = new MessageChannel();
    const finish = (value: unknown) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), type === "local-status" ? 1800 : 15000);
    channel.port1.addEventListener("message", ({ data }) => finish(data), { once: true });
    channel.port1.start();
    try {
      worker.postMessage({ type, assets: assetsForPage() }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

export function OfflinePreparation({ loadPlan }: { loadPlan?: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let active = true;
    let updating = false;
    async function check() {
      if (!active || updating) return;
      try {
        const worker = (await navigator.serviceWorker?.getRegistration())?.active;
        if (!active) return;
        const answer = worker && (await requestOffline(worker, "local-status"));
        if (!active) return;
        if (typeof answer !== "object" || !answer) {
          setStatus("unprepared");
          return;
        }
        const { ready, prepared } = answer as { ready: boolean; prepared: boolean };
        setStatus(ready ? "ready" : prepared ? "update" : "unprepared");
        if (!ready && prepared && navigator.onLine && worker) {
          updating = true;
          setBusy(true);
          await loadPlan?.();
          const saved = await requestOffline(worker, "prepare-local");
          if (active) setStatus(saved === true ? "ready" : "update");
        }
      } catch {
        if (active) setStatus("update");
      } finally {
        if (active && updating) setBusy(false);
        updating = false;
      }
    }
    void check();
    navigator.serviceWorker?.addEventListener("controllerchange", check);
    window.addEventListener("online", check);
    return () => {
      active = false;
      navigator.serviceWorker?.removeEventListener("controllerchange", check);
      window.removeEventListener("online", check);
    };
  }, [loadPlan]);

  async function prepare() {
    setBusy(true);
    try {
      const worker = (await navigator.serviceWorker?.getRegistration())?.active;
      if (!worker) throw new Error("离线功能尚未就绪");
      await loadPlan?.();
      setStatus((await requestOffline(worker, "prepare-local")) === true ? "ready" : "failed");
    } catch {
      setStatus("failed");
    } finally {
      setBusy(false);
    }
  }

  const message = {
    checking: "",
    unprepared: "尚未准备离线页面。",
    update: "离线页面需要更新，联网后可重试。",
    ready: "可以离线重新打开此页。请保留下载的文件作为备份。",
    failed: "未能准备离线页面，请联网重试。",
  }[status];

  return (
    <div className="field-offline">
      <button
        type="button"
        className="btn field-offline-btn"
        disabled={busy}
        onClick={() => void prepare()}
      >
        <Download size={16} aria-hidden="true" />
        {busy ? "正在准备离线页面…" : status === "ready" ? "刷新离线页面" : "准备离线打开"}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
