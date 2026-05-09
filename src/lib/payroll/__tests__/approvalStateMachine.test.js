import { describe, it, expect } from 'vitest';
import {
  canTransition,
  canTransitionPayrollRun,
  evaluateApprovalAction,
  evaluateExportEligibility,
  evaluateMarkAsPaidAction,
  PAYROLL_RUN_STATUS,
  selectApprovableIds,
  TIMESHEET_STATUS,
} from '../approvalStateMachine.js';

// ─── canTransition ─────────────────────────────────────────────────

describe('canTransition', () => {
  it('allows draft → approved', () => {
    expect(canTransition(TIMESHEET_STATUS.DRAFT, TIMESHEET_STATUS.APPROVED)).toBe(true);
  });

  it('allows draft → blocked', () => {
    expect(canTransition(TIMESHEET_STATUS.DRAFT, TIMESHEET_STATUS.BLOCKED)).toBe(true);
  });

  it('allows approved → exported', () => {
    expect(canTransition(TIMESHEET_STATUS.APPROVED, TIMESHEET_STATUS.EXPORTED)).toBe(true);
  });

  it('allows approved → draft (unapprove)', () => {
    expect(canTransition(TIMESHEET_STATUS.APPROVED, TIMESHEET_STATUS.DRAFT)).toBe(true);
  });

  it('allows blocked → draft (after exception cleared)', () => {
    expect(canTransition(TIMESHEET_STATUS.BLOCKED, TIMESHEET_STATUS.DRAFT)).toBe(true);
  });

  it('allows exported → paid (Phase 4 manual mark-as-paid)', () => {
    expect(canTransition(TIMESHEET_STATUS.EXPORTED, TIMESHEET_STATUS.PAID)).toBe(true);
  });

  it('allows submitted → paid (Phase 5 webhook)', () => {
    expect(canTransition(TIMESHEET_STATUS.SUBMITTED, TIMESHEET_STATUS.PAID)).toBe(true);
  });

  it('allows rejected → draft (un-reject for editing)', () => {
    expect(canTransition(TIMESHEET_STATUS.REJECTED, TIMESHEET_STATUS.DRAFT)).toBe(true);
  });

  it('rejects paid → anything (terminal status)', () => {
    expect(canTransition(TIMESHEET_STATUS.PAID, TIMESHEET_STATUS.DRAFT)).toBe(false);
    expect(canTransition(TIMESHEET_STATUS.PAID, TIMESHEET_STATUS.APPROVED)).toBe(false);
    expect(canTransition(TIMESHEET_STATUS.PAID, TIMESHEET_STATUS.EXPORTED)).toBe(false);
  });

  it('rejects illegal forward jumps (draft → exported)', () => {
    expect(canTransition(TIMESHEET_STATUS.DRAFT, TIMESHEET_STATUS.EXPORTED)).toBe(false);
    expect(canTransition(TIMESHEET_STATUS.DRAFT, TIMESHEET_STATUS.PAID)).toBe(false);
  });

  it('rejects identity transitions (X → X)', () => {
    for (const s of Object.values(TIMESHEET_STATUS)) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it('rejects unknown statuses', () => {
    expect(canTransition('frobnicated', TIMESHEET_STATUS.APPROVED)).toBe(false);
    expect(canTransition(TIMESHEET_STATUS.DRAFT, 'frobnicated')).toBe(false);
    expect(canTransition(null, null)).toBe(false);
  });

  it('rejects exported → submitted as a non-skip path (kept legal anyway for Phase 5 future)', () => {
    // Exported → submitted IS legal (Phase 5 will export-then-submit
    // a CSV-mode run). Document that here so the test acts as a
    // reminder when Phase 5 lands.
    expect(canTransition(TIMESHEET_STATUS.EXPORTED, TIMESHEET_STATUS.SUBMITTED)).toBe(true);
  });
});

// ─── evaluateApprovalAction ────────────────────────────────────────

describe('evaluateApprovalAction — approve', () => {
  it('allows approving a clean draft', () => {
    const r = evaluateApprovalAction({
      timesheet: { status: 'draft' },
      action: 'approve',
      exceptions: [],
    });
    expect(r.ok).toBe(true);
    expect(r.nextStatus).toBe(TIMESHEET_STATUS.APPROVED);
  });

  it('allows approving a clean pending_approval', () => {
    const r = evaluateApprovalAction({
      timesheet: { status: 'pending_approval' },
      action: 'approve',
      exceptions: [],
    });
    expect(r.ok).toBe(true);
  });

  it('allows approving a draft with warn-only exceptions', () => {
    const r = evaluateApprovalAction({
      timesheet: { status: 'draft' },
      action: 'approve',
      exceptions: [{ severity: 'warn', code: 'shift_too_long' }],
    });
    expect(r.ok).toBe(true);
  });

  it('refuses to approve when block exceptions remain', () => {
    const r = evaluateApprovalAction({
      timesheet: { status: 'draft' },
      action: 'approve',
      exceptions: [
        { severity: 'block', code: 'caregiver_missing_paychex_employee_id' },
        { severity: 'warn', code: 'out_of_geofence' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('blocked_by_exceptions');
    expect(r.blocking_codes).toEqual(['caregiver_missing_paychex_employee_id']);
  });

  it('refuses to approve a paid or exported timesheet', () => {
    const r1 = evaluateApprovalAction({
      timesheet: { status: 'paid' },
      action: 'approve',
    });
    expect(r1.ok).toBe(false);
    expect(r1.code).toBe('invalid_from_status');

    const r2 = evaluateApprovalAction({
      timesheet: { status: 'exported' },
      action: 'approve',
    });
    expect(r2.ok).toBe(false);
  });

  it('refuses to approve a blocked timesheet (must be regenerated first)', () => {
    const r = evaluateApprovalAction({
      timesheet: { status: 'blocked' },
      action: 'approve',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_from_status');
  });

  it('refuses double-approval', () => {
    const r = evaluateApprovalAction({
      timesheet: { status: 'approved' },
      action: 'approve',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('already_approved');
  });
});

describe('evaluateApprovalAction — unapprove', () => {
  it('allows unapproving an approved timesheet', () => {
    const r = evaluateApprovalAction({
      timesheet: { status: 'approved' },
      action: 'unapprove',
    });
    expect(r.ok).toBe(true);
    expect(r.nextStatus).toBe(TIMESHEET_STATUS.DRAFT);
  });

  it('refuses to unapprove an exported (already submitted) timesheet', () => {
    const r = evaluateApprovalAction({
      timesheet: { status: 'exported' },
      action: 'unapprove',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_from_status');
  });

  it('refuses to unapprove a draft', () => {
    const r = evaluateApprovalAction({
      timesheet: { status: 'draft' },
      action: 'unapprove',
    });
    expect(r.ok).toBe(false);
  });
});

describe('evaluateApprovalAction — argument validation', () => {
  it('rejects missing timesheet', () => {
    const r = evaluateApprovalAction({ action: 'approve' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_timesheet');
  });

  it('rejects unknown action', () => {
    const r = evaluateApprovalAction({
      timesheet: { status: 'draft' },
      action: 'frobnicate',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('unknown_action');
  });
});

// ─── selectApprovableIds ────────────────────────────────────────

describe('selectApprovableIds', () => {
  it('returns ids of clean draft + pending_approval timesheets', () => {
    const tss = [
      { id: 't1', status: 'draft' },
      { id: 't2', status: 'pending_approval' },
      { id: 't3', status: 'draft' },
    ];
    const ex = new Map([
      ['t1', []],
      ['t2', [{ severity: 'warn', code: 'out_of_geofence' }]],
      ['t3', []],
    ]);
    const result = selectApprovableIds({ timesheets: tss, exceptionsByTimesheetId: ex });
    expect(result.sort()).toEqual(['t1', 't2', 't3']);
  });

  it('excludes timesheets with block-severity exceptions', () => {
    const tss = [
      { id: 't1', status: 'draft' },
      { id: 't2', status: 'draft' },
    ];
    const ex = new Map([
      ['t1', [{ severity: 'block', code: 'missing_clock_out' }]],
      ['t2', []],
    ]);
    const result = selectApprovableIds({ timesheets: tss, exceptionsByTimesheetId: ex });
    expect(result).toEqual(['t2']);
  });

  it('excludes already-approved / exported / blocked rows', () => {
    const tss = [
      { id: 't1', status: 'approved' },
      { id: 't2', status: 'exported' },
      { id: 't3', status: 'blocked' },
      { id: 't4', status: 'paid' },
      { id: 't5', status: 'draft' },
    ];
    const ex = new Map([['t5', []]]);
    const result = selectApprovableIds({ timesheets: tss, exceptionsByTimesheetId: ex });
    expect(result).toEqual(['t5']);
  });

  it('accepts a plain object instead of a Map for exceptionsByTimesheetId', () => {
    const tss = [
      { id: 't1', status: 'draft' },
      { id: 't2', status: 'draft' },
    ];
    const ex = { t1: [{ severity: 'block' }], t2: [] };
    const result = selectApprovableIds({ timesheets: tss, exceptionsByTimesheetId: ex });
    expect(result).toEqual(['t2']);
  });

  it('handles missing / non-array inputs gracefully', () => {
    expect(selectApprovableIds({ timesheets: null })).toEqual([]);
    expect(selectApprovableIds({})).toEqual([]);
  });
});

// ─── evaluateExportEligibility ──────────────────────────────────

describe('evaluateExportEligibility', () => {
  it('accepts a single approved timesheet from one org', () => {
    const r = evaluateExportEligibility({
      timesheets: [{ id: 't1', status: 'approved', org_id: 'org_a' }],
    });
    expect(r.ok).toBe(true);
    expect(r.orgId).toBe('org_a');
  });

  it('accepts many approved timesheets sharing one org', () => {
    const r = evaluateExportEligibility({
      timesheets: [
        { id: 't1', status: 'approved', org_id: 'org_a' },
        { id: 't2', status: 'approved', org_id: 'org_a' },
        { id: 't3', status: 'approved', org_id: 'org_a' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.orgId).toBe('org_a');
  });

  it('refuses an empty list', () => {
    const r = evaluateExportEligibility({ timesheets: [] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('empty');
  });

  it('refuses a non-array input', () => {
    const r = evaluateExportEligibility({ timesheets: null });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('empty');
  });

  it('refuses a list containing a non-approved timesheet', () => {
    const r = evaluateExportEligibility({
      timesheets: [
        { id: 't1', status: 'approved', org_id: 'org_a' },
        { id: 't2', status: 'draft', org_id: 'org_a' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_approved');
    expect(r.message).toContain('t2');
  });

  it('refuses to mix orgs (cross-tenant guard)', () => {
    const r = evaluateExportEligibility({
      timesheets: [
        { id: 't1', status: 'approved', org_id: 'org_a' },
        { id: 't2', status: 'approved', org_id: 'org_b' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('mixed_org');
  });

  it('refuses a timesheet with no org_id (cannot validate tenancy)', () => {
    const r = evaluateExportEligibility({
      timesheets: [{ id: 't1', status: 'approved' }],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('missing_org_id');
  });
});

// ─── canTransitionPayrollRun (Phase 4 PR #3) ───────────────────────

describe('canTransitionPayrollRun', () => {
  it('allows exported → completed (Mark as Paid)', () => {
    expect(canTransitionPayrollRun(PAYROLL_RUN_STATUS.EXPORTED, PAYROLL_RUN_STATUS.COMPLETED)).toBe(true);
  });

  it('allows submitted → completed (Phase 5 webhook path)', () => {
    expect(canTransitionPayrollRun(PAYROLL_RUN_STATUS.SUBMITTED, PAYROLL_RUN_STATUS.COMPLETED)).toBe(true);
  });

  it('allows exported → failed (something went wrong post-export)', () => {
    expect(canTransitionPayrollRun(PAYROLL_RUN_STATUS.EXPORTED, PAYROLL_RUN_STATUS.FAILED)).toBe(true);
  });

  it('allows failed → exported (re-export after fix)', () => {
    expect(canTransitionPayrollRun(PAYROLL_RUN_STATUS.FAILED, PAYROLL_RUN_STATUS.EXPORTED)).toBe(true);
  });

  it('refuses completed → anything (terminal)', () => {
    for (const s of Object.values(PAYROLL_RUN_STATUS)) {
      expect(canTransitionPayrollRun(PAYROLL_RUN_STATUS.COMPLETED, s)).toBe(false);
    }
  });

  it('refuses draft → completed (must export first)', () => {
    expect(canTransitionPayrollRun(PAYROLL_RUN_STATUS.DRAFT, PAYROLL_RUN_STATUS.COMPLETED)).toBe(false);
  });

  it('rejects unknown statuses', () => {
    expect(canTransitionPayrollRun('frobnicated', PAYROLL_RUN_STATUS.COMPLETED)).toBe(false);
    expect(canTransitionPayrollRun(PAYROLL_RUN_STATUS.EXPORTED, 'frobnicated')).toBe(false);
  });
});

// ─── evaluateMarkAsPaidAction (Phase 4 PR #3) ──────────────────────

describe('evaluateMarkAsPaidAction', () => {
  // Use a date well in the past so the "in the future" guard doesn't
  // interfere with status-machine testing.
  const PAST_PAID_DATE = '2026-01-01';

  it('allows marking an exported run as paid with a valid past date', () => {
    const r = evaluateMarkAsPaidAction({
      run: { status: 'exported' },
      paidDate: PAST_PAID_DATE,
    });
    expect(r.ok).toBe(true);
    expect(r.nextStatus).toBe(PAYROLL_RUN_STATUS.COMPLETED);
  });

  it('allows marking a submitted run as paid (Phase 5 alt path)', () => {
    const r = evaluateMarkAsPaidAction({
      run: { status: 'submitted' },
      paidDate: PAST_PAID_DATE,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses to mark a draft run as paid', () => {
    const r = evaluateMarkAsPaidAction({
      run: { status: 'draft' },
      paidDate: PAST_PAID_DATE,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_from_status');
  });

  it('refuses to re-mark an already-completed run', () => {
    const r = evaluateMarkAsPaidAction({
      run: { status: 'completed' },
      paidDate: PAST_PAID_DATE,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_from_status');
  });

  it('refuses a run with no status', () => {
    const r = evaluateMarkAsPaidAction({ run: {}, paidDate: PAST_PAID_DATE });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_run');
  });

  it('refuses an invalid paid_date format', () => {
    const r = evaluateMarkAsPaidAction({
      run: { status: 'exported' },
      paidDate: '04/30/2026',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_paid_date');
  });

  it('refuses a missing paid_date', () => {
    const r = evaluateMarkAsPaidAction({
      run: { status: 'exported' },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_paid_date');
  });

  it('refuses a paid_date in the future (typo guard)', () => {
    const r = evaluateMarkAsPaidAction({
      run: { status: 'exported' },
      paidDate: '2099-12-31',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('paid_date_in_future');
  });
});
