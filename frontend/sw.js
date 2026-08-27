// sw.js — app-shell cache for PWA (network-first for fresh deploys)
//
// Bump CACHE on every deploy (v7 -> v8 -> ...). The new worker deletes old
// caches in activate, and core files are fetched network-first so a normal
// reopen always gets the latest code. Cache is only used as an offline fallback.
const CACHE = "om-order-v110";

// IPL artwork lives in its own cache, deliberately NOT version-stamped.
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
  "./apple-touch-icon.png",
  "./apple-touch-icon-precomposed.png",
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

  // The certificate has to be fetched by the browser itself, not through here.
  // A service worker's own fetch does not inherit the exception you tap through
  // on the warning page, so on a self-signed site every fetch made in here
  // fails — which is exactly why the icon never arrives, and why asking for
  // /cert.pem through the worker failed instead of downloading.
  if (url.pathname === "/cert.pem") return;

  // Only manage GET requests; let the browser handle the rest normally.
  if (e.request.method !== "GET") return;

  // IPL artwork - the parts diagrams and the brand logos: serve from cache
  // immediately, then refresh in the background. A drawing appears instantly
  // on a second viewing and survives deploys, while a re-extracted model still
  // corrects itself on the next open rather than needing a cache bump. The
  // brand logos sit a folder deeper, hence the optional path segment.
  if (/\/ipl\/(?:brands\/)?[^/]+\.png$/.test(url.pathname)) {
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
            // Same trap as below: with nothing cached and the network gone,
            // returning `hit` returns undefined.
            .catch(
              () =>
                hit ||
                new Response("", { status: 504, statusText: "Offline" })
            );
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
      // A cache miss here used to resolve to undefined, and respondWith takes
      // that as a failure — Safari then reports "Returned response is null",
      // which says nothing about what went wrong. Answer with a real response
      // so the browser shows an ordinary error instead.
      .catch(() =>
        caches.match(e.request).then(
          (hit) =>
            hit ||
            new Response("Offline, and this page is not in the cache.", {
              status: 504,
              statusText: "Offline",
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
        )
      )
  );
});

// ---- Push notifications ----------------------------------------------------
// The worker is what receives these. The app itself is not running when one
// arrives — the phone wakes this file, shows the notification, and goes back to
// sleep.
self.addEventListener("push", (e) => {
  let d = { title: "OM Service", body: "", slip: "" };
  try {
    if (e.data) d = Object.assign(d, e.data.json());
  } catch (_) {
    // A push with no readable payload still deserves to be shown: a silent
    // failure here is a notification the person never sees.
    if (e.data) d.body = e.data.text();
  }
  e.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      // Replaces rather than stacks when the same slip is marked twice.
      tag: d.slip ? `slip-${d.slip}` : "om-service",
      renotify: true,
      data: { slip: d.slip || "" },
    })
  );
});

// Tapping it should land on the list, not just open the app somewhere.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL("./index.html?go=quote", self.location).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      // Reuse a window that is already open rather than piling up new ones.
      for (const w of wins) {
        if (w.url.startsWith(self.location.origin) && "focus" in w) {
          w.postMessage({ type: "go", screen: "quote" });
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
