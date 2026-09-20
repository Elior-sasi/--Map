// סנטר-Map service worker - the whole app is one file, so caching it is enough for full offline use.
const CACHE = 'center-map-de358795a94a';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './maskable-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') {                       // app shell, offline-first
    e.respondWith(caches.match('./index.html').then(c => c || fetch(e.request)));
    return;
  }
  if (u.origin === location.origin) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(c => c || fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(cc => cc.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match('./index.html'))));
    return;
  }
  if (u.hostname.endsWith('gstatic.com') || u.hostname.endsWith('googleapis.com')) {   // fonts
    e.respondWith(caches.match(e.request).then(c => c || fetch(e.request).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(cc => cc.put(e.request, copy)); return r;
    }).catch(() => c)));
  }
});
