// sw.js — app-shell cache for PWA (cache-first, refreshed in the background)
//
// Bump CACHE on every deploy (v7 -> v8 -> ...). The new worker deletes old
// caches in activate and precaches the new shell.
//
// The shell was network-first for a long time: every open waited for ~400KB
// to come over workshop Wi-Fi - with a copy already sitting on the phone -
// so a deploy would reach phones one open sooner. That guarantee was priced
// on EVERY open, and opens outnumber deploys a hundred to one. Now the cached
// copy is served instantly and the fresh one is fetched behind it, so a
// deploy shows one open later and startup does not touch the network at all.
const CACHE = "om-order-v352";

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
  "./fogger-tubes.js",
  "./common-jobs.js",
  "./pdf-fit.js",
  "./signature-font.js",
  "./service-items.js",
  "./app-functions.js",
  "./machine-types.js",
  "./machine-names.js",
  "./machine-ipl.js",
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

  // IPL artwork AND the book files that describe it: serve from cache
  // immediately, then refresh in the background. A drawing appears instantly
  // on a second viewing and survives deploys, while a re-extracted model still
  // corrects itself on the next open rather than needing a cache bump. The
  // brand logos sit a folder deeper, hence the optional path segment.
  //
  // The .json files were on the VERSIONED cache until the library could be
  // downloaded for offline use. That was fine while every book was fetched on
  // demand, and wrong the moment a technician carried the whole lot onto a
  // job: every deploy wiped the books and left 80MB of drawings the app could
  // no longer describe - offline, with no way to get them back until they were
  // next on office Wi-Fi. Same cache, same stale-while-revalidate, so a
  // re-imported book still corrects itself on the next open.
  if (/\/ipl\/(?:brands\/)?[^/]+\.(?:png|json)$/.test(url.pathname)) {
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

  // Cache-first, refreshed behind: the same shape the IPL diagrams have used
  // in production since v65. The cached copy answers immediately; the network
  // copy replaces it for the NEXT open. The versioned install above still
  // hard-refreshes everything whenever CACHE is bumped, so the two update
  // paths back each other up.
  //
  // A cache miss (fresh install, or iOS cleared storage under pressure) falls
  // through to the network. And a miss that also fails the network answers
  // with a real Response - respondWith(undefined) is how Safari ends up
  // saying "Returned response is null", which helps nobody.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(
          () =>
            hit ||
            new Response("Offline, and this page is not in the cache.", {
              status: 504,
              statusText: "Offline",
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
        );
      return hit || fresh;
    })
  );
});

// ---- Answering the app -----------------------------------------------------
// TWO QUESTIONS THE APP ASKS, both of them about deploys.
//
// Everything about taking an update used to depend on the BROWSER deciding to
// re-check this file. A phone that has been open on the bench since Tuesday may
// never do it: iOS keeps the app's page alive for days, so there is no "next
// open" for a new worker to arrive on. John, 28 Sep 2026 - "especially when
// they didn't close the app for a few days, they don't receive the update".
//
//   version        which shell this worker is serving. The app compares it with
//                  the version the SERVER says it is holding.
//   refresh-shell  fetch every shell file from the network, past every cache,
//                  and put it in. The app reloads afterwards and gets the new
//                  screens - WITHOUT this worker ever having been replaced,
//                  which is the whole point, because on the phones this is for,
//                  it is the worker that will not budge.
self.addEventListener("message", (e) => {
  const msg = e.data || {};
  const reply = (payload) => {
    if (e.source && e.source.postMessage) e.source.postMessage(payload);
  };

  if (msg.type === "version") {
    reply({ type: "version", version: CACHE });
    return;
  }

  if (msg.type === "refresh-shell") {
    e.waitUntil(
      (async () => {
        try {
          // EVERY file first, and only then put any of them in. A shell that
          // is half new is worse than a shell that is entirely old: last
          // week's app.js against this week's index.html is a broken screen
          // nobody can explain, and it would survive until the next deploy.
          const fetched = await Promise.all(
            SHELL.map(async (u) => {
              const res = await fetch(new Request(u, { cache: "reload" }));
              if (!res || res.status !== 200) throw new Error("not 200: " + u);
              return [u, res];
            })
          );
          const cache = await caches.open(CACHE);
          for (const [u, res] of fetched) await cache.put(u, res);
          reply({ type: "refresh-shell", ok: true });
        } catch (_) {
          // Offline, or the server mid-deploy. Nothing has been touched, so
          // the app carries on with the shell it has and asks again later.
          reply({ type: "refresh-shell", ok: false });
        }
      })()
    );
  }
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
