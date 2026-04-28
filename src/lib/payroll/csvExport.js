// Paychex Flex SPI ("Hours Only Flexible") CSV export — pure function.
//
// Targets Paychex Flex Payroll Center → Import payroll data → Files
// (template "Hours Only Flexible"). Confirmed format per the owner
// 2026-04-27 (see docs/handoff-paychex-phase-4.md).
//
// Six columns, in this exact order:
//
//   | # | Column         | Max | Format                     |
//   |---|----------------|-----|----------------------------|
//   | 1 | Company ID     |  8  | alphanumeric               |
//   | 2 | Worker ID      | 10  | alphanumeric (TC = short)  |
//   | 3 | Pay Component  | 20  | alphanumeric (case-sens.)  |
//   | 4 | Hours          |  7  | numeric -999.99..999.99    |
//   | 5 | Rate           |  9  | numeric 0.0001..99999999.. |
//   | 6 | Rate #         |  2  | alphanumeric 1-25 or 'M'   |
//
// One earning per row. A caregiver with regular + OT + mileage in a
// week becomes 3 rows: same Worker ID, different Pay Component per row.
// Paychex groups rows into a single check by Worker ID + Pay Component.
//
// Rate convention (verified against an actual TC paystub 2026-04-27):
// Paychex does NOT auto-apply OT/DT premium multipliers. The Rate
// column is the literal $/hr to multiply by Hours. So:
//   Regular row  : Rate = base_hourly_rate
//   Overtime row : Rate = base_hourly_rate × 1.5
//   Doubletime   : Rate = base_hourly_rate × 2
//   Mileage row  : Rate = $0.725 (organizations.settings.payroll.mileage_rate)
//                  Hours = miles_driven
//
// Per-shift rates (Phase 4 PR #2):
//   When a workweek's shifts carry distinct hourly rates, the exporter
//   emits one Hourly row per (worker, distinct rate) — e.g. 8h @ $20
//   and 16h @ $22 in regular hours produces:
//     Hourly,8.00,20    and    Hourly,16.00,22
//   Paychex sums them into a single check by Worker ID + Pay Component.
//
//   For Overtime / Doubletime rows in a multi-rate week, CA labor law
//   (DLSE Manual §49.1.2) requires the OT premium to be calculated
//   against the weekly weighted-average regular rate of pay (ROP), not
//   any one shift's rate. The exporter emits a single Overtime row at
//   ROP × 1.5 and a single Doubletime row at ROP × 2. When all shifts
//   carry the same rate, ROP === that rate, so the math reduces to TC's
//   existing single-rate convention (verified against TC paystubs).
//
//   Caller contract: the timesheet object MUST carry either
//     - `regular_by_rate: [{rate, hours}]` + `regular_rate_of_pay:
//       number` (the multi-rate / Phase 4 PR #2 path), OR
//     - `hourly_rate: number` (the legacy single-rate path; produces
//       one Hourly row at that rate with the full regular_hours total).
//   The caller (front-end / payroll-export-run edge function) computes
//   these from `timesheet_shifts` joined with `shifts.hourly_rate` —
//   see `src/features/accounting/storage.js`.
//
// Skip / block behavior:
//   - Skip the Mileage row when org's pay_components.mileage is null
//     or empty (org hasn't told Paychex what to call mileage). The
//     Hours rows still emit; mileage isn't blocking.
//   - DT row requires pay_components.double_time. If unset and DT
//     hours > 0, the timesheet should already carry the
//     `dt_pay_component_missing` exception (block) and never reach
//     this function. Defensive: if it does reach here, we omit the DT
//     row to avoid emitting a row with a null Pay Component.
//   - A timesheet with no `paychex_employee_id` has no Worker ID and
//     would produce an unusable row. Such timesheets carry the
//     `caregiver_missing_paychex_employee_id` exception (block) and
//     should also never reach this function. Defensive: throw rather
//     than emit a row with a blank Worker ID.
//   - Regular / OT / DT rows with 0 hours are omitted (Paychex doesn't
//     need the row; the worker's check is just smaller).
//   - Mileage row with 0 miles is omitted.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   docs/handoff-paychex-phase-4.md ("Paychex SPI file format").

const HEADER_ROW = ['Company ID', 'Worker ID', 'Pay Component', 'Hours', 'Rate', 'Rate #'];

const OT_MULTIPLIER = 1.5;
const DT_MULTIPLIER = 2.0;

/**
 * Format a number for the Hours / Rate columns. Paychex accepts up to
 * 4 decimals on Rate but we round to 4 to keep file size reasonable.
 * Hours are rounded to 2 (TC's existing payroll precision).
 */
function formatHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00';
  return (Math.round(n * 100) / 100).toFixed(2);
}

function formatRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  // Trim trailing zeros after the decimal so $20 doesn't read as
  // "20.0000" — Paychex accepts either but tighter looks more like
  // what the back office hand-types today.
  const rounded = Math.round(n * 10000) / 10000;
  if (Number.isInteger(rounded)) return rounded.toString();
  return rounded.toString();
}

/**
 * Escape a single CSV field. Standard RFC 4180:
 *   - Wrap in double quotes if the value contains comma, quote, CR,
 *     or LF.
 *   - Escape embedded double quotes by doubling them.
 *
 * Worker IDs, hours, and rates are numeric so they never need
 * quoting in practice. Pay Component names ("Hourly", "Overtime",
 * "Mileage") don't either. Company display strings could in theory
 * contain a comma but `display_id` is digit-only. Defensive escaping
 * keeps us safe if any of those inputs ever change.
 */
function escapeCsvField(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function joinRow(cells) {
  return cells.map(escapeCsvField).join(',');
}

/**
 * Resolve org-level config the exporter needs. Throws on missing
 * required values rather than silently emitting a malformed CSV.
 */
function resolveOrgConfig(orgSettings) {
  const settings = orgSettings || {};
  const paychex = settings.paychex || {};
  const payroll = settings.payroll || {};

  const companyId = paychex.display_id;
  if (typeof companyId !== 'string' || companyId.trim() === '') {
    throw new Error(
      'csvExport: organizations.settings.paychex.display_id is required '
        + '(the 8-digit Paychex Flex client number used in the SPI Company ID column)',
    );
  }

  const payComponents = payroll.pay_components || {};
  const mileageRate = Number.isFinite(payroll.mileage_rate)
    ? Number(payroll.mileage_rate)
    : null;

  return {
    companyId: companyId.trim(),
    payComponents: {
      regular: typeof payComponents.regular === 'string' ? payComponents.regular : null,
      overtime: typeof payComponents.overtime === 'string' ? payComponents.overtime : null,
      double_time:
        typeof payComponents.double_time === 'string' ? payComponents.double_time : null,
      mileage: typeof payComponents.mileage === 'string' ? payComponents.mileage : null,
    },
    mileageRate,
  };
}

/**
 * Build the rows for a single timesheet. Returns an array of
 * 6-cell row arrays (not yet CSV-joined).
 *
 * Contract:
 *   timesheet — must include:
 *     - paychex_employee_id (string)                              REQUIRED
 *     - overtime_hours, double_time_hours, mileage_total (numbers)
 *
 *   For the regular hours, EITHER:
 *     (a) `regular_by_rate: [{ rate, hours }]` — multi-rate path
 *         (Phase 4 PR #2). Emits one Hourly row per entry. Used when
 *         the timesheet carries shifts at distinct rates.
 *     (b) `hourly_rate: number` + `regular_hours: number` — legacy
 *         single-rate path. Emits one Hourly row.
 *
 *   For OT / DT premium rows, ALSO required when overtime_hours or
 *   double_time_hours > 0:
 *     - `regular_rate_of_pay: number` — the CA weighted-average ROP
 *       computed by `computeRegularRateOfPay(...)`. The OT row's rate
 *       is ROP × 1.5; the DT row's rate is ROP × 2. When all shifts
 *       carry the same rate, ROP === that rate so the math matches the
 *       single-rate convention Paychex previously saw.
 *     - For (b)/legacy callers without ROP: falls back to
 *       `hourly_rate × multiplier`, which is correct only for
 *       single-rate weeks.
 */
function buildRowsForTimesheet(timesheet, orgConfig) {
  const employeeId = timesheet.paychex_employee_id;
  if (typeof employeeId !== 'string' || employeeId.trim() === '') {
    throw new Error(
      `csvExport: timesheet for caregiver ${timesheet.caregiver_id ?? '<unknown>'} has no `
        + 'paychex_employee_id; cannot generate a Worker ID for the SPI CSV.',
    );
  }

  const ot = Number(timesheet.overtime_hours) || 0;
  const dt = Number(timesheet.double_time_hours) || 0;
  const mileage = Number(timesheet.mileage_total) || 0;

  // ── Resolve the regular-hours bucket: per-rate or single-rate ──
  // Multi-rate path: caller passed { regular_by_rate: [{rate, hours}] }.
  // Single-rate path: caller passed `hourly_rate` and `regular_hours`.
  const perRate = Array.isArray(timesheet.regular_by_rate)
    ? timesheet.regular_by_rate
        .map((r) => ({
          rate: Number(r?.rate),
          hours: Number(r?.hours),
        }))
        .filter((r) =>
          Number.isFinite(r.rate) && r.rate > 0
          && Number.isFinite(r.hours) && r.hours > 0,
        )
    : null;

  const legacyReg = Number(timesheet.regular_hours) || 0;
  const legacyRateRaw = timesheet.hourly_rate;
  const legacyRate = Number(legacyRateRaw);
  const legacyRateValid =
    legacyRateRaw != null && Number.isFinite(legacyRate) && legacyRate > 0;

  const usingPerRate = Array.isArray(perRate) && perRate.length > 0;
  const totalReg = usingPerRate
    ? perRate.reduce((s, r) => s + r.hours, 0)
    : legacyReg;

  // ROP for OT / DT premium rows. Prefer caller-provided ROP. Fall back
  // to legacy `hourly_rate` when present (single-rate weeks).
  const ropRaw = timesheet.regular_rate_of_pay;
  const rop = Number(ropRaw);
  const ropValid = ropRaw != null && Number.isFinite(rop) && rop > 0;
  const premiumBaseRate = ropValid
    ? rop
    : (legacyRateValid ? legacyRate : null);

  const rows = [];

  // ── Hourly rows ──
  if (totalReg > 0) {
    if (!orgConfig.payComponents.regular) {
      throw new Error(
        'csvExport: regular hours present but organizations.settings.payroll.'
          + 'pay_components.regular is not configured.',
      );
    }
    if (usingPerRate) {
      for (const r of perRate) {
        rows.push([
          orgConfig.companyId,
          employeeId,
          orgConfig.payComponents.regular,
          formatHours(r.hours),
          formatRate(r.rate),
          '',
        ]);
      }
    } else {
      if (!legacyRateValid) {
        throw new Error(
          `csvExport: timesheet for caregiver ${timesheet.caregiver_id ?? '<unknown>'} has `
            + 'regular hours but no positive hourly_rate (or regular_by_rate). Set the rate '
            + 'before exporting.',
        );
      }
      rows.push([
        orgConfig.companyId,
        employeeId,
        orgConfig.payComponents.regular,
        formatHours(legacyReg),
        formatRate(legacyRate),
        '',
      ]);
    }
  }

  // ── Overtime row (single row, premium rate = ROP × 1.5) ──
  if (ot > 0) {
    if (!orgConfig.payComponents.overtime) {
      throw new Error(
        'csvExport: overtime hours present but organizations.settings.payroll.'
          + 'pay_components.overtime is not configured.',
      );
    }
    if (premiumBaseRate == null) {
      throw new Error(
        `csvExport: timesheet for caregiver ${timesheet.caregiver_id ?? '<unknown>'} has `
          + 'overtime hours but no regular_rate_of_pay (or hourly_rate fallback). Set the rate '
          + 'before exporting.',
      );
    }
    rows.push([
      orgConfig.companyId,
      employeeId,
      orgConfig.payComponents.overtime,
      formatHours(ot),
      formatRate(premiumBaseRate * OT_MULTIPLIER),
      '',
    ]);
  }

  // ── Doubletime row (single row, premium rate = ROP × 2) ──
  if (dt > 0) {
    // Defensive: the dt_pay_component_missing exception should already
    // have blocked this timesheet upstream. Skip silently rather than
    // emit a row with a null Pay Component.
    if (orgConfig.payComponents.double_time && premiumBaseRate != null) {
      rows.push([
        orgConfig.companyId,
        employeeId,
        orgConfig.payComponents.double_time,
        formatHours(dt),
        formatRate(premiumBaseRate * DT_MULTIPLIER),
        '',
      ]);
    }
  }

  // ── Mileage row ──
  if (mileage > 0) {
    // Skip the mileage row when the org hasn't named its Paychex
    // Mileage Earning. Caregiver still gets paid for hours; the
    // mileage reimbursement just doesn't ride along on this CSV.
    if (orgConfig.payComponents.mileage && orgConfig.mileageRate != null) {
      rows.push([
        orgConfig.companyId,
        employeeId,
        orgConfig.payComponents.mileage,
        formatHours(mileage),
        formatRate(orgConfig.mileageRate),
        '',
      ]);
    }
  }

  return rows;
}

/**
 * Generate a Paychex Flex "Hours Only Flexible" CSV from a list of
 * approved timesheets.
 *
 * @param {Array<object>} timesheets
 *   Each timesheet must carry the per-row fields documented in
 *   `buildRowsForTimesheet`. Callers should filter out timesheets that
 *   carry blocking exceptions before calling this function — see
 *   `exceptions.js`.
 * @param {object} orgSettings
 *   `organizations.settings` jsonb. Reads `paychex.display_id`,
 *   `payroll.pay_components`, and `payroll.mileage_rate`.
 * @returns {string} CSV string with a header row and one row per
 *   (caregiver, pay component) combination. Lines separated by `\r\n`
 *   per RFC 4180; final line ends with a newline.
 */
export function generatePaychexCsv(timesheets, orgSettings) {
  if (!Array.isArray(timesheets)) {
    throw new Error('csvExport: timesheets must be an array');
  }

  const orgConfig = resolveOrgConfig(orgSettings);

  const rows = [HEADER_ROW];
  for (const ts of timesheets) {
    const tsRows = buildRowsForTimesheet(ts, orgConfig);
    for (const r of tsRows) rows.push(r);
  }

  return rows.map(joinRow).join('\r\n') + '\r\n';
}

// Exported for tests so we can assert on the shape without re-parsing
// the joined string.
export const _internal = {
  buildRowsForTimesheet,
  resolveOrgConfig,
  formatHours,
  formatRate,
  escapeCsvField,
  HEADER_ROW,
};
