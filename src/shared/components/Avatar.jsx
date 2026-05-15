import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { AVATAR_BUCKET, AVATAR_SIGNED_URL_TTL_SEC, avatarInitials } from '../../lib/avatar';
import styles from './Avatar.module.css';

// Module-level cache so the same path doesn't re-mint a signed URL
// every time the component remounts (e.g. dashboard scroll, tab
// switch). Entries expire ~5min before the URL itself does.
const URL_CACHE = new Map(); // path → { url, expiresAt }
const URL_TTL_MS = (AVATAR_SIGNED_URL_TTL_SEC - 5 * 60) * 1000;

async function getSignedAvatarUrl(path) {
  if (!path || !supabase) return null;
  const now = Date.now();
  const cached = URL_CACHE.get(path);
  if (cached && cached.expiresAt > now) return cached.url;
  const { data, error } = await supabase
    .storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(path, AVATAR_SIGNED_URL_TTL_SEC);
  if (error || !data?.signedUrl) return null;
  URL_CACHE.set(path, { url: data.signedUrl, expiresAt: now + URL_TTL_MS });
  return data.signedUrl;
}

// Lets the upload component invalidate the cache when a new path is
// written so the next render shows the fresh photo immediately.
export function invalidateAvatarCache(path) {
  if (path) URL_CACHE.delete(path);
}

/**
 * Profile-picture display. Renders the photo when `path` is set and
 * readable; falls back to the initials avatar (matching the legacy
 * `.cgAvatar` / `.detailAvatar` look) when no path or the signed URL
 * fails.
 *
 * Props:
 *   path        — storage object key inside the profile-pictures bucket
 *   firstName   — used for initials fallback
 *   lastName    — used for initials fallback
 *   size        — 'sm' (44px, list cards) | 'lg' (56px, profile header)
 *   children    — optional overlay (used by AvatarUpload for the edit hint)
 */
export function Avatar({ path, firstName, lastName, size = 'sm', children }) {
  const [signedUrl, setSignedUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (!path) {
      setSignedUrl(null);
      return undefined;
    }
    getSignedAvatarUrl(path).then((url) => {
      if (cancelled) return;
      if (url) setSignedUrl(url);
      else setFailed(true);
    });
    return () => { cancelled = true; };
  }, [path]);

  const sizeClass = size === 'lg' ? styles.sizeLg : styles.sizeSm;
  const showImage = signedUrl && !failed;
  return (
    <div className={`${styles.root} ${sizeClass}`}>
      {showImage ? (
        <img
          className={styles.image}
          src={signedUrl}
          alt=""
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{avatarInitials(firstName, lastName)}</span>
      )}
      {children}
    </div>
  );
}
