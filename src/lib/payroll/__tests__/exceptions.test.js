import { describe, it, expect } from 'vitest';
import {
  detectExceptions,
  hasBlockingExceptions,
  summarizeBlockReason,
} from '../exceptions.js';

const CLEAN_DRAFT = {
  timesheet: {
    org_id: 'org_1',
    caregiver_id: 'cg_1',
    pay_period_start: '2026-04-27',
    pay_period_end: '2026-05-03',
    status: 'draft',
    regular_hours: 8,
    overtime_hours: 0,
    double_time_hours: 0,
    mileage_total: 0,
    mileage_reimbursement: 0,
    gross_pay: 200,
  },
  timesheet_shifts: [
    {
      shift_id: 's1',
      hours_worked: 8,
      hour_classification: 'regular',
      mileage: 0,
    },
  ],
  meta: {
    primaryRate: 25,
    distinctRates: [25],
    mileageRate: 0.725,
    perShift: [
      {
        shift_id: 's1',
        usedClockEvents: true,
        missingClockIn: false,
        missingClockOut: false,
        hadGeofenceFailure: false,
        totalHours: 8,
      },
    ],
  },
};

const SYNCED_CAREGIVER = {
  paychex_worker_id: 'pw_001',
  paychex_sync_status: 'active',
};

// ─── Argument validation ──────────────────────────────────────────

describe('detectExceptions — argument validation', () => {
  it('throws on missing draft', () => {
    expect(() => detectExceptions({ caregiver: SYNCED_CAREGIVER })).toThrow(/draft/);
  });

  it('throws on draft with no timesheet_shifts', () => {
    expect(() =>
      detectExceptions({
        draft: { timesheet: {}, meta: {} },
        caregiver: SYNCED_CAREGIVER,
      }),
    ).toThrow(/buildTimesheet/);
  });

  it('throws on missing caregiver', () => {
    expect(() => detectExceptions({ draft: CLEAN_DRAFT })).toThrow(/caregiver/);
  });
});

// ─── Clean shift ─────────────────────────────────────────────────

describe('detectExceptions — clean shift produces no exceptions', () => {
  it('returns an empty array for a perfectly clean week', () => {
    expect(detectExceptions({ draft: CLEAN_DRAFT, caregiver: SYNCED_CAREGIVER })).toEqual([]);
  });
});

// ─── Per-code coverage ──────────────────────────────────────────────

describe('detectExceptions — per-code', () => {
  it('flags missing_clock_out as a blocking exception', () => {
    const draft = {
      ...CLEAN_DRAFT,
      meta: {
        ...CLEAN_DRAFT.meta,
        perShift: [{ ...CLEAN_DRAFT.meta.perShift[0], missingClockOut: true }],
      },
    };
    const result = detectExceptions({ draft, caregiver: SYNCED_CAREGIVER });
    const ex = result.find((e) => e.code === 'missing_clock_out');
    expect(ex).toBeDefined();
    expect(ex.severity).toBe('block');
    expect(ex.shift_id).toBe('s1');
  });

  it('flags out_of_geofence as a warning (not blocking)', () => {
    const draft = {
      ...CLEAN_DRAFT,
      meta: {
        ...CLEAN_DRAFT.meta,
        perShift: [{ ...CLEAN_DRAFT.meta.perShift[0], hadGeofenceFailure: true }],
      },
    };
    const result = detectExceptions({ draft, caregiver: SYNCED_CAREGIVER });
    const ex = result.find((e) => e.code === 'out_of_geofence');
    expect(ex).toBeDefined();
    expect(ex.severity).toBe('warn');
    expect(ex.shift_id).toBe('s1');
  });

  it('flags rate_mismatch as a blocking exception when 2+ distinct rates exist', () => {
    const draft = {
      ...CLEAN_DRAFT,
      meta: { ...CLEAN_DRAFT.meta, distinctRates: [25, 30] },
    };
    const result = detectExceptions({ draft, caregiver: SYNCED_CAREGIVER });
    const ex = result.find((e) => e.code === 'rate_mismatch');
    expect(ex).toBeDefined();
    expect(ex.severity).toBe('block');
    expect(ex.message).toContain('25');
    expect(ex.message).toContain('30');
  });

  it('does NOT flag rate_mismatch when there is only one distinct rate', () => {
    const result = detectExceptions({ draft: CLEAN_DRAFT, caregiver: SYNCED_CAREGIVER });
    expect(result.find((e) => e.code === 'rate_mismatch')).toBeUndefined();
  });

  it('flags blocked_caregiver when payroll_blocked = true', () => {
    const result = detectExceptions({
      draft: CLEAN_DRAFT,
      caregiver: {
        ...SYNCED_CAREGIVER,
        payroll_blocked: true,
        payroll_block_reason: 'Termination pending',
      },
    });
    const ex = result.find((e) => e.code === 'blocked_caregiver');
    expect(ex).toBeDefined();
    expect(ex.severity).toBe('block');
    expect(ex.message).toContain('Termination pending');
  });

  it('flags blocked_caregiver when paychex_sync_status is rehire_blocked', () => {
    const result = detectExceptions({
      draft: CLEAN_DRAFT,
      caregiver: { ...SYNCED_CAREGIVER, paychex_sync_status: 'rehire_blocked' },
    });
    const ex = result.find((e) => e.code === 'blocked_caregiver');
    expect(ex).toBeDefined();
    expect(ex.severity).toBe('block');
  });

  it('flags shift_too_long as a warning when totalHours > 16', () => {
    const draft = {
      ...CLEAN_DRAFT,
      meta: {
        ...CLEAN_DRAFT.meta,
        perShift: [{ ...CLEAN_DRAFT.meta.perShift[0], totalHours: 18 }],
      },
    };
    const result = detectExceptions({ draft, caregiver: SYNCED_CAREGIVER });
    const ex = result.find((e) => e.code === 'shift_too_long');
    expect(ex).toBeDefined();
    expect(ex.severity).toBe('warn');
    expect(ex.message).toContain('18');
  });

  it('does NOT flag shift_too_long at the boundary (exactly 16)', () => {
    const draft = {
      ...CLEAN_DRAFT,
      meta: {
        ...CLEAN_DRAFT.meta,
        perShift: [{ ...CLEAN_DRAFT.meta.perShift[0], totalHours: 16 }],
      },
    };
    const result = detectExceptions({ draft, caregiver: SYNCED_CAREGIVER });
    expect(result.find((e) => e.code === 'shift_too_long')).toBeUndefined();
  });

  it('flags caregiver_not_in_paychex as warn (entitlement-blocked Phase 2 caregivers)', () => {
    const result = detectExceptions({
      draft: CLEAN_DRAFT,
      caregiver: { paychex_worker_id: null, paychex_sync_status: 'error' },
    });
    const ex = result.find((e) => e.code === 'caregiver_not_in_paychex');
    expect(ex).toBeDefined();
    expect(ex.severity).toBe('warn');
  });

  it('does NOT flag caregiver_not_in_paychex when worker id is set', () => {
    const result = detectExceptions({
      draft: CLEAN_DRAFT,
      caregiver: { paychex_worker_id: 'pw_999', paychex_sync_status: 'active' },
    });
    expect(result.find((e) => e.code === 'caregiver_not_in_paychex')).toBeUndefined();
  });
});

// ─── Multi-shift, multi-exception combinations ───────────────────────

describe('detectExceptions — combinations', () => {
  it('emits one exception per offending shift (per-shift codes are not deduped)', () => {
    const draft = {
      ...CLEAN_DRAFT,
      meta: {
        ...CLEAN_DRAFT.meta,
        perShift: [
          { shift_id: 's1', missingClockOut: true, hadGeofenceFailure: false, totalHours: 8 },
          { shift_id: 's2', missingClockOut: true, hadGeofenceFailure: false, totalHours: 8 },
        ],
      },
    };
    const result = detectExceptions({ draft, caregiver: SYNCED_CAREGIVER });
    const missing = result.filter((e) => e.code === 'missing_clock_out');
    expect(missing).toHaveLength(2);
    expect(missing.map((e) => e.shift_id).sort()).toEqual(['s1', 's2']);
  });

  it('attaches caregiver-level codes once even with many shifts', () => {
    const draft = {
      ...CLEAN_DRAFT,
      meta: {
        ...CLEAN_DRAFT.meta,
        distinctRates: [25, 30],
        perShift: [
          { shift_id: 's1', totalHours: 8 },
          { shift_id: 's2', totalHours: 8 },
        ],
      },
    };
    const result = detectExceptions({ draft, caregiver: SYNCED_CAREGIVER });
    expect(result.filter((e) => e.code === 'rate_mismatch')).toHaveLength(1);
  });

  it('combines caregiver-level + per-shift codes correctly', () => {
    const draft = {
      ...CLEAN_DRAFT,
      meta: {
        ...CLEAN_DRAFT.meta,
        distinctRates: [25, 30],
        perShift: [
          {
            shift_id: 's1',
            missingClockOut: true,
            hadGeofenceFailure: true,
            totalHours: 18,
          },
        ],
      },
    };
    const result = detectExceptions({
      draft,
      caregiver: { paychex_worker_id: null, paychex_sync_status: 'pending' },
    });
    const codes = new Set(result.map((e) => e.code));
    expect(codes.has('rate_mismatch')).toBe(true);
    expect(codes.has('missing_clock_out')).toBe(true);
    expect(codes.has('out_of_geofence')).toBe(true);
    expect(codes.has('shift_too_long')).toBe(true);
    expect(codes.has('caregiver_not_in_paychex')).toBe(true);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────

describe('hasBlockingExceptions', () => {
  it('returns true when at least one block-severity entry exists', () => {
    expect(
      hasBlockingExceptions([
        { severity: 'warn', code: 'out_of_geofence', message: '' },
        { severity: 'block', code: 'missing_clock_out', message: '' },
      ]),
    ).toBe(true);
  });

  it('returns false for warns-only', () => {
    expect(
      hasBlockingExceptions([{ severity: 'warn', code: 'shift_too_long', message: '' }]),
    ).toBe(false);
  });

  it('returns false for empty / non-array', () => {
    expect(hasBlockingExceptions([])).toBe(false);
    expect(hasBlockingExceptions(null)).toBe(false);
    expect(hasBlockingExceptions(undefined)).toBe(false);
  });
});

describe('summarizeBlockReason', () => {
  it('joins distinct block codes alphabetically', () => {
    expect(
      summarizeBlockReason([
        { severity: 'warn', code: 'out_of_geofence', message: '' },
        { severity: 'block', code: 'missing_clock_out', message: '' },
        { severity: 'block', code: 'rate_mismatch', message: '' },
        { severity: 'block', code: 'missing_clock_out', message: '' }, // dup
      ]),
    ).toBe('missing_clock_out, rate_mismatch');
  });

  it('returns null when no blocking exceptions', () => {
    expect(summarizeBlockReason([])).toBe(null);
    expect(
      summarizeBlockReason([{ severity: 'warn', code: 'shift_too_long', message: '' }]),
    ).toBe(null);
  });
});
