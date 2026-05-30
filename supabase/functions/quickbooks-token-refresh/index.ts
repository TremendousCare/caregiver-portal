// ─── QuickBooks token refresh cron ──────────────────────────────────────
// POSTed by pg_cron every 30 minutes (see
// supabase/migrations/20260603000000_quickbooks_token_refresh_cron.sql).
//
// For each row in quickbooks_connections, applies
// decideRefreshAction() and acts on the result:
//   • skip                  → no-op
//   • mark_reauth_required  → UPDATE status='reauth_required' so the
//                             Settings card surfaces the warning and
//                             the cron stops trying.
//   • refresh               → fetch the current refresh_token via
//                             get_qb_connection (service-role), call
//                             Intuit's /oauth2/v1/tokens with
//                             grant_type=refresh_token, persist the
//                             new pair via refresh_qb_connection_tokens
//                             (the service-role-only RPC added in PR
//                             #1 specifically for this path).
//
// Failure handling:
//   • 401 from Intuit → flag the connection 'reauth_required'. This
//     happens when the refresh token was rotated by a parallel
//     refresh (only one rotation can win) or when Intuit revoked
//     the grant.
//   • Any other error → flag the connection 'error' with a short
//     status_message. The next tick will retry — error is transient.
//
// Returns a JSON summary so the cron job's HTTP response is loggable.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  decideRefreshAction,
  expiriesFromTokenResponse,
  refreshAccessToken,
  type RefreshableConnection,
} from "../_shared/helpers/quickbooks.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QB_CLIENT_ID = Deno.env.get("QB_CLIENT_ID");
const QB_CLIENT_SECRET = Deno.env.get("QB_CLIENT_SECRET");

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

type ConnectionRow = RefreshableConnection & {
  id: string;
  org_id: string;
  environment: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!QB_CLIENT_ID || !QB_CLIENT_SECRET) {
    console.error("[qb-token-refresh] missing QB_CLIENT_ID or QB_CLIENT_SECRET");
    return json({ error: "Server misconfigured" }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Pull every connection that COULD need a refresh — 'active' (the
  // happy path) and 'error' (so transient failures self-heal on the
  // next tick). 'reauth_required' is sticky until the owner
  // reconnects, so skip it at the query level too.
  const { data: connections, error: listErr } = await supabase
    .from("quickbooks_connections")
    .select(
      "id, org_id, environment, status, access_token_expires_at, refresh_token_expires_at",
    )
    .in("status", ["active", "error"]);

  if (listErr) {
    console.error("[qb-token-refresh] failed to list connections:", listErr);
    return json({ error: listErr.message }, 500);
  }

  const summary = {
    total: connections?.length ?? 0,
    refreshed: 0,
    skipped: 0,
    marked_reauth_required: 0,
    failed: 0,
  };

  for (const conn of (connections ?? []) as ConnectionRow[]) {
    const decision = decideRefreshAction(conn);

    if (decision.action === "skip") {
      summary.skipped++;
      continue;
    }

    if (decision.action === "mark_reauth_required") {
      await markConnection(supabase, conn.id, "reauth_required", decision.reason);
      summary.marked_reauth_required++;
      continue;
    }

    // decision.action === "refresh"
    try {
      const { data: rows, error: getErr } = await supabase.rpc(
        "get_qb_connection",
        { p_org_id: conn.org_id, p_environment: conn.environment },
      );
      if (getErr) throw new Error(`get_qb_connection: ${getErr.message}`);
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row?.refresh_token) {
        throw new Error("get_qb_connection returned no refresh_token");
      }

      const tokens = await refreshAccessToken({
        refreshToken: row.refresh_token as string,
        clientId: QB_CLIENT_ID,
        clientSecret: QB_CLIENT_SECRET,
      });
      const { accessExpiresAt, refreshExpiresAt } = expiriesFromTokenResponse(tokens);

      const { error: setErr } = await supabase.rpc(
        "refresh_qb_connection_tokens",
        {
          p_org_id: conn.org_id,
          p_environment: conn.environment,
          p_refresh_token: tokens.refresh_token,
          p_access_token: tokens.access_token,
          p_access_token_expires_at: accessExpiresAt.toISOString(),
          p_refresh_token_expires_at: refreshExpiresAt.toISOString(),
        },
      );
      if (setErr) throw new Error(`refresh_qb_connection_tokens: ${setErr.message}`);

      summary.refreshed++;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      console.error(
        `[qb-token-refresh] refresh failed for ${conn.org_id}/${conn.environment}:`,
        msg,
      );

      // 401 from Intuit's token endpoint means the refresh token is
      // dead — owner must reconnect. Anything else is transient
      // (network, 5xx, rate limit) and self-heals next tick.
      const isAuth401 = / 401 /.test(msg) || /invalid_grant/.test(msg);
      if (isAuth401) {
        await markConnection(supabase, conn.id, "reauth_required", truncate(msg));
        summary.marked_reauth_required++;
      } else {
        await markConnection(supabase, conn.id, "error", truncate(msg));
        summary.failed++;
      }
    }
  }

  return json({ ok: true, summary });
});

async function markConnection(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  id: string,
  status: "error" | "reauth_required",
  message: string,
): Promise<void> {
  const { error } = await supabase
    .from("quickbooks_connections")
    .update({
      status,
      status_message: message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    console.error(`[qb-token-refresh] failed to mark ${id} as ${status}:`, error);
  }
}

function truncate(s: string): string {
  return s.length > 500 ? s.slice(0, 500) : s;
}
