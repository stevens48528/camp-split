// 把網頁本身存在手機上，營地沒訊號時也能打開；資料的離線同步由 Firestore 自己處理
const CACHE = "camp-split-v1";
const APP = ["./", "index.html", "app.js", "split.js", "style.css", "manifest.webmanifest", "icon-192.png"];
const SDK = ["firebase-app", "firebase-auth", "firebase-firestore"].map(n => `https://www.gstatic.com/firebasejs/13.1.0/${n}.js`);

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([...APP, ...SDK])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const own = url.origin === location.origin && url.pathname.startsWith(new URL("./", location.href).pathname);
  const lib = url.href.startsWith("https://www.gstatic.com/firebasejs/") || /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (own) e.respondWith(networkFirst(req));
  else if (lib) e.respondWith(cacheFirst(req));
});
// 網頁本身：有網路就拿最新版，訊號差（4 秒沒回應）或沒網路就用存著的
async function networkFirst(req){
  const cache = await caches.open(CACHE);
  const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; });
  fresh.catch(() => {});
  const timeout = new Promise(r => setTimeout(r, 4000));
  try {
    const res = await Promise.race([fresh, timeout]);
    if (res) return res;
  } catch {}
  const hit = await cache.match(req, {ignoreSearch:true}) || (req.mode === "navigate" && await cache.match("./"));
  return hit || fresh;
}
// 函式庫和字型的網址有版本號，存過就直接用
async function cacheFirst(req){
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") (await caches.open(CACHE)).put(req, res.clone());
  return res;
}
