// ─── Payroll: weekly timesheet generation cron ───
//
// Runs Monday 06:00 America/Los_Angeles every week (registered in
// supabase/migrations/20260426000000_payroll_generate_timesheets_cron.sql).
// For every organization that has `settings.features_enabled.payroll`
// turned on, generates draft `timesheets` rows + `timesheet_shifts`
// junction rows for the most recently completed Mon→Sun workweek.
//
// What this function does NOT do:
//   - Call Paychex. Phase 5 (direct API submission) is gated on the
//     Paychex Payroll & Check API scope; this function is purely
//     internal and runs whether or not Paychex is reachable.
//   - Approve, export, or submit anything. Drafts wait for Phase 4's
//     Approval UI.
//   - Mutate `caregivers.paychex_*` fields. Worker sync (Phase 2)
//     owns those.
//
// Idempotency: a UNIQUE (org_id, caregiver_id, pay_period_start)
// constraint on `timesheets` plus a lookup-before-insert per caregiver
// makes re-running safe. If a draft already exists for the target
// week, the function skips that caregiver.
//
// Multi-tenancy:
//   - Iterates `organizations` rows where the payroll feature flag is
//     on. Per directive 4 + 9 in CLAUDE.md, every fetch is filtered by
//     `org_id` and per-org cron iteration is mandatory.
//   - When Phase B adds `org_id` to `caregivers`, `shifts`, and
//     `clock_events`, the per-caregiver fetch below tightens to also
//     filter by `org_id`. Until then, the cron uses caregivers' shift
//     assignments as the join — TC is the only org so cross-tenant
//     reads are not yet possible.
//
// Manual triggering: a service-role caller can POST a body with
// `{ org_id?: string, pay_period_start?: 'YYYY-MM-DD', dry_run?: boolean }`
// to limit the run to a specific org/week or to preview without
// persisting. The cron itself POSTs `{}`.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   ("Phase 3 — Timesheet generation and overtime engine").

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Cross-tree imports: the canonical implementations live under src/
// so vitest can exercise them without Deno globals. Supabase's deploy
// bundler resolves relative paths outside the function dir.
import { buildTimesheet } from "../../../src/lib/payroll/timesheetBuilder.js";
import {
  detectExceptions,
  hasBlockingExceptions,
  summarizeBlockReason,
} from "../../../src/lib/payroll/exceptions.js";
import {
  utcMsToWallClockParts,
  wallClockToUtcMs,
} from "../../../src/lib/scheduling/timezone.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Domain types ──────────────────────────────────────────────────

interface OrgRow {
  id: string;
  slug: string;
  settings: Record<string, unknown> | null;
}

interface ShiftRow {
  id: string;
  assigned_caregiver_id: string | null;
  start_time: string;
  end_time: string;
  status: string;
  hourly_rate: number | null;
  mileage: number | null;
}

interface ClockEventRow {
  shift_id: string;
  caregiver_id: string;
  event_type: "in" | "out";
  occurred_at: string;
  geofence_passed: boolean | null;
}

interface CaregiverRow {
  id: string;
  paychex_worker_id: string | null;
  paychex_employee_id: string | null;
  paychex_sync_status: string | null;
}

interface OrgResult {
  org_id: string;
  org_slug: string;
  pay_period_start: string;
  pay_period_end: string;
  caregivers_considered: number;
  timesheets_inserted: number;
  timesheets_skipped_existing: number;
  timesheets_skipped_empty: number;
  timesheets_blocked: number;
  errors: Array<{ caregiver_id: string; message: string }>;
}

// ─── Workweek calculation ──────────────────────────────────────────

/**
 * Compute the most recently COMPLETED Mon→Sun workweek in the given
 * timezone, relative to `now`. Returns YYYY-MM-DD strings. The cron
 * fires Monday 06:00 PT, so this resolves to Mon-of-last-week through
 * Sun-of-last-week.
 *
 * If a caller passes an explicit `pay_period_start` it overrides the
 * computed start; the end is always start + 6 days.
 */
function priorWorkweek(
  now: Date,
  timezone: string,
  explicitStart?: string,
): { weekStart: string; weekEnd: string } {
  if (explicitStart && /^\d{4}-\d{2}-\d{2}$/.test(explicitStart)) {
    const [y, m, d] = explicitStart.split("-").map(Number);
    const startMs = wallClockToUtcMs({ year: y, month: m, day: d }, timezone);
    const endMs = wallClockToUtcMs(
      { year: y, month: m, day: d + 6 },
      timezone,
    );
    return {
      weekStart: explicitStart,
      weekEnd: utcMsToWallClockParts(endMs, timezone).dateOnly,
    };
  }

  const parts = utcMsToWallClockParts(now.getTime(), timezone);
  // dayOfWeek: 0=Sun..6=Sat. We want the most recent Sunday strictly
  // before `now`. If today is Sunday, we still take the prior week's
  // Sunday (cron isn't expected to fire mid-Sunday, but be safe).
  const daysBackToSunday = parts.dayOfWeek === 0 ? 7 : parts.dayOfWeek;
  const sundayMs = wallClockToUtcMs(
    { year: parts.year, month: parts.month, day: parts.day - daysBackToSunday },
    timezone,
  );
  const sundayParts = utcMsToWallClockParts(sundayMs, timezone);
  const mondayMs = wallClockToUtcMs(
    { year: sundayParts.year, month: sundayParts.month, day: sundayParts.day - 6 },
    timezone,
  );
  return {
    weekStart: utcMsToWallClockParts(mondayMs, timezone).dateOnly,
    weekEnd: sundayParts.dateOnly,
  };
}

/**
 * Convert a YYYY-MM-DD wall-clock date to the start-of-day UTC
 * timestamp in the configured timezone, used for the `<` / `>` filters
 * against `shifts.start_time` / `shifts.end_time`.
 */
function dateOnlyToTzInstant(
  dateIso: string,
  timezone: string,
  dayOffset = 0,
): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const ms = wallClockToUtcMs(
    { year: y, month: m, day: d + dayOffset },
    timezone,
  );
  return new Date(ms).toISOString();
}

// ─── Per-org generation ────────────────────────────────────────────

async function generateForOrg(
  supabase: ReturnType<typeof createClient>,
  org: OrgRow,
  now: Date,
  options: { explicitStart?: string; dryRun: boolean },
): Promise<OrgResult> {
  const settings = (org.settings ?? {}) as Record<string, unknown>;
  const payroll = (settings.payroll ?? {}) as Record<string, unknown>;
  const timezone = typeof payroll.timezone === "string" && payroll.timezone.length > 0
    ? (payroll.timezone as string)
    : "America/Los_Angeles";

  const { weekStart, weekEnd } = priorWorkweek(now, timezone, options.explicitStart);

  const result: OrgResult = {
    org_id: org.id,
    org_slug: org.slug,
    pay_period_start: weekStart,
    pay_period_end: weekEnd,
    caregivers_considered: 0,
    timesheets_inserted: 0,
    timesheets_skipped_existing: 0,
    timesheets_skipped_empty: 0,
    timesheets_blocked: 0,
    errors: [],
  };

  // Fetch all shifts overlapping the workweek for this org.
  // Until Phase B adds shifts.org_id, this query is implicitly
  // single-org because TC is the only org. The org filter is layered
  // in via the caregiver join below.
  const startInstant = dateOnlyToTzInstant(weekStart, timezone, 0);
  const endInstant = dateOnlyToTzInstant(weekEnd, timezone, 1);

  const { data: shiftsData, error: shiftsErr } = await supabase
    .from("shifts")
    .select("id, assigned_caregiver_id, start_time, end_time, status, hourly_rate, mileage")
    .lt("start_time", endInstant)
    .gt("end_time", startInstant)
    .not("assigned_caregiver_id", "is", null)
    // Skip statuses that should never appear on a paycheck.
    .in("status", ["completed", "in_progress", "confirmed", "assigned", "no_show"]);

  if (shiftsErr) {
    result.errors.push({ caregiver_id: "*", message: `shifts query failed: ${shiftsErr.message}` });
    return result;
  }

  const allShifts = (shiftsData ?? []) as ShiftRow[];

  // Filter out cancelled shifts and group by caregiver.
  const shiftsByCaregiver = new Map<string, ShiftRow[]>();
  for (const s of allShifts) {
    if (!s.assigned_caregiver_id) continue;
    if (s.status === "cancelled") continue;
    if (!shiftsByCaregiver.has(s.assigned_caregiver_id)) {
      shiftsByCaregiver.set(s.assigned_caregiver_id, []);
    }
    shiftsByCaregiver.get(s.assigned_caregiver_id)!.push(s);
  }

  if (shiftsByCaregiver.size === 0) {
    return result;
  }

  // Fetch clock events for those shifts. Single-shot for performance.
  const shiftIds = allShifts.map((s) => s.id);
  let clockEventsByShift = new Map<string, ClockEventRow[]>();
  // Supabase IN filter handles up to a few thousand items; chunk for
  // safety even though TC weekly volume is ~hundreds.
  for (let i = 0; i < shiftIds.length; i += 500) {
    const batch = shiftIds.slice(i, i + 500);
    const { data: eventsData, error: eventsErr } = await supabase
      .from("clock_events")
      .select("shift_id, caregiver_id, event_type, occurred_at, geofence_passed")
      .in("shift_id", batch);
    if (eventsErr) {
      result.errors.push({
        caregiver_id: "*",
        message: `clock_events query failed: ${eventsErr.message}`,
      });
      return result;
    }
    for (const e of (eventsData ?? []) as ClockEventRow[]) {
      if (!clockEventsByShift.has(e.shift_id)) clockEventsByShift.set(e.shift_id, []);
      clockEventsByShift.get(e.shift_id)!.push(e);
    }
  }

  // Fetch caregiver state for the considered caregivers (paychex sync state).
  const caregiverIds = Array.from(shiftsByCaregiver.keys());
  const caregiversById = new Map<string, CaregiverRow>();
  for (let i = 0; i < caregiverIds.length; i += 500) {
    const batch = caregiverIds.slice(i, i + 500);
    const { data: cgData, error: cgErr } = await supabase
      .from("caregivers")
      .select("id, paychex_worker_id, paychex_employee_id, paychex_sync_status")
      .in("id", batch);
    if (cgErr) {
      result.errors.push({
        caregiver_id: "*",
        message: `caregivers query failed: ${cgErr.message}`,
      });
      return result;
    }
    for (const c of (cgData ?? []) as CaregiverRow[]) {
      caregiversById.set(c.id, c);
    }
  }

  // Idempotency: load existing timesheets for this (org, weekStart)
  // up front so we can skip caregivers whose draft already exists.
  const { data: existingData, error: existingErr } = await supabase
    .from("timesheets")
    .select("caregiver_id")
    .eq("org_id", org.id)
    .eq("pay_period_start", weekStart);
  if (existingErr) {
    result.errors.push({
      caregiver_id: "*",
      message: `timesheets pre-check failed: ${existingErr.message}`,
    });
    return result;
  }
  const existingCaregivers = new Set(
    ((existingData ?? []) as Array<{ caregiver_id: string }>).map((r) => r.caregiver_id),
  );

  // ── Per-caregiver loop ──
  for (const [caregiverId, shiftsForCaregiver] of shiftsByCaregiver) {
    result.caregivers_considered += 1;

    if (existingCaregivers.has(caregiverId)) {
      result.timesheets_skipped_existing += 1;
      continue;
    }

    const events: ClockEventRow[] = [];
    for (const s of shiftsForCaregiver) {
      const evs = clockEventsByShift.get(s.id);
      if (evs) events.push(...evs);
    }

    let draft;
    try {
      draft = buildTimesheet({
        orgId: org.id,
        caregiverId,
        weekStart,
        weekEnd,
        shifts: shiftsForCaregiver,
        clockEvents: events,
        orgSettings: settings,
      });
    } catch (err) {
      result.errors.push({
        caregiver_id: caregiverId,
        message: `buildTimesheet failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (!draft) {
      result.timesheets_skipped_empty += 1;
      continue;
    }

    const caregiver = caregiversById.get(caregiverId) ?? {
      id: caregiverId,
      paychex_worker_id: null,
      paychex_employee_id: null,
      paychex_sync_status: null,
    };

    let exceptions: Array<{ severity: string; code: string; message: string; shift_id?: string }>;
    try {
      exceptions = detectExceptions({ draft, caregiver, orgSettings: settings });
    } catch (err) {
      result.errors.push({
        caregiver_id: caregiverId,
        message: `detectExceptions failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const blocked = hasBlockingExceptions(exceptions);
    const blockReason = blocked ? summarizeBlockReason(exceptions) : null;

    const tsRow = {
      ...draft.timesheet,
      status: blocked ? "blocked" : "draft",
      block_reason: blockReason,
      // Preserve the exception payload in `notes` until the Phase 4
      // UI surfaces a dedicated structure. JSON keeps it parseable.
      notes: exceptions.length > 0 ? JSON.stringify({ exceptions }) : null,
    };

    if (options.dryRun) {
      // Don't persist; still count what would have happened.
      if (blocked) result.timesheets_blocked += 1;
      else result.timesheets_inserted += 1;
      continue;
    }

    const { data: insertedTs, error: tsErr } = await supabase
      .from("timesheets")
      .insert(tsRow)
      .select("id")
      .single();

    if (tsErr) {
      // Unique-violation: someone else inserted in the gap. Treat as
      // "already exists" and continue rather than failing the run.
      if (tsErr.code === "23505") {
        result.timesheets_skipped_existing += 1;
        continue;
      }
      result.errors.push({
        caregiver_id: caregiverId,
        message: `timesheets insert failed: ${tsErr.message}`,
      });
      continue;
    }

    const timesheetId = (insertedTs as { id: string }).id;

    if (draft.timesheet_shifts.length > 0) {
      const linkRows = draft.timesheet_shifts.map((row: Record<string, unknown>) => ({
        ...row,
        timesheet_id: timesheetId,
      }));
      const { error: linkErr } = await supabase
        .from("timesheet_shifts")
        .insert(linkRows);
      if (linkErr) {
        result.errors.push({
          caregiver_id: caregiverId,
          message: `timesheet_shifts insert failed: ${linkErr.message}`,
        });
        // Leave the timesheet row in place — Phase 4 UI will show it
        // as draft with no line items, which is debuggable. Removing
        // it here would complicate retries; the unique constraint
        // protects against duplicates on re-run.
      }
    }

    // Fire-and-forget event log so the activity feed reflects it.
    // Per the plan's "Events table integration": the payload includes
    // `timesheet_id` as a top-level key so Phase B's backfill can
    // derive `org_id` from `timesheets.org_id`.
    supabase
      .from("events")
      .insert({
        event_type: "timesheet_generated",
        entity_type: "caregiver",
        entity_id: caregiverId,
        actor: "system:payroll-generate-timesheets",
        payload: {
          timesheet_id: timesheetId,
          org_id: org.id,
          caregiver_id: caregiverId,
          pay_period_start: weekStart,
          pay_period_end: weekEnd,
          regular_hours: draft.timesheet.regular_hours,
          overtime_hours: draft.timesheet.overtime_hours,
          double_time_hours: draft.timesheet.double_time_hours,
          mileage_total: draft.timesheet.mileage_total,
          gross_pay: draft.timesheet.gross_pay,
          status: blocked ? "blocked" : "draft",
          block_reason: blockReason,
          exception_codes: Array.from(new Set(exceptions.map((e) => e.code))),
        },
      })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            "[payroll-generate-timesheets] event log failed:",
            error.message,
          );
        }
      });

    if (blocked) result.timesheets_blocked += 1;
    else result.timesheets_inserted += 1;
  }

  return result;
}

// ─── Main handler ──────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { error: "POST required." });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Optional body — cron sends `{}`. Manual operators can send an
  // org_id, an explicit pay_period_start, or dry_run=true.
  let body: { org_id?: string; pay_period_start?: string; dry_run?: boolean } = {};
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  }

  // Fetch enabled orgs.
  let orgQuery = supabase
    .from("organizations")
    .select("id, slug, settings")
    .filter("settings->features_enabled->>payroll", "eq", "true");
  if (body.org_id) {
    orgQuery = orgQuery.eq("id", body.org_id);
  }
  const { data: orgsData, error: orgsErr } = await orgQuery;
  if (orgsErr) {
    return jsonResponse(500, {
      error: `organizations query failed: ${orgsErr.message}`,
    });
  }

  const orgs = (orgsData ?? []) as OrgRow[];
  if (orgs.length === 0) {
    return jsonResponse(200, {
      ok: true,
      message: "No organizations have payroll enabled.",
      orgs: [],
    });
  }

  const now = new Date();
  const orgResults: OrgResult[] = [];
  for (const org of orgs) {
    try {
      const r = await generateForOrg(supabase, org, now, {
        explicitStart: body.pay_period_start,
        dryRun: body.dry_run === true,
      });
      orgResults.push(r);
    } catch (err) {
      orgResults.push({
        org_id: org.id,
        org_slug: org.slug,
        pay_period_start: "",
        pay_period_end: "",
        caregivers_considered: 0,
        timesheets_inserted: 0,
        timesheets_skipped_existing: 0,
        timesheets_skipped_empty: 0,
        timesheets_blocked: 0,
        errors: [{
          caregiver_id: "*",
          message: `org generation failed: ${err instanceof Error ? err.message : String(err)}`,
        }],
      });
    }
  }

  const totalErrors = orgResults.reduce((s, r) => s + r.errors.length, 0);
  return jsonResponse(totalErrors > 0 ? 207 : 200, {
    ok: totalErrors === 0,
    dry_run: body.dry_run === true,
    triggered_at: now.toISOString(),
    orgs: orgResults,
  });
});
