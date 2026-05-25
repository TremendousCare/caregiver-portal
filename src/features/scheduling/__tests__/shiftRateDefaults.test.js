// Unit tests for the pure auto-fill helpers in shiftRateDefaults.js.

import { describe, it, expect } from 'vitest';
import {
  applyCaregiverDefaultRate,
  applyClientDefaultRate,
  matchesCaregiverDefault,
  matchesClientDefault,
} from '../shiftRateDefaults';

// ─── applyCaregiverDefaultRate ───────────────────────────────

describe('applyCaregiverDefaultRate', () => {
  it('fills hourlyRate when null and caregiver has a default', () => {
    const draft = { hourlyRate: null, foo: 'bar' };
    const out = applyCaregiverDefaultRate(draft, { defaultPayRate: 24.5 });
    expect(out).toEqual({ hourlyRate: 24.5, foo: 'bar' });
  });

  it('fills hourlyRate when undefined and caregiver has a default', () => {
    const draft = {};
    const out = applyCaregiverDefaultRate(draft, { defaultPayRate: 24.5 });
    expect(out.hourlyRate).toBe(24.5);
  });

  it('fills hourlyRate when empty string and caregiver has a default', () => {
    // Form inputs return '' before the user types; treat as empty.
    const draft = { hourlyRate: '' };
    const out = applyCaregiverDefaultRate(draft, { defaultPayRate: 30 });
    expect(out.hourlyRate).toBe(30);
  });

  it('does NOT overwrite an explicit non-zero hourlyRate', () => {
    const draft = { hourlyRate: 28 };
    const out = applyCaregiverDefaultRate(draft, { defaultPayRate: 24.5 });
    expect(out.hourlyRate).toBe(28);
  });

  it('does NOT overwrite an explicit zero hourlyRate (0 is valid: unpaid shift)', () => {
    // 0 is a legitimate rate (training shift, donation case). Helper
    // treats it as "explicitly set" and leaves it alone.
    const draft = { hourlyRate: 0 };
    const out = applyCaregiverDefaultRate(draft, { defaultPayRate: 24.5 });
    expect(out.hourlyRate).toBe(0);
  });

  it('no-ops when caregiver is null', () => {
    const draft = { hourlyRate: null };
    expect(applyCaregiverDefaultRate(draft, null)).toBe(draft);
  });

  it('no-ops when caregiver has no defaultPayRate', () => {
    const draft = { hourlyRate: null };
    expect(applyCaregiverDefaultRate(draft, { id: 'cg-1' })).toBe(draft);
  });

  it('no-ops when draft is null', () => {
    expect(applyCaregiverDefaultRate(null, { defaultPayRate: 24.5 })).toBeNull();
  });

  it('returns a NEW object (never mutates the input)', () => {
    const draft = { hourlyRate: null };
    const out = applyCaregiverDefaultRate(draft, { defaultPayRate: 24.5 });
    expect(out).not.toBe(draft);
    expect(draft.hourlyRate).toBeNull();
  });

  it('treats defaultPayRate=0 as a valid default (unpaid training fallback)', () => {
    // Edge case: an org sets the default to 0 to force per-shift entry.
    const draft = { hourlyRate: null };
    const out = applyCaregiverDefaultRate(draft, { defaultPayRate: 0 });
    expect(out.hourlyRate).toBe(0);
  });
});

// ─── applyClientDefaultRate ──────────────────────────────────

describe('applyClientDefaultRate', () => {
  it('fills billableRate when null and client has a default', () => {
    const draft = { billableRate: null };
    const out = applyClientDefaultRate(draft, { defaultBillableRate: 35 });
    expect(out.billableRate).toBe(35);
  });

  it('does NOT overwrite an explicit billableRate', () => {
    const draft = { billableRate: 40 };
    const out = applyClientDefaultRate(draft, { defaultBillableRate: 35 });
    expect(out.billableRate).toBe(40);
  });

  it('no-ops when client is null', () => {
    const draft = { billableRate: null };
    expect(applyClientDefaultRate(draft, null)).toBe(draft);
  });

  it('returns a new object (never mutates)', () => {
    const draft = { billableRate: null };
    const out = applyClientDefaultRate(draft, { defaultBillableRate: 35 });
    expect(out).not.toBe(draft);
    expect(draft.billableRate).toBeNull();
  });
});

// ─── matchesCaregiverDefault ─────────────────────────────────

describe('matchesCaregiverDefault', () => {
  it('returns true when number matches', () => {
    expect(matchesCaregiverDefault(24.5, { defaultPayRate: 24.5 })).toBe(true);
  });

  it('returns true when string-from-input numerically matches', () => {
    expect(matchesCaregiverDefault('24.5', { defaultPayRate: 24.5 })).toBe(true);
  });

  it('returns false when rates differ', () => {
    expect(matchesCaregiverDefault(28, { defaultPayRate: 24.5 })).toBe(false);
  });

  it('returns false when caregiver is null', () => {
    expect(matchesCaregiverDefault(24.5, null)).toBe(false);
  });

  it('returns false when no default exists', () => {
    expect(matchesCaregiverDefault(24.5, {})).toBe(false);
  });

  it('returns false for empty/null draft rate even if default exists', () => {
    expect(matchesCaregiverDefault(null, { defaultPayRate: 24.5 })).toBe(false);
    expect(matchesCaregiverDefault('', { defaultPayRate: 24.5 })).toBe(false);
  });
});

// ─── matchesClientDefault ────────────────────────────────────

describe('matchesClientDefault', () => {
  it('returns true when numbers match', () => {
    expect(matchesClientDefault(35, { defaultBillableRate: 35 })).toBe(true);
  });

  it('returns false when no client', () => {
    expect(matchesClientDefault(35, null)).toBe(false);
  });

  it('returns false when default is null', () => {
    expect(matchesClientDefault(35, { defaultBillableRate: null })).toBe(false);
  });
});
