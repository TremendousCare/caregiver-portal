import { describe, it, expect } from 'vitest';
import {
  isActiveClient,
  isActiveCaregiver,
  resolveRevenueRates,
  resolvePayRate,
  computeShiftFinancials,
  aggregateFinancials,
  computeMonthlyTrend,
  padMonthlySeries,
  pctDelta,
  buildKpi,
} from '../financialsMetrics.js';

const client = (o = {}) => ({
  id: 'client_1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  phase: 'active',
  archived: false,
  default_billable_rate: 40,
  default_billable_ot_rate: 60,
  ...o,
});

const caregiver = (o = {}) => ({
  id: 'cg_1',
  first_name: 'Grace',
  last_name: 'Hopper',
  employment_status: 'active',
  archived: false,
  default_pay_rate: 20,
  ...o,
});

const shift = (o = {}) => ({
  shiftId: 's1',
  clientId: 'client_1',
  caregiverId: 'cg_1',
  startTime: '2026-05-04T16:00:00.000Z',
  hours: { regular: 8, overtime: 0, doubleTime: 0 },
  billableRate: null,
  payRate: null,
  hasPayrollClassification: true,
  ...o,
});

describe('active-status predicates', () => {
  it('treats active, non-archived clients as active', () => {
    expect(isActiveClient(client())).toBe(true);
    expect(isActiveClient(client({ phase: 'intake' }))).toBe(false);
    expect(isActiveClient(client({ archived: true }))).toBe(false);
    expect(isActiveClient(null)).toBe(false);
  });

  it('treats active/onboarding, non-archived caregivers as active', () => {
    expect(isActiveCaregiver(caregiver())).toBe(true);
    expect(isActiveCaregiver(caregiver({ employment_status: 'onboarding' }))).toBe(true);
    expect(isActiveCaregiver(caregiver({ employment_status: 'terminated' }))).toBe(false);
    expect(isActiveCaregiver(caregiver({ archived: true }))).toBe(false);
  });
});

describe('resolveRevenueRates', () => {
  it('prefers the per-shift billable rate over the client default', () => {
    const r = resolveRevenueRates(shift({ billableRate: 45 }), client());
    expect(r.regularRate).toBe(45);
    expect(r.regularSource).toBe('shift');
  });

  it('falls back to the client default rate', () => {
    const r = resolveRevenueRates(shift(), client());
    expect(r.regularRate).toBe(40);
    expect(r.regularSource).toBe('client');
    expect(r.otRate).toBe(60);
    expect(r.otSource).toBe('client');
  });

  it('derives OT at 1.5x when the client has no OT rate', () => {
    const r = resolveRevenueRates(shift(), client({ default_billable_ot_rate: null }));
    expect(r.otRate).toBe(60); // 40 * 1.5
    expect(r.otSource).toBe('derived');
  });

  it('still uses an explicit OT rate even when the regular rate is missing', () => {
    const r = resolveRevenueRates(shift(), client({ default_billable_rate: null }));
    expect(r.regularSource).toBeNull();
    expect(r.otSource).toBe('client'); // explicit OT rate stands on its own
    expect(r.otRate).toBe(60);
  });

  it('reports null sources when no rate is available at all', () => {
    const r = resolveRevenueRates(
      shift(),
      client({ default_billable_rate: null, default_billable_ot_rate: null }),
    );
    expect(r.regularSource).toBeNull();
    expect(r.otSource).toBeNull();
  });
});

describe('resolvePayRate', () => {
  it('prefers the per-shift pay rate, then the caregiver default', () => {
    expect(resolvePayRate(shift({ payRate: 25 }), caregiver()).regularRate).toBe(25);
    expect(resolvePayRate(shift(), caregiver()).regularRate).toBe(20);
    expect(resolvePayRate(shift(), caregiver({ default_pay_rate: null })).regularSource).toBeNull();
  });
});

describe('computeShiftFinancials', () => {
  it('computes revenue, labor cost, and margin for a regular shift', () => {
    const sf = computeShiftFinancials({ shift: shift(), client: client(), caregiver: caregiver() });
    expect(sf.revenue).toBe(320); // 8 * 40
    expect(sf.laborCost).toBe(160); // 8 * 20
    expect(sf.margin).toBe(160);
    expect(sf.totalHours).toBe(8);
  });

  it('applies OT (1.5x) and DT (2x) premiums to labor cost', () => {
    const s = shift({ hours: { regular: 8, overtime: 2, doubleTime: 1 } });
    const sf = computeShiftFinancials({ shift: s, client: client(), caregiver: caregiver() });
    // revenue: 8*40 + (2+1)*60 = 320 + 180 = 500
    expect(sf.revenue).toBe(500);
    // labor: 8*20 + 2*20*1.5 + 1*20*2 = 160 + 60 + 40 = 260
    expect(sf.laborCost).toBe(260);
    expect(sf.margin).toBe(240);
  });

  it('excludes (zeroes) revenue when no billable rate is resolvable', () => {
    const sf = computeShiftFinancials({
      shift: shift(),
      client: client({ default_billable_rate: null }),
      caregiver: caregiver(),
    });
    expect(sf.revenue).toBe(0);
    expect(sf.missingRevenueRate).toBe(true);
    expect(sf.laborCost).toBe(160);
    expect(sf.missingCostRate).toBe(false);
  });

  it('zeroes labor cost when no pay rate is resolvable', () => {
    const sf = computeShiftFinancials({
      shift: shift(),
      client: client(),
      caregiver: caregiver({ default_pay_rate: null }),
    });
    expect(sf.laborCost).toBe(0);
    expect(sf.missingCostRate).toBe(true);
  });
});

describe('aggregateFinancials', () => {
  const clientsById = new Map([
    ['client_1', client()],
    ['client_2', client({ id: 'client_2', first_name: 'Bob', last_name: 'Jones', default_billable_rate: 50, default_billable_ot_rate: 75 })],
  ]);
  const caregiversById = new Map([
    ['cg_1', caregiver()],
    ['cg_2', caregiver({ id: 'cg_2', first_name: 'Carl', last_name: 'King', default_pay_rate: 30 })],
  ]);

  it('rolls up totals, per-client, and per-caregiver', () => {
    const shifts = [
      shift({ shiftId: 'a', clientId: 'client_1', caregiverId: 'cg_1', hours: { regular: 8, overtime: 0, doubleTime: 0 } }),
      shift({ shiftId: 'b', clientId: 'client_2', caregiverId: 'cg_2', hours: { regular: 10, overtime: 0, doubleTime: 0 } }),
    ];
    const agg = aggregateFinancials({ shifts, clientsById, caregiversById });
    // revenue: 8*40 + 10*50 = 320 + 500 = 820
    expect(agg.totals.revenue).toBe(820);
    // labor: 8*20 + 10*30 = 160 + 300 = 460
    expect(agg.totals.laborCost).toBe(460);
    expect(agg.totals.grossMargin).toBe(360);
    expect(agg.totals.grossMarginPct).toBeCloseTo(43.9, 1);
    expect(agg.totals.shiftCount).toBe(2);

    // byClient sorted by revenue desc → client_2 (500) first
    expect(agg.byClient[0].clientId).toBe('client_2');
    expect(agg.byClient[0].name).toBe('Bob Jones');
    expect(agg.byClient[0].revenue).toBe(500);

    // byCaregiver sorted by hours desc → cg_2 (10h) first
    expect(agg.byCaregiver[0].caregiverId).toBe('cg_2');
    expect(agg.byCaregiver[0].totalHours).toBe(10);
  });

  it('counts excluded shifts when rates are missing but still rolls up hours', () => {
    const noRateClients = new Map([['client_1', client({ default_billable_rate: null })]]);
    const shifts = [shift({ shiftId: 'a' })];
    const agg = aggregateFinancials({ shifts, clientsById: noRateClients, caregiversById });
    expect(agg.excluded.missingRevenueRate).toBe(1);
    expect(agg.totals.revenue).toBe(0);
    expect(agg.totals.totalHours).toBe(8);
  });

  it('computes overtime percentage of total hours', () => {
    const shifts = [shift({ hours: { regular: 6, overtime: 2, doubleTime: 0 } })];
    const agg = aggregateFinancials({ shifts, clientsById, caregiversById });
    expect(agg.totals.overtimePct).toBe(25); // 2 / 8
  });

  it('returns null margin% when there is no revenue', () => {
    const agg = aggregateFinancials({ shifts: [], clientsById, caregiversById });
    expect(agg.totals.grossMarginPct).toBeNull();
    expect(agg.totals.revenue).toBe(0);
  });

  it('accepts plain objects as the lookup maps', () => {
    const agg = aggregateFinancials({
      shifts: [shift()],
      clientsById: { client_1: client() },
      caregiversById: { cg_1: caregiver() },
    });
    expect(agg.totals.revenue).toBe(320);
  });
});

describe('computeMonthlyTrend / padMonthlySeries', () => {
  const clientsById = { client_1: client() };
  const caregiversById = { cg_1: caregiver() };

  it('buckets shifts by calendar month', () => {
    const shifts = [
      shift({ shiftId: 'a', startTime: '2026-04-10T16:00:00Z' }),
      shift({ shiftId: 'b', startTime: '2026-05-10T16:00:00Z' }),
      shift({ shiftId: 'c', startTime: '2026-05-20T16:00:00Z' }),
    ];
    const trend = computeMonthlyTrend({ shifts, clientsById, caregiversById });
    expect(trend.map((r) => r.month)).toEqual(['2026-04', '2026-05']);
    expect(trend[1].revenue).toBe(640); // two May shifts × 320
  });

  it('pads a sparse series to a fixed trailing window with zero-rows', () => {
    const trend = computeMonthlyTrend({
      shifts: [shift({ startTime: '2026-05-10T16:00:00Z' })],
      clientsById,
      caregiversById,
    });
    const padded = padMonthlySeries(trend, '2026-05', 3);
    expect(padded.map((r) => r.month)).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(padded[0].revenue).toBe(0);
    expect(padded[2].revenue).toBe(320);
  });

  it('pads across a year boundary correctly', () => {
    const padded = padMonthlySeries([], '2026-01', 3);
    expect(padded.map((r) => r.month)).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});

describe('pctDelta / buildKpi', () => {
  it('computes percentage change and guards divide-by-zero', () => {
    expect(pctDelta(110, 100)).toBe(10);
    expect(pctDelta(90, 100)).toBe(-10);
    expect(pctDelta(50, 0)).toBeNull();
  });

  it('builds a KPI descriptor with abs and pct deltas', () => {
    const k = buildKpi(120, 100);
    expect(k.value).toBe(120);
    expect(k.prior).toBe(100);
    expect(k.absDelta).toBe(20);
    expect(k.pctDelta).toBe(20);
  });
});
