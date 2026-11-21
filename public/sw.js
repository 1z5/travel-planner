// 行中页的离线外壳（Service Worker）。
//
// 为什么只缓存 /t 导航（不再缓存 /p）：行中模式的核心诉求是「地铁里/境外
// 没信号时也能看到今天的安排」，/t 是执行镜头、离线价值最高。而 /p 分享页
// 的 URL 本身就是能力凭据（拿到链接可读/可共编），SW 缓存会忽略服务端的
// `Cache-Control: no-store`，把带 token 的页面永久留在设备上（审计 R13）。
// 取舍：分享页离线可读性下降，换取「私有工件不落长期本地缓存」。
//
// 刻意不做：
// - 不缓存 /api（数据会过期，行中要的是「最后一次看到的安排」，不是实时数据，
//   而缓存 API 会让「重新生成」读到旧结果，违背「不猜」原则）；
// - 不做 precache 全站（首屏没必要，且会缓存到过期内容）；
// - 不用第三方 PWA 库（这一百行覆盖 90% 场景，引入 Serwist 只为它不值得）。
//
// 注册时机见 components/PwaBootstrap.tsx（仅生产环境注册）。

const CACHE = "tp-trip-shell-v3";
// 旧外壳仍写 localStorage。存储迁移只能使用与当前版本兼容的离线外壳。
const LOCAL_CACHE = "tp-local-shell-v3";
const PREVIOUS_LOCAL_CACHES = ["tp-local-shell-v2", "tp-local-shell-v1"];
const LOCAL_NETWORK_BUDGET_MS = 1200;
const OFFLINE_MESSAGE = "当前离线，且没有可用的缓存页面。请连网后重试。";

// 跳过 waiting：装完立刻接管，行中场景等不起「关闭所有标签页再打开」
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 清掉旧版本缓存（版本号变更时旧壳子必须让位）
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("tp-trip-shell-") && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// 只缓存不含用户数据的本机页面外壳与版本化静态资源。
self.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (
    (type !== "prepare-local" && type !== "local-status") ||
    !event.ports[0] ||
    !event.source?.url
  )
    return;
  if (new URL(event.source.url).pathname !== "/local") return;
  const assets = Array.isArray(event.data.assets) ? event.data.assets.slice(0, 100) : [];
  const paths = assets.filter(
    (path) =>
      typeof path === "string" &&
      /^\/_next\/static\/[a-zA-Z0-9_.%/-]+$/.test(path) &&
      new URL(path, self.location.origin).pathname === path,
  );
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(LOCAL_CACHE);
        if (type === "local-status") {
          const shell = await cache.match("/local");
          const ready =
            !!shell &&
            paths.length > 0 &&
            (await Promise.all(paths.map((asset) => cache.match(asset)))).every(Boolean);
          const prepared =
            !!shell ||
            (
              await Promise.all(
                PREVIOUS_LOCAL_CACHES.map((cacheName) => caches.match("/local", { cacheName })),
              )
            ).some(Boolean);
          event.ports[0].postMessage({ ready, prepared });
          return;
        }
        await cache.addAll([...new Set(paths), "/local"]);
        event.ports[0].postMessage(true);
      } catch {
        event.ports[0].postMessage(false);
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" && url.pathname === "/local") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(LOCAL_CACHE);
        const cached = await cache.match("/local");
        const controller = new AbortController();
        const timer = cached
          ? setTimeout(() => controller.abort(), LOCAL_NETWORK_BUDGET_MS)
          : undefined;
        let fresh;
        try {
          fresh = await fetch(req, { signal: controller.signal });
        } catch {
          // 离线或弱网时用已准备的外壳，行程数据由浏览器本机读取。
        } finally {
          clearTimeout(timer);
        }
        return (
          (fresh?.ok ? fresh : undefined) ??
          cached ??
          fresh ??
          new Response(OFFLINE_MESSAGE, { status: 504 })
        );
      })(),
    );
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(LOCAL_CACHE);
        return (await cache.match(url.pathname)) ?? fetch(req);
      })(),
    );
    return;
  }
  const isTripNav = req.mode === "navigate" && url.pathname.startsWith("/t/");
  if (!isTripNav) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      // 后台刷新：有缓存也更新，下次打开就是新版本（stale-while-revalidate）
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) return cached;
      const fresh = await network;
      return (
        fresh ??
        new Response(OFFLINE_MESSAGE, {
          status: 504,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      );
    })(),
  );
});
