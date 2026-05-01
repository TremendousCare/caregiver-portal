import { describe, it, expect } from 'vitest';
import { normalizeBillableRate } from '../../features/clients/storage.js';

describe('normalizeBillableRate', () => {
  it('returns null for empty string', () => {
    expect(normalizeBillableRate('')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(normalizeBillableRate(null)).toBeNull();
    expect(normalizeBillableRate(undefined)).toBeNull();
  });

  it('parses a numeric string', () => {
    expect(normalizeBillableRate('35')).toBe(35);
    expect(normalizeBillableRate('35.50')).toBe(35.5);
  });

  it('passes through a real number', () => {
    expect(normalizeBillableRate(35)).toBe(35);
    expect(normalizeBillableRate(35.5)).toBe(35.5);
  });

  it('keeps a real zero', () => {
    // "0" is a deliberate user input, not "no rate set." Persist it as 0.
    expect(normalizeBillableRate('0')).toBe(0);
    expect(normalizeBillableRate(0)).toBe(0);
  });

  it('rejects negative numbers as null', () => {
    expect(normalizeBillableRate('-5')).toBeNull();
    expect(normalizeBillableRate(-5)).toBeNull();
  });

  it('rejects non-numeric strings as null', () => {
    expect(normalizeBillableRate('abc')).toBeNull();
    expect(normalizeBillableRate('$35')).toBeNull();
    expect(normalizeBillableRate('  ')).toBeNull();
  });

  it('rejects NaN/Infinity as null', () => {
    expect(normalizeBillableRate(NaN)).toBeNull();
    expect(normalizeBillableRate(Infinity)).toBeNull();
    expect(normalizeBillableRate(-Infinity)).toBeNull();
  });
});
