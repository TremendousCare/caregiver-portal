// ─── Payroll: timesheet actions (approve / unapprove / edit) ───
//
// Single edge function fronting all per-row mutations the Phase 4 PR
// #2 ThisWeekView triggers:
//
//   { action: 'approve',           timesheet_id }
//   { action: 'approve_bulk',      timesheet_ids: string[] }
//   { action: 'unapprove',         timesheet_id }
//   { action: 'edit_timesheet',    timesheet_id, edits: {...}, reason }
//   { action: 'edit_shift_rate',   timesheet_id, shift_id, hourly_rate, reason }
//   { action: 'edit_shift_mileage',timesheet_id, shift_id, mileage,      reason }
//
// Every action goes through the same auth gate (JWT-derived org_id +
// staff role) and writes one or more `events` rows for the audit log.
//
// Why one function, not six: the auth + tenancy + audit boilerplate is
// the same for each mutation. One handler keeps the surface small for
// the UI and isolates the auth logic in one place. The action
// discriminator pattern is already used elsewhere in this codebase
// (`esign`, `bulk-sms`, etc.).
//
// Multi-tenancy:
//   - org_id derives from the caller's JWT, never from the request body.
//   - Every UPDATE / SELECT filters by org_id so a forged timesheet_id
//     belonging to another org cannot be touched.
//   - Every event row carries org_id + the entity's primary id as
//     top-level payload keys per the plan's events-table contract.
//
// What this function does NOT do:
//   - Regenerate a timesheet from scratch (DELETE + rerun cron logic
//     for one caregiver/week). That's `payroll-regenerate-timesheet`.
//   - Generate a CSV / batch a payroll run. That's `payroll-export-run`.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   docs/handoff-paychex-phase-4.md  ("PR #2 — Edits + approval + ...")

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Cross-tree imports (canonical at src/ so vitest can exercise them).
import {
  evaluateApprovalAction,
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

// ─── Auth (mirrors paychex-sync-worker conventions) ───────────────

interface AuthContext {
  orgId: string;
  userEmail: string | null;
  userId: string | null;
}

async function authenticateRequest(
  authHeader: string | null,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; status: number; error: string }> {
  if (!authHeader) {
    return { ok: false, status: 401, error: "Missing Authorization header." };
  }
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, error: "Malformed JWT." };
  }
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
  if (userErr || !userData.user) {
    return { ok: false, status: 401, error: "Not authenticated." };
  }

  return {
    ok: true,
    ctx: {
      orgId,
      userEmail: userData.user.email ?? null,
      userId: userData.user.id ?? null,
    },
  };
}

async function assertStaff(
  supabase: ReturnType<typeof createClient>,
  email: string | null,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!email) {
    return { ok: false, status: 403, error: "Staff access required." };
  }
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  if (!roleRow || !["admin", "member"].includes((roleRow as { role: string }).role)) {
    return { ok: false, status: 403, error: "Staff access required." };
  }
  return { ok: true };
}

// ─── Helpers ──────────────────────────────────────────────────────

interface TimesheetRow {
  id: string;
  org_id: string;
  caregiver_id: string;
  status: string;
  pay_period_start: string;
  pay_period_end: string;
  notes: string | null;
}

function parseExceptionsFromNotes(notes: string | null): Array<{ severity: string; code: string }> {
  if (!notes) return [];
  try {
    const parsed = JSON.parse(notes);
    return Array.isArray(parsed?.exceptions) ? parsed.exceptions : [];
  } catch {
    return [];
  }
}

async function loadTimesheet(
  admin: ReturnType<typeof createClient>,
  orgId: string,
  timesheetId: string,
): Promise<{ ok: true; row: TimesheetRow } | { ok: false; status: number; error: string }> {
  const { data, error } = await admin
    .from("timesheets")
    .select("id, org_id, caregiver_id, status, pay_period_start, pay_period_end, notes")
    .eq("id", timesheetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 500, error: `Timesheet lookup failed: ${error.message}` };
  }
  if (!data) {
    // Either missing or belongs to another org. Don't leak which.
    return { ok: false, status: 404, error: "Timesheet not found." };
  }
  return { ok: true, row: data as TimesheetRow };
}

function logEvent(
  admin: ReturnType<typeof createClient>,
  args: {
    eventType: string;
    orgId: string;
    caregiverId: string;
    actor: string;
    payload: Record<string, unknown>;
  },
) {
  // Fire-and-forget: per the plan's events-table contract, log failures
  // never block the main response path.
  admin
    .from("events")
    .insert({
      event_type: args.eventType,
      entity_type: "caregiver",
      entity_id: args.caregiverId,
      actor: args.actor,
      org_id: args.orgId,
      payload: { ...args.payload, org_id: args.orgId, caregiver_id: args.caregiverId },
    })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) {
        console.warn(`[payroll-timesheet-actions] event log failed: ${error.message}`);
      }
    });
}

function trimReason(reason: unknown): string {
  if (typeof reason !== "string") return "";
  return reason.trim();
}

// ─── Action handlers ──────────────────────────────────────────────

async function handleApprove(
  admin: ReturnType<typeof createClient>,
  ctx: AuthContext,
  args: { timesheet_id: string },
) {
  const ts = await loadTimesheet(admin, ctx.orgId, args.timesheet_id);
  if (!ts.ok) return ts;

  const exceptions = parseExceptionsFromNotes(ts.row.notes);
  const decision = evaluateApprovalAction({
    timesheet: { status: ts.row.status },
    action: "approve",
    exceptions,
  });
  if (!decision.ok) {
    return {
      ok: false as const,
      status: 422,
      error: decision.message,
      code: decision.code,
      blocking_codes: (decision as { blocking_codes?: string[] }).blocking_codes,
    };
  }

  const approver = ctx.userEmail || "unknown";
  const { error: updateErr } = await admin
    .from("timesheets")
    .update({
      status: TIMESHEET_STATUS.APPROVED,
      approved_by: approver,
      approved_at: new Date().toISOString(),
    })
    .eq("id", ts.row.id)
    .eq("org_id", ctx.orgId)
    .eq("status", ts.row.status); // optimistic concurrency
  if (updateErr) {
    return { ok: false as const, status: 500, error: `Approve failed: ${updateErr.message}` };
  }

  logEvent(admin, {
    eventType: "timesheet_approved",
    orgId: ctx.orgId,
    caregiverId: ts.row.caregiver_id,
    actor: `user:${approver}`,
    payload: {
      timesheet_id: ts.row.id,
      pay_period_start: ts.row.pay_period_start,
      pay_period_end: ts.row.pay_period_end,
      previous_status: ts.row.status,
    },
  });

  return { ok: true as const, timesheet_id: ts.row.id, status: TIMESHEET_STATUS.APPROVED };
}

async function handleApproveBulk(
  admin: ReturnType<typeof createClient>,
  ctx: AuthContext,
  args: { timesheet_ids: string[] },
) {
  if (!Array.isArray(args.timesheet_ids) || args.timesheet_ids.length === 0) {
    return { ok: false as const, status: 400, error: "timesheet_ids must be a non-empty array." };
  }
  const results: Array<{ timesheet_id: string; ok: boolean; status?: string; error?: string }> = [];
  for (const id of args.timesheet_ids) {
    if (typeof id !== "string" || id === "") {
      results.push({ timesheet_id: String(id), ok: false, error: "invalid id" });
      continue;
    }
    const r = await handleApprove(admin, ctx, { timesheet_id: id });
    if (r.ok) {
      results.push({ timesheet_id: id, ok: true, status: r.status });
    } else {
      results.push({ timesheet_id: id, ok: false, error: (r as { error: string }).error });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: true as const,
    approved_count: okCount,
    failed_count: results.length - okCount,
    results,
  };
}

async function handleUnapprove(
  admin: ReturnType<typeof createClient>,
  ctx: AuthContext,
  args: { timesheet_id: string },
) {
  const ts = await loadTimesheet(admin, ctx.orgId, args.timesheet_id);
  if (!ts.ok) return ts;

  const decision = evaluateApprovalAction({
    timesheet: { status: ts.row.status },
    action: "unapprove",
  });
  if (!decision.ok) {
    return {
      ok: false as const,
      status: 422,
      error: decision.message,
      code: decision.code,
    };
  }

  const { error: updateErr } = await admin
    .from("timesheets")
    .update({
      status: TIMESHEET_STATUS.DRAFT,
      approved_by: null,
      approved_at: null,
    })
    .eq("id", ts.row.id)
    .eq("org_id", ctx.orgId)
    .eq("status", TIMESHEET_STATUS.APPROVED);
  if (updateErr) {
    return { ok: false as const, status: 500, error: `Unapprove failed: ${updateErr.message}` };
  }

  logEvent(admin, {
    eventType: "timesheet_unapproved",
    orgId: ctx.orgId,
    caregiverId: ts.row.caregiver_id,
    actor: `user:${ctx.userEmail || "unknown"}`,
    payload: {
      timesheet_id: ts.row.id,
      pay_period_start: ts.row.pay_period_start,
      pay_period_end: ts.row.pay_period_end,
    },
  });

  return { ok: true as const, timesheet_id: ts.row.id, status: TIMESHEET_STATUS.DRAFT };
}

// Edit hour totals (regular_hours, overtime_hours, double_time_hours,
// mileage_total, gross_pay) directly on the timesheets row. The back
// office uses this when an exception requires a manual override (e.g.
// "shift had no clock-out; use scheduled hours" or "DT zeroed out
// because Paychex DT earning isn't configured yet").
//
// Gross_pay is recomputed by the caller? No — for the inline-edit path
// the back office is only nudging totals and we trust them to also
// adjust gross_pay if needed. Keeping it manual avoids surprising
// re-derivations when the data underneath is incomplete.
async function handleEditTimesheet(
  admin: ReturnType<typeof createClient>,
  ctx: AuthContext,
  args: {
    timesheet_id: string;
    edits: {
      regular_hours?: number;
      overtime_hours?: number;
      double_time_hours?: number;
      mileage_total?: number;
      mileage_reimbursement?: number;
      gross_pay?: number;
    };
    reason: string;
  },
) {
  const reason = trimReason(args.reason);
  if (reason.length === 0) {
    return { ok: false as const, status: 400, error: "Reason is required for inline edits." };
  }
  if (!args.edits || typeof args.edits !== "object") {
    return { ok: false as const, status: 400, error: "edits payload is required." };
  }

  const ts = await loadTimesheet(admin, ctx.orgId, args.timesheet_id);
  if (!ts.ok) return ts;

  // Editable from these statuses only. Editing an exported / paid /
  // submitted row is a refusal — those are visible-to-Paychex states.
  const EDITABLE_STATUSES = new Set([
    TIMESHEET_STATUS.DRAFT,
    TIMESHEET_STATUS.PENDING_APPROVAL,
    TIMESHEET_STATUS.BLOCKED,
  ]);
  if (!EDITABLE_STATUSES.has(ts.row.status)) {
    return {
      ok: false as const,
      status: 422,
      error: `Cannot edit a timesheet in status "${ts.row.status}". `
        + "Unapprove first if it's already approved.",
    };
  }

  // Whitelist + numeric sanity. Reject negative numbers and NaN.
  const ALLOWED = new Set([
    "regular_hours", "overtime_hours", "double_time_hours",
    "mileage_total", "mileage_reimbursement", "gross_pay",
  ]);
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.edits)) {
    if (!ALLOWED.has(k)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      return {
        ok: false as const,
        status: 400,
        error: `Field "${k}" must be a non-negative number.`,
      };
    }
    update[k] = n;
  }
  if (Object.keys(update).length === 0) {
    return { ok: false as const, status: 400, error: "No editable fields supplied." };
  }

  update.last_edited_by = ctx.userEmail || "unknown";
  update.last_edited_at = new Date().toISOString();
  update.last_edit_reason = reason;
  update.updated_at = new Date().toISOString();

  const { error: updateErr } = await admin
    .from("timesheets")
    .update(update)
    .eq("id", ts.row.id)
    .eq("org_id", ctx.orgId)
    .in("status", Array.from(EDITABLE_STATUSES));
  if (updateErr) {
    return { ok: false as const, status: 500, error: `Edit failed: ${updateErr.message}` };
  }

  logEvent(admin, {
    eventType: "timesheet_adjusted",
    orgId: ctx.orgId,
    caregiverId: ts.row.caregiver_id,
    actor: `user:${ctx.userEmail || "unknown"}`,
    payload: {
      timesheet_id: ts.row.id,
      pay_period_start: ts.row.pay_period_start,
      edits: update,
      reason,
    },
  });

  return { ok: true as const, timesheet_id: ts.row.id, edits: update };
}

// Edit a single shift's hourly_rate via the timesheet expand panel.
// We update `shifts.hourly_rate` directly (NOT a copy on
// timesheet_shifts) so a future regenerate picks up the new rate.
// Audit trail is written to events; the timesheet's last_edit_*
// columns are also updated so the row's "last touched" timestamp
// stays accurate.
async function handleEditShiftRate(
  admin: ReturnType<typeof createClient>,
  ctx: AuthContext,
  args: {
    timesheet_id: string;
    shift_id: string;
    hourly_rate: number;
    reason: string;
  },
) {
  const reason = trimReason(args.reason);
  if (reason.length === 0) {
    return { ok: false as const, status: 400, error: "Reason is required for inline edits." };
  }
  const rate = Number(args.hourly_rate);
  if (!Number.isFinite(rate) || rate < 0) {
    return { ok: false as const, status: 400, error: "hourly_rate must be a non-negative number." };
  }

  const ts = await loadTimesheet(admin, ctx.orgId, args.timesheet_id);
  if (!ts.ok) return ts;

  // Validate the shift belongs to this timesheet AND to this org.
  // Doing both checks separately so the error tells us which broke.
  const { data: linkData, error: linkErr } = await admin
    .from("timesheet_shifts")
    .select("shift_id, timesheet_id")
    .eq("timesheet_id", ts.row.id)
    .eq("shift_id", args.shift_id)
    .maybeSingle();
  if (linkErr) {
    return { ok: false as const, status: 500, error: `Shift link lookup failed: ${linkErr.message}` };
  }
  if (!linkData) {
    return { ok: false as const, status: 404, error: "Shift is not part of this timesheet." };
  }

  const { data: shiftRow, error: shiftErr } = await admin
    .from("shifts")
    .select("id, org_id, hourly_rate")
    .eq("id", args.shift_id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (shiftErr) {
    return { ok: false as const, status: 500, error: `Shift lookup failed: ${shiftErr.message}` };
  }
  if (!shiftRow) {
    // Either the shift doesn't exist or belongs to another org. Either
    // way, refuse without leaking which.
    return { ok: false as const, status: 404, error: "Shift not found." };
  }
  const previousRate = (shiftRow as { hourly_rate: number | null }).hourly_rate;

  const { error: updateErr } = await admin
    .from("shifts")
    .update({ hourly_rate: rate })
    .eq("id", args.shift_id)
    .eq("org_id", ctx.orgId);
  if (updateErr) {
    return { ok: false as const, status: 500, error: `Rate update failed: ${updateErr.message}` };
  }

  // Tag the timesheet with the edit so the UI sees a fresh "last edited"
  // marker even though its column values didn't change. The export
  // recomputes per-shift gross from shifts.hourly_rate at export time.
  await admin
    .from("timesheets")
    .update({
      last_edited_by: ctx.userEmail || "unknown",
      last_edited_at: new Date().toISOString(),
      last_edit_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ts.row.id)
    .eq("org_id", ctx.orgId);

  logEvent(admin, {
    eventType: "timesheet_adjusted",
    orgId: ctx.orgId,
    caregiverId: ts.row.caregiver_id,
    actor: `user:${ctx.userEmail || "unknown"}`,
    payload: {
      timesheet_id: ts.row.id,
      shift_id: args.shift_id,
      field: "hourly_rate",
      previous_value: previousRate,
      new_value: rate,
      reason,
    },
  });

  return {
    ok: true as const,
    timesheet_id: ts.row.id,
    shift_id: args.shift_id,
    field: "hourly_rate",
    new_value: rate,
  };
}

// Edit a single shift's mileage. Same shape as edit_shift_rate.
async function handleEditShiftMileage(
  admin: ReturnType<typeof createClient>,
  ctx: AuthContext,
  args: {
    timesheet_id: string;
    shift_id: string;
    mileage: number;
    reason: string;
  },
) {
  const reason = trimReason(args.reason);
  if (reason.length === 0) {
    return { ok: false as const, status: 400, error: "Reason is required for inline edits." };
  }
  const miles = Number(args.mileage);
  if (!Number.isFinite(miles) || miles < 0) {
    return { ok: false as const, status: 400, error: "mileage must be a non-negative number." };
  }

  const ts = await loadTimesheet(admin, ctx.orgId, args.timesheet_id);
  if (!ts.ok) return ts;

  const { data: linkData, error: linkErr } = await admin
    .from("timesheet_shifts")
    .select("shift_id, timesheet_id")
    .eq("timesheet_id", ts.row.id)
    .eq("shift_id", args.shift_id)
    .maybeSingle();
  if (linkErr) {
    return { ok: false as const, status: 500, error: `Shift link lookup failed: ${linkErr.message}` };
  }
  if (!linkData) {
    return { ok: false as const, status: 404, error: "Shift is not part of this timesheet." };
  }

  const { data: shiftRow, error: shiftErr } = await admin
    .from("shifts")
    .select("id, org_id, mileage")
    .eq("id", args.shift_id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (shiftErr) {
    return { ok: false as const, status: 500, error: `Shift lookup failed: ${shiftErr.message}` };
  }
  if (!shiftRow) {
    return { ok: false as const, status: 404, error: "Shift not found." };
  }
  const previousMileage = (shiftRow as { mileage: number | null }).mileage;

  const { error: updateErr } = await admin
    .from("shifts")
    .update({ mileage: miles })
    .eq("id", args.shift_id)
    .eq("org_id", ctx.orgId);
  if (updateErr) {
    return { ok: false as const, status: 500, error: `Mileage update failed: ${updateErr.message}` };
  }

  await admin
    .from("timesheets")
    .update({
      last_edited_by: ctx.userEmail || "unknown",
      last_edited_at: new Date().toISOString(),
      last_edit_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ts.row.id)
    .eq("org_id", ctx.orgId);

  logEvent(admin, {
    eventType: "timesheet_adjusted",
    orgId: ctx.orgId,
    caregiverId: ts.row.caregiver_id,
    actor: `user:${ctx.userEmail || "unknown"}`,
    payload: {
      timesheet_id: ts.row.id,
      shift_id: args.shift_id,
      field: "mileage",
      previous_value: previousMileage,
      new_value: miles,
      reason,
    },
  });

  return {
    ok: true as const,
    timesheet_id: ts.row.id,
    shift_id: args.shift_id,
    field: "mileage",
    new_value: miles,
  };
}

// ─── Main handler ────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse(405, { error: "POST required." }, cors);

  // ── Auth ──
  const authResult = await authenticateRequest(req.headers.get("Authorization"));
  if (!authResult.ok) return jsonResponse(authResult.status, { error: authResult.error }, cors);
  const ctx = authResult.ctx;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const staffCheck = await assertStaff(admin, ctx.userEmail);
  if (!staffCheck.ok) {
    return jsonResponse(staffCheck.status, { error: staffCheck.error }, cors);
  }

  // ── Body ──
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Body must be valid JSON." }, cors);
  }
  const action = typeof body.action === "string" ? body.action : null;
  if (!action) {
    return jsonResponse(400, { error: "Missing `action`." }, cors);
  }

  try {
    switch (action) {
      case "approve": {
        const r = await handleApprove(admin, ctx, {
          timesheet_id: String(body.timesheet_id || ""),
        });
        return jsonResponse(r.ok ? 200 : (r as { status: number }).status, r, cors);
      }
      case "approve_bulk": {
        const r = await handleApproveBulk(admin, ctx, {
          timesheet_ids: Array.isArray(body.timesheet_ids)
            ? body.timesheet_ids.map((x) => String(x))
            : [],
        });
        return jsonResponse(200, r, cors);
      }
      case "unapprove": {
        const r = await handleUnapprove(admin, ctx, {
          timesheet_id: String(body.timesheet_id || ""),
        });
        return jsonResponse(r.ok ? 200 : (r as { status: number }).status, r, cors);
      }
      case "edit_timesheet": {
        const r = await handleEditTimesheet(admin, ctx, {
          timesheet_id: String(body.timesheet_id || ""),
          edits: (body.edits as Record<string, number>) || {},
          reason: String(body.reason || ""),
        });
        return jsonResponse(r.ok ? 200 : (r as { status: number }).status, r, cors);
      }
      case "edit_shift_rate": {
        const r = await handleEditShiftRate(admin, ctx, {
          timesheet_id: String(body.timesheet_id || ""),
          shift_id: String(body.shift_id || ""),
          hourly_rate: Number(body.hourly_rate),
          reason: String(body.reason || ""),
        });
        return jsonResponse(r.ok ? 200 : (r as { status: number }).status, r, cors);
      }
      case "edit_shift_mileage": {
        const r = await handleEditShiftMileage(admin, ctx, {
          timesheet_id: String(body.timesheet_id || ""),
          shift_id: String(body.shift_id || ""),
          mileage: Number(body.mileage),
          reason: String(body.reason || ""),
        });
        return jsonResponse(r.ok ? 200 : (r as { status: number }).status, r, cors);
      }
      default:
        return jsonResponse(400, { error: `Unknown action "${action}".` }, cors);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[payroll-timesheet-actions] handler threw: ${message}`);
    return jsonResponse(500, { error: `Internal error: ${message}` }, cors);
  }
});
