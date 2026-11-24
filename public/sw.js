const CACHE = 'antennar-shell-v15';
const BASE = new URL(self.registration.scope).pathname;
const SHELL = [BASE, `${BASE}manifest.webmanifest`, `${BASE}icons/icon.svg`];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname === `${BASE}data/fcc-catalog.json`) {
    event.respondWith(fetch(event.request).then(response => { if (response.ok) { const copy=response.clone(); void caches.open(CACHE).then(cache=>cache.put(event.request,copy)); } return response; }).catch(() => caches.match(event.request)));
  } else if (url.pathname.startsWith(`${BASE}data/fcc/`)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => { if (response.ok) { const copy=response.clone(); void caches.open(CACHE).then(cache=>cache.put(event.request,copy)); } return response; })));
  } else if (SHELL.includes(url.pathname) || url.pathname.startsWith(`${BASE}assets/`)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => { const copy=response.clone(); void caches.open(CACHE).then(cache=>cache.put(event.request,copy)); return response; })));
  }
});
