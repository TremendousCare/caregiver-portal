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
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  exportedAt: row.exported_at,
  submittedAt: row.submitted_at,
  paychexCheckId: row.paychex_check_id,
  blockReason: row.block_reason,
  notes: row.notes,
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
