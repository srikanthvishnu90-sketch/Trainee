// Upmore service worker: app-shell cache + offline fallback.
// bfac28dc2b5b5d65 is stamped by src/build-app.py (short git hash) so every deploy
// gets a fresh cache version — a stale service worker must never serve an
// old build of the app shell.
const CACHE = "upmore-bfac28dc2b5b5d65";
const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only handle same-origin GETs; let API/auth go to network
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Never cache Supabase or API calls
  if (url.pathname.startsWith("/rest/") || url.pathname.startsWith("/auth/")) return;
  const isShell = url.pathname === "/" || url.pathname === "/index.html";
  if (isShell) {
    // Network-first for the app shell: always serve the latest deployed
    // build; fall back to cache only when offline.
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match("/index.html"))
      )
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit || caches.match("/index.html"));
      return hit || net;
    })
  );
});
