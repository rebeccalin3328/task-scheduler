// Caches the app so it opens instantly and works offline.
const CACHE = 'task-scheduler-v3';
const FILES = ['./', './index.html', './parser.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // Shared links arrive as index.html?text=...; serve the cached page and keep the query for the app.
  const key = url.pathname.endsWith('/') || url.pathname.endsWith('index.html') ? './index.html' : e.request;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(CACHE).then(c => c.put(key === './index.html' ? './index.html' : e.request, copy));
    return r;
  }).catch(() => caches.match(key)));
});
