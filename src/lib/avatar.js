// Pure helpers for profile-picture upload + display.
//
// Anything that touches the DOM (canvas draw, FileReader, Supabase
// Storage SDK) lives in src/shared/components/Avatar*.jsx so this
// module can be unit-tested without jsdom shims for canvas/Image.

export const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB raw
export const AVATAR_TARGET_PX = 512; // square output edge
export const AVATAR_JPEG_QUALITY = 0.9;
export const AVATAR_BUCKET = 'profile-pictures';
// Signed URLs are minted with this TTL (seconds). 1 hour balances
// "user can leave a profile page open" against "leaked URL has a
// bounded blast radius".
export const AVATAR_SIGNED_URL_TTL_SEC = 60 * 60;

/**
 * Validate a File picked from <input type="file">.
 * Returns `{ ok: true }` on success or `{ ok: false, error: <msg> }`
 * with a user-facing message on failure.
 */
export function validateAvatarFile(file) {
  if (!file) return { ok: false, error: 'No file selected.' };
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    return { ok: false, error: 'Photo must be a JPEG, PNG, or WebP.' };
  }
  if (typeof file.size === 'number' && file.size > MAX_AVATAR_SIZE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return { ok: false, error: `Photo is ${mb} MB — max is 5 MB.` };
  }
  return { ok: true };
}

/**
 * Compute the cover-fit crop rectangle for a source image so the
 * output is a centered square of `target × target` pixels.
 *
 * Returns the args you pass to `ctx.drawImage(src, sx, sy, sWidth,
 * sHeight, 0, 0, dWidth, dHeight)` — `sx/sy/sWidth/sHeight` define
 * the source crop (centered square of `min(srcW, srcH)`), and
 * `dWidth/dHeight` are both `target`. If the source is smaller than
 * `target` on its shortest edge, we don't upscale — the destination
 * shrinks instead.
 */
export function computeCoverCrop(srcW, srcH, target = AVATAR_TARGET_PX) {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    throw new Error('computeCoverCrop: source dimensions must be positive');
  }
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error('computeCoverCrop: target must be positive');
  }
  const side = Math.min(srcW, srcH);
  const sx = Math.floor((srcW - side) / 2);
  const sy = Math.floor((srcH - side) / 2);
  const dSide = Math.min(side, target);
  return {
    sx,
    sy,
    sWidth: side,
    sHeight: side,
    dWidth: dSide,
    dHeight: dSide,
  };
}

/**
 * Build a storage path inside the `profile-pictures` bucket.
 * Path shape: `<orgId>/<entityType>/<entityId>/<uuid>.jpg`
 *
 * The output is always `.jpg` because the uploader re-encodes to
 * JPEG after the cover-crop resize, regardless of the source format.
 * Per-upload UUID suffix means stale browser caches never show a
 * replaced photo, and deleting the old object on replace is trivial.
 */
export function buildAvatarPath(orgId, entityType, entityId, uuid) {
  if (!orgId) throw new Error('buildAvatarPath: orgId is required');
  if (entityType !== 'caregivers' && entityType !== 'clients') {
    throw new Error(`buildAvatarPath: unknown entityType "${entityType}"`);
  }
  if (!entityId) throw new Error('buildAvatarPath: entityId is required');
  if (!uuid) throw new Error('buildAvatarPath: uuid is required');
  return `${orgId}/${entityType}/${entityId}/${uuid}.jpg`;
}

/**
 * Generate the initials shown when no photo is set. Always exactly
 * two characters (or one if only a first or last name is present).
 * Returns '?' if both are empty so the avatar never renders blank.
 */
export function avatarInitials(firstName, lastName) {
  const f = (firstName || '').trim();
  const l = (lastName || '').trim();
  if (!f && !l) return '?';
  return `${(f[0] || '').toUpperCase()}${(l[0] || '').toUpperCase()}` || '?';
}
