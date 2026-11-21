import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { makeCdp, openCdp } from "./lib/chrome-cdp.mjs";

const baseIndex = process.argv.indexOf("--base-url");
const source = new URL(baseIndex >= 0 ? process.argv[baseIndex + 1] : "http://127.0.0.1:3000");
assert.equal(source.protocol, "http:");
assert.ok(["127.0.0.1", "localhost"].includes(source.hostname), "使用本机生产构建");
const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
let executable;
for (const candidate of candidates) {
  if (
    await fs.access(candidate).then(
      () => true,
      () => false,
    )
  ) {
    executable = candidate;
    break;
  }
}
assert.ok(executable, "未找到 Chrome，请设置 CHROME_PATH");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "travel-offline-check-"));
let mode = "online";
let weakRequests = 0;
const proxy = http.createServer((req, res) => {
  if (process.env.VERBOSE) console.log(mode, req.method, req.url);
  if (mode === "offline") {
    res.destroy();
    return;
  }
  if (mode === "weak" && req.url.includes("offline-probe=weak")) {
    weakRequests++;
    return;
  }
  const upstream = http.request(
    new URL(req.url, source),
    {
      method: req.method,
      headers: { ...req.headers, host: source.host },
    },
    (reply) => {
      res.writeHead(reply.statusCode, { ...reply.headers, "cache-control": "no-store" });
      reply.pipe(res);
    },
  );
  upstream.on("error", () => res.destroy());
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${proxy.address().port}`;
const chrome = spawn(
  executable,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    ...(process.env.VISUAL_CHROME_NO_SANDBOX ? ["--no-sandbox"] : []),
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let cdp;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  let port;
  for (let attempt = 0; attempt < 90 && !port; attempt++) {
    const file = await fs
      .readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      .catch(() => "");
    port = Number(file.split("\n")[0]);
    if (!port) await wait(100);
  }
  assert.ok(port, "Chrome 未启动");
  cdp = await makeCdp(await openCdp(port));
  async function evaluate(expression) {
    const output = await cdp.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      1200,
    );
    if (output.exceptionDetails) throw new Error(output.exceptionDetails.exception?.description);
    return output.result.value;
  }
  async function until(expression, timeout = 12000) {
    const deadline = Date.now() + timeout;
    do {
      if (await evaluate(expression).catch(() => false)) return;
      await wait(120);
    } while (Date.now() < deadline);
    throw new Error(`等待页面条件超时：${expression}`);
  }
  async function press(text) {
    const button = `[...document.querySelectorAll('button')].find(el=>!el.disabled&&el.textContent.trim()===${JSON.stringify(text)})`;
    await until(`!!(${button})`);
    await evaluate(`${button}.click()`);
  }
  async function record(place) {
    await evaluate("document.querySelector('#footprint-place').focus()");
    await cdp.send("Input.insertText", { text: place });
    await press("记录停留");
    await until(`document.body.innerText.includes(${JSON.stringify("已记下 · " + place)})`);
  }
  async function reload(url) {
    await evaluate("window.__offlineCheckOldDocument = true");
    if (url) await cdp.send("Page.navigate", { url });
    else await cdp.send("Page.reload");
    await until("!window.__offlineCheckOldDocument && !!document.querySelector('#journal-title')");
  }
  async function attach(selector, filename) {
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert.ok(nodeId);
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [filename] });
  }
  await cdp.send("Page.enable");
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: profile });
  await cdp.send("Page.navigate", { url: base + "/robots.txt" });
  await until("location.pathname==='/robots.txt'");
  const legacyId = "32f9ab11-376e-4d0a-9e33-77ef8b344e09";
  const legacy = {
    format: "ai-travel-companion",
    version: 1,
    localId: legacyId,
    walk: true,
    title: "旧版旅行手记",
    plan: {
      city: "随走手记",
      summary: "",
      totalCostCny: 0,
      tips: [],
      days: [{ day: 1, theme: "随走", spots: [], dailyCostCny: 0, transitMin: 0 }],
    },
    notes: [
      {
        id: "f781943b-3db8-4ec3-bf80-9c414f331177",
        at: "2026-11-19T08:30:00Z",
        text: "第一次走到这条河。",
      },
    ],
  };
  const before = JSON.stringify([JSON.stringify(legacy)]);
  await evaluate(`localStorage.setItem("tp.local-trip-files.v1", ${JSON.stringify(before)})`);
  await cdp.send("Page.navigate", { url: base + "/local?trip=" + legacyId });
  await until("document.querySelector('.journal-entry')?.textContent==='第一次走到这条河。'");
  assert.ok((await evaluate("location.href")).endsWith(legacyId));
  await cdp.send("Page.navigate", { url: base + "/local?open=walk" });
  await until("!!document.querySelector('#footprint-place')");
  await until("!!navigator.serviceWorker.controller");
  await record("临河的长椅");
  const image = await evaluate(`(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 80;
    const context = canvas.getContext("2d");
    context.fillStyle = "#4c765d";
    context.fillRect(0, 0, 120, 80);
    return canvas.toDataURL("image/jpeg");
  })()`);
  const imagePath = path.join(profile, "sample.jpg");
  await fs.writeFile(imagePath, Buffer.from(image.split(",")[1], "base64"));
  await attach(".journal-pick input", imagePath);
  await until("document.querySelector('.journal-photo-draft img')?.naturalWidth > 0");
  await evaluate("document.querySelector('#journal-note').focus()");
  await cdp.send("Input.insertText", { text: "浏览器重开前没来得及写完。" });
  await until("document.body.innerText.includes('草稿已保存在本机')");
  await press("准备离线打开");
  await until("document.body.innerText.includes('可以离线重新打开')");
  await evaluate(`(async () => {
    const current = await caches.open("tp-local-shell-v3");
    const previous = await caches.open("tp-local-shell-v2");
    await previous.put("/local", await current.match("/local"));
    return caches.delete("tp-local-shell-v3");
  })()`);
  await reload();
  await until("document.body.innerText.includes('可以离线重新打开')");

  const address = await evaluate("location.href");
  mode = "weak";
  const started = Date.now();
  await reload(address + "&offline-probe=weak");
  assert.ok(Date.now() - started < 4500, "弱网必须及时回退");
  await until(
    "[...document.querySelectorAll('.journal-moment h4')].some(el=>el.textContent==='临河的长椅')",
  );
  assert.ok(weakRequests > 0, "必须实际命中挂起的文档请求");

  mode = "offline";
  await reload();
  await until(
    "[...document.querySelectorAll('.journal-moment h4')].some(el=>el.textContent==='临河的长椅')",
  );
  await until("document.querySelector('#journal-note')?.value==='浏览器重开前没来得及写完。'");
  await until("document.querySelector('.journal-photo-draft img')?.naturalWidth===120");
  await press("保存手记");
  await until("document.body.innerText.includes('这一刻已保存到本机')");
  await evaluate("document.querySelector('.journal-jump').click()");
  await until("document.querySelector('.journal-print img')?.naturalWidth===120");
  await record("过街后的书店");
  await press("下载含进展的备份");
  const backupPath = path.join(profile, "travel-companion.backup.json");
  let backup;
  for (let attempt = 0; attempt < 45 && !backup; attempt++) {
    backup = await fs
      .readFile(backupPath, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (!backup) await wait(120);
  }
  assert.deepEqual(
    Object.values(backup?.arrivals ?? {})
      .map(({ place }) => place)
      .sort(),
    ["临河的长椅", "过街后的书店"],
  );
  assert.ok(backup.notes[0].photo.src.startsWith("data:image/jpeg;base64,"));
  assert.equal(backup.version, 1);
  await press("本机列表");
  await press("从本机移除");
  await press("确认移除");
  await until(
    "document.querySelectorAll('.companion-trip').length===1 && document.querySelector('.companion-trip').textContent.includes('旧版旅行手记')",
  );
  await attach("input[type=file]", backupPath);
  await until("document.querySelectorAll('.journal-moment').length===3");
  await evaluate("document.querySelector('.journal-jump').click()");
  await until("document.querySelector('.journal-print img')?.naturalWidth===120");
  assert.equal(await evaluate('localStorage.getItem("tp.local-trip-files.v1")'), before);
  console.log("离线门禁通过：旧库迁移、缓存更新、弱网回退、草稿恢复及照片备份恢复。");
} finally {
  cdp?.close();
  chrome.kill("SIGTERM");
  proxy.closeAllConnections();
  proxy.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
