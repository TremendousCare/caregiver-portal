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
//   - missing_clock_out      block  (a shift was scheduled-only with no clock-out)
//   - out_of_geofence        warn   (caregiver clocked outside the geofence)
//   - rate_mismatch          block  (multiple distinct rates within a single timesheet)
//   - blocked_caregiver      block  (caregivers.payroll_blocked = true / sync error)
//   - shift_too_long         warn   (a single shift > LONG_SHIFT_WARNING_HOURS)
//   - caregiver_not_in_paychex  warn  (no paychex_worker_id yet — entitlement gap)
//
// Severity is deliberate. `caregiver_not_in_paychex` is `warn` because
// Paychex's worker WRITE entitlement is gated at their backend during
// Phase 2 rollout — blocking the whole pipeline on it would mean every
// new caregiver halts payroll until Paychex enables the entitlement.
// The exception still surfaces; back office decides per case.
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
 *     - paychex_sync_status      (string | null)
 *     - payroll_blocked          (boolean | undefined; future column)
 *     - payroll_block_reason     (string | undefined)
 *
 * @returns {Array<{
 *   severity: 'block' | 'warn',
 *   code: string,
 *   message: string,
 *   shift_id?: string,
 * }>}
 */
export function detectExceptions({ draft, caregiver }) {
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

  // ── 3. Rate mismatch (block) ─────────────────────────────────────
  const distinctRates = Array.isArray(meta.distinctRates) ? meta.distinctRates : [];
  if (distinctRates.length > 1) {
    out.push({
      severity: EXCEPTION_SEVERITY.BLOCK,
      code: EXCEPTION_CODE.RATE_MISMATCH,
      message:
        `Caregiver's shifts this week carry ${distinctRates.length} distinct hourly rates `
          + `(${distinctRates.join(', ')}). Reconcile before approving so gross pay is accurate.`,
    });
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
