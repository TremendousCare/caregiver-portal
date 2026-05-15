import { useRef, useState } from 'react';
import { supabase, getOrgClaims } from '../../lib/supabase';
import {
  ALLOWED_AVATAR_TYPES,
  AVATAR_BUCKET,
  AVATAR_JPEG_QUALITY,
  AVATAR_TARGET_PX,
  buildAvatarPath,
  computeCoverCrop,
  validateAvatarFile,
} from '../../lib/avatar';
import { Avatar, invalidateAvatarCache } from './Avatar';
import styles from './Avatar.module.css';

// Read a File into an HTMLImageElement so we can draw it on a canvas.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the image file.'));
    };
    img.src = url;
  });
}

// Cover-crop + re-encode to JPEG. Returns a Blob ready to upload.
async function resizeToJpeg(file) {
  const img = await loadImage(file);
  const crop = computeCoverCrop(img.naturalWidth, img.naturalHeight, AVATAR_TARGET_PX);
  const canvas = document.createElement('canvas');
  canvas.width = crop.dWidth;
  canvas.height = crop.dHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the image.');
  ctx.drawImage(
    img,
    crop.sx, crop.sy, crop.sWidth, crop.sHeight,
    0, 0, crop.dWidth, crop.dHeight,
  );
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))),
      'image/jpeg',
      AVATAR_JPEG_QUALITY,
    );
  });
}

/**
 * Avatar with an upload-on-click overlay and a "Remove photo" link
 * below it. Used in the caregiver and client profile headers.
 *
 * Props:
 *   entityType    — 'caregivers' | 'clients'
 *   entityId      — row id of the caregiver or client
 *   currentPath   — current `avatar_path` value (nullable)
 *   firstName     — for the initials fallback
 *   lastName      — for the initials fallback
 *   size          — 'sm' | 'lg' (defaults to 'lg' for headers)
 *   onChange(newPath) — called with the new path (or null on remove)
 *                       after the DB has been updated. Parent should
 *                       update local state so the next render reflects
 *                       the new value.
 */
export function AvatarUpload({
  entityType,
  entityId,
  currentPath,
  firstName,
  lastName,
  size = 'lg',
  onChange,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const handlePick = async (e) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again still fires onChange.
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    await doUpload(file);
  };

  const doUpload = async (file) => {
    setError(null);
    const v = validateAvatarFile(file);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    if (!supabase) {
      setError('Storage is not configured.');
      return;
    }
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { orgId } = getOrgClaims(session);
      if (!orgId) throw new Error('No organization on your session. Please sign in again.');

      const blob = await resizeToJpeg(file);
      const uuid = crypto.randomUUID();
      const newPath = buildAvatarPath(orgId, entityType, entityId, uuid);

      const { error: upErr } = await supabase
        .storage
        .from(AVATAR_BUCKET)
        .upload(newPath, blob, {
          contentType: 'image/jpeg',
          cacheControl: '3600',
          upsert: false,
        });
      if (upErr) throw upErr;

      const { error: dbErr } = await supabase
        .from(entityType)
        .update({ avatar_path: newPath })
        .eq('id', entityId);
      if (dbErr) {
        // DB update failed — clean up the orphaned object so the
        // bucket doesn't accumulate unreferenced files.
        await supabase.storage.from(AVATAR_BUCKET).remove([newPath]).catch(() => {});
        throw dbErr;
      }

      // Delete the prior object (if any) so the bucket doesn't grow
      // unbounded. Best-effort; a leftover orphan is non-fatal.
      if (currentPath && currentPath !== newPath) {
        await supabase.storage.from(AVATAR_BUCKET).remove([currentPath]).catch(() => {});
        invalidateAvatarCache(currentPath);
      }

      invalidateAvatarCache(newPath);
      onChange?.(newPath);
    } catch (e) {
      setError(e?.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!currentPath || !supabase) return;
    setError(null);
    setBusy(true);
    try {
      const { error: dbErr } = await supabase
        .from(entityType)
        .update({ avatar_path: null })
        .eq('id', entityId);
      if (dbErr) throw dbErr;
      await supabase.storage.from(AVATAR_BUCKET).remove([currentPath]).catch(() => {});
      invalidateAvatarCache(currentPath);
      onChange?.(null);
    } catch (e) {
      setError(e?.message || 'Could not remove photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className={styles.uploadWrap}>
        <Avatar path={currentPath} firstName={firstName} lastName={lastName} size={size}>
          <input
            ref={inputRef}
            type="file"
            accept={ALLOWED_AVATAR_TYPES.join(',')}
            className={styles.fileInput}
            onChange={handlePick}
            disabled={busy}
            aria-label="Upload profile photo"
            title="Change photo"
          />
          {busy ? (
            <div className={styles.busyOverlay}>…</div>
          ) : (
            <div className={styles.editOverlay}>Change</div>
          )}
        </Avatar>
      </div>
      {currentPath && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.removeBtn}
            onClick={handleRemove}
            disabled={busy}
          >
            Remove photo
          </button>
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
