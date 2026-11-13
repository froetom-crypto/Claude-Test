// App-Shell offline verfügbar machen; API-Antworten werden nie gecacht (immer live)
const V = 'pk-v5';
const SHELL = ['./', 'index.html', 'styles.css', 'stats.js', 'app.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  // Netz zuerst, damit Updates sofort ankommen; offline aus dem Cache
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(V).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
