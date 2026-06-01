// Financials storage — query layer for the owner-only Financials sub-tab.
//
// Fetches and NORMALIZES the raw inputs the dashboard needs; all math
// lives in src/lib/financials/financialsMetrics.js. Read-only — this tab
// never writes.
//
// Multi-tenancy: every query filters by `org_id` explicitly (Phase B
// added org_id to shifts / clients / caregivers). The explicit filter is
// a second line of defense alongside RLS.
//
// Hours basis: like invoicing/storage.js, we read the payroll-computed
// per-shift hour_classification from timesheet_shifts when available, and
// fall back to the scheduled shift duration (treated as regular) when the
// payroll cron hasn't run for that shift yet. The normalized shift carries
// `hasPayrollClassification` so the UI can flag provisional figures.

import { supabase, isSupabaseConfigured } from '../../../lib/supabase';

/**
 * Fetch completed shifts in [start, end] (inclusive of end day) for the
 * org, normalized for the metrics layer.
 *
 * @returns {Promise<Array<{
 *   shiftId, clientId, caregiverId, startTime,
 *   hours: { regular, overtime, doubleTime },
 *   billableRate, payRate, hasPayrollClassification,
 * }>>}
 */
export async function fetchCompletedShifts({ orgId, start, end }) {
  if (!isSupabaseConfigured() || !orgId || !start || !end) return [];

  // UTC window with a day of padding on the trailing edge so we capture
  // shifts that start late on the end date in the org's local timezone.
  const startBound = `${start}T00:00:00.000Z`;
  const endBound = (() => {
    const [y, m, d] = end.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString();
  })();

  const { data: shifts, error } = await supabase
    .from('shifts')
    .select(`
      id,
      client_id,
      assigned_caregiver_id,
      start_time,
      end_time,
      status,
      hourly_rate,
      billable_rate,
      timesheet_shifts (
        hours_worked,
        hour_classification,
        timesheet:timesheets ( org_id )
      )
    `)
    .eq('org_id', orgId)
    .eq('status', 'completed')
    .gte('start_time', startBound)
    .lt('start_time', endBound)
    .order('start_time', { ascending: true });

  if (error) {
    console.error('[financials/storage] fetchCompletedShifts failed:', error.message);
    return [];
  }

  const out = [];
  for (const shift of shifts ?? []) {
    const split = pickPayrollSplit(shift.timesheet_shifts, orgId);
    let regular = 0;
    let overtime = 0;
    let doubleTime = 0;
    let hasPayrollClassification = false;

    if (split) {
      hasPayrollClassification = true;
      const hrs = Number(split.hours_worked) || 0;
      switch (split.hour_classification) {
        case 'overtime': overtime = hrs; break;
        case 'double_time': doubleTime = hrs; break;
        case 'regular':
        default: regular = hrs; break;
      }
    } else {
      const startMs = new Date(shift.start_time).getTime();
      const endMs = new Date(shift.end_time).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        regular = (endMs - startMs) / 3_600_000;
      }
    }

    if (regular + overtime + doubleTime <= 0) continue;

    out.push({
      shiftId: shift.id,
      clientId: shift.client_id,
      caregiverId: shift.assigned_caregiver_id,
      startTime: shift.start_time,
      hours: { regular, overtime, doubleTime },
      billableRate: shift.billable_rate != null ? Number(shift.billable_rate) : null,
      payRate: shift.hourly_rate != null ? Number(shift.hourly_rate) : null,
      hasPayrollClassification,
    });
  }
  return out;
}

// A boundary-spanning shift can appear in multiple timesheet_shifts rows.
// Any row for THIS org is fine for classification purposes here (we are
// not period-splitting — the metrics layer aggregates across the whole
// selected range).
function pickPayrollSplit(tsShifts, orgId) {
  if (!Array.isArray(tsShifts) || tsShifts.length === 0) return null;
  return tsShifts.find((ts) => ts?.timesheet?.org_id === orgId) ?? tsShifts[0] ?? null;
}

/**
 * Fetch rate-config + display rows for the given client and caregiver
 * ids, keyed by id for O(1) lookup in the metrics layer.
 *
 * @returns {Promise<{ clientsById: Map, caregiversById: Map }>}
 */
export async function fetchRateConfig({ orgId, clientIds, caregiverIds }) {
  const clientsById = new Map();
  const caregiversById = new Map();
  if (!isSupabaseConfigured() || !orgId) return { clientsById, caregiversById };

  const cIds = Array.from(new Set((clientIds ?? []).filter(Boolean)));
  const gIds = Array.from(new Set((caregiverIds ?? []).filter(Boolean)));

  if (cIds.length > 0) {
    const { data, error } = await supabase
      .from('clients')
      .select('id, first_name, last_name, phase, archived, default_billable_rate, default_billable_ot_rate')
      .eq('org_id', orgId)
      .in('id', cIds);
    if (error) {
      console.error('[financials/storage] fetchRateConfig clients failed:', error.message);
    } else {
      for (const row of data ?? []) clientsById.set(row.id, normalizeClient(row));
    }
  }

  if (gIds.length > 0) {
    const { data, error } = await supabase
      .from('caregivers')
      .select('id, first_name, last_name, employment_status, archived, default_pay_rate')
      .eq('org_id', orgId)
      .in('id', gIds);
    if (error) {
      console.error('[financials/storage] fetchRateConfig caregivers failed:', error.message);
    } else {
      for (const row of data ?? []) caregiversById.set(row.id, normalizeCaregiver(row));
    }
  }

  return { clientsById, caregiversById };
}

/**
 * Org-wide active counts (independent of the selected period). "Active"
 * uses the same conventions as financialsMetrics' predicates.
 *
 * @returns {Promise<{ activeClients: number, activeCaregivers: number }>}
 */
export async function fetchActiveCounts({ orgId }) {
  if (!isSupabaseConfigured() || !orgId) return { activeClients: 0, activeCaregivers: 0 };

  const [clientsRes, caregiversRes] = await Promise.all([
    supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('archived', false)
      .eq('phase', 'active'),
    supabase
      .from('caregivers')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('archived', false)
      .in('employment_status', ['active', 'onboarding']),
  ]);

  if (clientsRes.error) {
    console.error('[financials/storage] fetchActiveCounts clients failed:', clientsRes.error.message);
  }
  if (caregiversRes.error) {
    console.error('[financials/storage] fetchActiveCounts caregivers failed:', caregiversRes.error.message);
  }

  return {
    activeClients: clientsRes.count ?? 0,
    activeCaregivers: caregiversRes.count ?? 0,
  };
}

function normalizeClient(row) {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    phase: row.phase,
    archived: row.archived === true,
    default_billable_rate: row.default_billable_rate != null ? Number(row.default_billable_rate) : null,
    default_billable_ot_rate: row.default_billable_ot_rate != null ? Number(row.default_billable_ot_rate) : null,
  };
}

function normalizeCaregiver(row) {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    employment_status: row.employment_status,
    archived: row.archived === true,
    default_pay_rate: row.default_pay_rate != null ? Number(row.default_pay_rate) : null,
  };
}
