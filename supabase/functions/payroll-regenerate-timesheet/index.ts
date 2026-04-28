// ─── Payroll: regenerate one caregiver's timesheet for a week ───
//
// Triggered from the Phase 4 PR #2 "Regenerate" button on a single
// ThisWeekView row. Used after the back office edits an underlying
// shift's clock_events / hourly_rate / mileage and wants the timesheet
// to reflect the updated source data.
//
// Behavior (atomic from the user's perspective):
//   1. DELETE the existing timesheet for (org_id, caregiver_id,
//      pay_period_start). The CASCADE on timesheet_shifts kills its
//      junction rows automatically.
//   2. Re-fetch shifts + clock_events + caregiver descriptor for the
//      week, run the same `buildTimesheet` + `detectExceptions` pure
//      functions the cron uses, and INSERT a fresh draft.
//   3. Write a `timesheet_regenerated` event with before/after summary.
//
// We deliberately mirror — rather than share — the per-caregiver loop
// from the cron (`payroll-generate-timesheets/index.ts`). Sharing
// would mean refactoring a stable, in-production cron, which adds risk
// for marginal code-saving. The pure-function shared dependencies
// (buildTimesheet / detectExceptions) make duplication of the I/O
// shell cheap and obvious.
//
// Multi-tenancy:
//   - org_id derives from the caller's JWT.
//   - All SELECT/DELETE/INSERT are filtered by org_id.
//   - The timesheet's existence in the caller's org is verified before
//     the DELETE, so a forged timesheet_id cannot delete another org's
//     data.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   docs/handoff-paychex-phase-4.md  ("PR #2 — Edits + approval + ...")

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const ALLOWED_ORIGINS = [
  "https://caregiver-portal.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(status: number, body: unknown, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ─── Auth (mirrors paychex-sync-worker conventions) ───────────────

interface AuthContext {
  orgId: string;
  userEmail: string | null;
}

async function authenticateRequest(
  authHeader: string | null,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; status: number; error: string }> {
  if (!authHeader) return { ok: false, status: 401, error: "Missing Authorization header." };
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, error: "Malformed JWT." };
  let payload: Record<string, unknown>;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    payload = JSON.parse(atob(padded));
  } catch {
    return { ok: false, status: 401, error: "Invalid JWT payload." };
  }
  const orgId = typeof payload.org_id === "string" ? payload.org_id : null;
  if (!orgId) {
    return {
      ok: false,
      status: 403,
      error:
        "JWT is missing org_id claim. Confirm the SaaS-retrofit access token hook is enabled.",
    };
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return { ok: false, status: 401, error: "Not authenticated." };
  return { ok: true, ctx: { orgId, userEmail: userData.user.email ?? null } };
}

async function assertStaff(
  supabase: ReturnType<typeof createClient>,
  email: string | null,
) {
  if (!email) return { ok: false, status: 403, error: "Staff access required." } as const;
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  if (!roleRow || !["admin", "member"].includes((roleRow as { role: string }).role)) {
    return { ok: false, status: 403, error: "Staff access required." } as const;
  }
  return { ok: true } as const;
}

// ─── Helpers ──────────────────────────────────────────────────────

function dateOnlyToTzInstant(dateIso: string, timezone: string, dayOffset = 0): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const ms = wallClockToUtcMs({ year: y, month: m, day: d + dayOffset }, timezone);
  return new Date(ms).toISOString();
}

function addDaysIso(dateIso: string, days: number, timezone: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const ms = wallClockToUtcMs({ year: y, month: m, day: d + days }, timezone);
  return utcMsToWallClockParts(ms, timezone).dateOnly;
}

// ─── Main handler ────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse(405, { error: "POST required." }, cors);

  // ── Auth ──
  const authResult = await authenticateRequest(req.headers.get("Authorization"));
  if (!authResult.ok) return jsonResponse(authResult.status, { error: authResult.error }, cors);
  const { orgId, userEmail } = authResult.ctx;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const staffCheck = await assertStaff(admin, userEmail);
  if (!staffCheck.ok) return jsonResponse(staffCheck.status, { error: staffCheck.error }, cors);

  // ── Body ──
  let body: { timesheet_id?: string; reason?: string } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Body must be valid JSON." }, cors);
  }
  const timesheetId = typeof body.timesheet_id === "string" ? body.timesheet_id : null;
  if (!timesheetId) {
    return jsonResponse(400, { error: "timesheet_id is required." }, cors);
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  // Reason is optional for regenerate (the source-data edits already
  // captured their reasons). Recorded if supplied.

  // ── Load existing timesheet (org-scoped) + org settings ──
  const { data: existingTs, error: existingErr } = await admin
    .from("timesheets")
    .select("id, org_id, caregiver_id, pay_period_start, pay_period_end, status")
    .eq("id", timesheetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (existingErr) {
    return jsonResponse(500, { error: `Timesheet lookup failed: ${existingErr.message}` }, cors);
  }
  if (!existingTs) {
    return jsonResponse(404, { error: "Timesheet not found." }, cors);
  }
  const ts = existingTs as {
    id: string;
    org_id: string;
    caregiver_id: string;
    pay_period_start: string;
    pay_period_end: string;
    status: string;
  };

  // Refuse to regenerate exported / submitted / paid rows. Those have
  // already been sent to Paychex (or are about to be); regenerating
  // would silently mutate a financial record. Approved is OK because
  // it's pre-export; the regenerate flips it back to draft naturally.
  const REGENERATABLE = new Set(["draft", "pending_approval", "approved", "blocked", "rejected"]);
  if (!REGENERATABLE.has(ts.status)) {
    return jsonResponse(422, {
      error:
        `Cannot regenerate a timesheet in status "${ts.status}". `
          + "Already-exported / submitted / paid rows are immutable.",
    }, cors);
  }

  // ── Load org settings ──
  const { data: orgRow, error: orgErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) {
    return jsonResponse(500, { error: `Org lookup failed: ${orgErr.message}` }, cors);
  }
  const settings = ((orgRow as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const payroll = (settings.payroll as Record<string, unknown> | undefined) ?? {};
  const timezone = typeof payroll.timezone === "string" && payroll.timezone.length > 0
    ? (payroll.timezone as string)
    : "America/Los_Angeles";

  const weekStart = ts.pay_period_start;
  const weekEnd = ts.pay_period_end || addDaysIso(weekStart, 6, timezone);
  const startInstant = dateOnlyToTzInstant(weekStart, timezone, 0);
  const endInstant = dateOnlyToTzInstant(weekEnd, timezone, 1);

  // ── Fetch caregiver's shifts for the week (org-scoped) ──
  // Phase B added shifts.org_id; the explicit filter is redundant with
  // the assigned_caregiver_id lookup but keeps the multi-tenancy
  // posture explicit.
  const { data: shiftsData, error: shiftsErr } = await admin
    .from("shifts")
    .select("id, assigned_caregiver_id, start_time, end_time, status, hourly_rate, mileage")
    .eq("org_id", orgId)
    .eq("assigned_caregiver_id", ts.caregiver_id)
    .lt("start_time", endInstant)
    .gt("end_time", startInstant)
    .in("status", ["completed", "in_progress", "confirmed", "assigned", "no_show"]);
  if (shiftsErr) {
    return jsonResponse(500, { error: `Shifts query failed: ${shiftsErr.message}` }, cors);
  }
  const shifts = ((shiftsData ?? []) as Array<{
    id: string; assigned_caregiver_id: string; start_time: string; end_time: string;
    status: string; hourly_rate: number | null; mileage: number | null;
  }>).filter((s) => s.status !== "cancelled");

  // ── Fetch clock_events for those shifts (org-scoped) ──
  let clockEvents: Array<{
    shift_id: string; caregiver_id: string; event_type: "in" | "out";
    occurred_at: string; geofence_passed: boolean | null;
  }> = [];
  if (shifts.length > 0) {
    const shiftIds = shifts.map((s) => s.id);
    const { data: eventsData, error: eventsErr } = await admin
      .from("clock_events")
      .select("shift_id, caregiver_id, event_type, occurred_at, geofence_passed")
      .eq("org_id", orgId)
      .in("shift_id", shiftIds);
    if (eventsErr) {
      return jsonResponse(500, { error: `Clock-events query failed: ${eventsErr.message}` }, cors);
    }
    clockEvents = (eventsData ?? []) as typeof clockEvents;
  }

  // ── Fetch caregiver state ──
  const { data: cgData, error: cgErr } = await admin
    .from("caregivers")
    .select("id, paychex_worker_id, paychex_employee_id, paychex_sync_status")
    .eq("org_id", orgId)
    .eq("id", ts.caregiver_id)
    .maybeSingle();
  if (cgErr) {
    return jsonResponse(500, { error: `Caregiver query failed: ${cgErr.message}` }, cors);
  }
  const caregiver = (cgData as {
    id: string; paychex_worker_id: string | null;
    paychex_employee_id: string | null; paychex_sync_status: string | null;
  } | null) ?? {
    id: ts.caregiver_id, paychex_worker_id: null,
    paychex_employee_id: null, paychex_sync_status: null,
  };

  // ── Build the new draft (pure functions) ──
  let draft;
  try {
    draft = buildTimesheet({
      orgId,
      caregiverId: ts.caregiver_id,
      weekStart,
      weekEnd,
      shifts,
      clockEvents,
      orgSettings: settings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(500, { error: `buildTimesheet failed: ${message}` }, cors);
  }

  let exceptions: Array<{ severity: string; code: string; message: string; shift_id?: string }> = [];
  let blocked = false;
  let blockReason: string | null = null;
  if (draft) {
    try {
      exceptions = detectExceptions({ draft, caregiver, orgSettings: settings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { error: `detectExceptions failed: ${message}` }, cors);
    }
    blocked = hasBlockingExceptions(exceptions);
    blockReason = blocked ? summarizeBlockReason(exceptions) : null;
  }

  // ── DELETE the old timesheet (CASCADE kills timesheet_shifts) ──
  const { error: deleteErr } = await admin
    .from("timesheets")
    .delete()
    .eq("id", ts.id)
    .eq("org_id", orgId);
  if (deleteErr) {
    return jsonResponse(500, { error: `Delete failed: ${deleteErr.message}` }, cors);
  }

  if (!draft) {
    // After DELETE, no shifts produce a draft. Return without inserting;
    // caller sees a "no shifts" state on next fetch.
    admin.from("events").insert({
      event_type: "timesheet_regenerated",
      entity_type: "caregiver",
      entity_id: ts.caregiver_id,
      actor: `user:${userEmail || "unknown"}`,
      org_id: orgId,
      payload: {
        timesheet_id: ts.id,
        previous_timesheet_id: ts.id,
        org_id: orgId,
        caregiver_id: ts.caregiver_id,
        pay_period_start: weekStart,
        pay_period_end: weekEnd,
        result: "deleted_no_replacement",
        reason: reason || null,
      },
    }).then(() => {});
    return jsonResponse(200, {
      ok: true,
      result: "deleted_no_replacement",
      message: "No shifts in the period; old timesheet deleted, no replacement generated.",
    }, cors);
  }

  // ── INSERT the fresh draft ──
  // Persist the per-rate breakdown + weighted ROP straight from the
  // engine's meta. The export function reads these instead of
  // re-running the engine. `regularByRate` is null/empty for shifts
  // with no rate; the export's legacy fallback (hourly_rate field)
  // covers that case.
  const tsRow = {
    ...draft.timesheet,
    status: blocked ? "blocked" : "draft",
    block_reason: blockReason,
    notes: exceptions.length > 0 ? JSON.stringify({ exceptions }) : null,
    regular_by_rate: Array.isArray(draft.meta?.regularByRate) && draft.meta.regularByRate.length > 0
      ? draft.meta.regularByRate
      : null,
    regular_rate_of_pay: draft.meta?.regularRateOfPay ?? null,
    last_edited_by: userEmail || "unknown",
    last_edited_at: new Date().toISOString(),
    last_edit_reason: reason || "Regenerate timesheet",
  };
  const { data: insertedTs, error: insertErr } = await admin
    .from("timesheets")
    .insert(tsRow)
    .select("id")
    .single();
  if (insertErr) {
    return jsonResponse(500, { error: `Insert failed: ${insertErr.message}` }, cors);
  }
  const newTimesheetId = (insertedTs as { id: string }).id;

  if (draft.timesheet_shifts.length > 0) {
    const linkRows = draft.timesheet_shifts.map((row: Record<string, unknown>) => ({
      ...row,
      timesheet_id: newTimesheetId,
    }));
    const { error: linkErr } = await admin
      .from("timesheet_shifts")
      .insert(linkRows);
    if (linkErr) {
      // Soft fail: the timesheet exists; back office can investigate
      // missing line items via the row's expand panel.
      console.warn(`[payroll-regenerate-timesheet] timesheet_shifts insert failed: ${linkErr.message}`);
    }
  }

  // Audit event (fire-and-forget per the events-table contract).
  admin.from("events").insert({
    event_type: "timesheet_regenerated",
    entity_type: "caregiver",
    entity_id: ts.caregiver_id,
    actor: `user:${userEmail || "unknown"}`,
    org_id: orgId,
    payload: {
      timesheet_id: newTimesheetId,
      previous_timesheet_id: ts.id,
      org_id: orgId,
      caregiver_id: ts.caregiver_id,
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
      reason: reason || null,
    },
  }).then(() => {});

  return jsonResponse(200, {
    ok: true,
    timesheet_id: newTimesheetId,
    previous_timesheet_id: ts.id,
    status: blocked ? "blocked" : "draft",
    block_reason: blockReason,
    exception_codes: Array.from(new Set(exceptions.map((e) => e.code))),
    regular_hours: draft.timesheet.regular_hours,
    overtime_hours: draft.timesheet.overtime_hours,
    double_time_hours: draft.timesheet.double_time_hours,
    mileage_total: draft.timesheet.mileage_total,
    gross_pay: draft.timesheet.gross_pay,
  }, cors);
});
