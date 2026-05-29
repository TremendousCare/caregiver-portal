// ─── QuickBooks OAuth init ──────────────────────────────────────────────
// Owner-only. POSTed by the Settings UI when the owner clicks
// "Connect QuickBooks". Creates a CSRF state row (via the
// init_qb_oauth_state RPC, which is owner-gated on the caller's
// JWT) and returns the Intuit OAuth authorize URL with the state
// embedded.
//
// Request:
//   POST  (no body required)
//   Authorization: Bearer <user_jwt>           ← required
//
// Response 200:
//   { "redirect_url": "https://appcenter.intuit.com/connect/oauth2?…",
//     "state_id":     "<uuid>",
//     "environment":  "sandbox" | "production" }
//
// Response 401: missing/invalid auth
// Response 403: RPC rejected (caller is not the owner / wrong org)
// Response 500: server misconfiguration (missing env vars)
//
// Env vars required (set in Supabase Dashboard → Edge Function Secrets):
//   QB_CLIENT_ID       — Intuit app's sandbox or production client_id
//   QB_REDIRECT_URI    — the URI registered with Intuit; must byte-match
//   QB_ENVIRONMENT     — 'sandbox' or 'production' (default 'sandbox')

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildAuthorizeUrl,
  QB_DEFAULT_SCOPES,
} from "../_shared/helpers/quickbooks.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const QB_CLIENT_ID      = Deno.env.get("QB_CLIENT_ID");
  const QB_REDIRECT_URI   = Deno.env.get("QB_REDIRECT_URI");
  const QB_ENVIRONMENT    = (Deno.env.get("QB_ENVIRONMENT") || "sandbox").toLowerCase();

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json({ error: "Server misconfigured: missing SUPABASE_URL or SUPABASE_ANON_KEY" }, 500);
  }
  if (!QB_CLIENT_ID || !QB_REDIRECT_URI) {
    return json({ error: "QuickBooks integration is not configured (missing QB_CLIENT_ID or QB_REDIRECT_URI)" }, 500);
  }
  if (QB_ENVIRONMENT !== "sandbox" && QB_ENVIRONMENT !== "production") {
    return json({ error: `Invalid QB_ENVIRONMENT: ${QB_ENVIRONMENT}` }, 500);
  }

  // Forward the user's JWT into the Supabase client so the RPC's
  // auth.jwt() calls return the caller's claims. The RPC enforces
  // owner-only access via public.is_owner() and an org_id match.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: stateId, error } = await supabase.rpc("init_qb_oauth_state", {
    p_environment: QB_ENVIRONMENT,
  });

  if (error) {
    const msg = String(error.message || "");
    if (msg.includes("Authentication required") || msg.includes("missing org_id")) {
      return json({ error: msg }, 401);
    }
    if (msg.includes("Only the org owner")) {
      return json({ error: msg }, 403);
    }
    console.error("[qb-init] init_qb_oauth_state failed:", error);
    return json({ error: msg || "Failed to initialize OAuth state" }, 500);
  }

  if (typeof stateId !== "string") {
    console.error("[qb-init] init_qb_oauth_state returned unexpected:", stateId);
    return json({ error: "OAuth state was not created" }, 500);
  }

  const url = buildAuthorizeUrl({
    clientId: QB_CLIENT_ID,
    redirectUri: QB_REDIRECT_URI,
    state: stateId,
    scopes: QB_DEFAULT_SCOPES,
  });

  return json({
    redirect_url: url,
    state_id: stateId,
    environment: QB_ENVIRONMENT,
  });
});
