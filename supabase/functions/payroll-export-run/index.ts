// ─── Payroll: export an approved payroll run as a Paychex SPI CSV ───
//
// Triggered from the Phase 4 PR #2 "Generate Payroll Run" modal in
// ThisWeekView after the back office types the gross-total
// confirmation. Receives a list of approved timesheet IDs and:
//
//   1. Validates auth (JWT-derived org_id + staff role).
//   2. Loads every timesheet by id, refusing the call if any is not
//      `approved` or doesn't belong to the caller's org. Cross-tenant
//      mixing is a hard fail (cross-tenant guard test in
//      approvalStateMachine).
//   3. Loads each caregiver's `paychex_employee_id` so the CSV can
//      identify the worker. Missing → `caregiver_missing_paychex_employee_id`
//      block, which should already have prevented approval; defensive.
//   4. Generates the SPI "Hours Only Flexible" CSV via the canonical
//      `generatePaychexCsv(timesheets, orgSettings)` pure function
//      (already shipped in Phase 4 PR #1).
//   5. Inserts a `payroll_runs` row in status `exported` with totals
//      (timesheet_count, total_gross, total_mileage), pay_period_start,
//      pay_period_end, pay_date, submitted_by, submitted_at, and the
//      generated csv_export_url + export_filename.
//   6. Marks each member timesheet as `exported` with `exported_at`.
//   7. Uploads the CSV to the private `payroll-exports` storage bucket
//      under `<org_id>/<payroll_run_id>.csv`.
//   8. Mints a short-lived signed URL (5 minutes) and returns it so
//      the frontend can trigger a download.
//   9. Writes a `payroll_run_submitted` event for the audit log.
//
// Production / dry-run: a `dry_run: true` body parameter (or the
// `PAYCHEX_DRY_RUN` env flag) skips the persistent state changes
// (no payroll_runs insert, no timesheet status flip, no event log)
// but still uploads the CSV so the back office can preview the
// exact bytes Paychex will see. This mirrors how PAYCHEX_DRY_RUN
// behaves elsewhere (see _shared/paychex.ts).
//
// Multi-tenancy:
//   - org_id derives from the caller's JWT.
//   - Every timesheet's `org_id` is verified against the caller's
//     org. Mismatch → 403 (cross-tenant guard).
//   - CSV file path is org-prefixed so storage RLS gates reads.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   docs/handoff-paychex-phase-4.md  ("PR #2 — Edits + approval + ...")

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { generatePaychexCsv } from "../../../src/lib/payroll/csvExport.js";
import {
  evaluateExportEligibility,
  TIMESHEET_STATUS,
} from "../../../src/lib/payroll/approvalStateMachine.js";
import { computeRegularRateOfPay } from "../../../src/lib/payroll/overtimeRules.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const ALLOWED_ORIGINS = [
  "https://caregiver-portal.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes — enough for one click-and-download.
const STORAGE_BUCKET = "payroll-exports";

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

function isDryRunEnv(): boolean {
  const v = Deno.env.get("PAYCHEX_DRY_RUN");
  if (!v) return false;
  const lower = v.trim().toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes";
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

// ─── Helpers ─────────────────────────────────────────────────────

interface TimesheetRow {
  id: string;
  org_id: string;
  caregiver_id: string;
  status: string;
  pay_period_start: string;
  pay_period_end: string;
  regular_hours: number | null;
  overtime_hours: number | null;
  double_time_hours: number | null;
  mileage_total: number | null;
  mileage_reimbursement: number | null;
  gross_pay: number | null;
  regular_by_rate: Array<{ rate: number; hours: number }> | null;
  regular_rate_of_pay: number | null;
}

interface CaregiverRow {
  id: string;
  paychex_employee_id: string | null;
}

// ─── Main handler ───────────────────────────────────────────────

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
  let body: { timesheet_ids?: string[]; pay_date?: string; dry_run?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Body must be valid JSON." }, cors);
  }
  const ids = Array.isArray(body.timesheet_ids)
    ? body.timesheet_ids.map((x) => String(x)).filter((x) => x.length > 0)
    : [];
  if (ids.length === 0) {
    return jsonResponse(400, { error: "timesheet_ids must be a non-empty array." }, cors);
  }
  const dryRun = body.dry_run === true || isDryRunEnv();

  // ── Load timesheets (org-scoped) ──
  // Don't filter by org_id at the SELECT — fetch by id and then verify
  // every row's org_id matches. That way a forged id targeting another
  // org returns "not found" rather than silently dropping (we want
  // the cross-tenant guard to fire and surface a clear error).
  const { data: tsData, error: tsErr } = await admin
    .from("timesheets")
    .select(`
      id, org_id, caregiver_id, status,
      pay_period_start, pay_period_end,
      regular_hours, overtime_hours, double_time_hours,
      mileage_total, mileage_reimbursement, gross_pay,
      regular_by_rate, regular_rate_of_pay
    `)
    .in("id", ids);
  if (tsErr) {
    return jsonResponse(500, { error: `Timesheets lookup failed: ${tsErr.message}` }, cors);
  }
  const fetched = (tsData ?? []) as TimesheetRow[];
  if (fetched.length !== ids.length) {
    const found = new Set(fetched.map((t) => t.id));
    const missing = ids.filter((x) => !found.has(x));
    return jsonResponse(404, {
      error: `Timesheet(s) not found or not visible: ${missing.join(", ")}`,
    }, cors);
  }
  // Verify every row belongs to the caller's org. Cross-tenant guard.
  for (const t of fetched) {
    if (t.org_id !== orgId) {
      return jsonResponse(403, {
        error:
          "Refusing to export timesheets from another organization. "
            + "Confirm the timesheet IDs belong to your org.",
        code: "cross_tenant",
      }, cors);
    }
  }

  // ── Status / eligibility ──
  const eligibility = evaluateExportEligibility({ timesheets: fetched });
  if (!eligibility.ok) {
    return jsonResponse(422, {
      error: eligibility.message,
      code: eligibility.code,
    }, cors);
  }

  // All same period? In v1 we only export approved drafts from a
  // single workweek (the "Generate Run" button surfaces only the
  // current period). Refuse mixed-period exports loudly so a future
  // bug can't accidentally bundle two weeks into one Paychex check.
  const distinctPeriods = new Set(fetched.map((t) => t.pay_period_start));
  if (distinctPeriods.size > 1) {
    return jsonResponse(422, {
      error:
        "Refusing to export timesheets spanning multiple pay periods in a single run. "
          + "Generate one run per workweek.",
      code: "mixed_pay_period",
      pay_periods: Array.from(distinctPeriods),
    }, cors);
  }
  const payPeriodStart = fetched[0].pay_period_start;
  const payPeriodEnd = fetched[0].pay_period_end;

  // ── Load caregiver paychex_employee_ids (org-scoped) ──
  const caregiverIds = Array.from(new Set(fetched.map((t) => t.caregiver_id)));
  const caregiverMap = new Map<string, CaregiverRow>();
  for (let i = 0; i < caregiverIds.length; i += 500) {
    const batch = caregiverIds.slice(i, i + 500);
    const { data: cgData, error: cgErr } = await admin
      .from("caregivers")
      .select("id, paychex_employee_id")
      .eq("org_id", orgId)
      .in("id", batch);
    if (cgErr) {
      return jsonResponse(500, { error: `Caregivers lookup failed: ${cgErr.message}` }, cors);
    }
    for (const row of (cgData ?? []) as CaregiverRow[]) {
      caregiverMap.set(row.id, row);
    }
  }

  // ── Load org settings for the CSV (display_id, mileage_rate, pay_components) ──
  const { data: orgRow, error: orgErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) {
    return jsonResponse(500, { error: `Org lookup failed: ${orgErr.message}` }, cors);
  }
  if (!orgRow) {
    return jsonResponse(403, { error: "Organization not found for caller." }, cors);
  }
  const settings = ((orgRow as { settings: Record<string, unknown> }).settings ?? {});
  const paychexSettings = (settings.paychex as Record<string, unknown> | undefined) ?? {};
  const payrollSettings = (settings.payroll as Record<string, unknown> | undefined) ?? {};

  // Default pay_date to today (UTC). Frontend may override via body.
  const payDate = typeof body.pay_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.pay_date)
    ? body.pay_date
    : new Date().toISOString().slice(0, 10);

  // ── Backfill regular_by_rate / ROP for legacy (pre-PR-2) rows ──
  // Phase 4 PR #2 added two persisted columns the cron + regenerate
  // populate at draft time:
  //   - regular_by_rate (jsonb [{rate, hours}, ...])
  //   - regular_rate_of_pay (numeric)
  // Drafts written before this PR shipped have BOTH null. Without a
  // backfill, csvExport's legacy single-rate path requires a
  // top-level `hourly_rate` we can't derive from the row alone — so
  // a legacy row would 422 the entire run. Fix: for any timesheet
  // missing both columns, look up its shifts (via the
  // timesheet_shifts junction joined to shifts.hourly_rate), then
  // run computeRegularRateOfPay just like the cron would. The result
  // populates the multi-rate path identically to a freshly-regenerated
  // draft. One extra read per legacy row only — PR-2 drafts skip the
  // lookup entirely.
  const legacyTimesheetIds = fetched
    .filter((t) =>
      !Array.isArray(t.regular_by_rate)
        && (t.regular_rate_of_pay == null || !Number.isFinite(Number(t.regular_rate_of_pay))),
    )
    .map((t) => t.id);
  const backfillByTimesheetId = new Map<
    string,
    { regular_by_rate: Array<{ rate: number; hours: number }>; regular_rate_of_pay: number }
  >();
  if (legacyTimesheetIds.length > 0) {
    const { data: linkData, error: linkErr } = await admin
      .from("timesheet_shifts")
      .select("timesheet_id, shift_id, hours_worked, hour_classification, shifts!inner(hourly_rate, org_id)")
      .in("timesheet_id", legacyTimesheetIds);
    if (linkErr) {
      return jsonResponse(500, {
        error: `Legacy timesheet shift lookup failed: ${linkErr.message}`,
      }, cors);
    }
    type LinkRow = {
      timesheet_id: string;
      shift_id: string;
      hours_worked: number | null;
      hour_classification: string;
      shifts: { hourly_rate: number | null; org_id: string };
    };
    const byTs = new Map<string, LinkRow[]>();
    for (const row of (linkData ?? []) as LinkRow[]) {
      // Defense in depth: refuse to use any joined shift not in the
      // caller's org. The `org_id` filter on `shifts` in storage RLS
      // already covers this; verify explicitly so a future RLS bug
      // can't cause a cross-tenant rate read.
      if (row.shifts?.org_id !== orgId) continue;
      if (!byTs.has(row.timesheet_id)) byTs.set(row.timesheet_id, []);
      byTs.get(row.timesheet_id)!.push(row);
    }
    for (const [tsId, links] of byTs) {
      const ropResult = computeRegularRateOfPay({
        byShiftWithRates: links.map((l) => ({
          hours: Number(l.hours_worked) || 0,
          rate: l.shifts?.hourly_rate != null ? Number(l.shifts.hourly_rate) : null,
        })),
      });
      // Aggregate per-rate buckets: legacy timesheet_shifts only stores
      // the dominant hour_classification per shift (a 12h shift with
      // 8h reg + 4h OT is recorded as a single regular row). Without
      // a per-class breakdown we can't accurately split into Reg / OT
      // / DT buckets — so fold ALL shifts into the rate buckets and
      // let the row's stored `regular_hours` total truncate to the
      // correct number on the CSV. This is an approximation that
      // matches what TC's back office did manually for years; PR-2
      // drafts get the exact split.
      const byRate = new Map<number, number>();
      for (const l of links) {
        const h = Number(l.hours_worked) || 0;
        const r = l.shifts?.hourly_rate;
        if (h <= 0 || r == null || !Number.isFinite(Number(r)) || Number(r) <= 0) continue;
        // Only count regular-classified hours toward Hourly buckets;
        // OT-classified shifts contribute via the ROP × 1.5 OT row.
        if (l.hour_classification !== "regular") continue;
        const prev = byRate.get(Number(r)) ?? 0;
        byRate.set(Number(r), prev + h);
      }
      const regularByRate = Array.from(byRate.entries())
        .map(([rate, hours]) => ({ rate, hours: Math.round(hours * 100) / 100 }))
        .sort((a, b) => a.rate - b.rate);
      // ROP can be null when no shift had a usable rate; that case is
      // already covered by the caregiver_missing_rate exception so the
      // row would have been blocked from approval. Skip backfill in
      // that case and let the eventual csvExport throw with the right
      // error.
      if (regularByRate.length > 0 && ropResult.regularRateOfPay != null) {
        backfillByTimesheetId.set(tsId, {
          regular_by_rate: regularByRate,
          regular_rate_of_pay: ropResult.regularRateOfPay,
        });
      }
    }
  }

  // ── Build the CSV-shaped timesheet inputs ──
  // Each entry needs: paychex_employee_id, regular_by_rate (or
  // hourly_rate fallback), regular_rate_of_pay, overtime_hours,
  // double_time_hours, mileage_total. Aggregate totals for the
  // payroll_runs row at the same time.
  const csvInputs: Array<{
    caregiver_id: string;
    paychex_employee_id: string | null;
    regular_by_rate: Array<{ rate: number; hours: number }> | null;
    regular_rate_of_pay: number | null;
    hourly_rate: number | null;
    regular_hours: number;
    overtime_hours: number;
    double_time_hours: number;
    mileage_total: number;
  }> = [];

  let totalGross = 0;
  let totalMileage = 0;
  for (const t of fetched) {
    const cg = caregiverMap.get(t.caregiver_id);
    const employeeId = cg?.paychex_employee_id ?? null;
    if (!employeeId) {
      return jsonResponse(422, {
        error:
          `Caregiver ${t.caregiver_id} has no paychex_employee_id. `
            + "Run paychex-backfill-employee-ids before exporting.",
        code: "caregiver_missing_paychex_employee_id",
        timesheet_id: t.id,
      }, cors);
    }

    const reg = Number(t.regular_hours) || 0;
    const ot = Number(t.overtime_hours) || 0;
    const dt = Number(t.double_time_hours) || 0;
    const mileage = Number(t.mileage_total) || 0;

    // Resolve per-rate input. PR-2 rows: read straight from the row.
    // Legacy rows: use the on-the-fly backfill we just computed above.
    const persistedByRate = Array.isArray(t.regular_by_rate) ? t.regular_by_rate : null;
    const persistedRop = t.regular_rate_of_pay ?? null;
    const backfill = backfillByTimesheetId.get(t.id) ?? null;
    const resolvedByRate = persistedByRate ?? backfill?.regular_by_rate ?? null;
    const resolvedRop = persistedRop ?? backfill?.regular_rate_of_pay ?? null;

    csvInputs.push({
      caregiver_id: t.caregiver_id,
      paychex_employee_id: employeeId,
      regular_by_rate: resolvedByRate,
      regular_rate_of_pay: resolvedRop,
      // Legacy fallback for the truly degenerate case (no per-rate
      // backfill possible because the underlying shifts had no rates):
      // pass the ROP as `hourly_rate` so csvExport's single-rate path
      // can still emit one row. csvExport otherwise prefers
      // regular_by_rate when present.
      hourly_rate: resolvedRop,
      regular_hours: reg,
      overtime_hours: ot,
      double_time_hours: dt,
      mileage_total: mileage,
    });

    totalGross += Number(t.gross_pay) || 0;
    totalMileage += mileage;
  }

  // Round to 2dp for the run row totals.
  totalGross = Math.round(totalGross * 100) / 100;
  totalMileage = Math.round(totalMileage * 100) / 100;

  // ── Generate the CSV string ──
  let csvText: string;
  try {
    csvText = generatePaychexCsv(csvInputs, settings);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(422, {
      error: `CSV generation failed: ${message}`,
      code: "csv_generation_failed",
    }, cors);
  }

  // ── Insert payroll_runs row first so we have a stable id for the path ──
  // Skip in dry-run; we still upload the CSV under a synthetic path so
  // the back office can preview, but no DB state moves.
  let payrollRunId: string | null = null;
  let exportFilename: string | null = null;

  if (!dryRun) {
    const filename = `${payPeriodStart}_${payPeriodEnd}_run.csv`;
    const { data: runData, error: runErr } = await admin
      .from("payroll_runs")
      .insert({
        org_id: orgId,
        pay_period_start: payPeriodStart,
        pay_period_end: payPeriodEnd,
        pay_date: payDate,
        status: "exported",
        submission_mode: "csv_export",
        timesheet_count: fetched.length,
        total_gross: totalGross,
        total_mileage: totalMileage,
        export_filename: filename,
        submitted_by: userEmail || "unknown",
        submitted_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (runErr) {
      return jsonResponse(500, {
        error: `payroll_runs insert failed: ${runErr.message}`,
      }, cors);
    }
    payrollRunId = (runData as { id: string }).id;
    exportFilename = filename;
  } else {
    // Dry-run: synthetic id and filename for the storage path.
    payrollRunId = `dryrun-${Date.now()}`;
    exportFilename = `${payPeriodStart}_${payPeriodEnd}_dryrun.csv`;
  }

  // ── Upload to storage ──
  const objectPath = `${orgId}/${payrollRunId}.csv`;
  const csvBytes = new TextEncoder().encode(csvText);
  const { error: uploadErr } = await admin.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, csvBytes, {
      contentType: "text/csv",
      upsert: true,
    });
  if (uploadErr) {
    // Try to roll back the payroll_runs insert if the upload failed —
    // otherwise we'd have an "exported" run pointing to nothing.
    if (!dryRun && payrollRunId) {
      await admin.from("payroll_runs").delete().eq("id", payrollRunId).eq("org_id", orgId);
    }
    return jsonResponse(500, { error: `CSV upload failed: ${uploadErr.message}` }, cors);
  }

  // ── Sign a short-lived URL ──
  // Signed URLs are returned by Storage's createSignedUrl helper. We
  // pass `download` so the URL forces a save dialog instead of
  // opening inline (Paychex cares about the file extension).
  const { data: signedData, error: signedErr } = await admin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS, { download: exportFilename || undefined });
  if (signedErr || !signedData?.signedUrl) {
    return jsonResponse(500, {
      error: `Signed URL generation failed: ${signedErr?.message ?? "no signed URL returned"}`,
    }, cors);
  }
  const signedUrl = signedData.signedUrl;

  // ── Update payroll_runs row with the storage URL (real runs only) ──
  if (!dryRun && payrollRunId) {
    const { error: updateRunErr } = await admin
      .from("payroll_runs")
      .update({ csv_export_url: objectPath })
      .eq("id", payrollRunId)
      .eq("org_id", orgId);
    if (updateRunErr) {
      console.warn(`[payroll-export-run] payroll_runs csv_export_url update failed: ${updateRunErr.message}`);
    }
  }

  // ── Mark each timesheet as exported (real runs only) ──
  // Optimistic concurrency: the UPDATE filter `status = approved`
  // matches zero rows if anyone (or another concurrent export call)
  // modified the row after we read it. supabase-js does NOT raise an
  // error in that case — it silently updates zero rows. Without the
  // .select() return-rows check below, the function would create the
  // payroll_runs row, leave the timesheet at `approved`, and return
  // success — letting the same row export again next call.
  //
  // Strategy: use `.select("id")` after `.update()`, treat any row
  // that doesn't come back as a concurrent-modification failure, and
  // if ANY row failed, roll the whole export back: delete the
  // payroll_runs row + delete the uploaded CSV, then return 409.
  // Some rows may already have flipped to `exported`; revert those
  // back to `approved` to preserve the invariant that an `exported`
  // row's csv_export_url points to a real run.
  if (!dryRun) {
    const exportedAt = new Date().toISOString();
    const flipped: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const t of fetched) {
      const { data: updatedRows, error: tsUpdateErr } = await admin
        .from("timesheets")
        .update({
          status: TIMESHEET_STATUS.EXPORTED,
          exported_at: exportedAt,
        })
        .eq("id", t.id)
        .eq("org_id", orgId)
        .eq("status", TIMESHEET_STATUS.APPROVED)
        .select("id");
      if (tsUpdateErr) {
        skipped.push({ id: t.id, reason: tsUpdateErr.message });
        continue;
      }
      if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
        skipped.push({
          id: t.id,
          reason:
            "Status was no longer 'approved' at update time (concurrent modification?).",
        });
        continue;
      }
      flipped.push(t.id);
    }

    if (skipped.length > 0) {
      // Roll back: revert any row we already flipped, delete the
      // payroll_runs row, delete the uploaded CSV. The signed URL we
      // already minted will simply 404 once the object is gone, which
      // is fine — the frontend treats a 409 as a hard failure.
      for (const flippedId of flipped) {
        await admin
          .from("timesheets")
          .update({
            status: TIMESHEET_STATUS.APPROVED,
            exported_at: null,
          })
          .eq("id", flippedId)
          .eq("org_id", orgId)
          .eq("status", TIMESHEET_STATUS.EXPORTED);
      }
      if (payrollRunId) {
        await admin
          .from("payroll_runs")
          .delete()
          .eq("id", payrollRunId)
          .eq("org_id", orgId);
      }
      await admin.storage
        .from(STORAGE_BUCKET)
        .remove([objectPath]);
      return jsonResponse(409, {
        ok: false,
        error:
          "One or more timesheets were not in 'approved' status when the export tried to "
            + "flip them. The run was rolled back; refresh the page and try again.",
        code: "concurrent_modification",
        skipped,
      }, cors);
    }

    // Audit event (org-level; no caregiver entity).
    admin
      .from("events")
      .insert({
        event_type: "payroll_run_submitted",
        entity_type: "caregiver", // events.entity_type CHECK only allows caregiver/client; the run is org-level so we attach to a representative caregiver
        entity_id: fetched[0].caregiver_id,
        actor: `user:${userEmail || "unknown"}`,
        org_id: orgId,
        payload: {
          payroll_run_id: payrollRunId,
          org_id: orgId,
          pay_period_start: payPeriodStart,
          pay_period_end: payPeriodEnd,
          pay_date: payDate,
          submission_mode: "csv_export",
          timesheet_count: fetched.length,
          timesheet_ids: fetched.map((t) => t.id),
          total_gross: totalGross,
          total_mileage: totalMileage,
          export_filename: exportFilename,
          dry_run: false,
        },
      })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(`[payroll-export-run] event log failed: ${error.message}`);
        }
      });
  }

  return jsonResponse(200, {
    ok: true,
    dry_run: dryRun,
    payroll_run_id: dryRun ? null : payrollRunId,
    timesheet_count: fetched.length,
    total_gross: totalGross,
    total_mileage: totalMileage,
    pay_period_start: payPeriodStart,
    pay_period_end: payPeriodEnd,
    pay_date: payDate,
    csv_filename: exportFilename,
    csv_signed_url: signedUrl,
    csv_signed_url_expires_in_seconds: SIGNED_URL_TTL_SECONDS,
  }, cors);
});
