// Financials period helpers — pure date-range math.
//
// The Financials sub-tab lets an owner view metrics over a selectable
// period: month-to-date (default), quarter-to-date, year-to-date, or a
// trailing-12-month window. Each selection resolves to a { start, end }
// pair of YYYY-MM-DD strings, plus the immediately-preceding comparable
// period so KPI tiles can show a period-over-period delta.
//
// Dates are computed in UTC against the YYYY-MM-DD calendar. The portal
// is single-region today (America/Los_Angeles); using UTC-calendar math
// keeps these helpers deterministic and unit-testable. Shift bounding in
// storage.js pads the query window to absorb the tz offset, matching how
// invoicing/storage.js already handles it.

export const PERIOD_OPTIONS = Object.freeze([
  { id: 'mtd', label: 'Month to date' },
  { id: 'qtd', label: 'Quarter to date' },
  { id: 'ytd', label: 'Year to date' },
  { id: 't12m', label: 'Trailing 12 months' },
]);

export const DEFAULT_PERIOD = 'mtd';

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function partsOf(date) {
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1, // 1-12
    d: date.getUTCDate(),
  };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Subtract `n` months from {y, m} (m is 1-12), clamping the day later.
function shiftMonths(y, m, n) {
  const zeroBased = (y * 12 + (m - 1)) - n;
  return { y: Math.floor(zeroBased / 12), m: (zeroBased % 12 + 12) % 12 + 1 };
}

/**
 * Resolve a period id to its current and prior ranges.
 *
 * @param {string} periodId  one of PERIOD_OPTIONS ids
 * @param {Date}   now       reference "today" (defaults to new Date())
 * @returns {{
 *   current: { start: string, end: string },
 *   prior:   { start: string, end: string },
 *   label: string,
 * }}
 *
 * Semantics:
 *   - mtd:  1st of this month → today; prior = same day-count window in
 *           the previous month (1st → min(today.day, daysInPrevMonth)).
 *   - qtd:  1st of this quarter → today; prior = previous quarter's
 *           start → the equivalent offset into it.
 *   - ytd:  Jan 1 → today; prior = Jan 1 → same month/day last year.
 *   - t12m: (today − 12 months) → today; prior = the 12 months before that.
 */
export function resolvePeriod(periodId, now = new Date()) {
  const { y, m, d } = partsOf(now);
  const today = iso(y, m, d);

  switch (periodId) {
    case 'qtd': {
      const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1; // 1,4,7,10
      const start = iso(y, qStartMonth, 1);
      // prior quarter
      const pq = shiftMonths(y, qStartMonth, 3);
      const priorStart = iso(pq.y, pq.m, 1);
      const offsetDays = dayOffset(iso(y, qStartMonth, 1), today);
      const priorEnd = addDays(priorStart, offsetDays);
      return { current: { start, end: today }, prior: { start: priorStart, end: priorEnd }, label: 'Quarter to date' };
    }
    case 'ytd': {
      const start = iso(y, 1, 1);
      const priorStart = iso(y - 1, 1, 1);
      const priorEnd = iso(y - 1, m, Math.min(d, daysInMonth(y - 1, m)));
      return { current: { start, end: today }, prior: { start: priorStart, end: priorEnd }, label: 'Year to date' };
    }
    case 't12m': {
      const startP = shiftMonths(y, m, 12);
      const start = iso(startP.y, startP.m, Math.min(d, daysInMonth(startP.y, startP.m)));
      const priorEndP = shiftMonths(y, m, 12);
      const priorEnd = addDays(iso(priorEndP.y, priorEndP.m, Math.min(d, daysInMonth(priorEndP.y, priorEndP.m))), -1);
      const priorStartP = shiftMonths(y, m, 24);
      const priorStart = iso(priorStartP.y, priorStartP.m, Math.min(d, daysInMonth(priorStartP.y, priorStartP.m)));
      return { current: { start, end: today }, prior: { start: priorStart, end: priorEnd }, label: 'Trailing 12 months' };
    }
    case 'mtd':
    default: {
      const start = iso(y, m, 1);
      const prev = shiftMonths(y, m, 1);
      const priorStart = iso(prev.y, prev.m, 1);
      const priorEnd = iso(prev.y, prev.m, Math.min(d, daysInMonth(prev.y, prev.m)));
      return { current: { start, end: today }, prior: { start: priorStart, end: priorEnd }, label: 'Month to date' };
    }
  }
}

/** Whole-day count between two YYYY-MM-DD strings (end − start). */
export function dayOffset(startIso, endIso) {
  const s = Date.parse(`${startIso}T00:00:00Z`);
  const e = Date.parse(`${endIso}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  return Math.round((e - s) / 86_400_000);
}

/** Add `n` days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(startIso, n) {
  const s = Date.parse(`${startIso}T00:00:00Z`);
  if (Number.isNaN(s)) return startIso;
  const d = new Date(s + n * 86_400_000);
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** The YYYY-MM of a YYYY-MM-DD string (for trend padding). */
export function monthOf(isoDate) {
  return (isoDate ?? '').slice(0, 7);
}
