// Timesheet approval state machine — pure helpers.
//
// Encodes the legal status transitions for `timesheets.status` so the
// edge function (`payroll-timesheet-actions`) and the UI can ask a
// single source of truth "may I move this row from X to Y?" rather
// than re-scattering the rules.
//
// The DB-level CHECK constraint on `timesheets.status` (migration
// 20260425170001_create_timesheets.sql) enumerates the legal VALUES
// but not the legal TRANSITIONS. The ladder lives here:
//
//   draft           → pending_approval | approved | blocked | rejected
//   pending_approval→ approved | rejected | blocked | draft
//   approved        → exported | rejected | draft   (back to draft for
//                     manual unapprove; rejected = void)
//   exported        → submitted | paid | rejected   (Phase 4 CSV path
//                     marks paid manually after Paychex; submitted is
//                     for the Phase 5 API path)
//   submitted       → paid | rejected
//   paid            → (terminal)
//   rejected        → draft                          (un-reject so the
//                     row can be edited and re-submitted)
//   blocked         → draft                          (cleared after
//                     resolving the underlying exception)
//
// Phase 4 PR #2 only exercises a subset:
//   - draft     → approved              (Approve / Bulk Approve All Clean)
//   - approved  → exported              (Generate Run + payroll-export-run)
//   - approved  → draft                 (Unapprove)
//   - blocked   → draft                 (Regenerate after edits clear blocks)
//
// The rest are documented for completeness and so PR #3 (Mark as Paid)
// can layer on without re-deriving the rules.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//     ("Phase 4 — Approval UI and CSV export").
//   docs/handoff-paychex-phase-4.md
//     ("PR #2 — Edits + approval + Generate Run + CSV export").

export const TIMESHEET_STATUS = Object.freeze({
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  EXPORTED: 'exported',
  SUBMITTED: 'submitted',
  PAID: 'paid',
  REJECTED: 'rejected',
  BLOCKED: 'blocked',
});

const ALL_STATUSES = new Set(Object.values(TIMESHEET_STATUS));

// Map of from-status → set of legal next statuses.
const ALLOWED = new Map([
  [TIMESHEET_STATUS.DRAFT, new Set([
    TIMESHEET_STATUS.PENDING_APPROVAL,
    TIMESHEET_STATUS.APPROVED,
    TIMESHEET_STATUS.BLOCKED,
    TIMESHEET_STATUS.REJECTED,
  ])],
  [TIMESHEET_STATUS.PENDING_APPROVAL, new Set([
    TIMESHEET_STATUS.APPROVED,
    TIMESHEET_STATUS.REJECTED,
    TIMESHEET_STATUS.BLOCKED,
    TIMESHEET_STATUS.DRAFT,
  ])],
  [TIMESHEET_STATUS.APPROVED, new Set([
    TIMESHEET_STATUS.EXPORTED,
    TIMESHEET_STATUS.REJECTED,
    TIMESHEET_STATUS.DRAFT,
  ])],
  [TIMESHEET_STATUS.EXPORTED, new Set([
    TIMESHEET_STATUS.SUBMITTED,
    TIMESHEET_STATUS.PAID,
    TIMESHEET_STATUS.REJECTED,
  ])],
  [TIMESHEET_STATUS.SUBMITTED, new Set([
    TIMESHEET_STATUS.PAID,
    TIMESHEET_STATUS.REJECTED,
  ])],
  [TIMESHEET_STATUS.PAID, new Set()], // terminal
  [TIMESHEET_STATUS.REJECTED, new Set([
    TIMESHEET_STATUS.DRAFT,
  ])],
  [TIMESHEET_STATUS.BLOCKED, new Set([
    TIMESHEET_STATUS.DRAFT,
  ])],
]);

/**
 * Whether `from → to` is a legal status transition. Pure: no side
 * effects, no DB lookups. Always returns false for unknown statuses.
 */
export function canTransition(from, to) {
  if (!ALL_STATUSES.has(from) || !ALL_STATUSES.has(to)) return false;
  if (from === to) return false;
  const allowed = ALLOWED.get(from);
  return allowed ? allowed.has(to) : false;
}

/**
 * Validate an approval action for a single timesheet. Used by the
 * `payroll-timesheet-actions` edge function and the UI gate on the
 * Approve button. Returns a structured result so callers can pattern
 * match on `.code` for user-facing messages.
 *
 * Args:
 *   timesheet: { status, ... }
 *   action: 'approve' | 'unapprove'
 *   exceptions: Array<{ severity }> — used by approve-action gate.
 */
export function evaluateApprovalAction({ timesheet, action, exceptions = [] }) {
  if (!timesheet || typeof timesheet.status !== 'string') {
    return { ok: false, code: 'invalid_timesheet', message: 'Timesheet has no status.' };
  }

  if (action === 'approve') {
    if (timesheet.status === TIMESHEET_STATUS.APPROVED) {
      return { ok: false, code: 'already_approved', message: 'Timesheet is already approved.' };
    }
    if (timesheet.status !== TIMESHEET_STATUS.DRAFT
        && timesheet.status !== TIMESHEET_STATUS.PENDING_APPROVAL) {
      return {
        ok: false,
        code: 'invalid_from_status',
        message: `Cannot approve a timesheet in status "${timesheet.status}".`,
      };
    }
    const blockers = (exceptions || []).filter((e) => e?.severity === 'block');
    if (blockers.length > 0) {
      const codes = Array.from(new Set(blockers.map((e) => e.code).filter(Boolean)));
      return {
        ok: false,
        code: 'blocked_by_exceptions',
        message:
          `Cannot approve while blocking exceptions remain: ${codes.join(', ') || '(unknown)'}.`,
        blocking_codes: codes,
      };
    }
    return { ok: true, nextStatus: TIMESHEET_STATUS.APPROVED };
  }

  if (action === 'unapprove') {
    if (timesheet.status !== TIMESHEET_STATUS.APPROVED) {
      return {
        ok: false,
        code: 'invalid_from_status',
        message: `Cannot unapprove a timesheet in status "${timesheet.status}".`,
      };
    }
    return { ok: true, nextStatus: TIMESHEET_STATUS.DRAFT };
  }

  return { ok: false, code: 'unknown_action', message: `Unknown action: ${action}` };
}

/**
 * Return the subset of timesheets eligible for "Approve All Clean."
 *
 * Rules:
 *   - Status is `draft` or `pending_approval`.
 *   - The timesheet's exceptions list (parsed from `notes` upstream)
 *     contains zero block-severity entries.
 *
 * The caller passes a parallel `exceptionsByTimesheetId` map so the
 * helper stays pure and testable. Returns the full set of approvable
 * IDs (not the timesheet rows), so the caller can pass them straight
 * to a bulk-approve action.
 */
export function selectApprovableIds({ timesheets, exceptionsByTimesheetId }) {
  if (!Array.isArray(timesheets)) return [];
  const map = exceptionsByTimesheetId instanceof Map
    ? exceptionsByTimesheetId
    : new Map(Object.entries(exceptionsByTimesheetId || {}));
  const out = [];
  for (const ts of timesheets) {
    if (!ts || typeof ts.id !== 'string') continue;
    if (ts.status !== TIMESHEET_STATUS.DRAFT
        && ts.status !== TIMESHEET_STATUS.PENDING_APPROVAL) {
      continue;
    }
    const exceptions = map.get(ts.id) || [];
    const hasBlocker = exceptions.some((e) => e?.severity === 'block');
    if (!hasBlocker) out.push(ts.id);
  }
  return out;
}

/**
 * Evaluate whether a list of approved timesheets is eligible to be
 * batched into a payroll run + exported. Used by the "Generate Run"
 * action and the payroll-export-run edge function.
 *
 * Rules:
 *   - At least one timesheet.
 *   - Every timesheet must be in status `approved`. Already-exported
 *     ones are quietly excluded by the caller (via filtering before
 *     calling this); a status-machine error here means a mistake.
 *   - All timesheets share one `org_id`. Cross-tenant export is a
 *     hard fail — never export another org's data.
 *
 * Returns { ok, code, message, orgId? } so the edge function and the
 * frontend can render a precise error.
 */
export function evaluateExportEligibility({ timesheets }) {
  if (!Array.isArray(timesheets) || timesheets.length === 0) {
    return { ok: false, code: 'empty', message: 'No timesheets selected for export.' };
  }
  let orgId = null;
  for (const ts of timesheets) {
    if (!ts || typeof ts.id !== 'string') {
      return { ok: false, code: 'invalid_timesheet', message: 'Timesheet has no id.' };
    }
    if (ts.status !== TIMESHEET_STATUS.APPROVED) {
      return {
        ok: false,
        code: 'not_approved',
        message:
          `Timesheet ${ts.id} is in status "${ts.status}"; only "approved" timesheets can be `
            + 'exported. Approve first.',
      };
    }
    if (!ts.org_id) {
      return {
        ok: false,
        code: 'missing_org_id',
        message: `Timesheet ${ts.id} has no org_id; cannot validate tenancy.`,
      };
    }
    if (orgId == null) {
      orgId = ts.org_id;
    } else if (orgId !== ts.org_id) {
      // Cross-tenant guard: refuse to export a list spanning multiple
      // orgs. The edge function should have already validated each
      // org_id against the caller's JWT, but this is a second line of
      // defense in case a future caller bypasses that check.
      return {
        ok: false,
        code: 'mixed_org',
        message:
          'Refusing to export timesheets from multiple organizations in a single run. '
            + 'Caller must group exports by org_id.',
      };
    }
  }
  return { ok: true, orgId };
}
