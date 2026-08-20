// sw.js — app-shell cache for PWA (network-first for fresh deploys)
//
// Bump CACHE on every deploy (v7 -> v8 -> ...). The new worker deletes old
// caches in activate, and core files are fetched network-first so a normal
// reopen always gets the latest code. Cache is only used as an offline fallback.
const CACHE = "om-order-v55";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./i18n.js",
  "./logo.png",
  "./icon-192.png",
  "./icon-180.png",
  "./icon-512.png",
  "./service.css",
  "./manifest.json",
];

self.addEventListener("install", (e) => {
  // Pre-cache the shell so the app still opens offline, but don't let one
  // missing file abort the whole install.
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(SHELL.map((u) => c.add(u)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  // Remove every cache that isn't the current version.
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

  // Only manage GET requests; let the browser handle the rest normally.
  if (e.request.method !== "GET") return;

  // Network-first: try the network, update the cache with the fresh copy,
  // and fall back to the cached version only when offline / the fetch fails.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Cache a clone of successful same-origin responses for offline use.
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
