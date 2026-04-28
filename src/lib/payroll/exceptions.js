// Payroll exception detection.
//
// Pure function: given a draft timesheet payload (the output of
// timesheetBuilder.js) plus a small caregiver descriptor, returns an
// array of exception objects:
//
//   { severity: 'block' | 'warn', code, message, shift_id?: string }
//
// The Phase 4 UI consumes this array to:
//   - Sort blocking exceptions to the top of the list.
//   - Render a colored badge (red for block, yellow for warn).
//   - Hide the per-row Approve button when any block-severity
//     exception is present.
//
// The Phase 3 edge function uses the array to decide whether the
// generated timesheet starts as `draft` (no blocks) or `blocked`
// (any block-severity code present), and to populate `block_reason`.
//
// Codes per the plan:
//   - missing_clock_out                        block
//       (a shift was scheduled-only with no clock-out)
//   - out_of_geofence                          warn
//       (caregiver clocked outside the geofence)
//   - blocked_caregiver                        block
//       (caregivers.payroll_blocked = true / sync error)
//   - shift_too_long                           warn
//       (a single shift > LONG_SHIFT_WARNING_HOURS)
//   - caregiver_not_in_paychex                 warn
//       (no paychex_worker_id yet — entitlement gap)
//   - dt_pay_component_missing                 block (Phase 4 PR #1)
//       (DT hours exist but the org has no Paychex Earning name
//        configured for double-time — CSV export would emit an
//        unmappable row)
//   - caregiver_missing_paychex_employee_id    block (Phase 4 PR #1)
//       (caregiver has hours but no SHORT paychex_employee_id — the
//        Paychex Flex SPI CSV cannot identify the worker without it)
//   - caregiver_missing_rate                   block (Phase 4 PR #2)
//       (a shift has hours but no hourly_rate; gross_pay would be
//        understated. Inline rate edit clears the block.)
//
// Removed Phase 4 PR #2:
//   - `rate_mismatch` was a hard block when shifts within a workweek
//     carried distinct rates. Replaced by per-shift rate handling +
//     CA weighted-average regular-rate-of-pay calculation in
//     overtimeRules.js / timesheetBuilder.js. Multiple rates within
//     a workweek is now legal and correctly paid.
//
// Severity is deliberate. `caregiver_not_in_paychex` is `warn` because
// Paychex's worker WRITE entitlement is gated at their backend during
// Phase 2 rollout — blocking the whole pipeline on it would mean every
// new caregiver halts payroll until Paychex enables the entitlement.
// The exception still surfaces; back office decides per case.
//
// `caregiver_missing_paychex_employee_id` is a separate, hard-block
// code: even when the caregiver IS synced (paychex_worker_id present),
// the CSV export cannot run without the short employeeId that Paychex
// returns in the worker GET response and the backfill function
// captures.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   ("Phase 3 — Timesheet generation and overtime engine"
//    + the Phase 4 ThisWeekView exception list).

import {
  EXCEPTION_CODE,
  EXCEPTION_SEVERITY,
  LONG_SHIFT_WARNING_HOURS,
} from './constants.js';

/**
 * Detect exceptions on a built timesheet draft.
 *
 * @param {object} args
 * @param {object} args.draft  Output of `buildTimesheet(...)` — must
 *                             contain `timesheet`, `timesheet_shifts`,
 *                             and `meta`.
 * @param {object} args.caregiver
 *   Minimal caregiver descriptor:
 *     - paychex_worker_id        (string | null)
 *     - paychex_employee_id      (string | null)  // short SPI Worker ID
 *     - paychex_sync_status      (string | null)
 *     - payroll_blocked          (boolean | undefined; future column)
 *     - payroll_block_reason     (string | undefined)
 *
 * @param {object} [args.orgSettings]
 *   Optional `organizations.settings` jsonb. When provided, drives the
 *   `dt_pay_component_missing` check using
 *   `payroll.pay_components.double_time`. Omitted = legacy callers that
 *   pre-date Phase 4; those callers won't get the DT-config exception.
 *
 * @returns {Array<{
 *   severity: 'block' | 'warn',
 *   code: string,
 *   message: string,
 *   shift_id?: string,
 * }>}
 */
export function detectExceptions({ draft, caregiver, orgSettings }) {
  if (!draft || !draft.timesheet || !Array.isArray(draft.timesheet_shifts)) {
    throw new Error(
      'exceptions: draft must be the return shape of buildTimesheet (timesheet + timesheet_shifts + meta)',
    );
  }
  if (!caregiver) {
    throw new Error('exceptions: caregiver descriptor is required');
  }

  const out = [];
  const meta = draft.meta || {};
  const perShift = Array.isArray(meta.perShift) ? meta.perShift : [];

  // ── 1. Blocked caregiver ─────────────────────────────────────────
  // `payroll_blocked` is a future column (Phase 4 introduces a
  // back-office toggle). Until then, treat the canonical paychex
  // sync states `error` and `rehire_blocked` as "blocked for
  // payroll" — those are the conditions where pushing money to a
  // worker is unsafe.
  const isBlocked =
    caregiver.payroll_blocked === true
    || caregiver.paychex_sync_status === 'rehire_blocked';
  if (isBlocked) {
    out.push({
      severity: EXCEPTION_SEVERITY.BLOCK,
      code: EXCEPTION_CODE.BLOCKED_CAREGIVER,
      message:
        caregiver.payroll_block_reason
          ? `Caregiver is blocked for payroll: ${caregiver.payroll_block_reason}`
          : 'Caregiver is blocked for payroll. Resolve in Paychex / Settings before approving.',
    });
  }

  // ── 2. Caregiver not in Paychex (warn) ───────────────────────────
  // We don't gate on this — the entitlement-blocked Phase 2 caregivers
  // would otherwise stall the whole pipeline.
  if (!caregiver.paychex_worker_id) {
    out.push({
      severity: EXCEPTION_SEVERITY.WARN,
      code: EXCEPTION_CODE.CAREGIVER_NOT_IN_PAYCHEX,
      message:
        'Caregiver has not been synced to Paychex Flex yet. Sync before submitting payroll.',
    });
  }

  // ── 3. Per-shift missing rate (block) ────────────────────────────
  // A shift with positive hours but no `hourly_rate` would understate
  // gross pay. The Phase 4 PR #2 inline rate edit clears the block by
  // setting the missing rate. Per-shift granularity surfaces exactly
  // which shift needs attention (vs. the old `rate_mismatch` which
  // bundled the whole week).
  for (const ps of perShift) {
    const hours = Number(ps?.totalHours) || 0;
    const rate = ps?.hourly_rate;
    const rateValid = typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
    if (hours > 0 && !rateValid) {
      out.push({
        severity: EXCEPTION_SEVERITY.BLOCK,
        code: EXCEPTION_CODE.CAREGIVER_MISSING_RATE,
        message:
          'Shift has worked hours but no hourly rate. Set a rate via inline edit '
            + 'before approving so gross pay is accurate.',
        shift_id: ps.shift_id,
      });
    }
  }

  // ── 3a. Caregiver missing Paychex SHORT employeeId (block) ───────
  // Distinct from `caregiver_not_in_paychex`: a caregiver who's been
  // synced (paychex_worker_id present) may still lack the short
  // employeeId until the Phase 4 backfill function captures it. The
  // CSV export's "Worker ID" column is the SHORT id; without it the
  // SPI import would fail or attach hours to the wrong worker.
  // Treat as block whenever the timesheet has any payable amount.
  const hasPayableAmount =
    (Number(draft.timesheet?.regular_hours) || 0) > 0
    || (Number(draft.timesheet?.overtime_hours) || 0) > 0
    || (Number(draft.timesheet?.double_time_hours) || 0) > 0
    || (Number(draft.timesheet?.mileage_total) || 0) > 0;
  if (
    hasPayableAmount
    && (caregiver.paychex_employee_id == null
      || (typeof caregiver.paychex_employee_id === 'string'
        && caregiver.paychex_employee_id.trim() === ''))
  ) {
    out.push({
      severity: EXCEPTION_SEVERITY.BLOCK,
      code: EXCEPTION_CODE.CAREGIVER_MISSING_PAYCHEX_EMPLOYEE_ID,
      message:
        'Caregiver has no Paychex employee ID (the short SPI Worker ID). '
          + 'Run paychex-backfill-employee-ids or set the value manually before exporting.',
    });
  }

  // ── 3b. Double-time pay component not configured (block) ─────────
  // The CSV export emits one row per (worker, pay_component). If the
  // timesheet carries DT hours but the org hasn't told Paychex Flex
  // the name of its Doubletime Earning, we have nothing to put in the
  // Pay Component column for those hours and the row would be
  // unmappable. Block until the owner either configures the Earning
  // (Paychex Flex Settings → Earnings, then update
  // organizations.settings.payroll.pay_components.double_time) or
  // zeroes out the DT hours via inline edit in the Phase 4 PR #2 UI.
  // Skip the DT-config check entirely when the caller didn't supply
  // orgSettings — preserves the pre-Phase-4 contract for callers that
  // only care about per-shift / per-caregiver checks.
  const dtHours = Number(draft.timesheet?.double_time_hours) || 0;
  if (dtHours > 0 && orgSettings) {
    const payComponents =
      (orgSettings.payroll && orgSettings.payroll.pay_components) || {};
    const dtName = payComponents.double_time;
    const dtConfigured = typeof dtName === 'string' && dtName.trim() !== '';
    if (!dtConfigured) {
      out.push({
        severity: EXCEPTION_SEVERITY.BLOCK,
        code: EXCEPTION_CODE.DT_PAY_COMPONENT_MISSING,
        message:
          `Timesheet has ${dtHours} double-time hours but no Paychex Earning is configured `
            + 'for double-time. Add the Earning in Paychex Flex Settings → Earnings and set '
            + 'organizations.settings.payroll.pay_components.double_time to its name, OR zero '
            + 'out the DT hours via inline edit before exporting.',
      });
    }
  }

  // ── 4. Per-shift exceptions ──────────────────────────────────────
  for (const ps of perShift) {
    if (ps.missingClockOut) {
      out.push({
        severity: EXCEPTION_SEVERITY.BLOCK,
        code: EXCEPTION_CODE.MISSING_CLOCK_OUT,
        message:
          'Shift has no clock-out event. Hours fall back to the scheduled end time. Confirm before approving.',
        shift_id: ps.shift_id,
      });
    }
    if (ps.hadGeofenceFailure) {
      out.push({
        severity: EXCEPTION_SEVERITY.WARN,
        code: EXCEPTION_CODE.OUT_OF_GEOFENCE,
        message:
          'Caregiver clocked in/out outside the client geofence at least once on this shift.',
        shift_id: ps.shift_id,
      });
    }
    if (ps.totalHours > LONG_SHIFT_WARNING_HOURS) {
      out.push({
        severity: EXCEPTION_SEVERITY.WARN,
        code: EXCEPTION_CODE.SHIFT_TOO_LONG,
        message:
          `Shift duration is ${ps.totalHours} hours, above the ${LONG_SHIFT_WARNING_HOURS}h `
            + 'sanity threshold. Likely a missing clock-out or data entry error.',
        shift_id: ps.shift_id,
      });
    }
  }

  return out;
}

/**
 * Convenience — does an exception list contain any block-severity
 * entries? Used by the Phase 3 cron to decide between status='draft'
 * and status='blocked'.
 */
export function hasBlockingExceptions(exceptions) {
  if (!Array.isArray(exceptions)) return false;
  return exceptions.some((e) => e.severity === EXCEPTION_SEVERITY.BLOCK);
}

/**
 * Convenience — produce a human-readable summary of the blocking
 * codes for `timesheets.block_reason`. Stable order so re-runs of the
 * cron over the same data produce the same string.
 */
export function summarizeBlockReason(exceptions) {
  if (!Array.isArray(exceptions)) return null;
  const codes = Array.from(
    new Set(
      exceptions
        .filter((e) => e.severity === EXCEPTION_SEVERITY.BLOCK)
        .map((e) => e.code),
    ),
  ).sort();
  return codes.length === 0 ? null : codes.join(', ');
}
