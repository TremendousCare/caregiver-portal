// ─── Paychex backfill: short employeeId → caregivers ───
//
// One-shot helper for Phase 4 PR #1. The Paychex SPI ("Hours Only
// Flexible") CSV requires the SHORT per-company employee number
// (e.g. "54", "67") in its Worker ID column — distinct from the long
// alphanumeric workerId we currently store in `caregivers.paychex_worker_id`.
//
// This function fetches the Paychex worker list for the caller's org
// company and populates `caregivers.paychex_employee_id` for any
// caregiver where:
//   - the column is currently null, AND
//   - the caregiver has a `paychex_worker_id` that matches a Paychex
//     worker's `workerId` field (one-to-one).
//
// We also tolerate matching via `workerCorrelationId == caregivers.id`
// for robustness — Phase 2's mapping function sets this on every POST,
// so it's the most reliable identity link. Either match populates the
// column.
//
// Idempotent: re-running is a no-op for caregivers whose employeeId is
// already set. The owner invokes this once after PR #1 merge, then
// once after Paychex enables the worker WRITE entitlement (when the
// remaining real syncs land).
//
// Multi-tenancy:
//   - org_id derives from the caller's JWT.
//   - companyId comes from organizations.settings.paychex.company_id;
//     missing means org is misconfigured and the function fails loud.
//   - Audit log rows carry org_id (handled by paychexCall in
//     _shared/paychex.ts).
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   docs/handoff-paychex-phase-4.md ("Worker ID — data model gap").

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  listCompanyWorkers,
  makeServiceClient,
  PaychexError,
} from "../_shared/paychex.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const ALLOWED_ORIGINS = [
  "https://caregiver-portal.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // safety: 5000 workers max per run

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
    ctx: { orgId, userEmail: userData.user.email ?? null },
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

interface CaregiverRow {
  id: string;
  paychex_worker_id: string | null;
  paychex_employee_id: string | null;
}

interface PaychexWorkerSummary {
  workerId?: string | null;
  employeeId?: string | null;
  workerCorrelationId?: string | null;
}

/**
 * Pull the worker list out of Paychex's response. Paychex returns
 * `{ metadata: { ... }, content: [...] }` with workers in `content`.
 * Defensive: also accept a bare array (in case the envelope changes).
 */
function extractWorkerList(body: unknown): PaychexWorkerSummary[] {
  if (Array.isArray(body)) return body as PaychexWorkerSummary[];
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const candidate = (obj.content ?? obj.data) as unknown;
    if (Array.isArray(candidate)) return candidate as PaychexWorkerSummary[];
  }
  return [];
}

/**
 * Pull the total count from Paychex's metadata so we know when to
 * stop paginating. Returns null when the envelope doesn't carry it,
 * in which case we paginate until an empty page.
 */
function extractTotalCount(body: unknown): number | null {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const meta = obj.metadata as Record<string, unknown> | undefined;
    const pagination = meta?.pagination as Record<string, unknown> | undefined;
    const total = pagination?.total;
    if (typeof total === "number" && Number.isFinite(total)) return total;
  }
  return null;
}

// ─── Main handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse(405, { error: "POST required." }, cors);

  // ── Auth ──
  const authResult = await authenticateRequest(req.headers.get("Authorization"));
  if (!authResult.ok) return jsonResponse(authResult.status, { error: authResult.error }, cors);
  const { orgId } = authResult.ctx;

  const admin = makeServiceClient();

  const staffCheck = await assertStaff(admin, authResult.ctx.userEmail);
  if (!staffCheck.ok) {
    return jsonResponse(staffCheck.status, { error: staffCheck.error }, cors);
  }

  // ── Optional body: { dry_run?: boolean } ──
  let dryRun = false;
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await req.json();
      dryRun = body?.dry_run === true;
    } catch {
      // ignore — empty body is fine
    }
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
  if (!orgRow) {
    return jsonResponse(403, { error: "Organization not found for caller." }, cors);
  }
  const settings = ((orgRow as { settings: Record<string, unknown> }).settings ?? {});
  const paychex = (settings.paychex as Record<string, unknown> | undefined) ?? {};
  const companyId = paychex.company_id;
  if (typeof companyId !== "string" || companyId.trim() === "") {
    return jsonResponse(412, {
      error:
        "Org is missing organizations.settings.paychex.company_id. Configure the org's Paychex company before backfilling employee IDs.",
    }, cors);
  }

  // ── Load caregivers needing backfill ──
  // Until Phase B adds caregivers.org_id, we cannot org-scope the
  // caregivers fetch directly. The staff role check is the cross-tenant
  // gate; TC is the only org today. Once Phase B lands, add
  // `.eq("org_id", orgId)`.
  const { data: cgData, error: cgErr } = await admin
    .from("caregivers")
    .select("id, paychex_worker_id, paychex_employee_id")
    .is("paychex_employee_id", null);
  if (cgErr) {
    return jsonResponse(500, { error: `caregivers query failed: ${cgErr.message}` }, cors);
  }
  const caregivers = (cgData ?? []) as CaregiverRow[];

  // Build lookup tables for matching.
  const byWorkerId = new Map<string, CaregiverRow>();
  const byCorrelationId = new Map<string, CaregiverRow>();
  for (const cg of caregivers) {
    if (cg.paychex_worker_id) byWorkerId.set(cg.paychex_worker_id, cg);
    byCorrelationId.set(cg.id, cg);
  }

  if (caregivers.length === 0) {
    return jsonResponse(200, {
      ok: true,
      message: "All caregivers already have a paychex_employee_id; nothing to do.",
      caregivers_considered: 0,
      caregivers_updated: 0,
      paychex_workers_seen: 0,
      dry_run: dryRun,
    }, cors);
  }

  // ── Paginate Paychex workers ──
  const ctx = { supabase: admin, orgId };
  const matches: Array<{ caregiver_id: string; employeeId: string; matchedOn: string }> = [];
  const pageErrors: Array<{ page: number; message: string }> = [];

  let offset = 0;
  let totalSeen = 0;
  let totalCount: number | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result;
    try {
      result = await listCompanyWorkers(ctx, {
        companyId,
        offset,
        limit: PAGE_LIMIT,
      });
    } catch (err) {
      const message = err instanceof PaychexError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
        ? err.message
        : String(err);
      pageErrors.push({ page, message });
      // Don't abort the whole run — record what we have so far and
      // return a partial result. The caller can re-invoke after
      // resolving the underlying issue.
      break;
    }

    if (totalCount === null) totalCount = extractTotalCount(result.body);
    const workers = extractWorkerList(result.body);
    totalSeen += workers.length;

    for (const w of workers) {
      const employeeId =
        typeof w.employeeId === "string" && w.employeeId.trim() !== ""
          ? w.employeeId.trim()
          : null;
      if (!employeeId) continue;

      // Prefer match on workerCorrelationId (= caregivers.id, set by
      // Phase 2's mapping). Fall back to workerId for caregivers that
      // were synced before correlation IDs were established.
      let cg: CaregiverRow | undefined;
      let matchedOn = "";
      if (w.workerCorrelationId && byCorrelationId.has(w.workerCorrelationId)) {
        cg = byCorrelationId.get(w.workerCorrelationId);
        matchedOn = "workerCorrelationId";
      } else if (w.workerId && byWorkerId.has(w.workerId)) {
        cg = byWorkerId.get(w.workerId);
        matchedOn = "workerId";
      }
      if (cg) {
        // Skip duplicates within the same run (defensive).
        if (!matches.find((m) => m.caregiver_id === cg!.id)) {
          matches.push({ caregiver_id: cg.id, employeeId, matchedOn });
        }
      }
    }

    // Stop conditions: empty page, fewer-than-limit page, or known
    // total reached.
    if (workers.length === 0 || workers.length < PAGE_LIMIT) break;
    if (totalCount !== null && totalSeen >= totalCount) break;

    offset += PAGE_LIMIT;
  }

  // ── Apply the updates ──
  let updated = 0;
  const updateErrors: Array<{ caregiver_id: string; message: string }> = [];

  if (!dryRun) {
    for (const m of matches) {
      const { error: updateErr } = await admin
        .from("caregivers")
        .update({ paychex_employee_id: m.employeeId })
        .eq("id", m.caregiver_id)
        .is("paychex_employee_id", null);
      if (updateErr) {
        updateErrors.push({ caregiver_id: m.caregiver_id, message: updateErr.message });
        continue;
      }
      updated += 1;
    }
  }

  return jsonResponse(updateErrors.length > 0 || pageErrors.length > 0 ? 207 : 200, {
    ok: updateErrors.length === 0 && pageErrors.length === 0,
    dry_run: dryRun,
    caregivers_considered: caregivers.length,
    caregivers_updated: updated,
    matches_found: matches.length,
    paychex_workers_seen: totalSeen,
    paychex_total_reported: totalCount,
    page_errors: pageErrors,
    update_errors: updateErrors,
    matches: matches.slice(0, 100), // first 100 for visibility; capped to keep response sane
  }, cors);
});
