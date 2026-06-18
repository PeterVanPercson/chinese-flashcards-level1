/* Ten-Level Chinese — service worker
   Two cache buckets:
   - SHELL (versioned): html/js/css/json — stale-while-revalidate, so a
     deploy reaches users one load later. Bumping the version drops ONLY
     this bucket.
   - ASSETS (stable): audio clips, icons, fonts, CDN libs — cache-first
     and effectively immutable; they survive shell version bumps so a
     deploy never re-downloads 10MB of audio. */
const SHELL_CACHE  = 'tlc-shell-v4';
const ASSET_CACHE  = 'tlc-assets-v1';

const SHELL = [
  './',
  'index.html',
  'assets/styles.css',
  'assets/app.js',
  'data/lessons.json',
  'assets/audio/manifest.json',
  'manifest.json',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) =>
      // Cache shell files individually — one miss must not void the rest.
      Promise.allSettled(SHELL.map((u) => c.add(u)))
    )
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// App shell = same-origin html/js/css/json (and the directory roots).
function isShellRequest(url) {
  return url.origin === self.location.origin &&
    (/\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith('/'));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App shell → stale-while-revalidate. The revalidation is kept alive
  // with waitUntil so the SW isn't killed before the cache updates.
  if (isShellRequest(url)) {
    e.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(req, { ignoreSearch: true });
        const revalidate = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        if (cached) {
          e.waitUntil(revalidate);
          return cached;
        }
        return (await revalidate) || cache.match('index.html');
      })
    );
    return;
  }

  // Everything else (audio, icons, fonts, CDN) → cache-first, stable bucket.
  e.respondWith(
    caches.open(ASSET_CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // Same-origin: only cache real successes. Cross-origin opaque
        // responses can't be inspected — cache them, but only when the
        // type is opaque (a CDN-level error usually surfaces as a
        // non-opaque error response and is skipped).
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (err) {
        return cached || Response.error();
      }
    })
  );
});
