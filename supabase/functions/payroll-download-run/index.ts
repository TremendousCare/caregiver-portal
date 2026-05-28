// ─── Payroll: download an existing run's CSV ───
//
// Triggered from the Phase 4 PR #3 PayrollRunsView "Download CSV"
// button. The original CSV was generated and uploaded to storage at
// run-creation time (`payroll-export-run`); this function re-mints a
// short-lived signed URL pointing at the same storage object.
//
// We deliberately do NOT regenerate the CSV from current timesheet
// data. Once a run is exported, its CSV is the source of truth for
// what was sent to Paychex — re-generating could introduce drift if
// any underlying data changed. The fact that exported timesheets
// can't be edited (Phase 4 PR #2 enforces this) means a fresh
// generate would usually match anyway, but "preserve the bytes the
// back office originally pulled" is a safer rule.
//
// Multi-tenancy:
//   - org_id derives from the caller's JWT.
//   - The run's org_id is verified against the caller's.
//   - The storage bucket's RLS policy gates path-prefix reads to
//     `<jwt.org_id>/...`, so signed URLs minted for another org
//     would fail anyway.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   docs/handoff-paychex-phase-4.md  ("PR #3 — Payroll Runs view + ...")

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const ALLOWED_ORIGINS = [
  "https://caregiver-portal.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes — same as payroll-export-run
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
  // Owners are admins hierarchically (mirrors public.is_admin() =
  // role IN ('admin','owner')); a literal === 'admin' locks owners out.
  if (!roleRow || !["admin", "owner"].includes((roleRow as { role: string }).role)) {
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
  let body: { payroll_run_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Body must be valid JSON." }, cors);
  }
  const runId = typeof body.payroll_run_id === "string" ? body.payroll_run_id : null;
  if (!runId) {
    return jsonResponse(400, { error: "payroll_run_id is required." }, cors);
  }

  // ── Load run (org-scoped) ──
  const { data: runRow, error: runErr } = await admin
    .from("payroll_runs")
    .select("id, org_id, status, csv_export_url, export_filename, pay_period_start, pay_period_end")
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
    csv_export_url: string | null; export_filename: string | null;
    pay_period_start: string; pay_period_end: string;
  };

  // Pre-export draft runs have no CSV. Only run statuses with a stored
  // CSV qualify; deliberately accept all four post-export statuses
  // (exported / submitted / processing / completed) so the back office
  // can re-pull a CSV any time after the initial export.
  const STATUSES_WITH_CSV = new Set(["exported", "submitted", "processing", "completed"]);
  if (!STATUSES_WITH_CSV.has(run.status)) {
    return jsonResponse(422, {
      error: `Run is in status "${run.status}"; no CSV exists yet. Generate the run first.`,
      code: "no_csv_yet",
    }, cors);
  }
  if (!run.csv_export_url) {
    return jsonResponse(422, {
      error:
        "Run has no csv_export_url recorded. The original export may have failed mid-flight; "
          + "re-run Generate Payroll Run for this period.",
      code: "csv_path_missing",
    }, cors);
  }

  // ── Sign a fresh short-lived URL ──
  const filename = run.export_filename
    || `${run.pay_period_start}_${run.pay_period_end}_run.csv`;
  const { data: signedData, error: signedErr } = await admin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(run.csv_export_url, SIGNED_URL_TTL_SECONDS, { download: filename });
  if (signedErr || !signedData?.signedUrl) {
    return jsonResponse(500, {
      error:
        `Signed URL generation failed: ${signedErr?.message ?? "no signed URL returned"}. `
          + "The storage object may have been deleted.",
      code: "storage_object_missing",
    }, cors);
  }

  return jsonResponse(200, {
    ok: true,
    payroll_run_id: run.id,
    csv_filename: filename,
    csv_signed_url: signedData.signedUrl,
    csv_signed_url_expires_in_seconds: SIGNED_URL_TTL_SECONDS,
  }, cors);
});
