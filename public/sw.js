// SafeOCR app-shell service worker. Models are cached by the engines themselves (Cache API); this
// only makes the page and its static assets load offline. Responses are stored and served as-is so
// the COOP/COEP headers that give the page cross-origin isolation come through intact.
//
// Only assets the server marks `immutable` are ever cached (production chunks and the runtimes
// are; a dev server's chunks are `no-store`), so a worker that outlives a production run cannot
// freeze a dev server's code. Hot-reload traffic is never intercepted at all.
const CACHE = 'safeocr-shell-v2';
const SHELL = ['/'];
const CACHE_FIRST_PREFIXES = ['/_next/static/', '/ocr-runtime/'];
const NEVER = [/hot-update/, /^\/_next\/static\/webpack\//, /^\/_next\/static\/development\//];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys.filter(key => key.startsWith('safeocr-shell-') && key !== CACHE).map(key => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (NEVER.some(pattern => pattern.test(url.pathname))) return;
  if (CACHE_FIRST_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && /immutable/.test(response.headers.get('cache-control') || '')) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put('/', response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match('/');
    if (cached) return cached;
    throw error;
  }
}
