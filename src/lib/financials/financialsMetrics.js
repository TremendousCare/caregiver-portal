// Financials metrics — pure functions.
//
// Powers the owner-only Accounting ▸ Financials sub-tab. Given the
// completed shifts in a period plus the client/caregiver rate config,
// these functions compute revenue, labor cost, gross margin, and the
// per-client / per-caregiver / monthly rollups the dashboard renders.
//
// NO database access here — storage.js fetches and normalizes, this
// module does the math, the components render. That separation keeps
// the business logic fully unit-testable (CLAUDE.md: new business logic
// gets tests before merging).
//
// IMPORTANT — this is an ANALYTICS ESTIMATE, not the system of record
// for billing or payroll:
//
//   - REVENUE rate resolution mirrors src/lib/invoicing/invoiceBuilder.js
//     (shift.billable_rate → client.default_billable_rate; OT/DT bill at
//     client.default_billable_ot_rate, else 1.5× the resolved regular
//     rate). The authoritative per-invoice figures live on the Invoicing
//     tab; small OT-rate edge cases may differ by cents here.
//
//   - LABOR COST uses each shift's own pay rate (shift.hourly_rate →
//     caregiver.default_pay_rate) with flat CA-style premiums: OT at
//     1.5×, double-time at 2×. Payroll's exact figure uses a weekly
//     weighted-average rate-of-pay (see timesheetBuilder.js); for a
//     dashboard the per-shift premium is accurate to the OT-premium
//     rounding. Exact reconciliation against timesheets.gross_pay is a
//     future iteration.
//
//   - Shifts missing BOTH a shift rate and the relevant default are
//     EXCLUDED from the dollar totals (never silently counted as $0) and
//     surfaced via the `excluded` counts so the UI can warn.

const OT_MULTIPLIER = 1.5;
const DT_MULTIPLIER = 2;

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function isPositiveNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

// ─── Active-status predicates ────────────────────────────────────
//
// Centralized so "what counts as active" is a one-line change. Mirrors
// the conventions used elsewhere in the app (archived flag + a status
// enum). Owners can tune the active phase/status sets here without
// hunting through component code.

const ACTIVE_CLIENT_PHASES = ['active'];
const ACTIVE_CAREGIVER_STATUSES = ['active', 'onboarding'];

export function isActiveClient(client) {
  if (!client) return false;
  if (client.archived === true) return false;
  return ACTIVE_CLIENT_PHASES.includes(client.phase);
}

export function isActiveCaregiver(caregiver) {
  if (!caregiver) return false;
  if (caregiver.archived === true) return false;
  return ACTIVE_CAREGIVER_STATUSES.includes(caregiver.employment_status);
}

// ─── Rate resolution ─────────────────────────────────────────────

/**
 * Resolve billable (revenue) rates for one shift.
 * Mirrors invoiceBuilder's resolution order.
 *
 * @returns {{
 *   regularRate: number, otRate: number,
 *   regularSource: 'shift'|'client'|null,
 *   otSource: 'client'|'derived'|null,
 * }}
 */
export function resolveRevenueRates(shift, client) {
  let regularRate = 0;
  let regularSource = null;
  if (isPositiveNumber(num(shift?.billableRate))) {
    regularRate = num(shift.billableRate);
    regularSource = 'shift';
  } else if (isPositiveNumber(num(client?.default_billable_rate))) {
    regularRate = num(client.default_billable_rate);
    regularSource = 'client';
  }

  let otRate = 0;
  let otSource = null;
  if (isPositiveNumber(num(client?.default_billable_ot_rate))) {
    otRate = num(client.default_billable_ot_rate);
    otSource = 'client';
  } else if (regularSource !== null) {
    otRate = round2(regularRate * OT_MULTIPLIER);
    otSource = 'derived';
  }

  return { regularRate, otRate, regularSource, otSource };
}

/**
 * Resolve the pay (labor cost) rate for one shift.
 * @returns {{ regularRate: number, regularSource: 'shift'|'caregiver'|null }}
 */
export function resolvePayRate(shift, caregiver) {
  if (isPositiveNumber(num(shift?.payRate))) {
    return { regularRate: num(shift.payRate), regularSource: 'shift' };
  }
  if (isPositiveNumber(num(caregiver?.default_pay_rate))) {
    return { regularRate: num(caregiver.default_pay_rate), regularSource: 'caregiver' };
  }
  return { regularRate: 0, regularSource: null };
}

// ─── Per-shift financials ────────────────────────────────────────

/**
 * Compute revenue + labor cost for a single normalized shift.
 *
 * @param {object} args
 * @param {object} args.shift  Normalized shift (see storage.js):
 *   { shiftId, clientId, caregiverId, startTime,
 *     hours: { regular, overtime, doubleTime },
 *     billableRate, payRate, hasPayrollClassification }
 * @param {object|undefined} args.client     client rate-config row
 * @param {object|undefined} args.caregiver  caregiver rate-config row
 *
 * @returns {{
 *   shiftId, clientId, caregiverId,
 *   regular, overtime, doubleTime, totalHours,
 *   revenue, laborCost, margin,
 *   missingRevenueRate: boolean, missingCostRate: boolean,
 * }}
 */
export function computeShiftFinancials({ shift, client, caregiver }) {
  const regular = num(shift?.hours?.regular);
  const overtime = num(shift?.hours?.overtime);
  const doubleTime = num(shift?.hours?.doubleTime);
  const totalHours = round2(regular + overtime + doubleTime);

  const rev = resolveRevenueRates(shift, client);
  const pay = resolvePayRate(shift, caregiver);

  const missingRevenueRate = rev.regularSource === null;
  const missingCostRate = pay.regularSource === null;

  const revenue = missingRevenueRate
    ? 0
    : round2(regular * rev.regularRate + (overtime + doubleTime) * rev.otRate);

  const laborCost = missingCostRate
    ? 0
    : round2(
      regular * pay.regularRate
        + overtime * pay.regularRate * OT_MULTIPLIER
        + doubleTime * pay.regularRate * DT_MULTIPLIER,
    );

  return {
    shiftId: shift?.shiftId,
    clientId: shift?.clientId,
    caregiverId: shift?.caregiverId,
    regular,
    overtime,
    doubleTime,
    totalHours,
    revenue,
    laborCost,
    margin: round2(revenue - laborCost),
    missingRevenueRate,
    missingCostRate,
  };
}

// ─── Aggregation ─────────────────────────────────────────────────

function emptyTotals() {
  return {
    revenue: 0,
    laborCost: 0,
    grossMargin: 0,
    grossMarginPct: null,
    regularHours: 0,
    overtimeHours: 0,
    doubleTimeHours: 0,
    totalHours: 0,
    overtimePct: null,
    shiftCount: 0,
  };
}

function finalizeTotals(t) {
  const revenue = round2(t.revenue);
  const laborCost = round2(t.laborCost);
  const grossMargin = round2(revenue - laborCost);
  const totalHours = round2(t.totalHours);
  const otAndDt = round2(t.overtimeHours + t.doubleTimeHours);
  return {
    revenue,
    laborCost,
    grossMargin,
    grossMarginPct: revenue > 0 ? round2((grossMargin / revenue) * 100) : null,
    regularHours: round2(t.regularHours),
    overtimeHours: round2(t.overtimeHours),
    doubleTimeHours: round2(t.doubleTimeHours),
    totalHours,
    overtimePct: totalHours > 0 ? round2((otAndDt / totalHours) * 100) : null,
    shiftCount: t.shiftCount,
  };
}

function accumulate(target, sf) {
  target.revenue += sf.revenue;
  target.laborCost += sf.laborCost;
  target.regularHours += sf.regular;
  target.overtimeHours += sf.overtime;
  target.doubleTimeHours += sf.doubleTime;
  target.totalHours += sf.totalHours;
  target.shiftCount += 1;
}

/**
 * Aggregate a set of normalized shifts into period totals plus
 * per-client and per-caregiver rollups.
 *
 * @param {object} args
 * @param {Array<object>} args.shifts        normalized shifts
 * @param {Map|object}    args.clientsById   id → client rate-config row
 * @param {Map|object}    args.caregiversById id → caregiver rate-config row
 *
 * @returns {{
 *   totals: object,
 *   byClient: Array<{ clientId, name, ...totals }>,
 *   byCaregiver: Array<{ caregiverId, name, ...totals }>,
 *   excluded: { missingRevenueRate: number, missingCostRate: number },
 * }}
 */
export function aggregateFinancials({ shifts, clientsById, caregiversById }) {
  const getClient = (id) => (clientsById instanceof Map ? clientsById.get(id) : clientsById?.[id]);
  const getCaregiver = (id) => (caregiversById instanceof Map ? caregiversById.get(id) : caregiversById?.[id]);

  const totals = emptyTotals();
  const byClient = new Map();
  const byCaregiver = new Map();
  const excluded = { missingRevenueRate: 0, missingCostRate: 0 };

  for (const shift of shifts ?? []) {
    const client = getClient(shift.clientId);
    const caregiver = getCaregiver(shift.caregiverId);
    const sf = computeShiftFinancials({ shift, client, caregiver });

    if (sf.totalHours <= 0) continue;
    if (sf.missingRevenueRate) excluded.missingRevenueRate += 1;
    if (sf.missingCostRate) excluded.missingCostRate += 1;

    accumulate(totals, sf);

    if (shift.clientId) {
      if (!byClient.has(shift.clientId)) {
        byClient.set(shift.clientId, {
          clientId: shift.clientId,
          name: clientName(client) ?? shift.clientId,
          ...emptyTotals(),
        });
      }
      accumulate(byClient.get(shift.clientId), sf);
    }
    if (shift.caregiverId) {
      if (!byCaregiver.has(shift.caregiverId)) {
        byCaregiver.set(shift.caregiverId, {
          caregiverId: shift.caregiverId,
          name: caregiverName(caregiver) ?? shift.caregiverId,
          ...emptyTotals(),
        });
      }
      accumulate(byCaregiver.get(shift.caregiverId), sf);
    }
  }

  const byClientOut = Array.from(byClient.values())
    .map((row) => ({ clientId: row.clientId, name: row.name, ...finalizeTotals(row) }))
    .sort((a, b) => b.revenue - a.revenue);
  const byCaregiverOut = Array.from(byCaregiver.values())
    .map((row) => ({ caregiverId: row.caregiverId, name: row.name, ...finalizeTotals(row) }))
    .sort((a, b) => b.totalHours - a.totalHours);

  return {
    totals: finalizeTotals(totals),
    byClient: byClientOut,
    byCaregiver: byCaregiverOut,
    excluded,
  };
}

function clientName(c) {
  if (!c) return null;
  const n = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return n.length > 0 ? n : null;
}

function caregiverName(c) {
  if (!c) return null;
  const n = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return n.length > 0 ? n : null;
}

// ─── Monthly trend buckets ───────────────────────────────────────

/**
 * Bucket normalized shifts into calendar months (keyed by the shift's
 * startTime, YYYY-MM in UTC) and compute per-month totals. Months with
 * no shifts are NOT synthesized here — the caller can pad the series to
 * a fixed window (see padMonthlySeries).
 *
 * @returns {Array<{ month: string, ...totals }>} sorted ascending by month.
 */
export function computeMonthlyTrend({ shifts, clientsById, caregiversById }) {
  const getClient = (id) => (clientsById instanceof Map ? clientsById.get(id) : clientsById?.[id]);
  const getCaregiver = (id) => (caregiversById instanceof Map ? caregiversById.get(id) : caregiversById?.[id]);

  const buckets = new Map();
  for (const shift of shifts ?? []) {
    const month = monthKey(shift.startTime);
    if (!month) continue;
    const sf = computeShiftFinancials({
      shift,
      client: getClient(shift.clientId),
      caregiver: getCaregiver(shift.caregiverId),
    });
    if (sf.totalHours <= 0) continue;
    if (!buckets.has(month)) buckets.set(month, emptyTotals());
    accumulate(buckets.get(month), sf);
  }

  return Array.from(buckets.entries())
    .map(([month, t]) => ({ month, ...finalizeTotals(t) }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function monthKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Pad a monthly series to exactly `count` trailing months ending at
 * `endMonth` (YYYY-MM), inserting zero-rows for empty months so charts
 * render a continuous axis.
 */
export function padMonthlySeries(series, endMonth, count) {
  const byMonth = new Map((series ?? []).map((row) => [row.month, row]));
  const out = [];
  const [ey, em] = (endMonth ?? '').split('-').map(Number);
  if (!Number.isFinite(ey) || !Number.isFinite(em)) return series ?? [];
  let y = ey;
  let m = em;
  const months = [];
  for (let i = 0; i < count; i += 1) {
    months.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  for (const month of months) {
    out.push(byMonth.get(month) ?? { month, ...finalizeTotals(emptyTotals()) });
  }
  return out;
}

// ─── Deltas (period-over-period) ─────────────────────────────────

/**
 * Percentage change from prior → current. Returns null when a
 * meaningful percentage can't be computed (no prior baseline).
 */
export function pctDelta(current, prior) {
  const c = num(current);
  const p = num(prior);
  if (p === 0) return null;
  return round2(((c - p) / Math.abs(p)) * 100);
}

/**
 * Build a KPI tile descriptor: absolute value, prior value, abs delta,
 * pct delta. Pure — the component decides how to render it.
 */
export function buildKpi(current, prior) {
  const c = num(current);
  const p = num(prior);
  return {
    value: round2(c),
    prior: round2(p),
    absDelta: round2(c - p),
    pctDelta: pctDelta(c, p),
  };
}

export const __test__ = { round2, monthKey, OT_MULTIPLIER, DT_MULTIPLIER };
