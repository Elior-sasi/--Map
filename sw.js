// סנטר-Map service worker - the whole app is one file, so caching it is enough for full offline use.
const CACHE = 'center-map-f2d939045df5-040b161a';
const ASSETS = ['./', './index.html', './data.json', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });
function offlinePage() {
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>סנטר-Map · אין חיבור</title><style>
html,body{margin:0;height:100%;background:#181e29;color:#fff;font:16px/1.5 -apple-system,system-ui,Heebo,sans-serif}
main{min-height:100%;display:grid;place-items:center;text-align:center;padding:24px;box-sizing:border-box}
.ic{width:84px;height:84px;border-radius:24px;background:#171d2e;display:grid;place-items:center;margin:0 auto 18px;box-shadow:0 6px 20px rgba(198,41,128,.25)}
h1{font-size:1.5em;margin:0 0 8px}p{color:#a9b8c9;margin:0 0 22px;max-width:28ch}
button{font:inherit;font-weight:800;color:#fff;background:#246ed1;border:0;border-radius:999px;padding:14px 28px;min-height:48px}
@media (prefers-color-scheme:light){html,body{background:#f2f4f8;color:#171d2e}p{color:#636e80}}
</style></head><body><main><div><div class="ic"><svg width="56" height="56" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 10a18 18 0 0 0-18 18c0 14 18 27 18 27s18-13 18-27a18 18 0 0 0-18-18" fill="white"/><path d="M39 22a10 10 0 1 0 0 13" stroke="#c62980" stroke-width="5" fill="none"/></svg></div>
<h1>אין חיבור כרגע</h1><p>בכניסה הראשונה צריך אינטרנט כדי להוריד את המפה. אחרי זה היא עובדת גם בלי קליטה.</p>
<button onclick="location.reload()">נסו שוב</button></div></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
// event reminders (sent by the daily GitHub Action a day before)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'סנטר-Map', {
    body: d.body || '', icon: './icon-192.png', badge: './icon-192.png', tag: d.tag || 'center-map', lang: 'he', dir: 'rtl',
    data: { url: d.url || './?view=events' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if (w.url.startsWith(self.registration.scope) && 'focus' in w) { w.navigate(url); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') {                       // app shell: instant from cache, refreshed quietly in the background
    const fresh = fetch('./index.html', { cache: 'no-cache' }).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); }
      return r;
    });
    e.respondWith(caches.match('./index.html').then(c => {
      if (c) { e.waitUntil(fresh.catch(() => {})); return c; }   // next open already gets the new version
      return fresh.catch(() => offlinePage());                    // first visit with no signal
    }));
    return;
  }
  if (u.pathname.endsWith('/cloud.json')) return;                 // always live
  if (u.pathname.endsWith('/data.json')) {                    // stale-while-revalidate: instant, then fresh
    e.respondWith(caches.open(CACHE).then(async c => {
      const cached = await c.match('./data.json');
      const net = fetch(e.request).then(r => { if (r.ok) c.put('./data.json', r.clone()); return r; }).catch(() => cached);
      return cached || net;
    }));
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
