/* Movie Vault service worker.
 *
 * - Precaches the app shell so the app opens offline.
 * - Same-origin GET requests are served network-first (updates show up as soon as you are online)
 *   and fall back to the cache when the network is unavailable.
 * - On a slow network the cached copy is served after NETWORK_TIMEOUT_MS; the network request still finishes in the background
 *   and refreshes the cache, so the next start is up to date. A page whose HTML came from the cache gets its scripts and styles
 *   from the cache too (one consistent version, no second wait); a page whose HTML came from the network waits for the network,
 *   so new HTML is never mixed with old scripts.
 * - Cross-origin requests (cover APIs, poster images, the Quagga / QR code CDN scripts and the ntfy.sh relay of the phone scanner) are never touched.
 *
 * To force every installed copy to refresh its precache, bump CACHE_VERSION below.
 * All paths are relative, so the app works both at the domain root and under /<repo-name>/.
 */
const CACHE_VERSION = 'v5';
const CACHE = 'movie-vault-' + CACHE_VERSION;
const NETWORK_TIMEOUT_MS = 3000;

const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/seed-data.js',   // only loaded on a first run (see index.html), which must work offline too
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

// Where each open page's HTML came from: client id -> 'network' | 'cache'. Lost when the browser stops this worker (and empty where
// FetchEvent.resultingClientId is not supported); requests of an unknown page simply get the timeout below.
const pageSource = new Map();
function remember(page, source) {
  if (!page) return;
  pageSource.set(page, source);
  if (pageSource.size > 20) pageSource.delete(pageSource.keys().next().value); // only the latest few pages matter
}

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
  if (url.pathname.includes('/api/')) return;       // live lookups (api/barcode): never cached for offline use
  event.respondWith(respond(event, req));
});

async function respond(event, req) {
  const page = req.mode === 'navigate' ? event.resultingClientId : '';
  const source = page ? '' : pageSource.get(event.clientId);
  const network = fromNetwork(event, req);
  if (source === 'cache') { // this page runs the cached version: keep it consistent (and fast); the network copy only refreshes the cache
    const hit = await fromCache(req);
    if (hit) return hit;
  }
  try {
    const res = await (source === 'network' ? network : Promise.race([network, timeout()]));
    if (res) { remember(page, 'network'); return res; }
    const hit = await fromCache(req); // slow network: the cached copy now, the network answer refreshes the cache for next time
    if (hit) { remember(page, 'cache'); return hit; }
    const late = await network;       // nothing cached (yet): keep waiting for the network
    remember(page, 'network');
    return late;
  } catch (err) {                     // offline
    const hit = await fromCache(req);
    if (hit) { remember(page, 'cache'); return hit; }
    return Response.error();
  }
}

// The network answer (cache:'no-cache' makes the browser revalidate with the server, so hosts that send max-age, like GitHub Pages'
// 10 minutes, cannot serve a stale copy while we are online). Storing it is kept alive with waitUntil, registered now while the event
// is still active, so the cache is refreshed even when the cached copy was served first and the page is already gone.
function fromNetwork(event, req) {
  let stored;
  const network = fetch(req, { cache: 'no-cache' }).then(res => {
    // Only store complete, same-origin responses. Never opaque ones (they bloat the storage quota).
    if (res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      stored = caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
    }
    return res;
  });
  event.waitUntil(network.then(() => stored, () => {}));
  return network;
}

async function fromCache(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  if (req.mode === 'navigate') return (await cache.match('index.html')) || (await cache.match('./'));
  return undefined;
}

function timeout() {
  return new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
}
