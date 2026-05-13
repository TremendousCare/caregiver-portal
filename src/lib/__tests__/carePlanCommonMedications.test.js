import { describe, it, expect } from 'vitest';
import {
  COMMON_MEDICATIONS,
  searchCommonMedications,
} from '../../features/care-plans/commonMedications';

// Tests for the autocomplete suggestion source used by the Health
// Profile medications LIST.

describe('COMMON_MEDICATIONS catalog', () => {
  it('has a reasonable number of entries (100+)', () => {
    expect(COMMON_MEDICATIONS.length).toBeGreaterThanOrEqual(100);
  });

  it('contains no duplicates', () => {
    expect(new Set(COMMON_MEDICATIONS).size).toBe(COMMON_MEDICATIONS.length);
  });

  it('every entry is a non-empty string', () => {
    for (const med of COMMON_MEDICATIONS) {
      expect(typeof med).toBe('string');
      expect(med.trim()).toBe(med);
      expect(med.length).toBeGreaterThan(0);
    }
  });

  it('includes well-known senior medications', () => {
    const lc = COMMON_MEDICATIONS.map((m) => m.toLowerCase());
    expect(lc.some((m) => m.includes('lisinopril'))).toBe(true);
    expect(lc.some((m) => m.includes('metformin'))).toBe(true);
    expect(lc.some((m) => m.includes('atorvastatin'))).toBe(true);
    expect(lc.some((m) => m.includes('donepezil'))).toBe(true);
    expect(lc.some((m) => m.includes('warfarin'))).toBe(true);
  });
});

describe('searchCommonMedications', () => {
  it('returns empty array for empty / whitespace query', () => {
    expect(searchCommonMedications('')).toEqual([]);
    expect(searchCommonMedications('   ')).toEqual([]);
    expect(searchCommonMedications(null)).toEqual([]);
    expect(searchCommonMedications(undefined)).toEqual([]);
  });

  it('is case-insensitive', () => {
    const a = searchCommonMedications('lisin');
    const b = searchCommonMedications('LISIN');
    expect(a).toEqual(b);
    expect(a.some((m) => m.toLowerCase().startsWith('lisinopril'))).toBe(true);
  });

  it('prioritizes prefix matches over contains matches', () => {
    // "in" appears inside many names. Prefix-matching entries (those
    // starting with "in") should come first.
    const out = searchCommonMedications('in', 10);
    if (out.length > 0) {
      const firstStartsWithIn = out[0].toLowerCase().startsWith('in');
      expect(firstStartsWithIn).toBe(true);
    }
  });

  it('matches brand names in parentheses', () => {
    const out = searchCommonMedications('lipitor');
    expect(out.some((m) => m.toLowerCase().includes('lipitor'))).toBe(true);
  });

  it('respects the limit argument', () => {
    const out = searchCommonMedications('e', 3);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('returns at most 8 by default', () => {
    const out = searchCommonMedications('a');
    expect(out.length).toBeLessThanOrEqual(8);
  });
});
