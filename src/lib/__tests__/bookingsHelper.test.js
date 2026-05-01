/**
 * Tests for getBookingUrlFromOrgSettings — locks the JSON path inside
 * organizations.settings where the per-org Microsoft Bookings public URL
 * lives. If the migration that seeds it (20260504000000) ever changes
 * shape, these tests force the helper and the migration to stay in sync.
 */

import { describe, it, expect } from 'vitest';
import {
  getBookingUrlFromOrgSettings,
  BOOKINGS_SETTINGS_KEY,
  BOOKINGS_PUBLIC_URL_KEY,
} from '../../../supabase/functions/_shared/helpers/bookings.ts';

describe('getBookingUrlFromOrgSettings', () => {
  it('returns the public URL when shape is correct', () => {
    const url = getBookingUrlFromOrgSettings({
      bookings: {
        public_url: 'https://outlook.office.com/book/Foo@bar.com/',
        business_id: 'Foo@bar.com',
      },
    });
    expect(url).toBe('https://outlook.office.com/book/Foo@bar.com/');
  });

  it('returns empty string when settings is null', () => {
    expect(getBookingUrlFromOrgSettings(null)).toBe('');
  });

  it('returns empty string when settings is undefined', () => {
    expect(getBookingUrlFromOrgSettings(undefined)).toBe('');
  });

  it('returns empty string when settings is not an object', () => {
    expect(getBookingUrlFromOrgSettings('not an object')).toBe('');
    expect(getBookingUrlFromOrgSettings(42)).toBe('');
  });

  it('returns empty string when bookings block is missing', () => {
    expect(getBookingUrlFromOrgSettings({})).toBe('');
    expect(getBookingUrlFromOrgSettings({ paychex: {} })).toBe('');
  });

  it('returns empty string when bookings block is not an object', () => {
    expect(getBookingUrlFromOrgSettings({ bookings: null })).toBe('');
    expect(getBookingUrlFromOrgSettings({ bookings: 'string' })).toBe('');
  });

  it('returns empty string when public_url is missing', () => {
    expect(getBookingUrlFromOrgSettings({ bookings: { business_id: 'x' } })).toBe('');
  });

  it('returns empty string when public_url is not a string', () => {
    expect(getBookingUrlFromOrgSettings({ bookings: { public_url: null } })).toBe('');
    expect(getBookingUrlFromOrgSettings({ bookings: { public_url: 42 } })).toBe('');
  });

  it('does not crash on deeply unexpected shapes', () => {
    expect(getBookingUrlFromOrgSettings({ bookings: { public_url: { nested: 'oops' } } })).toBe('');
  });

  it('exports the JSON path constants', () => {
    expect(BOOKINGS_SETTINGS_KEY).toBe('bookings');
    expect(BOOKINGS_PUBLIC_URL_KEY).toBe('public_url');
  });
});
