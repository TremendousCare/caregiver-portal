// Accounting storage — thin wrappers around the timesheets +
// timesheet_shifts tables created in Phase 1 and populated by Phase 3's
// payroll-generate-timesheets cron.
//
// Phase 4 PR #1 is read-only: this layer fetches drafts to render in
// ThisWeekView. PR #2 will add update/approve/regenerate paths.
//
// Multi-tenancy: every query filters by `org_id`. Until Phase B
// tightens RLS on these tables (already in place per Phase 1's
// create_timesheets.sql), the explicit filter is the second line of
// defense.

import { supabase, isSupabaseConfigured } from '../../lib/supabase';

// ─── Mappers (DB snake_case → app camelCase) ──────────────────────

export const dbToTimesheet = (row) => ({
  id: row.id,
  orgId: row.org_id,
  caregiverId: row.caregiver_id,
  payPeriodStart: row.pay_period_start,
  payPeriodEnd: row.pay_period_end,
  status: row.status,
  regularHours: row.regular_hours != null ? Number(row.regular_hours) : 0,
  overtimeHours: row.overtime_hours != null ? Number(row.overtime_hours) : 0,
  doubleTimeHours: row.double_time_hours != null ? Number(row.double_time_hours) : 0,
  mileageTotal: row.mileage_total != null ? Number(row.mileage_total) : 0,
  mileageReimbursement: row.mileage_reimbursement != null ? Number(row.mileage_reimbursement) : 0,
  grossPay: row.gross_pay != null ? Number(row.gross_pay) : 0,
  // Phase 4 PR #2: per-shift-rate aggregation + CA weighted ROP. Used
  // by the export function and by the per-row "rate breakdown"
  // popover in ThisWeekView. Null on pre-PR-2 drafts; UI falls back
  // to a single rate inferred from the underlying shifts in that case.
  regularByRate: Array.isArray(row.regular_by_rate)
    ? row.regular_by_rate.map((r) => ({
        rate: Number(r?.rate),
        hours: Number(r?.hours),
      }))
    : null,
  regularRateOfPay: row.regular_rate_of_pay != null
    ? Number(row.regular_rate_of_pay)
    : null,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  exportedAt: row.exported_at,
  submittedAt: row.submitted_at,
  paychexCheckId: row.paychex_check_id,
  blockReason: row.block_reason,
  notes: row.notes,
  // Phase 4 PR #2 inline-edit audit columns.
  lastEditedBy: row.last_edited_by ?? null,
  lastEditedAt: row.last_edited_at ?? null,
  lastEditReason: row.last_edit_reason ?? null,
  createdAt: row.created_at,
});

export const dbToTimesheetShift = (row) => ({
  timesheetId: row.timesheet_id,
  shiftId: row.shift_id,
  hoursWorked: row.hours_worked != null ? Number(row.hours_worked) : 0,
  hourClassification: row.hour_classification,
  mileage: row.mileage != null ? Number(row.mileage) : 0,
});

// ─── Pay period helpers ──────────────────────────────────────────

/**
 * Compute the most recently COMPLETED Mon→Sun workweek in
 * America/Los_Angeles, relative to `now`. Mirrors the cron's logic
 * in supabase/functions/payroll-generate-timesheets/index.ts so the
 * UI's "This Week" matches whatever the cron most recently produced.
 *
 * Returns { start, end } as YYYY-MM-DD strings.
 */
export function priorWorkweek(now = new Date(), timezone = 'America/Los_Angeles') {
  // Use Intl to extract the wall-clock weekday in the target tz.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const weekdayShort = get('weekday'); // Mon, Tue, ..., Sun
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayShort);

  // Most recent Sunday strictly before today (if today IS Sunday,
  // still take the prior week's Sunday — same convention as the cron).
  const daysBackToSunday = dayOfWeek === 0 ? 7 : dayOfWeek;
  const sunday = new Date(Date.UTC(year, month - 1, day - daysBackToSunday));
  const monday = new Date(Date.UTC(
    sunday.getUTCFullYear(),
    sunday.getUTCMonth(),
    sunday.getUTCDate() - 6,
  ));

  const fmtIso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

  return { start: fmtIso(monday), end: fmtIso(sunday) };
}

// ─── Queries ──────────────────────────────────────────────────────

/**
 * Fetch all timesheets for a given org + pay period start, with their
 * line items (timesheet_shifts) joined in. Sorted by caregiver-id for
 * stable rendering.
 *
 * Returns Array<{ timesheet, shifts }>.
 */
export async function getTimesheetsForPeriod({ orgId, payPeriodStart }) {
  if (!isSupabaseConfigured() || !orgId || !payPeriodStart) return [];

  const { data, error } = await supabase
    .from('timesheets')
    .select('*, timesheet_shifts(*)')
    .eq('org_id', orgId)
    .eq('pay_period_start', payPeriodStart)
    .order('caregiver_id', { ascending: true });

  if (error) {
    console.error('[accounting/storage] getTimesheetsForPeriod failed:', error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    timesheet: dbToTimesheet(row),
    shifts: (row.timesheet_shifts ?? []).map(dbToTimesheetShift),
  }));
}

/**
 * Fetch full shift records for a list of shift_ids so the
 * expand panel can show clock-in/out times, hourly_rate, and mileage
 * inline. Org-scoped.
 *
 * Returns Map<shiftId, { id, startTime, endTime, hourlyRate, mileage,
 * status }>.
 */
export async function getShiftDetails({ orgId, shiftIds }) {
  if (!isSupabaseConfigured() || !orgId || !Array.isArray(shiftIds) || shiftIds.length === 0) {
    return new Map();
  }
  const { data, error } = await supabase
    .from('shifts')
    .select('id, start_time, end_time, hourly_rate, mileage, status')
    .eq('org_id', orgId)
    .in('id', shiftIds);
  if (error) {
    console.error('[accounting/storage] getShiftDetails failed:', error.message);
    return new Map();
  }
  const map = new Map();
  for (const row of data ?? []) {
    map.set(row.id, {
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time,
      hourlyRate: row.hourly_rate != null ? Number(row.hourly_rate) : null,
      mileage: row.mileage != null ? Number(row.mileage) : 0,
      status: row.status,
    });
  }
  return map;
}

/**
 * Fetch the caregiver records referenced by the given timesheets so
 * the UI can render names + Paychex sync state.
 *
 * Returns a Map<caregiverId, { id, firstName, lastName, paychexWorkerId,
 * paychexEmployeeId, paychexSyncStatus }>.
 */
export async function getCaregiverDescriptors(caregiverIds) {
  if (!isSupabaseConfigured() || !Array.isArray(caregiverIds) || caregiverIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from('caregivers')
    .select('id, first_name, last_name, paychex_worker_id, paychex_employee_id, paychex_sync_status')
    .in('id', caregiverIds);

  if (error) {
    console.error('[accounting/storage] getCaregiverDescriptors failed:', error.message);
    return new Map();
  }

  const map = new Map();
  for (const row of data ?? []) {
    map.set(row.id, {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      paychexWorkerId: row.paychex_worker_id,
      paychexEmployeeId: row.paychex_employee_id,
      paychexSyncStatus: row.paychex_sync_status,
    });
  }
  return map;
}

/**
 * Parse the JSON-encoded exception array out of `timesheets.notes`.
 * Phase 3's cron writes the array as `{ exceptions: [...] }` so the
 * Phase 4 UI can surface them. Returns [] for any parse failure.
 */
export function parseExceptionsFromNotes(notes) {
  if (!notes || typeof notes !== 'string') return [];
  try {
    const parsed = JSON.parse(notes);
    return Array.isArray(parsed?.exceptions) ? parsed.exceptions : [];
  } catch {
    return [];
  }
}

// ─── Edge function invocations (Phase 4 PR #2) ───────────────────
//
// Each helper wraps a single call to one of the payroll-* edge
// functions. Errors bubble up as thrown Errors with a usable message
// so the UI can `try/catch` and toast.

async function invokeOrThrow(functionName, body) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured.');
  }
  const { data, error } = await supabase.functions.invoke(functionName, { body });
  if (error) {
    // supabase-js wraps the response in a FunctionError that doesn't
    // always carry the JSON body. Try to pull the original message.
    const message = error?.context?.responseJson?.error
      || error?.message
      || 'Unknown error';
    throw new Error(message);
  }
  if (data && data.ok === false) {
    throw new Error(data.error || 'Action failed.');
  }
  return data;
}

export function approveTimesheet(timesheetId) {
  return invokeOrThrow('payroll-timesheet-actions', {
    action: 'approve',
    timesheet_id: timesheetId,
  });
}

export function approveTimesheetsBulk(timesheetIds) {
  return invokeOrThrow('payroll-timesheet-actions', {
    action: 'approve_bulk',
    timesheet_ids: timesheetIds,
  });
}

export function unapproveTimesheet(timesheetId) {
  return invokeOrThrow('payroll-timesheet-actions', {
    action: 'unapprove',
    timesheet_id: timesheetId,
  });
}

export function editTimesheetTotals({ timesheetId, edits, reason }) {
  return invokeOrThrow('payroll-timesheet-actions', {
    action: 'edit_timesheet',
    timesheet_id: timesheetId,
    edits,
    reason,
  });
}

export function editShiftRate({ timesheetId, shiftId, hourlyRate, reason }) {
  return invokeOrThrow('payroll-timesheet-actions', {
    action: 'edit_shift_rate',
    timesheet_id: timesheetId,
    shift_id: shiftId,
    hourly_rate: hourlyRate,
    reason,
  });
}

export function editShiftMileage({ timesheetId, shiftId, mileage, reason }) {
  return invokeOrThrow('payroll-timesheet-actions', {
    action: 'edit_shift_mileage',
    timesheet_id: timesheetId,
    shift_id: shiftId,
    mileage,
    reason,
  });
}

export function regenerateTimesheet({ timesheetId, reason }) {
  return invokeOrThrow('payroll-regenerate-timesheet', {
    timesheet_id: timesheetId,
    reason: reason || '',
  });
}

export function exportPayrollRun({ timesheetIds, payDate, dryRun = false }) {
  return invokeOrThrow('payroll-export-run', {
    timesheet_ids: timesheetIds,
    pay_date: payDate,
    dry_run: dryRun,
  });
}
