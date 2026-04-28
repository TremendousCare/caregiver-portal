import { describe, it, expect } from 'vitest';
import { generatePaychexCsv, _internal } from '../csvExport.js';

const TC_ORG_SETTINGS = {
  paychex: {
    display_id: '70125496',
    company_id: '00M9LQF7LUBLSED1THE0',
  },
  payroll: {
    mileage_rate: 0.725,
    pay_components: {
      regular: 'Hourly',
      overtime: 'Overtime',
      double_time: null,
      mileage: 'Mileage',
    },
  },
};

const CLEAN_TIMESHEET = {
  caregiver_id: 'cg_001',
  paychex_employee_id: '54',
  hourly_rate: 20,
  regular_hours: 40,
  overtime_hours: 0,
  double_time_hours: 0,
  mileage_total: 0,
};

// ─── Argument validation ───────────────────────────────────────────

describe('generatePaychexCsv — argument validation', () => {
  it('throws when timesheets is not an array', () => {
    expect(() => generatePaychexCsv(null, TC_ORG_SETTINGS)).toThrow(/array/);
    expect(() => generatePaychexCsv({}, TC_ORG_SETTINGS)).toThrow(/array/);
  });

  it('throws when display_id is missing', () => {
    expect(() =>
      generatePaychexCsv([CLEAN_TIMESHEET], { paychex: {}, payroll: {} }),
    ).toThrow(/display_id/);
  });

  it('throws when a timesheet has no paychex_employee_id', () => {
    const ts = { ...CLEAN_TIMESHEET, paychex_employee_id: null };
    expect(() => generatePaychexCsv([ts], TC_ORG_SETTINGS)).toThrow(/paychex_employee_id/);
  });

  it('throws when a timesheet has hours but no hourly_rate', () => {
    const ts = { ...CLEAN_TIMESHEET, hourly_rate: null };
    expect(() => generatePaychexCsv([ts], TC_ORG_SETTINGS)).toThrow(/hourly_rate/);
  });

  it('throws when regular hours present but pay_components.regular is null', () => {
    const settings = {
      ...TC_ORG_SETTINGS,
      payroll: { ...TC_ORG_SETTINGS.payroll, pay_components: { regular: null } },
    };
    expect(() => generatePaychexCsv([CLEAN_TIMESHEET], settings)).toThrow(/pay_components.regular/);
  });
});

// ─── Header row ────────────────────────────────────────────────────

describe('generatePaychexCsv — header', () => {
  it('emits the SPI Hours Only header in exact column order', () => {
    const csv = generatePaychexCsv([], TC_ORG_SETTINGS);
    expect(csv).toBe('Company ID,Worker ID,Pay Component,Hours,Rate,Rate #\r\n');
  });
});

// ─── Single caregiver, clean week ──────────────────────────────────

describe('generatePaychexCsv — single caregiver, regular hours only', () => {
  it('emits header + one Hourly row', () => {
    const csv = generatePaychexCsv([CLEAN_TIMESHEET], TC_ORG_SETTINGS);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Company ID,Worker ID,Pay Component,Hours,Rate,Rate #');
    expect(lines[1]).toBe('70125496,54,Hourly,40.00,20,');
    expect(lines[2]).toBe(''); // trailing newline
  });

  it('uses the org display_id, not company_id, in column 1', () => {
    const csv = generatePaychexCsv([CLEAN_TIMESHEET], TC_ORG_SETTINGS);
    expect(csv).toContain('70125496');
    expect(csv).not.toContain('00M9LQF7LUBLSED1THE0');
  });
});

// ─── Multi-row caregiver (reg + OT + mileage) ──────────────────────

describe('generatePaychexCsv — caregiver with regular + OT + mileage', () => {
  it('emits 3 rows: Hourly @ base, Overtime @ 1.5x, Mileage @ rate', () => {
    const ts = {
      ...CLEAN_TIMESHEET,
      regular_hours: 40,
      overtime_hours: 4,
      mileage_total: 25,
    };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    const lines = csv.trim().split('\r\n');
    expect(lines.length).toBe(4); // header + 3 data rows
    expect(lines[1]).toBe('70125496,54,Hourly,40.00,20,');
    expect(lines[2]).toBe('70125496,54,Overtime,4.00,30,');
    expect(lines[3]).toBe('70125496,54,Mileage,25.00,0.725,');
  });

  it('uses identical Worker ID across rows (Paychex groups by worker + earning)', () => {
    const ts = { ...CLEAN_TIMESHEET, regular_hours: 40, overtime_hours: 4 };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    const lines = csv.trim().split('\r\n').slice(1); // drop header
    const workerIds = lines.map((l) => l.split(',')[1]);
    expect(workerIds).toEqual(['54', '54']);
  });
});

// ─── DT handling ───────────────────────────────────────────────────

describe('generatePaychexCsv — double-time handling', () => {
  it('omits the DT row defensively when pay_components.double_time is null', () => {
    // Note: such a timesheet should already carry the
    // dt_pay_component_missing exception (block) and never reach the
    // exporter. This is a defensive belt-and-suspenders test.
    const ts = {
      ...CLEAN_TIMESHEET,
      regular_hours: 8,
      double_time_hours: 4,
    };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    const lines = csv.trim().split('\r\n');
    expect(lines.length).toBe(2); // header + 1 Hourly row, no DT row
    expect(csv).not.toContain('Doubletime');
    expect(csv).not.toContain('double_time');
  });

  it('emits DT row at 2x rate when pay_components.double_time is set', () => {
    const settings = {
      ...TC_ORG_SETTINGS,
      payroll: {
        ...TC_ORG_SETTINGS.payroll,
        pay_components: {
          ...TC_ORG_SETTINGS.payroll.pay_components,
          double_time: 'Doubletime',
        },
      },
    };
    const ts = {
      ...CLEAN_TIMESHEET,
      regular_hours: 8,
      overtime_hours: 4,
      double_time_hours: 6.01,
    };
    const csv = generatePaychexCsv([ts], settings);
    const lines = csv.trim().split('\r\n');
    expect(lines.length).toBe(4);
    expect(lines[3]).toBe('70125496,54,Doubletime,6.01,40,');
  });
});

// ─── Mileage handling ──────────────────────────────────────────────

describe('generatePaychexCsv — mileage handling', () => {
  it('skips Mileage row when org pay_components.mileage is null', () => {
    const settings = {
      ...TC_ORG_SETTINGS,
      payroll: {
        ...TC_ORG_SETTINGS.payroll,
        pay_components: {
          ...TC_ORG_SETTINGS.payroll.pay_components,
          mileage: null,
        },
      },
    };
    const ts = { ...CLEAN_TIMESHEET, mileage_total: 25 };
    const csv = generatePaychexCsv([ts], settings);
    expect(csv).not.toContain('Mileage');
  });

  it('skips Mileage row when mileage_total is 0', () => {
    const csv = generatePaychexCsv([CLEAN_TIMESHEET], TC_ORG_SETTINGS);
    expect(csv).not.toContain('Mileage');
  });

  it('uses the IRS rate from organizations.settings.payroll.mileage_rate, not the worker rate', () => {
    const ts = { ...CLEAN_TIMESHEET, mileage_total: 10, hourly_rate: 25 };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    expect(csv).toContain('Mileage,10.00,0.725,');
    expect(csv).not.toContain('Mileage,10.00,25');
  });
});

// ─── Multiple caregivers ───────────────────────────────────────────

describe('generatePaychexCsv — multiple caregivers', () => {
  it('emits all rows in input order, distinct Worker IDs preserved', () => {
    const tsA = { ...CLEAN_TIMESHEET, paychex_employee_id: '54', regular_hours: 40 };
    const tsB = { ...CLEAN_TIMESHEET, paychex_employee_id: '67', regular_hours: 32, hourly_rate: 22 };
    const csv = generatePaychexCsv([tsA, tsB], TC_ORG_SETTINGS);
    const lines = csv.trim().split('\r\n');
    expect(lines.length).toBe(3);
    expect(lines[1]).toBe('70125496,54,Hourly,40.00,20,');
    expect(lines[2]).toBe('70125496,67,Hourly,32.00,22,');
  });
});

// ─── Empty inputs ──────────────────────────────────────────────────

describe('generatePaychexCsv — edge cases', () => {
  it('emits header only for an empty timesheet array', () => {
    const csv = generatePaychexCsv([], TC_ORG_SETTINGS);
    expect(csv).toBe('Company ID,Worker ID,Pay Component,Hours,Rate,Rate #\r\n');
  });

  it('emits no data rows for a zero-hours zero-mileage timesheet', () => {
    const ts = {
      ...CLEAN_TIMESHEET,
      regular_hours: 0,
      overtime_hours: 0,
      double_time_hours: 0,
      mileage_total: 0,
    };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    expect(csv).toBe('Company ID,Worker ID,Pay Component,Hours,Rate,Rate #\r\n');
  });

  it('rounds hours to 2 decimals and rate to up to 4', () => {
    const ts = {
      ...CLEAN_TIMESHEET,
      regular_hours: 8.376,
      // 20.5678 * 10000 = 205678 exactly in IEEE 754, so the rounding
      // doesn't shift on us. (20.12345 * 10000 lands at 201234.499... in
      // JS, which Math.round drops to 201234 — a fragile test value.)
      hourly_rate: 20.5678,
    };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    expect(csv).toContain('8.38');
    expect(csv).toContain('20.5678');
  });
});

// ─── CSV escaping ──────────────────────────────────────────────────

describe('generatePaychexCsv — CSV escaping', () => {
  it('escapes commas, quotes, and newlines in any field', () => {
    expect(_internal.escapeCsvField('plain')).toBe('plain');
    expect(_internal.escapeCsvField('with,comma')).toBe('"with,comma"');
    expect(_internal.escapeCsvField('with"quote')).toBe('"with""quote"');
    expect(_internal.escapeCsvField('with\nnewline')).toBe('"with\nnewline"');
  });

  it('handles a Pay Component name that contains a comma (defensive)', () => {
    const settings = {
      ...TC_ORG_SETTINGS,
      payroll: {
        ...TC_ORG_SETTINGS.payroll,
        pay_components: {
          ...TC_ORG_SETTINGS.payroll.pay_components,
          regular: 'Hourly, Reg',
        },
      },
    };
    const csv = generatePaychexCsv([CLEAN_TIMESHEET], settings);
    expect(csv).toContain('"Hourly, Reg"');
  });
});

// ─── Per-shift rates (Phase 4 PR #2) ───────────────────────────────

describe('generatePaychexCsv — per-shift rates: regular_by_rate path', () => {
  it('emits one Hourly row per distinct rate (8h@$20 + 16h@$22)', () => {
    const ts = {
      caregiver_id: 'cg_split',
      paychex_employee_id: '54',
      regular_by_rate: [
        { rate: 20, hours: 8 },
        { rate: 22, hours: 16 },
      ],
      regular_rate_of_pay: 21.3333, // weighted ROP for 8/16 split
      overtime_hours: 0,
      double_time_hours: 0,
      mileage_total: 0,
    };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    const lines = csv.trim().split('\r\n');
    expect(lines.length).toBe(3); // header + 2 Hourly rows
    expect(lines[1]).toBe('70125496,54,Hourly,8.00,20,');
    expect(lines[2]).toBe('70125496,54,Hourly,16.00,22,');
  });

  it('uses regular_rate_of_pay × 1.5 for the Overtime row', () => {
    // 30h @ $20 + 20h @ $25 with 10h reclassified weekly to OT.
    // ROP = (30*20 + 20*25) / 50 = 1100 / 50 = 22.
    // OT row rate = 22 × 1.5 = 33.
    const ts = {
      caregiver_id: 'cg_mix',
      paychex_employee_id: '54',
      regular_by_rate: [
        { rate: 20, hours: 30 },
        { rate: 25, hours: 10 },
      ],
      regular_rate_of_pay: 22,
      overtime_hours: 10,
      double_time_hours: 0,
      mileage_total: 0,
    };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    expect(csv).toContain('Hourly,30.00,20,');
    expect(csv).toContain('Hourly,10.00,25,');
    expect(csv).toContain('Overtime,10.00,33,');
  });

  it('uses regular_rate_of_pay × 2 for the Doubletime row', () => {
    const settings = {
      ...TC_ORG_SETTINGS,
      payroll: {
        ...TC_ORG_SETTINGS.payroll,
        pay_components: {
          ...TC_ORG_SETTINGS.payroll.pay_components,
          double_time: 'Doubletime',
        },
      },
    };
    const ts = {
      caregiver_id: 'cg_dt',
      paychex_employee_id: '54',
      regular_by_rate: [
        { rate: 18, hours: 8 },
        { rate: 22, hours: 8 },
        { rate: 30, hours: 8 },
      ],
      // ROP = (8*18 + 8*22 + 8*30) / 24 = 560/24 ≈ 23.3333
      regular_rate_of_pay: 23.3333,
      overtime_hours: 4,
      double_time_hours: 2,
      mileage_total: 0,
    };
    const csv = generatePaychexCsv([ts], settings);
    // Overtime rate = 23.3333 × 1.5 ≈ 35
    expect(csv).toContain('Overtime,4.00,35,');
    // Doubletime rate = 23.3333 × 2 ≈ 46.6666
    expect(csv).toContain('Doubletime,2.00,46.6666,');
  });

  it('produces a single Hourly row (single-rate degenerate case via per-rate)', () => {
    const ts = {
      caregiver_id: 'cg_one',
      paychex_employee_id: '54',
      regular_by_rate: [{ rate: 25, hours: 40 }],
      regular_rate_of_pay: 25,
      overtime_hours: 0,
      double_time_hours: 0,
      mileage_total: 0,
    };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    const lines = csv.trim().split('\r\n');
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe('70125496,54,Hourly,40.00,25,');
  });

  it('legacy single-rate path (hourly_rate + regular_hours) still works', () => {
    // Back-compat: if a caller doesn't supply regular_by_rate, fall
    // through to the legacy single-rate path. Used by callers that
    // built CSVs before Phase 4 PR #2.
    const csv = generatePaychexCsv([CLEAN_TIMESHEET], TC_ORG_SETTINGS);
    expect(csv).toContain('Hourly,40.00,20,');
  });

  it('throws when overtime present but no ROP and no fallback hourly_rate', () => {
    const ts = {
      caregiver_id: 'cg_orphan',
      paychex_employee_id: '54',
      regular_by_rate: [{ rate: 20, hours: 30 }],
      // no regular_rate_of_pay, no hourly_rate
      overtime_hours: 5,
      double_time_hours: 0,
      mileage_total: 0,
    };
    expect(() => generatePaychexCsv([ts], TC_ORG_SETTINGS)).toThrow(/regular_rate_of_pay/);
  });

  it('drops zero-hour entries from regular_by_rate without erroring', () => {
    const ts = {
      caregiver_id: 'cg_z',
      paychex_employee_id: '54',
      regular_by_rate: [
        { rate: 20, hours: 8 },
        { rate: 25, hours: 0 }, // dropped
      ],
      regular_rate_of_pay: 20,
      overtime_hours: 0,
      double_time_hours: 0,
      mileage_total: 0,
    };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    const lines = csv.trim().split('\r\n');
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('Hourly,8.00,20,');
  });

  it('stable row order: regular_by_rate entries emit in input order', () => {
    const ts = {
      caregiver_id: 'cg_order',
      paychex_employee_id: '54',
      regular_by_rate: [
        { rate: 30, hours: 4 },
        { rate: 20, hours: 8 },
        { rate: 25, hours: 12 },
      ],
      regular_rate_of_pay: 25,
      overtime_hours: 0,
      double_time_hours: 0,
      mileage_total: 0,
    };
    const csv = generatePaychexCsv([ts], TC_ORG_SETTINGS);
    const lines = csv.trim().split('\r\n').slice(1);
    expect(lines[0]).toContain(',Hourly,4.00,30,');
    expect(lines[1]).toContain(',Hourly,8.00,20,');
    expect(lines[2]).toContain(',Hourly,12.00,25,');
  });
});

// ─── Internal helpers (smoke) ──────────────────────────────────────

describe('csvExport _internal helpers', () => {
  it('formatHours rounds to 2 decimals and pads', () => {
    expect(_internal.formatHours(8)).toBe('8.00');
    expect(_internal.formatHours(8.376)).toBe('8.38');
    expect(_internal.formatHours(0.37)).toBe('0.37');
    // null coerces to 0 → "0.00"; explicit non-numeric → "0.00".
    expect(_internal.formatHours(null)).toBe('0.00');
    expect(_internal.formatHours('not a number')).toBe('0.00');
  });

  it('formatRate trims trailing zeros', () => {
    expect(_internal.formatRate(20)).toBe('20');
    expect(_internal.formatRate(20.5)).toBe('20.5');
    expect(_internal.formatRate(0.725)).toBe('0.725');
    // 20.5678 * 10000 = 205678 exactly; chosen to dodge IEEE 754
    // rounding edge cases that bite values like 20.12345.
    expect(_internal.formatRate(20.5678)).toBe('20.5678');
  });

  it('HEADER_ROW matches the SPI six-column spec', () => {
    expect(_internal.HEADER_ROW).toEqual([
      'Company ID',
      'Worker ID',
      'Pay Component',
      'Hours',
      'Rate',
      'Rate #',
    ]);
  });
});
