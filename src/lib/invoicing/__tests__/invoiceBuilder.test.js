import { describe, it, expect } from 'vitest';
import {
  buildInvoice,
  HOUR_CLASS,
  INVOICE_EXCEPTION_CODE,
  INVOICE_EXCEPTION_SEVERITY,
} from '../invoiceBuilder.js';

const ORG_ID = 'org-tc-uuid';
const PERIOD_START = '2026-04-20';
const PERIOD_END = '2026-04-26';

function client(overrides = {}) {
  return {
    id: 'client_smith_01',
    default_billable_rate: 35,
    default_billable_ot_rate: 50,
    address: '123 Main St',
    city: 'San Diego',
    state: 'CA',
    zip: '92101',
    ...overrides,
  };
}

function lineItem(overrides = {}) {
  return {
    shiftId: overrides.shiftId ?? 'shift_001',
    billable_rate: overrides.billable_rate ?? null,
    hours: { regular: 0, overtime: 0, doubleTime: 0, ...(overrides.hours ?? {}) },
    hasPayrollClassification:
      overrides.hasPayrollClassification ?? true,
  };
}

// ─── Argument validation ──────────────────────────────────────────

describe('buildInvoice — argument validation', () => {
  it('throws when orgId is missing', () => {
    expect(() =>
      buildInvoice({
        client: client(),
        billingPeriodStart: PERIOD_START,
        billingPeriodEnd: PERIOD_END,
        shiftLineItems: [],
      }),
    ).toThrow(/orgId is required/);
  });

  it('throws when client is missing', () => {
    expect(() =>
      buildInvoice({
        orgId: ORG_ID,
        billingPeriodStart: PERIOD_START,
        billingPeriodEnd: PERIOD_END,
        shiftLineItems: [],
      }),
    ).toThrow(/client \{ id \} is required/);
  });

  it('throws when shiftLineItems is not an array', () => {
    expect(() =>
      buildInvoice({
        orgId: ORG_ID,
        client: client(),
        billingPeriodStart: PERIOD_START,
        billingPeriodEnd: PERIOD_END,
        shiftLineItems: null,
      }),
    ).toThrow(/shiftLineItems must be an array/);
  });

  it('throws when a line item has negative hours', () => {
    expect(() =>
      buildInvoice({
        orgId: ORG_ID,
        client: client(),
        billingPeriodStart: PERIOD_START,
        billingPeriodEnd: PERIOD_END,
        shiftLineItems: [
          lineItem({ hours: { regular: -1, overtime: 0, doubleTime: 0 } }),
        ],
      }),
    ).toThrow(/negative hours/);
  });
});

// ─── Empty period ─────────────────────────────────────────────────

describe('buildInvoice — empty period', () => {
  it('returns null when there are no line items', () => {
    expect(
      buildInvoice({
        orgId: ORG_ID,
        client: client(),
        billingPeriodStart: PERIOD_START,
        billingPeriodEnd: PERIOD_END,
        shiftLineItems: [],
      }),
    ).toBeNull();
  });

  it('returns null when every line item has zero hours', () => {
    expect(
      buildInvoice({
        orgId: ORG_ID,
        client: client(),
        billingPeriodStart: PERIOD_START,
        billingPeriodEnd: PERIOD_END,
        shiftLineItems: [
          lineItem({ shiftId: 'a' }),
          lineItem({ shiftId: 'b' }),
        ],
      }),
    ).toBeNull();
  });
});

// ─── Happy path: regular hours only ───────────────────────────────

describe('buildInvoice — regular hours only', () => {
  it('uses client default_billable_rate when shift has none', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client({ default_billable_rate: 35 }),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        lineItem({ shiftId: 's1', hours: { regular: 8 } }),
        lineItem({ shiftId: 's2', hours: { regular: 4 } }),
      ],
    });
    expect(result).not.toBeNull();
    expect(result.invoice.regular_hours).toBe(12);
    expect(result.invoice.overtime_hours).toBe(0);
    expect(result.invoice.regular_rate).toBe(35);
    expect(result.invoice.subtotal).toBe(420); // 12 × 35
    expect(result.invoice.total).toBe(420);
    expect(result.invoice.status).toBe('draft');
    expect(result.invoice_shifts).toHaveLength(2);
    expect(result.invoice_shifts[0].billable_rate_applied).toBe(35);
    expect(result.invoice_shifts[0].hour_classification).toBe(HOUR_CLASS.REGULAR);
    expect(result.exceptions).toHaveLength(0);
  });

  it('prefers per-shift billable_rate over client default', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client({ default_billable_rate: 35 }),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        lineItem({ shiftId: 's1', billable_rate: 40, hours: { regular: 8 } }),
      ],
    });
    expect(result.invoice.subtotal).toBe(320); // 8 × 40
    expect(result.invoice_shifts[0].billable_rate_applied).toBe(40);
    expect(result.invoice.regular_rate).toBe(40);
  });

  it('snapshots regular_rate as null when shifts have varying rates', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client(),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        lineItem({ shiftId: 's1', billable_rate: 35, hours: { regular: 8 } }),
        lineItem({ shiftId: 's2', billable_rate: 40, hours: { regular: 4 } }),
      ],
    });
    expect(result.invoice.regular_rate).toBeNull();
    expect(result.invoice.subtotal).toBe(8 * 35 + 4 * 40);
  });
});

// ─── OT and DT billing ────────────────────────────────────────────

describe('buildInvoice — overtime and double-time', () => {
  it('bills OT hours at the client default_billable_ot_rate', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client({ default_billable_rate: 35, default_billable_ot_rate: 50 }),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        lineItem({ shiftId: 's1', hours: { regular: 8, overtime: 2 } }),
      ],
    });
    expect(result.invoice.regular_hours).toBe(8);
    expect(result.invoice.overtime_hours).toBe(2);
    expect(result.invoice.subtotal).toBe(8 * 35 + 2 * 50); // 380
    expect(result.invoice.ot_rate).toBe(50);
    // No warning — explicit OT rate is set.
    expect(result.exceptions).toHaveLength(0);
  });

  it('falls back to 1.5x base when client OT rate is missing, and warns', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client({ default_billable_rate: 30, default_billable_ot_rate: null }),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        lineItem({ shiftId: 's1', hours: { regular: 8, overtime: 2 } }),
      ],
    });
    expect(result.invoice.ot_rate).toBe(45); // 30 × 1.5
    expect(result.invoice.subtotal).toBe(8 * 30 + 2 * 45); // 330
    const warn = result.exceptions.find(
      (e) => e.code === INVOICE_EXCEPTION_CODE.CLIENT_MISSING_OT_RATE,
    );
    expect(warn).toBeDefined();
    expect(warn.severity).toBe(INVOICE_EXCEPTION_SEVERITY.WARN);
  });

  it('does not warn about missing OT rate when there are no OT/DT hours', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client({ default_billable_rate: 30, default_billable_ot_rate: null }),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        lineItem({ shiftId: 's1', hours: { regular: 8 } }),
      ],
    });
    const warn = result.exceptions.find(
      (e) => e.code === INVOICE_EXCEPTION_CODE.CLIENT_MISSING_OT_RATE,
    );
    expect(warn).toBeUndefined();
  });

  it('bills double_time hours at the OT rate (DT folds into OT in v1)', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client({ default_billable_rate: 30, default_billable_ot_rate: 50 }),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        lineItem({ shiftId: 's1', hours: { regular: 0, doubleTime: 4 } }),
      ],
    });
    expect(result.invoice.double_time_hours).toBe(4);
    expect(result.invoice.subtotal).toBe(4 * 50); // 200
  });

  it('classifies a mixed-hours shift by dominant class', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client(),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        // 2h reg + 6h OT → dominant = overtime
        lineItem({ shiftId: 's1', hours: { regular: 2, overtime: 6 } }),
      ],
    });
    expect(result.invoice_shifts[0].hour_classification).toBe(HOUR_CLASS.OVERTIME);
  });
});

// ─── Exception emission: missing rates / address ──────────────────

describe('buildInvoice — exceptions', () => {
  it('emits a block exception when neither shift nor client has a rate', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client({ default_billable_rate: null, default_billable_ot_rate: null }),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        lineItem({ shiftId: 's1', billable_rate: null, hours: { regular: 8 } }),
      ],
    });
    const block = result.exceptions.find(
      (e) => e.code === INVOICE_EXCEPTION_CODE.CLIENT_MISSING_RATE,
    );
    expect(block).toBeDefined();
    expect(block.severity).toBe(INVOICE_EXCEPTION_SEVERITY.BLOCK);
    expect(block.shiftId).toBe('s1');
    expect(result.invoice.status).toBe('blocked');
    expect(result.invoice.block_reason).toBeTruthy();
    // Subtotal is 0 because we have no rate to multiply with.
    expect(result.invoice.subtotal).toBe(0);
    // Per-shift rate is also null on the junction.
    expect(result.invoice_shifts[0].billable_rate_applied).toBeNull();
  });

  it('emits CLIENT_MISSING_ADDRESS warning when all address fields are blank', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client({ address: '', city: '', state: '', zip: '' }),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [lineItem({ hours: { regular: 4 } })],
    });
    const warn = result.exceptions.find(
      (e) => e.code === INVOICE_EXCEPTION_CODE.CLIENT_MISSING_ADDRESS,
    );
    expect(warn).toBeDefined();
    expect(warn.severity).toBe(INVOICE_EXCEPTION_SEVERITY.WARN);
    // Warn does not block.
    expect(result.invoice.status).toBe('draft');
  });

  it('does not warn about address when at least one address field is present', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client({ address: '', city: 'San Diego', state: '', zip: '' }),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [lineItem({ hours: { regular: 4 } })],
    });
    const warn = result.exceptions.find(
      (e) => e.code === INVOICE_EXCEPTION_CODE.CLIENT_MISSING_ADDRESS,
    );
    expect(warn).toBeUndefined();
  });

  it('logs missing payroll classification in meta without erroring', () => {
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client(),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        lineItem({
          shiftId: 's1',
          hours: { regular: 8 },
          hasPayrollClassification: false,
        }),
      ],
    });
    expect(result.meta.missingClassificationShiftIds).toEqual(['s1']);
    expect(result.invoice.subtotal).toBe(8 * 35);
  });
});

// ─── Combined: realistic week ─────────────────────────────────────

describe('buildInvoice — realistic week scenario', () => {
  it('rolls up a 50h week with regular + OT correctly', () => {
    // 5 weekdays × 10h = 50h. Per CA rules (computed upstream), the
    // first 40h are regular and the last 10h are OT. Each shift here
    // is a single 10h day; OT is concentrated on Friday's 10h shift
    // (the upstream classifier puts the over-40 hours on the last
    // chronological shift). Either way, totals across the week are
    // 40h regular + 10h OT.
    const result = buildInvoice({
      orgId: ORG_ID,
      client: client({ default_billable_rate: 35, default_billable_ot_rate: 50 }),
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      shiftLineItems: [
        lineItem({ shiftId: 'mon', hours: { regular: 8, overtime: 2 } }),
        lineItem({ shiftId: 'tue', hours: { regular: 8, overtime: 2 } }),
        lineItem({ shiftId: 'wed', hours: { regular: 8, overtime: 2 } }),
        lineItem({ shiftId: 'thu', hours: { regular: 8, overtime: 2 } }),
        lineItem({ shiftId: 'fri', hours: { regular: 8, overtime: 2 } }),
      ],
    });
    expect(result.invoice.regular_hours).toBe(40);
    expect(result.invoice.overtime_hours).toBe(10);
    expect(result.invoice.subtotal).toBe(40 * 35 + 10 * 50); // 1400 + 500 = 1900
    expect(result.invoice.total).toBe(1900);
    expect(result.invoice_shifts).toHaveLength(5);
    expect(result.exceptions).toHaveLength(0);
  });
});
