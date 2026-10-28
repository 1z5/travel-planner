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

const CACHE = "tp-trip-shell-v2";
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
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
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
