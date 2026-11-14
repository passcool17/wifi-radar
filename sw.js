const CACHE = 'wifi-radar-v1.1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './js/samples.js',
  './js/simulator.js',
  './js/esp32.js',
  './js/source.js',
  './js/radar.js',
  './js/graph.js',
  './js/app.js',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './manifest.webmanifest',
  './cablage/index.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(ASSETS.map((url) => cache.add(url).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/flash')) return;
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        return fresh;
      } catch {
        if (req.mode === 'navigate') {
          const page = await caches.match('./index.html');
          if (page) return page;
        }
        throw new Error('offline');
      }
    })(),
  );
});
