// Invoicing storage — query layer for the Invoicing sub-tab.
//
// Phase 1 is read-only: this layer fetches the raw inputs the
// ThisWeekView needs to PREVIEW what an invoice run for the prior
// workweek would look like. No persistence yet — Phase 2 will add
// the cron + draft-invoice writes + approval helpers.
//
// Multi-tenancy: every query filters by `org_id` explicitly. The
// Phase B2b RLS policies are also in place, but the explicit filter
// is a second line of defense (and necessary today since the older
// permissive policies still grant in parallel until Phase B5).

import { supabase, isSupabaseConfigured } from '../../../lib/supabase';

// ─── Pay period helpers ──────────────────────────────────────────

/**
 * Compute the most recently COMPLETED Mon→Sun workweek in the org's
 * configured timezone, relative to `now`. Same shape as
 * payroll's priorWorkweek so a Wednesday-morning glance at Invoicing
 * shows the same period as Payroll.
 *
 * Returns { start, end } as YYYY-MM-DD strings.
 */
export function priorWorkweek(now = new Date(), timezone = 'America/Los_Angeles') {
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
  const weekdayShort = get('weekday');
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayShort);

  // Most recent Sunday strictly before today (if today IS Sunday,
  // still take the prior week's Sunday).
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

// ─── Read paths (Phase 1 read-only preview) ──────────────────────

/**
 * Fetch every completed shift in the period for the given org,
 * grouped (in memory) by client. Returns the data the Phase 1 preview
 * needs to render rate × hours per client without persisting anything.
 *
 * The query joins timesheet_shifts so we can read the per-shift
 * hour_classification (regular / overtime / double_time) the payroll
 * cron computed. Shifts without a matching timesheet_shifts row (e.g.,
 * caregiver hasn't been assigned to a timesheet yet) fall through with
 * everything classified as `regular` — the UI flags those rows so the
 * back office knows the preview will adjust once payroll runs Monday.
 *
 * Returns:
 *   {
 *     periodStart, periodEnd,
 *     clients: Array<{
 *       client: { id, first_name, last_name, ... rate config ... },
 *       lineItems: Array<{ shiftId, billable_rate, hours: {regular, overtime, doubleTime}, hasPayrollClassification }>,
 *     }>,
 *   }
 */
export async function getPeriodPreviewData({ orgId, periodStart, periodEnd }) {
  if (!isSupabaseConfigured() || !orgId || !periodStart || !periodEnd) {
    return { periodStart, periodEnd, clients: [] };
  }

  // Workweek window in UTC. The cron uses the org's tz when classifying
  // OT, so the timesheet_shifts row already has the correct in-week
  // hours per shift; here we only need to bound the shifts query by
  // a UTC window that's wide enough to catch every shift the cron
  // already attributed to the period. Using YYYY-MM-DD with a 24h
  // pad on each side covers any tz offset.
  const startBound = `${periodStart}T00:00:00.000Z`;
  // Add one day to periodEnd so the window includes Sunday's shifts.
  const endBound = (() => {
    const [y, m, d] = periodEnd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + 2)); // +2 days = Sunday + buffer
    return dt.toISOString();
  })();

  // Pull shifts in window with the timesheet_shifts hour split
  // joined in. We only consider completed shifts — open / cancelled /
  // no_show shifts aren't billable.
  const { data: shifts, error: shiftsError } = await supabase
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
        timesheet_id,
        hours_worked,
        hour_classification,
        timesheet:timesheets (
          id,
          org_id,
          pay_period_start
        )
      )
    `)
    .eq('org_id', orgId)
    .eq('status', 'completed')
    .gte('start_time', startBound)
    .lt('start_time', endBound)
    .order('start_time', { ascending: true });

  if (shiftsError) {
    console.error('[invoicing/storage] getPeriodPreviewData shifts query failed:', shiftsError.message);
    return { periodStart, periodEnd, clients: [] };
  }

  if (!Array.isArray(shifts) || shifts.length === 0) {
    return { periodStart, periodEnd, clients: [] };
  }

  // Filter timesheet_shifts links to ones that match this billing period
  // and same org. A caregiver shift can appear in multiple weeks'
  // timesheet_shifts (boundary-spanning shifts) — we want the row
  // whose timesheet is for THIS period.
  function pickPayrollSplitForPeriod(tsShifts) {
    if (!Array.isArray(tsShifts) || tsShifts.length === 0) return null;
    const match = tsShifts.find(
      (ts) => ts?.timesheet?.org_id === orgId
        && ts?.timesheet?.pay_period_start === periodStart,
    );
    if (match) return match;
    // Fall back to any timesheet_shifts row for this org if there's no
    // exact period match — better than treating everything as regular,
    // and the UI will flag the period mismatch in meta.
    return tsShifts.find((ts) => ts?.timesheet?.org_id === orgId) ?? null;
  }

  // Bucket by client_id.
  const byClientId = new Map();
  const clientIds = new Set();
  for (const shift of shifts) {
    if (!shift.client_id) continue;
    clientIds.add(shift.client_id);
    const split = pickPayrollSplitForPeriod(shift.timesheet_shifts);

    let regular = 0;
    let overtime = 0;
    let doubleTime = 0;
    let hasPayrollClassification = false;

    if (split) {
      hasPayrollClassification = true;
      const hrs = Number(split.hours_worked) || 0;
      switch (split.hour_classification) {
        case 'overtime':
          overtime = hrs;
          break;
        case 'double_time':
          doubleTime = hrs;
          break;
        case 'regular':
        default:
          regular = hrs;
          break;
      }
    } else {
      // No payroll split available — fall back to scheduled duration
      // and treat as regular. The UI surfaces this so the back office
      // knows the preview is provisional.
      const startMs = new Date(shift.start_time).getTime();
      const endMs = new Date(shift.end_time).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        regular = (endMs - startMs) / 3_600_000;
      }
    }

    if (regular + overtime + doubleTime <= 0) continue;

    if (!byClientId.has(shift.client_id)) {
      byClientId.set(shift.client_id, []);
    }
    byClientId.get(shift.client_id).push({
      shiftId: shift.id,
      billable_rate: shift.billable_rate != null ? Number(shift.billable_rate) : null,
      hours: { regular, overtime, doubleTime },
      hasPayrollClassification,
      shiftStart: shift.start_time,
      shiftEnd: shift.end_time,
      assignedCaregiverId: shift.assigned_caregiver_id,
    });
  }

  if (byClientId.size === 0) {
    return { periodStart, periodEnd, clients: [] };
  }

  // Fetch the client records for the rate config + display info.
  const { data: clientRows, error: clientsError } = await supabase
    .from('clients')
    .select('id, first_name, last_name, address, city, state, zip, default_billable_rate, default_billable_ot_rate, payer_type, archived')
    .in('id', Array.from(clientIds));

  if (clientsError) {
    console.error('[invoicing/storage] getPeriodPreviewData clients query failed:', clientsError.message);
    return { periodStart, periodEnd, clients: [] };
  }

  const clientsMap = new Map();
  for (const row of clientRows ?? []) {
    clientsMap.set(row.id, {
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      address: row.address,
      city: row.city,
      state: row.state,
      zip: row.zip,
      default_billable_rate: row.default_billable_rate != null
        ? Number(row.default_billable_rate)
        : null,
      default_billable_ot_rate: row.default_billable_ot_rate != null
        ? Number(row.default_billable_ot_rate)
        : null,
      payer_type: row.payer_type,
      archived: row.archived === true,
    });
  }

  const out = [];
  for (const [clientId, lineItems] of byClientId) {
    const c = clientsMap.get(clientId);
    if (!c) continue; // Defensive: a shift orphaned from its client row.
    out.push({ client: c, lineItems });
  }

  // Stable rendering order: alphabetical by last name then first name.
  out.sort((a, b) => {
    const an = `${a.client.last_name || ''} ${a.client.first_name || ''}`.trim().toLowerCase();
    const bn = `${b.client.last_name || ''} ${b.client.first_name || ''}`.trim().toLowerCase();
    return an.localeCompare(bn);
  });

  return { periodStart, periodEnd, clients: out };
}
