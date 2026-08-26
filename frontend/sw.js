// sw.js — app-shell cache for PWA (network-first for fresh deploys)
//
// Bump CACHE on every deploy (v7 -> v8 -> ...). The new worker deletes old
// caches in activate, and core files are fetched network-first so a normal
// reopen always gets the latest code. Cache is only used as an offline fallback.
const CACHE = "om-order-v85";

// Parts diagrams live in their own cache, deliberately NOT version-stamped.
// They are large, they are already fetched only when a section is opened, and
// they do not change when the app does — so wiping them on every deploy just
// made phones re-download the same drawings over office Wi-Fi. This cache
// survives version bumps; only the app shell above is versioned.
const IPL_CACHE = "om-ipl-diagrams";
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
      Promise.all(
        keys
          .filter((k) => k !== CACHE && k !== IPL_CACHE)
          .map((k) => caches.delete(k))
      )
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

  // Parts diagrams: serve from cache immediately, then refresh in the
  // background. A drawing appears instantly on a second viewing and survives
  // deploys, while a re-extracted model still corrects itself on the next
  // open rather than needing a cache bump.
  if (/\/ipl\/[^/]+\.png$/.test(url.pathname)) {
    e.respondWith(
      caches.open(IPL_CACHE).then((cache) =>
        cache.match(e.request).then((hit) => {
          const fresh = fetch(e.request)
            .then((res) => {
              if (res && res.status === 200 && res.type === "basic") {
                cache.put(e.request, res.clone());
              }
              return res;
            })
            .catch(() => hit);
          return hit || fresh;
        })
      )
    );
    return;
  }

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
