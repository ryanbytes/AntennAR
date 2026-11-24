const CACHE = 'antennar-shell-v2';
const BASE = new URL(self.registration.scope).pathname;
const SHELL = [BASE, `${BASE}manifest.webmanifest`, `${BASE}icons/icon.svg`];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname === `${BASE}data/fcc-sites.json` || url.pathname === `${BASE}data/acma-sites.json`) {
    event.respondWith(fetch(event.request).then(response => { if (response.ok) { const copy=response.clone(); void caches.open(CACHE).then(cache=>cache.put(event.request,copy)); } return response; }).catch(() => caches.match(event.request)));
  } else if (SHELL.includes(url.pathname) || url.pathname.startsWith(`${BASE}assets/`)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => { const copy=response.clone(); void caches.open(CACHE).then(cache=>cache.put(event.request,copy)); return response; })));
  }
});
