/* Movie Vault service worker.
 *
 * - Precaches the app shell so the app opens offline.
 * - Same-origin GET requests are served network-first (updates show up as soon as you are online)
 *   and fall back to the cache when the network is unavailable.
 * - Cross-origin requests (cover APIs, poster images, the Quagga / PeerJS / QR code CDN scripts) are never touched.
 *
 * To force every installed copy to refresh its precache, bump CACHE_VERSION below.
 * All paths are relative, so the app works both at the domain root and under /<repo-name>/.
 */
const CACHE_VERSION = 'v2';
const CACHE = 'movie-vault-' + CACHE_VERSION;

const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/seed-data.js',
  'js/storage.js',
  'js/covers.js',
  'js/scanner.js',
  'js/remote-scan.js',
  'js/app.js',
  'js/pwa.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache:'reload' skips the browser HTTP cache so a new version never precaches stale files.
    await cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(name => name.startsWith('movie-vault-') && name !== CACHE)
           .map(name => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: leave to the browser
  event.respondWith(networkFirst(event, req));
});

async function networkFirst(event, req) {
  try {
    // cache:'no-cache' makes the browser revalidate with the server, so hosts that send
    // max-age (GitHub Pages: 10 minutes) cannot serve a stale copy while we are online.
    const res = await fetch(req, { cache: 'no-cache' });
    // Only store complete, same-origin responses. Never opaque ones (they bloat the storage quota).
    if (res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(
        caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {})
      );
    }
    return res;
  } catch (err) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = (await cache.match('index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    return Response.error();
  }
}
