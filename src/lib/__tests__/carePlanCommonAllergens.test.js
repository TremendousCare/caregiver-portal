import { describe, it, expect } from 'vitest';
import {
  COMMON_ALLERGENS,
  searchCommonAllergens,
} from '../../features/care-plans/commonAllergens';

// Tests for the autocomplete suggestion source used by the Health
// Profile allergies LIST. Mirrors the shape of
// carePlanCommonMedications.test.js — same contract, different data.

describe('COMMON_ALLERGENS catalog', () => {
  it('has a reasonable number of entries (60+)', () => {
    expect(COMMON_ALLERGENS.length).toBeGreaterThanOrEqual(60);
  });

  it('contains no duplicates', () => {
    expect(new Set(COMMON_ALLERGENS).size).toBe(COMMON_ALLERGENS.length);
  });

  it('every entry is a non-empty trimmed string', () => {
    for (const a of COMMON_ALLERGENS) {
      expect(typeof a).toBe('string');
      expect(a.trim()).toBe(a);
      expect(a.length).toBeGreaterThan(0);
    }
  });

  it('covers each of the major buckets we documented', () => {
    const lc = COMMON_ALLERGENS.map((a) => a.toLowerCase());
    // Drug
    expect(lc.some((a) => a.includes('penicillin'))).toBe(true);
    expect(lc.some((a) => a.includes('sulfa'))).toBe(true);
    // Food
    expect(lc.some((a) => a.includes('peanut'))).toBe(true);
    expect(lc.some((a) => a.includes('shellfish'))).toBe(true);
    // Environmental
    expect(lc.some((a) => a.includes('pollen'))).toBe(true);
    expect(lc.some((a) => a.includes('dust mite'))).toBe(true);
    // Insect
    expect(lc.some((a) => a.includes('bee'))).toBe(true);
    // Material
    expect(lc.some((a) => a.includes('latex'))).toBe(true);
  });
});

describe('searchCommonAllergens', () => {
  it('returns empty array for empty / whitespace / nullish query', () => {
    expect(searchCommonAllergens('')).toEqual([]);
    expect(searchCommonAllergens('   ')).toEqual([]);
    expect(searchCommonAllergens(null)).toEqual([]);
    expect(searchCommonAllergens(undefined)).toEqual([]);
  });

  it('is case-insensitive', () => {
    const a = searchCommonAllergens('pen');
    const b = searchCommonAllergens('PEN');
    expect(a).toEqual(b);
    expect(a.some((s) => s.toLowerCase().startsWith('pen'))).toBe(true);
  });

  it('prioritizes prefix matches over contains matches', () => {
    const out = searchCommonAllergens('la', 10);
    if (out.length > 0) {
      // "Latex" should come before substrings containing "la".
      expect(out[0].toLowerCase().startsWith('la')).toBe(true);
    }
  });

  it('finds common food allergens by short prefix', () => {
    const out = searchCommonAllergens('pea');
    expect(out.some((s) => s.toLowerCase().includes('peanut'))).toBe(true);
  });

  it('respects an explicit limit', () => {
    const out = searchCommonAllergens('a', 3);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('returns at most 8 by default', () => {
    const out = searchCommonAllergens('a');
    expect(out.length).toBeLessThanOrEqual(8);
  });
});
