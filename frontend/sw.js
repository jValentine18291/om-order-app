// sw.js — minimal app-shell cache for PWA installability (Phase 1)
const CACHE = "om-order-v4";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls — always hit the network for live data.
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
