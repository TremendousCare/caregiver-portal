// Round-trip tests for the default_pay_rate / default_pay_ot_rate
// columns added in migration 20260526000000. Locks in the coercion
// rules in caregiverToDb that prevent empty-string-to-numeric errors.

import { describe, it, expect } from 'vitest';
import { dbToCaregiver, caregiverToDb } from '../storage';

describe('dbToCaregiver — pay rate fields', () => {
  it('maps default_pay_rate from snake_case to camelCase number', () => {
    const out = dbToCaregiver({ id: 'cg-1', default_pay_rate: '24.50' });
    expect(out.defaultPayRate).toBe(24.5);
  });

  it('maps default_pay_ot_rate from snake_case to camelCase number', () => {
    const out = dbToCaregiver({ id: 'cg-1', default_pay_ot_rate: '36.75' });
    expect(out.defaultPayOtRate).toBe(36.75);
  });

  it('returns null when rate columns are NULL in the DB', () => {
    const out = dbToCaregiver({ id: 'cg-1' });
    expect(out.defaultPayRate).toBeNull();
    expect(out.defaultPayOtRate).toBeNull();
  });

  it('does NOT collapse 0 to null (0 is a valid rate)', () => {
    const out = dbToCaregiver({ id: 'cg-1', default_pay_rate: 0, default_pay_ot_rate: 0 });
    expect(out.defaultPayRate).toBe(0);
    expect(out.defaultPayOtRate).toBe(0);
  });
});

describe('caregiverToDb — pay rate fields', () => {
  it('serializes a number through as-is', () => {
    const out = caregiverToDb({ id: 'cg-1', defaultPayRate: 24.5, defaultPayOtRate: 36.75 });
    expect(out.default_pay_rate).toBe(24.5);
    expect(out.default_pay_ot_rate).toBe(36.75);
  });

  it('coerces a numeric STRING to a number (form input path)', () => {
    // ProfileCard <input type="number"> returns strings via the
    // editForm. Without coercion, Postgres rejects '"24.50"' for a
    // numeric column.
    const out = caregiverToDb({ id: 'cg-1', defaultPayRate: '24.50', defaultPayOtRate: '36.75' });
    expect(out.default_pay_rate).toBe(24.5);
    expect(out.default_pay_ot_rate).toBe(36.75);
  });

  it('coerces empty string to null (cleared input)', () => {
    // The bug this guards against: user clears the input, the form
    // sends '', and we POST { default_pay_rate: '' } which crashes
    // with "invalid input syntax for type numeric".
    const out = caregiverToDb({ id: 'cg-1', defaultPayRate: '', defaultPayOtRate: '' });
    expect(out.default_pay_rate).toBeNull();
    expect(out.default_pay_ot_rate).toBeNull();
  });

  it('serializes undefined/null fields as null', () => {
    const out = caregiverToDb({ id: 'cg-1' });
    expect(out.default_pay_rate).toBeNull();
    expect(out.default_pay_ot_rate).toBeNull();
  });

  it('preserves 0 (does not collapse to null)', () => {
    const out = caregiverToDb({ id: 'cg-1', defaultPayRate: 0, defaultPayOtRate: 0 });
    expect(out.default_pay_rate).toBe(0);
    expect(out.default_pay_ot_rate).toBe(0);
  });

  it('does NOT touch proposed_pay_rate (independent field)', () => {
    // proposed_pay_rate stays its own column — Sprint 4 introduces
    // default_pay_rate as a distinct concept (operating rate vs
    // historical interview offer).
    const out = caregiverToDb({ id: 'cg-1', proposedPayRate: 22, defaultPayRate: 24.5 });
    expect(out.proposed_pay_rate).toBe(22);
    expect(out.default_pay_rate).toBe(24.5);
  });
});
