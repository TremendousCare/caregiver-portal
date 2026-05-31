/* ─── Office / admin PWA service worker (minimal, network-first) ───
 *
 * This is the DELIBERATELY "dumb" service worker for the office app. Its only
 * jobs are (1) make the office app installable and (2) load fast on repeat
 * visits — WITHOUT the cache-bricking risk of precaching the app shell.
 *
 * Design rules (see the PWA discussion in the project history):
 *   • Pages are ALWAYS network-first, so a new deploy is picked up on the
 *     next load — updates flow automatically, with no "Update" prompt
 *     (the opposite of the caregiver SW at /care, which is prompt-based on
 *     purpose so a shift is never interrupted).
 *   • Only immutable, content-hashed build assets are cached (cache-first).
 *     A new deploy ships new filenames, so a cached asset is never stale.
 *   • NEVER cache API / auth / Supabase traffic (different origin → ignored).
 *   • Pass through entirely for the caregiver (/care), BD (/bd) and public
 *     token surfaces, so this SW cannot affect them even though its scope is
 *     the whole origin. Keep `isReserved()` in sync with App.jsx and
 *     src/pwa/routeScope.js.
 *   • skipWaiting + clients.claim so each new version activates immediately.
 *     Safe here precisely because nothing stale is served from precache.
 */

const CACHE = 'tc-office-v1';
const OFFLINE_URL = '/office-offline.html';

// Prefixes owned by other surfaces — must mirror src/pwa/routeScope.js.
function isReserved(pathname) {
  return (
    pathname === '/care' || pathname.startsWith('/care/') ||
    pathname === '/bd' || pathname.startsWith('/bd/') ||
    pathname === '/apply' ||
    pathname.startsWith('/upload/') ||
    pathname.startsWith('/sign/') ||
    pathname.startsWith('/survey/')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting()),
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
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only ever touch our own origin. Supabase, Google Fonts, any third-party
  // API call → leave to the network (and the browser's own HTTP cache).
  if (url.origin !== self.location.origin) return;

  // Never interfere with the other surfaces.
  if (isReserved(url.pathname)) return;

  // Page navigations: network-first → offline fallback. Guarantees staff
  // always get the freshest deploy when online.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL)),
    );
    return;
  }

  // Immutable, content-hashed build assets: cache-first for speed. Safe
  // because filenames change on every deploy.
  if (['script', 'style', 'worker', 'image', 'font'].includes(request.destination)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          // Only cache successful same-origin responses.
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        });
      }),
    );
  }
  // Everything else (e.g. the manifest, data requests): default network.
});
