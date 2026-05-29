// ─── QuickBooks OAuth callback ──────────────────────────────────────────
// Intuit redirects the user's browser here after they grant consent.
// No user JWT is present in this request — the trust boundary is the
// `state` query parameter, which must match a row created moments
// earlier by quickbooks-oauth-init under the owner's auth.
//
// Intuit's redirect query string:
//   ?code=<auth_code>&state=<state_id>&realmId=<qb_company_id>
//   …or on user denial:
//   ?error=access_denied&error_description=<…>&state=<state_id>
//
// Flow:
//   1. Validate the query params.
//   2. Exchange the auth code for tokens via Intuit's token endpoint.
//   3. Call complete_qb_oauth() RPC (service-role) — it verifies the
//      state row, upserts the connection, writes Vault secrets,
//      and burns the state row atomically.
//   4. 302 redirect the browser back to the Settings page with a
//      qb=connected or qb_error=<code> query param so the React UI
//      can show a success/failure toast.
//
// Env vars required (set in Supabase Dashboard → Edge Function Secrets):
//   QB_CLIENT_ID                — Intuit app's client_id
//   QB_CLIENT_SECRET            — Intuit app's client_secret
//   QB_REDIRECT_URI             — must byte-match the one used at init
//   PORTAL_BASE_URL             — origin to redirect the browser back to
//                                 (defaults to caregiver-portal.vercel.app)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  exchangeCodeForTokens,
  expiriesFromTokenResponse,
  QB_DEFAULT_SCOPES,
} from "../_shared/helpers/quickbooks.ts";

const DEFAULT_PORTAL_BASE_URL = "https://caregiver-portal.vercel.app";
const SETTINGS_PATH = "/admin/settings";

function buildRedirect(portalBase: string, key: string, value: string): Response {
  let dest: URL;
  try {
    dest = new URL(SETTINGS_PATH, portalBase);
  } catch {
    dest = new URL(SETTINGS_PATH, DEFAULT_PORTAL_BASE_URL);
  }
  dest.searchParams.set(key, value);
  return Response.redirect(dest.toString(), 302);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const portalBase = Deno.env.get("PORTAL_BASE_URL") || DEFAULT_PORTAL_BASE_URL;

  // ── 1. Parse query params from Intuit's redirect ──
  const code            = url.searchParams.get("code");
  const state           = url.searchParams.get("state");
  const realmId         = url.searchParams.get("realmId");
  const intuitError     = url.searchParams.get("error");
  const intuitErrorDesc = url.searchParams.get("error_description");

  if (intuitError) {
    console.warn(`[qb-callback] Intuit returned error: ${intuitError} — ${intuitErrorDesc ?? ""}`);
    return buildRedirect(portalBase, "qb_error", intuitError);
  }
  if (!code || !state || !realmId) {
    return buildRedirect(portalBase, "qb_error", "missing_params");
  }

  // ── 2. Validate server config ──
  const SUPABASE_URL              = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const QB_CLIENT_ID              = Deno.env.get("QB_CLIENT_ID");
  const QB_CLIENT_SECRET          = Deno.env.get("QB_CLIENT_SECRET");
  const QB_REDIRECT_URI           = Deno.env.get("QB_REDIRECT_URI");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[qb-callback] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return buildRedirect(portalBase, "qb_error", "server_misconfigured");
  }
  if (!QB_CLIENT_ID || !QB_CLIENT_SECRET || !QB_REDIRECT_URI) {
    console.error("[qb-callback] missing QB_CLIENT_ID / QB_CLIENT_SECRET / QB_REDIRECT_URI");
    return buildRedirect(portalBase, "qb_error", "server_misconfigured");
  }

  // ── 3. Exchange the auth code for tokens at Intuit ──
  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      code,
      redirectUri: QB_REDIRECT_URI,
      clientId: QB_CLIENT_ID,
      clientSecret: QB_CLIENT_SECRET,
    });
  } catch (e) {
    console.error("[qb-callback] token exchange failed:", e);
    return buildRedirect(portalBase, "qb_error", "token_exchange_failed");
  }

  const { accessExpiresAt, refreshExpiresAt } = expiriesFromTokenResponse(tokens);

  // ── 4. Persist via the state-gated RPC ──
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await supabase.rpc("complete_qb_oauth", {
    p_state_id: state,
    p_realm_id: realmId,
    p_refresh_token: tokens.refresh_token,
    p_access_token:  tokens.access_token,
    p_access_token_expires_at:  accessExpiresAt.toISOString(),
    p_refresh_token_expires_at: refreshExpiresAt.toISOString(),
    // Intuit does not echo the granted scopes in the token response.
    // The owner consented to QB_DEFAULT_SCOPES (that's what we sent
    // in the authorize URL), so that's what we persist.
    p_scopes: [...QB_DEFAULT_SCOPES],
  });

  if (error) {
    const msg = String(error.message || "");
    console.error("[qb-callback] complete_qb_oauth failed:", error);
    if (msg.includes("state not found") || msg.includes("already consumed")) {
      return buildRedirect(portalBase, "qb_error", "state_replayed");
    }
    if (msg.includes("expired")) {
      return buildRedirect(portalBase, "qb_error", "expired_state");
    }
    return buildRedirect(portalBase, "qb_error", "persist_failed");
  }

  return buildRedirect(portalBase, "qb", "connected");
});
