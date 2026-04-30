// Invoice builder — pure function.
//
// Given a client + the shifts the client was billed for in a workweek,
// produce a draft `invoices` row plus `invoice_shifts` junction rows.
// NO database writes; the Phase 2 cron + Phase 2 UI both call this and
// then persist.
//
// Design choices (mirroring src/lib/payroll/timesheetBuilder.js where
// it makes sense; flagged where they diverge):
//
//  - Hours classification (regular / overtime / double_time) is sourced
//    from the upstream timesheet_shifts row when one exists for the
//    shift, else everything is treated as `regular`. Rationale: a
//    caregiver's OT is a property of THEIR workweek, not the client's.
//    If we re-derived classification from the client's shifts alone
//    we'd under-count OT (the caregiver might have hit 40h via shifts
//    on three different clients). Reading the payroll-side classification
//    keeps caregiver-OT and client-billing-OT aligned to the cent.
//
//  - Rate resolution per shift, in priority order:
//       1. shifts.billable_rate (per-shift override)
//       2. clients.default_billable_rate (client-level fallback)
//       3. → emit `client_missing_rate` block-severity exception, treat
//          rate as 0 for the math (so we don't crash; the block prevents
//          approval).
//
//  - OT rate (applies to overtime + double_time hours):
//       1. clients.default_billable_ot_rate (per-client OT rate)
//       2. → 1.5 × the resolved regular rate (industry default)
//       Note: per-client, not per-shift. Confirmed with the owner —
//       different clients have different OT rates, but a single client
//       has one OT rate. Same answer applies to double-time hours
//       (DT bills at OT rate in v1; a separate DT rate can be added
//       additively if needed).
//
//  - Mileage / reimbursement billing is OUT of scope for v1. If a client
//    contract reimburses caregiver mileage, that's a separate line
//    item we'll model in a later phase.
//
//  - When the period has zero billable hours, the builder returns null.
//    The caller skips empty drafts entirely.
//
// Returns:
//   {
//     invoice: { ... shape suitable for INSERT into invoices },
//     invoice_shifts: [ ... shape suitable for INSERT into invoice_shifts ],
//     exceptions: [ { code, severity, ... } ],
//     meta: { ... builder-only metadata for logging / UI inspection }
//   }
//   or null when there is nothing to bill.
//
// Plan reference: docs/INVOICING.md ("Invoice builder").

export const HOUR_CLASS = Object.freeze({
  REGULAR: 'regular',
  OVERTIME: 'overtime',
  DOUBLE_TIME: 'double_time',
});

export const INVOICE_EXCEPTION_CODE = Object.freeze({
  CLIENT_MISSING_RATE: 'client_missing_rate',
  CLIENT_MISSING_OT_RATE: 'client_missing_ot_rate',
  CLIENT_MISSING_ADDRESS: 'client_missing_address',
  SHIFT_MISSING_HOURS: 'shift_missing_hours',
});

export const INVOICE_EXCEPTION_SEVERITY = Object.freeze({
  BLOCK: 'block',
  WARN: 'warn',
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isPositiveNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Resolve the regular rate for a single shift. Returns:
 *   { rate: number, source: 'shift' | 'client' | null }
 * source = null when no rate is available (caller emits the exception).
 */
function resolveShiftRegularRate(shift, client) {
  if (isPositiveNumber(shift?.billable_rate)) {
    return { rate: Number(shift.billable_rate), source: 'shift' };
  }
  if (isPositiveNumber(client?.default_billable_rate)) {
    return { rate: Number(client.default_billable_rate), source: 'client' };
  }
  return { rate: 0, source: null };
}

/**
 * Resolve the OT rate for the client. OT rate is per-client, not
 * per-shift (locked decision with the owner). Returns:
 *   { rate: number, source: 'client' | 'derived' | null }
 *   source = 'derived' means we used 1.5 × the client's regular rate.
 *   source = null means we have no client regular rate either.
 */
function resolveClientOtRate(client) {
  if (isPositiveNumber(client?.default_billable_ot_rate)) {
    return { rate: Number(client.default_billable_ot_rate), source: 'client' };
  }
  if (isPositiveNumber(client?.default_billable_rate)) {
    return {
      rate: round2(Number(client.default_billable_rate) * 1.5),
      source: 'derived',
    };
  }
  return { rate: 0, source: null };
}

/**
 * Build a draft invoice (and its line items) for one client/billing
 * period.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {object} args.client
 *   Client row. Reads id, default_billable_rate, default_billable_ot_rate,
 *   address (for the missing-address warning).
 * @param {string} args.billingPeriodStart  YYYY-MM-DD (Monday in tz).
 * @param {string} args.billingPeriodEnd    YYYY-MM-DD (Sunday in tz).
 * @param {Array<object>} args.shiftLineItems
 *   One entry per shift the client was billed for. Each entry shape:
 *     {
 *       shiftId: string,
 *       billable_rate: number | null,   // shifts.billable_rate
 *       hours: { regular: number, overtime: number, doubleTime: number },
 *       // Whether the upstream timesheet_shifts row exists. When false,
 *       // the builder treats all hours as regular (no caregiver-OT
 *       // attribution available). Logged in meta for transparency.
 *       hasPayrollClassification: boolean,
 *     }
 *
 * @returns {null | {
 *   invoice: object,
 *   invoice_shifts: Array<object>,
 *   exceptions: Array<{code: string, severity: string, message: string, shiftId?: string}>,
 *   meta: object,
 * }}
 */
export function buildInvoice({
  orgId,
  client,
  billingPeriodStart,
  billingPeriodEnd,
  shiftLineItems,
}) {
  if (!orgId) throw new Error('invoiceBuilder: orgId is required');
  if (!client || typeof client.id !== 'string') {
    throw new Error('invoiceBuilder: client { id } is required');
  }
  if (!billingPeriodStart) throw new Error('invoiceBuilder: billingPeriodStart is required');
  if (!billingPeriodEnd) throw new Error('invoiceBuilder: billingPeriodEnd is required');
  if (!Array.isArray(shiftLineItems)) {
    throw new Error('invoiceBuilder: shiftLineItems must be an array');
  }

  // Aggregate hours and exceptions in one pass.
  const exceptions = [];
  const otResolution = resolveClientOtRate(client);

  let regularHoursTotal = 0;
  let overtimeHoursTotal = 0;
  let doubleTimeHoursTotal = 0;
  let subtotal = 0;
  const invoiceShifts = [];
  const distinctRegularRates = new Set();
  const missingClassificationShiftIds = [];

  for (const item of shiftLineItems) {
    if (!item || typeof item.shiftId !== 'string') {
      throw new Error('invoiceBuilder: every shiftLineItem requires shiftId');
    }

    const reg = Number(item.hours?.regular) || 0;
    const ot = Number(item.hours?.overtime) || 0;
    const dt = Number(item.hours?.doubleTime) || 0;

    if (reg < 0 || ot < 0 || dt < 0) {
      throw new Error(`invoiceBuilder: shift ${item.shiftId} has negative hours`);
    }

    if (reg + ot + dt <= 0) {
      // Zero-hour shifts are silently dropped — the cron should have
      // filtered them upstream, but a stray no_show / cancelled shift
      // shouldn't crash the build.
      exceptions.push({
        code: INVOICE_EXCEPTION_CODE.SHIFT_MISSING_HOURS,
        severity: INVOICE_EXCEPTION_SEVERITY.WARN,
        shiftId: item.shiftId,
        message: `Shift ${item.shiftId} has zero billable hours.`,
      });
      continue;
    }

    if (item.hasPayrollClassification === false) {
      missingClassificationShiftIds.push(item.shiftId);
    }

    const regResolution = resolveShiftRegularRate(item, client);
    if (regResolution.source === null) {
      exceptions.push({
        code: INVOICE_EXCEPTION_CODE.CLIENT_MISSING_RATE,
        severity: INVOICE_EXCEPTION_SEVERITY.BLOCK,
        shiftId: item.shiftId,
        message:
          `No billable rate available for shift ${item.shiftId}: shift has no `
          + `billable_rate and client ${client.id} has no default_billable_rate.`,
      });
    } else {
      distinctRegularRates.add(regResolution.rate);
    }

    // Per-shift dominant classification for the junction row's
    // hour_classification (CHECK constraint requires a single value).
    // Tie-break order matches timesheet_shifts: regular > overtime > dt.
    let dominant = HOUR_CLASS.REGULAR;
    if (reg >= ot && reg >= dt) dominant = HOUR_CLASS.REGULAR;
    else if (ot >= dt) dominant = HOUR_CLASS.OVERTIME;
    else dominant = HOUR_CLASS.DOUBLE_TIME;

    const totalHours = reg + ot + dt;

    // Per-shift dollar contribution. OT and DT hours bill at the OT
    // rate; regular hours bill at the resolved regular rate. When OT
    // exists but no client OT rate is configured we already derived
    // 1.5 × the client default; the warning below surfaces it.
    let shiftSubtotal = reg * regResolution.rate;
    if (ot + dt > 0) {
      // Use the resolved OT rate. If we couldn't resolve an OT rate at
      // all (no client default rate either), fall back to 1.5 × the
      // shift's regular rate so we still emit a defensible number; the
      // block exception above will gate approval.
      const otRate = otResolution.source !== null
        ? otResolution.rate
        : round2(regResolution.rate * 1.5);
      shiftSubtotal += (ot + dt) * otRate;
    }
    shiftSubtotal = round2(shiftSubtotal);

    invoiceShifts.push({
      shift_id: item.shiftId,
      hours_worked: round2(totalHours),
      hour_classification: dominant,
      billable_rate_applied:
        regResolution.source === null ? null : round2(regResolution.rate),
    });

    regularHoursTotal += reg;
    overtimeHoursTotal += ot;
    doubleTimeHoursTotal += dt;
    subtotal += shiftSubtotal;
  }

  // Nothing to bill → caller skips this client/period entirely.
  if (invoiceShifts.length === 0) return null;

  // Client-level OT rate warning (if there's any OT/DT and client has
  // no explicit OT rate, we derived 1.5 × base — flag for review).
  if ((overtimeHoursTotal + doubleTimeHoursTotal) > 0
      && otResolution.source === 'derived') {
    exceptions.push({
      code: INVOICE_EXCEPTION_CODE.CLIENT_MISSING_OT_RATE,
      severity: INVOICE_EXCEPTION_SEVERITY.WARN,
      message:
        `Client ${client.id} has no default_billable_ot_rate; OT hours `
        + 'are billed at 1.5× the regular rate. Set an explicit OT rate '
        + 'on the client to silence this warning.',
    });
  }

  // Address warning — useful for the PDF / printable invoice. Doesn't
  // gate approval (you can still issue an invoice without an address).
  const addressFields = [client.address, client.city, client.state, client.zip];
  const hasAnyAddress = addressFields.some(
    (v) => typeof v === 'string' && v.trim().length > 0,
  );
  if (!hasAnyAddress) {
    exceptions.push({
      code: INVOICE_EXCEPTION_CODE.CLIENT_MISSING_ADDRESS,
      severity: INVOICE_EXCEPTION_SEVERITY.WARN,
      message: `Client ${client.id} has no billing address on file.`,
    });
  }

  // Snapshot rates onto the invoice when shifts share a single regular
  // rate. When rates vary we leave invoice.regular_rate null and the UI
  // shows "Mixed" — the per-shift rate on invoice_shifts.billable_rate_applied
  // is the source of truth in that case.
  const snapshotRegularRate = distinctRegularRates.size === 1
    ? round2(Array.from(distinctRegularRates)[0])
    : null;
  const snapshotOtRate = otResolution.source !== null
    ? round2(otResolution.rate)
    : null;

  const subtotalRounded = round2(subtotal);
  const totalRounded = subtotalRounded; // No tax / discount yet.

  const blockedByExceptions = exceptions.some(
    (e) => e.severity === INVOICE_EXCEPTION_SEVERITY.BLOCK,
  );

  const invoice = {
    org_id: orgId,
    client_id: client.id,
    invoice_number: null,
    billing_period_start: billingPeriodStart,
    billing_period_end: billingPeriodEnd,
    status: blockedByExceptions ? 'blocked' : 'draft',
    regular_hours: round2(regularHoursTotal),
    overtime_hours: round2(overtimeHoursTotal),
    double_time_hours: round2(doubleTimeHoursTotal),
    regular_rate: snapshotRegularRate,
    ot_rate: snapshotOtRate,
    subtotal: subtotalRounded,
    total: totalRounded,
    block_reason: blockedByExceptions
      ? exceptions.find((e) => e.severity === INVOICE_EXCEPTION_SEVERITY.BLOCK)?.message
        ?? 'Blocked by validation exceptions.'
      : null,
  };

  const meta = {
    distinctRegularRates: Array.from(distinctRegularRates).sort((a, b) => a - b),
    otRateSource: otResolution.source,
    missingClassificationShiftIds,
    shiftCount: invoiceShifts.length,
  };

  return { invoice, invoice_shifts: invoiceShifts, exceptions, meta };
}
