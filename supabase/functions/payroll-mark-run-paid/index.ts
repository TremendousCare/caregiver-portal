// ─── Payroll: mark a run as paid in Paychex ───
//
// Triggered from the Phase 4 PR #3 PayrollRunsView "Mark as Paid in
// Paychex" confirmation modal. Receives a payroll_runs.id and the
// actual paid_date the back office wants to record. Marks the run
// `completed` and every member timesheet `paid`, plus writes a
// `payroll_run_completed` event for the audit log.
//
// What this function does NOT do:
//   - Talk to Paychex. It is a local state flip only — the back
//     office has separately submitted the run via the CSV upload (or
//     Phase 5's API path) and is now confirming the run actually
//     paid. Phase 5's webhook handler will fire this same state flip
//     automatically; this manual path stays available indefinitely.
//
// Multi-tenancy:
//   - org_id derives from the caller's JWT.
//   - The run's org_id is verified against the caller's. The member
//     timesheet UPDATE filters by both the run id and org_id.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   docs/handoff-paychex-phase-4.md  ("PR #3 — Payroll Runs view + ...")

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  evaluateMarkAsPaidAction,
  PAYROLL_RUN_STATUS,
  TIMESHEET_STATUS,
} from "../../../src/lib/payroll/approvalStateMachine.js";

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

// ─── Auth ────────────────────────────────────────────────────────

interface AuthContext { orgId: string; userEmail: string | null; }

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
    return { ok: false, status: 403, error: "JWT is missing org_id claim." };
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return { ok: false, status: 401, error: "Not authenticated." };
  return { ok: true, ctx: { orgId, userEmail: userData.user.email ?? null } };
}

async function assertAdmin(
  supabase: ReturnType<typeof createClient>,
  email: string | null,
) {
  if (!email) return { ok: false, status: 403, error: "Admin access required." } as const;
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  if (!roleRow || (roleRow as { role: string }).role !== "admin") {
    return { ok: false, status: 403, error: "Admin access required." } as const;
  }
  return { ok: true } as const;
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
  const adminCheck = await assertAdmin(admin, userEmail);
  if (!adminCheck.ok) return jsonResponse(adminCheck.status, { error: adminCheck.error }, cors);

  // ── Body ──
  let body: { payroll_run_id?: string; paid_date?: string; notes?: string } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Body must be valid JSON." }, cors);
  }
  const runId = typeof body.payroll_run_id === "string" ? body.payroll_run_id : null;
  if (!runId) {
    return jsonResponse(400, { error: "payroll_run_id is required." }, cors);
  }
  const paidDate = typeof body.paid_date === "string" ? body.paid_date : "";

  // ── Load run (org-scoped) ──
  const { data: runRow, error: runErr } = await admin
    .from("payroll_runs")
    .select("id, org_id, status, pay_period_start, pay_period_end, pay_date, timesheet_count, total_gross")
    .eq("id", runId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (runErr) {
    return jsonResponse(500, { error: `Run lookup failed: ${runErr.message}` }, cors);
  }
  if (!runRow) {
    return jsonResponse(404, { error: "Payroll run not found." }, cors);
  }
  const run = runRow as {
    id: string; org_id: string; status: string;
    pay_period_start: string; pay_period_end: string; pay_date: string;
    timesheet_count: number; total_gross: number;
  };

  // ── Validate state transition ──
  const decision = evaluateMarkAsPaidAction({ run: { status: run.status }, paidDate });
  if (!decision.ok) {
    return jsonResponse(422, {
      error: decision.message,
      code: decision.code,
    }, cors);
  }

  // ── Update the run ──
  const completedAt = new Date().toISOString();
  const { data: updatedRun, error: updateRunErr } = await admin
    .from("payroll_runs")
    .update({
      status: PAYROLL_RUN_STATUS.COMPLETED,
      completed_at: completedAt,
    })
    .eq("id", run.id)
    .eq("org_id", orgId)
    .eq("status", run.status) // optimistic concurrency
    .select("id");
  if (updateRunErr) {
    return jsonResponse(500, { error: `Run update failed: ${updateRunErr.message}` }, cors);
  }
  if (!Array.isArray(updatedRun) || updatedRun.length === 0) {
    return jsonResponse(409, {
      error:
        "Run status changed between read and write. Refresh the page and try again.",
      code: "concurrent_modification",
    }, cors);
  }

  // ── Flip member timesheets to paid ──
  // Match on payroll_run_id (Phase 4 PR #3). Pre-PR-3 exported runs
  // have NULL payroll_run_id; for those, fall back to a (org_id +
  // pay_period_start + status='exported') match. The fallback is
  // best-effort and documented in the PR #3 migration.
  const paidAt = completedAt;
  let memberTimesheetsFlipped = 0;
  let memberTimesheetsFallbackPath = false;

  // Primary path: payroll_run_id link.
  const { data: primaryFlipped, error: primaryErr } = await admin
    .from("timesheets")
    .update({ status: TIMESHEET_STATUS.PAID, submitted_at: paidAt })
    .eq("payroll_run_id", run.id)
    .eq("org_id", orgId)
    .eq("status", TIMESHEET_STATUS.EXPORTED)
    .select("id");
  if (primaryErr) {
    console.warn(`[payroll-mark-run-paid] primary timesheet flip failed: ${primaryErr.message}`);
  } else {
    memberTimesheetsFlipped = (primaryFlipped ?? []).length;
  }

  // Fallback for pre-PR-3 legacy runs: only fire if the primary path
  // matched 0 rows. Don't fire if it matched some — that means we
  // already have a clean PR-3 link and a fallback would risk picking
  // up unrelated rows.
  if (memberTimesheetsFlipped === 0) {
    const { data: fallbackFlipped, error: fallbackErr } = await admin
      .from("timesheets")
      .update({
        status: TIMESHEET_STATUS.PAID,
        submitted_at: paidAt,
        payroll_run_id: run.id, // backfill the link while we're here
      })
      .eq("org_id", orgId)
      .eq("pay_period_start", run.pay_period_start)
      .eq("status", TIMESHEET_STATUS.EXPORTED)
      .is("payroll_run_id", null)
      .select("id");
    if (fallbackErr) {
      console.warn(`[payroll-mark-run-paid] fallback flip failed: ${fallbackErr.message}`);
    } else if ((fallbackFlipped ?? []).length > 0) {
      memberTimesheetsFlipped = fallbackFlipped!.length;
      memberTimesheetsFallbackPath = true;
    }
  }

  // ── Audit event (fire-and-forget) ──
  admin.from("events").insert({
    event_type: "payroll_run_completed",
    entity_type: "caregiver",
    // entity_id needs a uuid; payload carries the precise linkage.
    // Use null so we don't attach to an arbitrary caregiver — the
    // event is org-level. events.entity_id is nullable.
    entity_id: null,
    actor: `user:${userEmail || "unknown"}`,
    org_id: orgId,
    payload: {
      payroll_run_id: run.id,
      org_id: orgId,
      pay_period_start: run.pay_period_start,
      pay_period_end: run.pay_period_end,
      pay_date: run.pay_date,
      paid_date: paidDate,
      timesheet_count: run.timesheet_count,
      total_gross: run.total_gross,
      member_timesheets_flipped: memberTimesheetsFlipped,
      fallback_path: memberTimesheetsFallbackPath,
      notes: typeof body.notes === "string" ? body.notes : null,
    },
  }).then(({ error }: { error: { message: string } | null }) => {
    if (error) console.warn(`[payroll-mark-run-paid] event log failed: ${error.message}`);
  });

  return jsonResponse(200, {
    ok: true,
    payroll_run_id: run.id,
    status: PAYROLL_RUN_STATUS.COMPLETED,
    completed_at: completedAt,
    paid_date: paidDate,
    member_timesheets_flipped: memberTimesheetsFlipped,
    fallback_path: memberTimesheetsFallbackPath,
  }, cors);
});
