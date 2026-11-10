// ============================================================
// 离线验真台的 Service Worker（只在静态站部署时注册，见模板尾部的判断）
//
// 目的很窄：加到主屏后，地铁里/没信号时也能打开这个页面。页面本身零网络依赖，
// 所以只需要缓存「导航文档」这一件事；不缓存 API（页面根本没有 API）、
// 不预缓存外部资源、不碰主站的 /sw.js（两者 scope 不重叠）。
//
// 为什么 network-first：页面更新后用户下次联网打开应该拿到新版本；
// 缓存只在断网时兜底，不用 stale-while-revalidate 制造「看到的还是旧规则集」。
// ============================================================

const CACHE = "trip-check-playground-v1";
const OFFLINE = new Response(
  "<!doctype html><meta charset='utf-8'><p style='font:16px/1.6 sans-serif;padding:24px'>当前离线，且没有缓存过这个页面。联网打开一次后再试。</p>",
  { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
);

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) || (await cache.match(self.registration.scope)) || OFFLINE;
      }
    })(),
  );
});
