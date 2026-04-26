// ─── Paychex Sync Worker ───
//
// Given { caregiver_id } in the request body, syncs that caregiver to
// Paychex Flex as a Worker. First sync = POST. Subsequent syncs =
// PATCH (or rehire-block if Paychex shows the worker as TERMINATED).
//
// Multi-tenancy:
//   - org_id derives from the caller's JWT, never from the request body.
//   - companyId loads from organizations.settings.paychex.company_id;
//     missing means the org is misconfigured and the function fails
//     loud rather than syncing to the wrong Paychex company.
//   - All audit log rows carry org_id.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   ("Phase 2 — Paychex client and worker sync").

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  WORKER_NONPII_MEDIA_TYPE,
  buildSyncIdempotencyKey,
  getWorker,
  makeServiceClient,
  patchWorker,
  PaychexError,
  postWorker,
} from "../_shared/paychex.ts";

// Cross-tree import: the mapping function is canonical at
// src/lib/paychex/workerMapping.js so vitest can exercise it without
// pulling in Deno globals. Supabase's deploy bundler resolves
// relative imports outside the function dir, so this works at
// deploy time. Future edits to the mapping file should ride
// alongside an edge function change to trigger the
// .github/workflows/deploy-edge-functions.yml path filter.
import { buildPaychexWorker, detectRehire } from "../../../src/lib/paychex/workerMapping.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
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

// ─── Auth helpers ──────────────────────────────────────────────────

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

  // The SaaS retrofit Phase A custom access token hook embeds org_id
  // as a top-level JWT claim. Decode the token directly; we don't
  // need a service-role lookup just to read claims that are in the
  // signed payload.
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, error: "Malformed JWT." };
  }
  let payload: Record<string, unknown>;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const json = atob(padded);
    payload = JSON.parse(json);
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

  // Confirm the JWT is real (signature valid + not expired) by
  // resolving the user via the anon client. This catches forged
  // tokens whose org_id was hand-crafted.
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

// ─── Helpers ───────────────────────────────────────────────────────

function truncateError(message: string, max = 500): string {
  return message.length <= max ? message : message.slice(0, max) + "…";
}

interface CaregiverRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  middle_name?: string | null;
  preferred_name?: string | null;
  paychex_worker_id: string | null;
  paychex_sync_status: string | null;
}

interface OrgSettings {
  paychex?: {
    company_id?: string;
    [key: string]: unknown;
  };
  payroll?: Record<string, unknown>;
  features_enabled?: { payroll?: boolean };
  [key: string]: unknown;
}

// Pull the worker's Paychex shape from the array-shape POST response,
// the array-shape PATCH response, or a single-object GET response.
function extractWorkerShape(body: unknown): Record<string, unknown> | null {
  if (!body) return null;
  if (Array.isArray(body) && body.length > 0 && typeof body[0] === "object") {
    return body[0] as Record<string, unknown>;
  }
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if ("workerId" in obj || "workerCorrelationId" in obj) return obj;
    // Some Paychex envelopes use { content: [...] } or { data: [...] }.
    const candidate = (obj.content ?? obj.data) as unknown;
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate[0] as Record<string, unknown>;
    }
  }
  return null;
}

// ─── Main handler ──────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse(405, { error: "POST required." }, cors);

  // ── Auth ──
  const authResult = await authenticateRequest(req.headers.get("Authorization"));
  if (!authResult.ok) return jsonResponse(authResult.status, { error: authResult.error }, cors);
  const { orgId, userEmail } = authResult.ctx;

  const admin = makeServiceClient();

  const staffCheck = await assertStaff(admin, userEmail);
  if (!staffCheck.ok) {
    return jsonResponse(staffCheck.status, { error: staffCheck.error }, cors);
  }

  // ── Body ──
  let body: { caregiver_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body." }, cors);
  }
  const caregiverId = body.caregiver_id;
  if (!caregiverId || typeof caregiverId !== "string") {
    return jsonResponse(400, { error: "caregiver_id is required." }, cors);
  }

  // ── Load caregiver (org-scoped) ──
  // Once Phase B adds caregivers.org_id we'll filter by it directly.
  // Until then we trust the existing single-tenant data shape but
  // still scope the org context for paychex_api_log + the org
  // settings lookup. The staff role check is the current cross-tenant
  // gate.
  const { data: caregiverData, error: caregiverErr } = await admin
    .from("caregivers")
    .select(
      "id, first_name, last_name, paychex_worker_id, paychex_sync_status",
    )
    .eq("id", caregiverId)
    .maybeSingle();
  if (caregiverErr) {
    return jsonResponse(500, { error: `Caregiver lookup failed: ${caregiverErr.message}` }, cors);
  }
  if (!caregiverData) {
    return jsonResponse(404, { error: "Caregiver not found." }, cors);
  }
  const caregiver = caregiverData as CaregiverRow;

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
  const orgSettings = ((orgRow as { settings: OrgSettings }).settings ?? {}) as OrgSettings;
  const companyId = orgSettings?.paychex?.company_id;
  if (!companyId || typeof companyId !== "string") {
    return jsonResponse(412, {
      error:
        "Org is missing organizations.settings.paychex.company_id. Configure the org's Paychex company before syncing workers.",
    }, cors);
  }

  // ── Build the worker payload ──
  let workerPayload: Record<string, unknown>;
  try {
    workerPayload = buildPaychexWorker({
      caregiver,
      orgSettings,
      referenceDate: new Date(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(422, { error: `Worker mapping failed: ${message}` }, cors);
  }

  const ctx = { supabase: admin, orgId };
  const idempotencyKey = await buildSyncIdempotencyKey(
    caregiver.id,
    new Date(),
  );

  // ── Decide POST vs PATCH vs rehire-block ──
  try {
    if (!caregiver.paychex_worker_id) {
      // Brand-new sync — POST.
      const result = await postWorker(ctx, {
        companyId,
        worker: workerPayload,
        idempotencyKey,
      });
      const workerShape = extractWorkerShape(result.body);
      const newWorkerId = workerShape && typeof workerShape.workerId === "string"
        ? workerShape.workerId
        : null;

      if (!result.dryRun && !newWorkerId) {
        // Defensive: a 2xx response with no workerId in the body is
        // unexpected. Persist nothing about workerId; surface the error.
        await admin
          .from("caregivers")
          .update({
            paychex_sync_status: "error",
            paychex_sync_error: truncateError(
              "Paychex returned 200 but no workerId in response body",
            ),
          })
          .eq("id", caregiver.id);
        return jsonResponse(502, {
          error: "Paychex returned 200 but no workerId in response body.",
        }, cors);
      }

      const updates: Record<string, unknown> = {
        paychex_sync_status: "active",
        paychex_last_synced_at: new Date().toISOString(),
        paychex_sync_error: null,
      };
      if (newWorkerId) {
        updates.paychex_worker_id = newWorkerId;
      }
      const { error: updateErr } = await admin
        .from("caregivers")
        .update(updates)
        .eq("id", caregiver.id);
      if (updateErr) {
        return jsonResponse(500, {
          error: `Caregiver state persist failed: ${updateErr.message}`,
        }, cors);
      }

      // Fire-and-forget event log so the activity feed reflects it.
      admin
        .from("events")
        .insert({
          event_type: "paychex_worker_synced",
          entity_type: "caregiver",
          entity_id: caregiver.id,
          actor: userEmail ? `user:${userEmail}` : "system:paychex-sync-worker",
          payload: {
            caregiver_id: caregiver.id,
            paychex_worker_id: newWorkerId,
            mode: "create",
            dry_run: result.dryRun,
            idempotency_key: idempotencyKey,
          },
        })
        .then(({ error }: { error: { message: string } | null }) => {
          if (error) console.warn("[paychex-sync-worker] event log failed:", error.message);
        });

      return jsonResponse(200, {
        ok: true,
        mode: "create",
        paychex_worker_id: newWorkerId,
        dry_run: result.dryRun,
        sync_status: "active",
      }, cors);
    }

    // Existing worker — first GET to detect TERMINATED, then PATCH.
    const existingWorkerId = caregiver.paychex_worker_id;
    let existingShape: Record<string, unknown> | null = null;
    try {
      const getResult = await getWorker(ctx, { workerId: existingWorkerId });
      existingShape = extractWorkerShape(getResult.body);
    } catch (err) {
      // If the GET itself fails (4xx/5xx/network), surface the error
      // and bail. We don't PATCH blind — the rehire-block exists
      // precisely to avoid mutating the wrong worker.
      if (err instanceof PaychexError) {
        await admin
          .from("caregivers")
          .update({
            paychex_sync_status: "error",
            paychex_sync_error: truncateError(`worker_lookup_failed: ${err.message}`),
          })
          .eq("id", caregiver.id);
        return jsonResponse(err.status && err.status < 500 ? 502 : 502, {
          error: `Failed to read existing Paychex worker: ${err.message}`,
          code: err.code,
        }, cors);
      }
      throw err;
    }

    const rehire = detectRehire(existingShape);
    if (rehire.rehire) {
      const { error: updateErr } = await admin
        .from("caregivers")
        .update({
          paychex_sync_status: "rehire_blocked",
          paychex_sync_error: truncateError(
            `rehire_detected: last terminated ${rehire.lastTerminationDate ?? "unknown"} (${rehire.lastTerminationReason ?? "no reason"})`,
          ),
        })
        .eq("id", caregiver.id);
      if (updateErr) {
        return jsonResponse(500, {
          error: `Persist failed: ${updateErr.message}`,
        }, cors);
      }
      return jsonResponse(409, {
        error: "rehire_detected",
        message:
          "Existing Paychex worker is TERMINATED. Reactivate manually in Paychex Flex; do not auto-PATCH.",
        last_termination_date: rehire.lastTerminationDate,
        last_termination_reason: rehire.lastTerminationReason,
        sync_status: "rehire_blocked",
      }, cors);
    }

    // PATCH path — strip currentStatus from the payload so we don't
    // accidentally flip an ACTIVE worker back to IN_PROGRESS. The
    // status transition is owned by the Phase 3+ promotion automation.
    const patchPayload = { ...workerPayload };
    delete (patchPayload as Record<string, unknown>).currentStatus;

    const result = await patchWorker(ctx, {
      workerId: existingWorkerId,
      worker: patchPayload,
      idempotencyKey,
      mediaType: WORKER_NONPII_MEDIA_TYPE,
    });

    const updates: Record<string, unknown> = {
      paychex_sync_status: "active",
      paychex_last_synced_at: new Date().toISOString(),
      paychex_sync_error: null,
    };
    const { error: updateErr } = await admin
      .from("caregivers")
      .update(updates)
      .eq("id", caregiver.id);
    if (updateErr) {
      return jsonResponse(500, {
        error: `Caregiver state persist failed: ${updateErr.message}`,
      }, cors);
    }

    admin
      .from("events")
      .insert({
        event_type: "paychex_worker_synced",
        entity_type: "caregiver",
        entity_id: caregiver.id,
        actor: userEmail ? `user:${userEmail}` : "system:paychex-sync-worker",
        payload: {
          caregiver_id: caregiver.id,
          paychex_worker_id: existingWorkerId,
          mode: "update",
          dry_run: result.dryRun,
          idempotency_key: idempotencyKey,
        },
      })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) console.warn("[paychex-sync-worker] event log failed:", error.message);
      });

    return jsonResponse(200, {
      ok: true,
      mode: "update",
      paychex_worker_id: existingWorkerId,
      dry_run: result.dryRun,
      sync_status: "active",
    }, cors);
  } catch (err) {
    if (err instanceof PaychexError) {
      // 423 hard-fail: never persist a workerId from the response.
      if (err.code === "client_account_locked") {
        await admin
          .from("caregivers")
          .update({
            paychex_sync_status: "error",
            paychex_sync_error: "client_account_locked",
          })
          .eq("id", caregiver.id);

        admin
          .from("events")
          .insert({
            event_type: "paychex_worker_sync_failed",
            entity_type: "caregiver",
            entity_id: caregiver.id,
            actor: userEmail ? `user:${userEmail}` : "system:paychex-sync-worker",
            payload: {
              caregiver_id: caregiver.id,
              error_code: err.code,
              status: err.status,
            },
          })
          .then(({ error }: { error: { message: string } | null }) => {
            if (error) console.warn("[paychex-sync-worker] event log failed:", error.message);
          });

        return jsonResponse(423, {
          error: "client_account_locked",
          message:
            "Paychex returned 423 Locked. The worker may have been partially created with an invalid workerId; we did not persist it. Retry later.",
          sync_status: "error",
        }, cors);
      }

      // Other 4xx: persist truncated error message.
      if (err.code === "client_error") {
        await admin
          .from("caregivers")
          .update({
            paychex_sync_status: "error",
            paychex_sync_error: truncateError(err.message),
          })
          .eq("id", caregiver.id);

        admin
          .from("events")
          .insert({
            event_type: "paychex_worker_sync_failed",
            entity_type: "caregiver",
            entity_id: caregiver.id,
            actor: userEmail ? `user:${userEmail}` : "system:paychex-sync-worker",
            payload: {
              caregiver_id: caregiver.id,
              error_code: err.code,
              status: err.status,
            },
          })
          .then(({ error }: { error: { message: string } | null }) => {
            if (error) console.warn("[paychex-sync-worker] event log failed:", error.message);
          });

        return jsonResponse(err.status ?? 400, {
          error: err.code,
          message: err.message,
          sync_status: "error",
        }, cors);
      }

      // Server / network error — leave sync_status alone (will retry).
      // Persist a sync_error so the UI can surface the latest reason.
      await admin
        .from("caregivers")
        .update({
          paychex_sync_status: "error",
          paychex_sync_error: truncateError(err.message),
        })
        .eq("id", caregiver.id);

      return jsonResponse(502, {
        error: err.code,
        message: err.message,
        sync_status: "error",
      }, cors);
    }

    // Unexpected — log and 500.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[paychex-sync-worker] unhandled error:", message);
    return jsonResponse(500, { error: truncateError(message) }, cors);
  }
});
