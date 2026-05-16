import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MILEAGE_RATE_CENTS,
  MILEAGE_SOURCES,
  MILEAGE_STATUSES,
  MAX_MILES_PER_ENTRY,
  MAX_RATE_CENTS_PER_MILE,
  computeMilesFromOdometer,
  roundMiles,
  computeReimbursementCents,
  formatCents,
  formatMiles,
  validateMileageDraft,
  buildMileageRow,
  isMileageEntryEditable,
  groupEntriesByMonth,
  totalsForEntries,
} from '../../features/bd-portal/lib/bdMileage';

describe('constants', () => {
  it('exposes the IRS rate fallback in cents', () => {
    expect(Number.isInteger(DEFAULT_MILEAGE_RATE_CENTS)).toBe(true);
    expect(DEFAULT_MILEAGE_RATE_CENTS).toBeGreaterThan(0);
    expect(DEFAULT_MILEAGE_RATE_CENTS).toBeLessThanOrEqual(MAX_RATE_CENTS_PER_MILE);
  });
  it('exposes a small whitelist of source values', () => {
    expect(MILEAGE_SOURCES).toEqual(['odometer', 'manual', 'gps_estimate']);
  });
  it('exposes the forward-compat status enum', () => {
    expect(MILEAGE_STATUSES).toEqual(['draft', 'submitted', 'approved', 'rejected', 'paid']);
  });
});

describe('computeMilesFromOdometer', () => {
  it('returns the difference for a valid pair', () => {
    expect(computeMilesFromOdometer(10000, 10012)).toBe(12);
  });
  it('handles zero-mile trips', () => {
    expect(computeMilesFromOdometer(10000, 10000)).toBe(0);
  });
  it('returns null when end < start', () => {
    expect(computeMilesFromOdometer(10012, 10000)).toBe(null);
  });
  it('returns null for missing or invalid input', () => {
    expect(computeMilesFromOdometer(null, 10)).toBe(null);
    expect(computeMilesFromOdometer(10, undefined)).toBe(null);
    expect(computeMilesFromOdometer('a', 10)).toBe(null);
    expect(computeMilesFromOdometer(-1, 0)).toBe(null);
    expect(computeMilesFromOdometer(0, -1)).toBe(null);
  });
  it('coerces numeric strings', () => {
    expect(computeMilesFromOdometer('10000', '10005')).toBe(5);
  });
});

describe('roundMiles', () => {
  it('rounds to two decimal places', () => {
    expect(roundMiles(12.345)).toBe(12.35);
    expect(roundMiles(12.344)).toBe(12.34);
  });
  it('returns null for non-finite input', () => {
    expect(roundMiles(NaN)).toBe(null);
    expect(roundMiles(Infinity)).toBe(null);
    expect(roundMiles('not a number')).toBe(null);
  });
  it('passes through small integers', () => {
    expect(roundMiles(0)).toBe(0);
    expect(roundMiles(12)).toBe(12);
  });
});

describe('computeReimbursementCents', () => {
  it('multiplies miles by rate and rounds to whole cents', () => {
    expect(computeReimbursementCents(10, 70)).toBe(700);          // 10 mi × 70¢ = $7.00
    expect(computeReimbursementCents(12.5, 67)).toBe(838);        // 12.5 × 67 = 837.5 → 838
  });
  it('returns 0 for invalid or negative input', () => {
    expect(computeReimbursementCents(NaN, 70)).toBe(0);
    expect(computeReimbursementCents(10, NaN)).toBe(0);
    expect(computeReimbursementCents(-5, 70)).toBe(0);
    expect(computeReimbursementCents(10, -1)).toBe(0);
  });
  it('handles zero miles without error', () => {
    expect(computeReimbursementCents(0, 70)).toBe(0);
  });
});

describe('formatCents', () => {
  it('formats whole dollar amounts', () => {
    expect(formatCents(700)).toBe('$7.00');
    expect(formatCents(0)).toBe('$0.00');
  });
  it('formats fractional cents with two decimals', () => {
    expect(formatCents(838)).toBe('$8.38');
    expect(formatCents(1)).toBe('$0.01');
  });
  it('adds thousands separators', () => {
    expect(formatCents(1234567)).toBe('$12,345.67');
  });
  it('handles negative input', () => {
    expect(formatCents(-250)).toBe('-$2.50');
  });
  it('safely renders non-numeric input', () => {
    expect(formatCents(null)).toBe('$0.00');
    expect(formatCents(undefined)).toBe('$0.00');
    expect(formatCents('nope')).toBe('$0.00');
  });
});

describe('formatMiles', () => {
  it('drops trailing zero for whole numbers', () => {
    expect(formatMiles(12)).toBe('12');
    expect(formatMiles(12.0)).toBe('12');
  });
  it('keeps one decimal for fractional miles', () => {
    expect(formatMiles(12.3)).toBe('12.3');
    expect(formatMiles(12.34)).toBe('12.3');
  });
  it('handles zero and non-numeric input', () => {
    expect(formatMiles(0)).toBe('0');
    expect(formatMiles(null)).toBe('0');
    expect(formatMiles('hi')).toBe('0');
  });
});

const validDraft = () => ({
  trip_date:            '2026-05-16',
  purpose:              'Visit to Hoag Hospital',
  miles:                12.5,
  source:               'manual',
  rate_cents_per_mile:  70,
  status:               'draft',
});

describe('validateMileageDraft', () => {
  it('accepts a minimal valid draft', () => {
    expect(validateMileageDraft(validDraft())).toEqual({ ok: true });
  });
  it('rejects missing form data', () => {
    expect(validateMileageDraft(null).ok).toBe(false);
    expect(validateMileageDraft(undefined).ok).toBe(false);
  });
  it('requires a trip date', () => {
    expect(validateMileageDraft({ ...validDraft(), trip_date: '' }).ok).toBe(false);
    expect(validateMileageDraft({ ...validDraft(), trip_date: null }).ok).toBe(false);
  });
  it('rejects an unparseable trip date', () => {
    expect(validateMileageDraft({ ...validDraft(), trip_date: 'garbage' }).ok).toBe(false);
  });
  it('requires a non-blank purpose', () => {
    expect(validateMileageDraft({ ...validDraft(), purpose: '' }).ok).toBe(false);
    expect(validateMileageDraft({ ...validDraft(), purpose: '   ' }).ok).toBe(false);
    expect(validateMileageDraft({ ...validDraft(), purpose: null }).ok).toBe(false);
  });
  it('requires miles > 0', () => {
    expect(validateMileageDraft({ ...validDraft(), miles: 0 }).ok).toBe(false);
    expect(validateMileageDraft({ ...validDraft(), miles: -1 }).ok).toBe(false);
    expect(validateMileageDraft({ ...validDraft(), miles: 'lots' }).ok).toBe(false);
  });
  it('caps miles at MAX_MILES_PER_ENTRY', () => {
    expect(validateMileageDraft({ ...validDraft(), miles: MAX_MILES_PER_ENTRY + 1 }).ok).toBe(false);
    expect(validateMileageDraft({ ...validDraft(), miles: MAX_MILES_PER_ENTRY }).ok).toBe(true);
  });
  it('rejects an unknown source', () => {
    expect(validateMileageDraft({ ...validDraft(), source: 'tea-leaves' }).ok).toBe(false);
  });
  it('requires a consistent odometer pair when source is odometer', () => {
    const draft = {
      ...validDraft(),
      source: 'odometer',
      odometer_start: 10010,
      odometer_end: 10000,
    };
    expect(validateMileageDraft(draft).ok).toBe(false);
  });
  it('accepts a consistent odometer pair', () => {
    const draft = {
      ...validDraft(),
      source: 'odometer',
      miles: 5,
      odometer_start: 10000,
      odometer_end: 10005,
    };
    expect(validateMileageDraft(draft).ok).toBe(true);
  });
  it('rejects negative or out-of-band rate', () => {
    expect(validateMileageDraft({ ...validDraft(), rate_cents_per_mile: -1 }).ok).toBe(false);
    expect(validateMileageDraft({ ...validDraft(), rate_cents_per_mile: MAX_RATE_CENTS_PER_MILE + 1 }).ok).toBe(false);
  });
  it('rejects unknown status', () => {
    expect(validateMileageDraft({ ...validDraft(), status: 'archived' }).ok).toBe(false);
  });
});

describe('buildMileageRow', () => {
  const ids = { orgId: 'org-1', userId: 'user-1', createdBy: 'Amy' };
  it('returns a row matching the bd_mileage_entries column shape', () => {
    const row = buildMileageRow(validDraft(), ids);
    expect(row.org_id).toBe('org-1');
    expect(row.user_id).toBe('user-1');
    expect(row.trip_date).toBe('2026-05-16');
    expect(row.purpose).toBe('Visit to Hoag Hospital');
    expect(row.miles).toBe(12.5);
    expect(row.source).toBe('manual');
    expect(row.rate_cents_per_mile).toBe(70);
    expect(row.reimbursement_cents).toBe(875); // 12.5 × 70 = 875
    expect(row.status).toBe('draft');
    expect(row.is_round_trip).toBe(false);
    expect(row.created_by).toBe('Amy');
  });
  it('coerces blank strings to null for nullable columns', () => {
    const draft = {
      ...validDraft(),
      start_location: '   ',
      end_location: '',
      notes: '',
      odometer_start: '',
      odometer_end: '',
    };
    const row = buildMileageRow(draft, ids);
    expect(row.start_location).toBe(null);
    expect(row.end_location).toBe(null);
    expect(row.notes).toBe(null);
    expect(row.odometer_start).toBe(null);
    expect(row.odometer_end).toBe(null);
  });
  it('trims whitespace on purpose and notes', () => {
    const row = buildMileageRow(
      { ...validDraft(), purpose: '  Drop-off  ', notes: '  follow up next week  ' },
      ids,
    );
    expect(row.purpose).toBe('Drop-off');
    expect(row.notes).toBe('follow up next week');
  });
  it('stamps submitted_at when status is submitted', () => {
    const row = buildMileageRow({ ...validDraft(), status: 'submitted' }, ids);
    expect(row.status).toBe('submitted');
    expect(typeof row.submitted_at).toBe('string');
    expect(Number.isNaN(new Date(row.submitted_at).getTime())).toBe(false);
  });
  it('does not stamp submitted_at for drafts', () => {
    const row = buildMileageRow(validDraft(), ids);
    expect(row.submitted_at).toBe(null);
  });
  it('rounds miles to two decimal places before computing reimbursement', () => {
    const row = buildMileageRow({ ...validDraft(), miles: 12.345, rate_cents_per_mile: 70 }, ids);
    expect(row.miles).toBe(12.35);
    expect(row.reimbursement_cents).toBe(Math.round(12.35 * 70));
  });
});

describe('isMileageEntryEditable', () => {
  const entry = { user_id: 'user-1', status: 'draft' };
  it('allows the owner to edit a draft', () => {
    expect(isMileageEntryEditable(entry, 'user-1')).toBe(true);
  });
  it('blocks a different user', () => {
    expect(isMileageEntryEditable(entry, 'user-2')).toBe(false);
  });
  it('blocks once submitted', () => {
    expect(isMileageEntryEditable({ ...entry, status: 'submitted' }, 'user-1')).toBe(false);
    expect(isMileageEntryEditable({ ...entry, status: 'approved' }, 'user-1')).toBe(false);
    expect(isMileageEntryEditable({ ...entry, status: 'paid' }, 'user-1')).toBe(false);
  });
  it('returns false for missing inputs', () => {
    expect(isMileageEntryEditable(null, 'user-1')).toBe(false);
    expect(isMileageEntryEditable(entry, null)).toBe(false);
  });
});

describe('groupEntriesByMonth', () => {
  it('groups entries by yyyy-mm without timezone drift', () => {
    const entries = [
      { trip_date: '2026-05-01', miles: 5 },
      { trip_date: '2026-05-31', miles: 7 },
      { trip_date: '2026-04-30', miles: 3 },
    ];
    const grouped = groupEntriesByMonth(entries);
    expect(Object.keys(grouped).sort()).toEqual(['2026-04', '2026-05']);
    expect(grouped['2026-05']).toHaveLength(2);
    expect(grouped['2026-04']).toHaveLength(1);
  });
  it('ignores malformed trip_date values', () => {
    const entries = [
      { trip_date: '2026-05-01', miles: 5 },
      { trip_date: null,         miles: 7 },
      { trip_date: 'garbage',    miles: 3 },
      {                          miles: 0 },
    ];
    const grouped = groupEntriesByMonth(entries);
    expect(Object.keys(grouped)).toEqual(['2026-05']);
    expect(grouped['2026-05']).toHaveLength(1);
  });
  it('returns an empty object for empty / nullish input', () => {
    expect(groupEntriesByMonth([])).toEqual({});
    expect(groupEntriesByMonth(null)).toEqual({});
    expect(groupEntriesByMonth(undefined)).toEqual({});
  });
});

describe('totalsForEntries', () => {
  it('sums miles and reimbursement cents', () => {
    const entries = [
      { miles: 10,   reimbursement_cents: 700 },
      { miles: 5.5,  reimbursement_cents: 385 },
      { miles: 0.1,  reimbursement_cents: 7 },
    ];
    const totals = totalsForEntries(entries);
    expect(totals.miles).toBe(15.6);
    expect(totals.reimbursement_cents).toBe(1092);
  });
  it('skips entries with non-numeric values', () => {
    const entries = [
      { miles: 10, reimbursement_cents: 700 },
      { miles: 'nope', reimbursement_cents: 'wrong' },
      { miles: null, reimbursement_cents: null },
    ];
    const totals = totalsForEntries(entries);
    expect(totals.miles).toBe(10);
    expect(totals.reimbursement_cents).toBe(700);
  });
  it('returns zero totals for empty / nullish input', () => {
    expect(totalsForEntries([])).toEqual({ miles: 0, reimbursement_cents: 0 });
    expect(totalsForEntries(null)).toEqual({ miles: 0, reimbursement_cents: 0 });
    expect(totalsForEntries(undefined)).toEqual({ miles: 0, reimbursement_cents: 0 });
  });
});
