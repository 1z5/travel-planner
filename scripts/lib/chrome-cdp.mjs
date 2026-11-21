const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Chrome / CDP ----------
export async function openCdp(port) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up */
    }
    await sleep(150);
  }
  throw new Error("Chrome DevTools 不可达");
}

export function makeCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        errors.push(
          `exception: ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "unknown"}`,
        );
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
        if (!/React DevTools|HMR|Fast Refresh/.test(text))
          errors.push(`console.error: ${text.slice(0, 200)}`);
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        const text = msg.params.entry.text ?? "";
        const url = msg.params.entry.url ?? "";
        if (!/React DevTools|HMR|Fast Refresh|favicon/.test(text) && !url.endsWith("/favicon.ico"))
          errors.push(`log.error: ${text.slice(0, 200)} ${url}`.trim());
      }
    });
    ws.addEventListener("open", () => {
      const send = (method, params = {}, timeout = 15000) =>
        new Promise((res, rej) => {
          const id = ++seq;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`Chrome DevTools 超时：${method}`));
          }, timeout);
          pending.set(id, { res, rej, timer });
          ws.send(JSON.stringify({ id, method, params }));
        });
      resolve({ send, errors, close: () => ws.close() });
    });
    ws.addEventListener("error", reject);
  });
}
