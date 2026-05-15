import { describe, it, expect } from 'vitest';
import {
  ALLOWED_AVATAR_TYPES,
  MAX_AVATAR_SIZE_BYTES,
  AVATAR_TARGET_PX,
  validateAvatarFile,
  computeCoverCrop,
  buildAvatarPath,
  avatarInitials,
} from '../avatar.js';

describe('validateAvatarFile', () => {
  it('accepts a small JPEG', () => {
    const file = { type: 'image/jpeg', size: 100_000 };
    expect(validateAvatarFile(file)).toEqual({ ok: true });
  });

  it('accepts PNG and WebP', () => {
    expect(validateAvatarFile({ type: 'image/png', size: 1000 }).ok).toBe(true);
    expect(validateAvatarFile({ type: 'image/webp', size: 1000 }).ok).toBe(true);
  });

  it('rejects null/undefined', () => {
    expect(validateAvatarFile(null).ok).toBe(false);
    expect(validateAvatarFile(undefined).ok).toBe(false);
  });

  it('rejects disallowed mime types (HEIC, SVG, GIF, PDF)', () => {
    for (const type of ['image/heic', 'image/svg+xml', 'image/gif', 'application/pdf']) {
      const r = validateAvatarFile({ type, size: 1000 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/JPEG|PNG|WebP/);
    }
  });

  it('rejects files over 5 MB', () => {
    const r = validateAvatarFile({ type: 'image/jpeg', size: MAX_AVATAR_SIZE_BYTES + 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/5 MB/);
  });

  it('accepts files at exactly the 5 MB boundary', () => {
    const r = validateAvatarFile({ type: 'image/jpeg', size: MAX_AVATAR_SIZE_BYTES });
    expect(r.ok).toBe(true);
  });

  it('error message reports size in MB to one decimal', () => {
    const r = validateAvatarFile({ type: 'image/jpeg', size: 7_340_032 }); // ~7.0 MB
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/7\.0 MB/);
  });

  it('keeps ALLOWED_AVATAR_TYPES stable (regression guard)', () => {
    expect(ALLOWED_AVATAR_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });
});

describe('computeCoverCrop', () => {
  it('returns a centered square for a wide source', () => {
    const r = computeCoverCrop(2000, 1000, 512);
    expect(r).toEqual({
      sx: 500, sy: 0, sWidth: 1000, sHeight: 1000, dWidth: 512, dHeight: 512,
    });
  });

  it('returns a centered square for a tall source', () => {
    const r = computeCoverCrop(800, 1600, 512);
    expect(r).toEqual({
      sx: 0, sy: 400, sWidth: 800, sHeight: 800, dWidth: 512, dHeight: 512,
    });
  });

  it('returns full source when already square at target size', () => {
    const r = computeCoverCrop(512, 512, 512);
    expect(r).toEqual({
      sx: 0, sy: 0, sWidth: 512, sHeight: 512, dWidth: 512, dHeight: 512,
    });
  });

  it('does not upscale a small source — destination shrinks instead', () => {
    const r = computeCoverCrop(300, 200, 512);
    expect(r.sWidth).toBe(200);
    expect(r.sHeight).toBe(200);
    expect(r.dWidth).toBe(200);
    expect(r.dHeight).toBe(200);
  });

  it('defaults target to AVATAR_TARGET_PX when not supplied', () => {
    const r = computeCoverCrop(2000, 2000);
    expect(r.dWidth).toBe(AVATAR_TARGET_PX);
    expect(r.dHeight).toBe(AVATAR_TARGET_PX);
  });

  it('throws on non-positive source dimensions', () => {
    expect(() => computeCoverCrop(0, 100)).toThrow();
    expect(() => computeCoverCrop(100, -1)).toThrow();
    expect(() => computeCoverCrop(NaN, 100)).toThrow();
  });

  it('throws on non-positive target', () => {
    expect(() => computeCoverCrop(100, 100, 0)).toThrow();
    expect(() => computeCoverCrop(100, 100, -5)).toThrow();
  });
});

describe('buildAvatarPath', () => {
  it('builds the caregiver path', () => {
    const p = buildAvatarPath('org-abc', 'caregivers', 'cg-123', 'uuid-xyz');
    expect(p).toBe('org-abc/caregivers/cg-123/uuid-xyz.jpg');
  });

  it('builds the client path', () => {
    const p = buildAvatarPath('org-abc', 'clients', 'cl-456', 'uuid-xyz');
    expect(p).toBe('org-abc/clients/cl-456/uuid-xyz.jpg');
  });

  it('uses orgId as the first segment (matches the RLS prefix check)', () => {
    const p = buildAvatarPath('ORG', 'caregivers', 'CG', 'U');
    expect(p.split('/')[0]).toBe('ORG');
  });

  it('rejects unknown entity types', () => {
    expect(() => buildAvatarPath('org', 'shifts', 'x', 'u')).toThrow(/entityType/);
  });

  it('rejects missing args', () => {
    expect(() => buildAvatarPath('', 'caregivers', 'x', 'u')).toThrow(/orgId/);
    expect(() => buildAvatarPath('org', 'caregivers', '', 'u')).toThrow(/entityId/);
    expect(() => buildAvatarPath('org', 'caregivers', 'x', '')).toThrow(/uuid/);
  });
});

describe('avatarInitials', () => {
  it('returns two uppercase letters', () => {
    expect(avatarInitials('Jane', 'Doe')).toBe('JD');
  });

  it('handles lowercase input', () => {
    expect(avatarInitials('alice', 'smith')).toBe('AS');
  });

  it('handles single-name inputs', () => {
    expect(avatarInitials('Jane', '')).toBe('J');
    expect(avatarInitials('', 'Doe')).toBe('D');
  });

  it('falls back to ? when both names are missing or whitespace', () => {
    expect(avatarInitials('', '')).toBe('?');
    expect(avatarInitials('   ', '   ')).toBe('?');
    expect(avatarInitials(null, null)).toBe('?');
    expect(avatarInitials(undefined, undefined)).toBe('?');
  });
});
