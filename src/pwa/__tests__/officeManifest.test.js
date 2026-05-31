import { describe, it, expect } from 'vitest';
import {
  OFFICE_BRANDING,
  resolveOfficeBranding,
  buildOfficeManifest,
} from '../officeManifest';

describe('resolveOfficeBranding', () => {
  it('falls back to defaults when org settings have no branding', () => {
    expect(resolveOfficeBranding(null)).toEqual(OFFICE_BRANDING);
    expect(resolveOfficeBranding({})).toEqual(OFFICE_BRANDING);
    expect(resolveOfficeBranding({ branding: {} })).toEqual(OFFICE_BRANDING);
  });

  it('overrides only the supplied fields (partial branding is safe)', () => {
    const resolved = resolveOfficeBranding({ branding: { name: 'Acme Home Care' } });
    expect(resolved.name).toBe('Acme Home Care');
    expect(resolved.short_name).toBe(OFFICE_BRANDING.short_name);
    expect(resolved.theme_color).toBe(OFFICE_BRANDING.theme_color);
    expect(resolved.icons).toEqual(OFFICE_BRANDING.icons);
  });

  it('overrides icons only when a non-empty array is provided', () => {
    const custom = [{ src: '/x.png', sizes: '192x192', type: 'image/png', purpose: 'any' }];
    expect(resolveOfficeBranding({ branding: { icons: custom } }).icons).toEqual(custom);
    expect(resolveOfficeBranding({ branding: { icons: [] } }).icons).toEqual(OFFICE_BRANDING.icons);
    expect(resolveOfficeBranding({ branding: { icons: 'nope' } }).icons).toEqual(OFFICE_BRANDING.icons);
  });
});

describe('buildOfficeManifest', () => {
  it('scopes the office app to the whole portal', () => {
    const m = buildOfficeManifest();
    expect(m.scope).toBe('/');
    expect(m.start_url).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.name).toBe(OFFICE_BRANDING.name);
  });

  it('makes all URLs absolute against the origin (required for blob manifests)', () => {
    const m = buildOfficeManifest(OFFICE_BRANDING, 'https://portal.example.com');
    expect(m.scope).toBe('https://portal.example.com/');
    expect(m.start_url).toBe('https://portal.example.com/');
    expect(m.id).toBe('https://portal.example.com/');
    expect(m.icons[0].src).toBe('https://portal.example.com/icons/icon-192.png');
    // Non-URL icon metadata is preserved.
    expect(m.icons[2].purpose).toBe('maskable');
  });

  it('reflects custom branding', () => {
    const branding = resolveOfficeBranding({ branding: { name: 'Acme', theme_color: '#111111' } });
    const m = buildOfficeManifest(branding);
    expect(m.name).toBe('Acme');
    expect(m.theme_color).toBe('#111111');
  });
});
