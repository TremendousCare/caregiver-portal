// ─────────────────────────────────────────────────────────────────
// Voice / CTI — RingCentral Embeddable widget position persistence
//
// Pure helpers for loading, storing, and clamping the draggable
// widget's position. Kept in plain JS (no React) so they can be
// unit-tested without a DOM.
//
// Storage shape: { left: number, top: number } in pixels, written as
// JSON. Returns null when the user has never dragged (use CSS default
// bottom-right placement in that case).
// ─────────────────────────────────────────────────────────────────

export const STORAGE_KEY = 'rc-embeddable-position-v1';

const MIN_VISIBLE_PX = 80;

function isFinitePosition(pos) {
  return (
    pos &&
    typeof pos === 'object' &&
    Number.isFinite(pos.left) &&
    Number.isFinite(pos.top)
  );
}

export function loadStoredPosition(storage) {
  const store = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isFinitePosition(parsed)) return null;
    return { left: parsed.left, top: parsed.top };
  } catch {
    return null;
  }
}

export function storePosition(pos, storage) {
  const store = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  if (!store) return;
  try {
    if (pos === null) {
      store.removeItem(STORAGE_KEY);
      return;
    }
    if (!isFinitePosition(pos)) return;
    store.setItem(STORAGE_KEY, JSON.stringify({ left: pos.left, top: pos.top }));
  } catch {
    // localStorage can throw in private-browsing mode or when quota
    // is exceeded — swallow; persistence is a nice-to-have.
  }
}

// Keep the widget on-screen even after window resize. We require at
// least MIN_VISIBLE_PX of the panel to remain visible on each axis so
// the user can always grab the header to drag it back.
export function clampPosition(pos, viewport, panel) {
  if (!isFinitePosition(pos)) return pos;
  const vw = Number.isFinite(viewport?.width) ? viewport.width : 0;
  const vh = Number.isFinite(viewport?.height) ? viewport.height : 0;
  const pw = Number.isFinite(panel?.width) ? panel.width : 0;
  const ph = Number.isFinite(panel?.height) ? panel.height : 0;

  const maxLeft = Math.max(0, vw - MIN_VISIBLE_PX);
  const minLeft = MIN_VISIBLE_PX - pw;
  const maxTop = Math.max(0, vh - MIN_VISIBLE_PX);
  const minTop = 0;

  const left = Math.min(maxLeft, Math.max(minLeft, pos.left));
  const top = Math.min(maxTop, Math.max(minTop, pos.top));
  return { left, top };
}
