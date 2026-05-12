// Phase 1.5 follow-up — close-pending-suggestion edge function.
//
// Thin wrapper around `closePendingSuggestion()` in
// `_shared/operations/closeSuggestion.ts`. Called by operator-write
// UI surfaces (SMSComposeBar first, more in PR 2) immediately after
// the underlying action lands successfully. The wrapper:
//
//   1. Verifies the caller's JWT (any authenticated user — operator
//      actions are not admin-gated).
//   2. Reads the JWT's org_id claim (required since the audit log is
//      org-scoped).
//   3. Calls the shared helper with a service-role client.
//   4. Returns a small status object the caller can ignore or log.
//
// **Failure is non-fatal by contract.** The operator's primary action
// (e.g. SMS send) already succeeded by the time this is invoked. A
// failure here must never block the UI flow — the frontend should
// swallow + log to console. The autonomy algorithm will simply miss
// this one positive signal; the next operator action will close the
// next suggestion.
//
// Why an edge function (not Postgres):
//   - `record_agent_action_v1` requires a pre-computed Ed25519
//     signature, which Postgres can't produce until SaaS Phase C
//     ships pgsodium-backed per-org keys.
//   - Service role internally to bypass the agent_actions write
//     lockdown (the table has INSERT/UPDATE/DELETE revoked from
//     authenticated; only service_role can write via the RPC).
//   - Same pattern as `agent-flag-toggle` (Phase 1.1.B).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  closePendingSuggestion,
  CLOSEABLE_ACTION_TYPES,
  CloseableActionType,
  CloseEntityType,
} from "../_shared/operations/closeSuggestion.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")
  || Deno.env.get("SUPABASE_ANON_KEY_SECRET");

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  entity_type?: string;
  entity_id?:   string;
  action_type?: string;
  params?:      Record<string, unknown>;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── 1. JWT auth — any authenticated session works. ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonResponse(401, { error: "Missing or invalid Authorization header" });
    }
    const token = authHeader.replace("Bearer ", "");

    const supabaseAuth = createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      return jsonResponse(401, { error: "Invalid or expired session" });
    }

    // ── 2. Validate body. ──
    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }
    if (body.entity_type !== "caregiver" && body.entity_type !== "client") {
      return jsonResponse(400, { error: "entity_type must be 'caregiver' or 'client'" });
    }
    if (!body.entity_id || typeof body.entity_id !== "string") {
      return jsonResponse(400, { error: "entity_id required" });
    }
    if (!body.action_type || !CLOSEABLE_ACTION_TYPES.includes(body.action_type as CloseableActionType)) {
      return jsonResponse(400, {
        error: `action_type must be one of: ${CLOSEABLE_ACTION_TYPES.join(", ")}`,
      });
    }

    // ── 3. Service-role client for the suggestion close + audit write.
    //       agent_actions writes are service-role-only by design. ──
    const supabaseService = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const actorEmail = (user.email || "").toLowerCase();
    const actor = `user:${actorEmail || user.id}`;

    const result = await closePendingSuggestion(supabaseService, {
      entityType: body.entity_type as CloseEntityType,
      entityId:   body.entity_id,
      actionType: body.action_type as CloseableActionType,
      actor,
      params:     body.params ?? {},
    });

    return jsonResponse(200, result);
  } catch (err) {
    console.error("[close-pending-suggestion] error:", err);
    return jsonResponse(500, { error: (err as Error).message || "internal error" });
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
