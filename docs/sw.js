// 舊網址的離線快取：清掉並移除自己，之後打開舊網址就會直接轉到新網址
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({type:"window"})) c.navigate(c.url);
  })());
});
