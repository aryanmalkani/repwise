// Keeps the app shell available offline. Your logs and photos are never cached here.
const VERSION = "gymlog-v4";
const LIBRARY = "gymlog-library-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/core.js", "/workout.js", "/manifest.webmanifest", "/icon.svg", "/gym.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== LIBRARY).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Exercise list and exercise photos: keep a copy on the phone so they work offline in the gym.
  if (url.origin === location.origin && url.pathname.startsWith("/api/library/")) {
    e.respondWith(
      caches.open(LIBRARY).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // Your logs and photos: always live, never cached by the service worker.
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  // Google Fonts: cache first.
  if (url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // App files: network first so updates show up right away, cache when offline.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone(); // has to happen before the response is handed to the page
            e.waitUntil(caches.open(VERSION).then((c) => c.put(req, copy)));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || (req.mode === "navigate" ? caches.match("/index.html") : Response.error()))
    );
  }
});
