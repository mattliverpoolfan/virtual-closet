// Service Worker — 提供離線支援
// 策略：app shell (HTML/CSS/JS) 採 network-first (有網一定拿最新版，沒網才用快取)
// CDN 模組與去背模型：cache-first（首次下載後永久離線可用）

const CACHE_VERSION = 'vc-v3';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icon.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isCDN = /cdn\.jsdelivr\.net|esm\.sh|unpkg\.com/.test(url.hostname);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // Network-first for app shell — 有網路時永遠拿最新版，沒網才退回快取
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
  } else if (isCDN) {
    // Cache-first for CDN (libraries + ML model)
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok || res.type === 'opaque') {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
          }
          return res;
        });
      })
    );
  }
});
