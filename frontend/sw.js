// Magnetic Memories service worker — NETWORK-FIRST (safe for frequent deploys).
// When online, you always get the freshest page (no stale-version trap).
// When offline, it serves the last good copy so the site/event tool still opens.
// It never touches API calls or uploads (POST), so payments/orders are unaffected.

const CACHE = 'mm-cache-v1';

self.addEventListener('install', () => {
  self.skipWaiting(); // activate the new SW immediately
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop any old caches from previous versions
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                    // never intercept uploads/POSTs
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // only our own site
  if (url.pathname.startsWith('/api/')) return;        // never cache API responses

  event.respondWith((async () => {
    try {
      // Always try the network first → fresh content whenever there's signal
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone()).catch(() => {});   // stash a copy for offline
      return fresh;
    } catch (err) {
      // Offline: fall back to the cached copy if we have one
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const home = await caches.match('/');
        if (home) return home;
      }
      throw err;
    }
  })());
});
