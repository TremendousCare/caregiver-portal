// ─── PWA route scoping ───
// The portal is one SPA serving a single index.html for several distinct
// surfaces (see App.jsx). The office/admin app is the catch-all: every path
// that is NOT a caregiver, BD, or public-token route. We use this to decide
// where to swap in the office manifest and where the office service worker
// is allowed to act.
//
// IMPORTANT: this list must stay in sync with the route split in App.jsx
// AND with the `isReserved()` guard in `public/app-sw.js` (a service worker
// cannot import app modules, so the prefixes are duplicated there with a
// cross-reference comment). If you add a new top-level surface, update all
// three places.

// Prefixes owned by surfaces OTHER than the office app. The office service
// worker must pass these through untouched; the office manifest must not be
// injected on them.
const RESERVED_PREFIXES = ['care', 'bd', 'apply', 'upload', 'sign', 'survey'];

// True when `pathname` belongs to a non-office surface.
export function isReservedRoute(pathname = '') {
  const path = String(pathname);
  return RESERVED_PREFIXES.some(
    (p) => path === `/${p}` || path.startsWith(`/${p}/`),
  );
}

// True when `pathname` is part of the office/admin app (the catch-all).
export function isOfficeRoute(pathname = '') {
  return !isReservedRoute(pathname);
}
