import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveMergeFields } from "../_shared/helpers/mergeFields.ts";
import { sendSmsToRingCentralWithRetry } from "../_shared/helpers/ringcentral.ts";

// ─── Environment Variables ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RC_CLIENT_ID = Deno.env.get("RINGCENTRAL_CLIENT_ID");
const RC_CLIENT_SECRET = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");
// Legacy JWT env var — used as fallback when no `category` is specified on
// the request body. Every existing call site hits this path today, so its
// behavior must remain byte-identical to the pre-Step-5 edge function.
const RC_JWT_TOKEN_FALLBACK = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
const RC_API_URL = "https://platform.ringcentral.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── Helpers ───

function normalizePhoneNumber(phone: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function fullName(entity: { first_name: string; last_name: string }): string {
  return `${entity.first_name || ""} ${entity.last_name || ""}`.trim();
}

async function getRingCentralAccessToken(jwt: string): Promise<string> {
  if (!RC_CLIENT_ID || !RC_CLIENT_SECRET) {
    throw new Error("RingCentral client credentials not configured");
  }
  if (!jwt) {
    throw new Error("RingCentral JWT not provided");
  }
  const response = await fetch(`${RC_API_URL}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`RingCentral auth failed: ${error}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function getRCFromNumber(supabase: any): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "ringcentral_from_number")
      .single();
    if (data?.value) {
      const val = typeof data.value === "string" ? data.value : String(data.value);
      const digits = val.replace(/\D/g, "");
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
      if (val.startsWith("+")) return val;
      return val;
    }
  } catch (_err) {
    // Fall through to env var
  }
  return Deno.env.get("RINGCENTRAL_FROM_NUMBER") || null;
}

// Resolve the sending phone number + JWT pair for a request.
//
// - If `category` is provided → look up the configured route in
//   communication_routes, fetch its JWT from Supabase Vault via the
//   get_route_ringcentral_jwt RPC, and return them. Hard-fails with a
//   descriptive error if the route is missing, inactive, or incomplete.
//
// - If `category` is omitted (every call site today) → fall back to the
//   legacy path: the global `ringcentral_from_number` app_setting plus the
//   global `RINGCENTRAL_JWT_TOKEN` env var. Byte-identical to pre-Step-5.
async function getSendingCredentials(
  supabase: any,
  category: string | null | undefined,
): Promise<{ fromNumber: string; jwt: string }> {
  // ── Path A: category specified → route-based lookup ──
  if (category) {
    const { data, error } = await supabase.rpc("get_route_ringcentral_jwt", {
      p_category: category,
    });
    if (error) {
      throw new Error(`Route lookup failed for "${category}": ${error.message}`);
    }
    if (!data || data.length === 0) {
      throw new Error(`Communication route "${category}" not found or inactive.`);
    }
    const route = data[0];
    if (!route.sms_from_number) {
      throw new Error(`Route "${category}" has no phone number configured. Set one in Admin Settings → Communication Routes.`);
    }
    if (!route.jwt) {
      throw new Error(`Route "${category}" has no JWT configured. Set one in Admin Settings → Communication Routes.`);
    }
    const normalized = normalizePhoneNumber(route.sms_from_number);
    if (!normalized) {
      throw new Error(`Route "${category}" has an invalid phone number: ${route.sms_from_number}`);
    }
    return { fromNumber: normalized, jwt: route.jwt };
  }

  // ── Path B: no category → legacy env-var path (unchanged behavior) ──
  const fromNumber = await getRCFromNumber(supabase);
  if (!fromNumber) {
    throw new Error("RingCentral from number not configured");
  }
  if (!RC_JWT_TOKEN_FALLBACK) {
    throw new Error("RingCentral JWT not configured (RINGCENTRAL_JWT_TOKEN env var missing)");
  }
  return { fromNumber, jwt: RC_JWT_TOKEN_FALLBACK };
}

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { caregiver_ids, client_ids, message, current_user, category } =
      await req.json();

    // Exactly one of caregiver_ids / client_ids must be supplied.
    // Old callers send only caregiver_ids → byte-identical behavior.
    // New client-side callers send only client_ids.
    const hasCaregivers = Array.isArray(caregiver_ids) && caregiver_ids.length > 0;
    const hasClients = Array.isArray(client_ids) && client_ids.length > 0;

    if (hasCaregivers && hasClients) {
      return new Response(
        JSON.stringify({
          error: "Specify either caregiver_ids or client_ids, not both",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!hasCaregivers && !hasClients) {
      return new Response(
        JSON.stringify({
          error: "caregiver_ids or client_ids is required and must be non-empty",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!message?.trim()) {
      return new Response(
        JSON.stringify({ error: "message is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const entityType: "caregiver" | "client" = hasClients ? "client" : "caregiver";
    const tableName = entityType === "client" ? "clients" : "caregivers";
    const ids: string[] = hasClients ? client_ids : caregiver_ids;
    // Caregivers expose `phase_override`; clients expose `phase` directly.
    const phaseColumn = entityType === "client" ? "phase" : "phase_override";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Fetch the target rows in one query. If the `sms_opted_out` column
    // does not exist yet (migration hasn't been applied but the edge
    // function auto-deployed on merge), retry without it. In that
    // window the opt-out gate becomes a no-op — behavior matches
    // pre-migration exactly — and bulk-sms stays functional.
    const fullCols =
      `id, first_name, last_name, phone, email, ${phaseColumn}, notes, sms_opted_out`;
    const fallbackCols =
      `id, first_name, last_name, phone, email, ${phaseColumn}, notes`;
    let entities: any[] | null = null;
    let fetchErr: { message?: string } | null = null;
    ({ data: entities, error: fetchErr } = await supabase
      .from(tableName)
      .select(fullCols)
      .in("id", ids));
    if (
      fetchErr &&
      String(fetchErr.message || "").includes("sms_opted_out")
    ) {
      ({ data: entities, error: fetchErr } = await supabase
        .from(tableName)
        .select(fallbackCols)
        .in("id", ids));
    }

    if (fetchErr) {
      return new Response(
        JSON.stringify({ error: `Failed to fetch ${tableName}: ${fetchErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!entities || entities.length === 0) {
      return new Response(
        JSON.stringify({ error: `No ${tableName} found for the given IDs` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Resolve sending credentials (phone number + JWT).
    // This is the key Step-5 branch: if `category` is absent (as in every
    // existing call site), this falls back to the legacy env-var path, so
    // behavior is byte-identical to the pre-Step-5 edge function.
    let fromNumber: string;
    let jwt: string;
    try {
      const creds = await getSendingCredentials(supabase, category);
      fromNumber = creds.fromNumber;
      jwt = creds.jwt;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: (err as Error).message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let accessToken: string;
    try {
      accessToken = await getRingCentralAccessToken(jwt);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `RingCentral auth failed: ${(err as Error).message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Process each recipient sequentially
    const results: Array<{
      id: string;
      name: string;
      status: "sent" | "skipped" | "failed";
      reason?: string;
    }> = [];

    for (const entity of entities) {
      const normalizedPhone = normalizePhoneNumber(entity.phone);

      // Skip: no valid phone
      if (!entity.phone || !normalizedPhone) {
        results.push({ id: entity.id, name: fullName(entity), status: "skipped", reason: "no valid phone number" });
        continue;
      }

      // Skip: recipient has opted out of SMS (TCPA compliance).
      // Every outbound SMS path must honor the opt-out flag; manual
      // sends are no exception.
      if (entity.sms_opted_out === true) {
        results.push({
          id: entity.id,
          name: fullName(entity),
          status: "skipped",
          reason: `${entityType} has opted out of SMS`,
        });
        continue;
      }

      // Resolve merge fields
      const resolvedMessage = resolveMergeFields(message, entity);

      try {
        // Send SMS. Helper retries exactly once on a confirmed 429 (RC's
        // rate limiter rejected us before delivery — safe to retry because
        // RC does not queue 429'd sends). Never retries on network errors
        // or 5xx; see sendSmsToRingCentralWithRetry for the full reasoning.
        const smsResponse = await sendSmsToRingCentralWithRetry(
          accessToken,
          fromNumber,
          normalizedPhone,
          resolvedMessage,
        );

        if (!smsResponse.ok) {
          const errText = await smsResponse.text();
          if (smsResponse.status === 429) {
            // Still 429 after one retry inside the helper → record as failed
            // and continue. The outer loop's per-recipient delay carries us
            // past the penalty interval before the next send.
            results.push({ id: entity.id, name: fullName(entity), status: "failed", reason: "Rate limit reached" });
            continue;
          }
          throw new Error(`RC API ${smsResponse.status}: ${errText}`);
        }

        // Log note on the entity record. When routed by category, record
        // which route was used in the outcome field for audit trail.
        const smsNote = {
          text: resolvedMessage,
          type: "text",
          direction: "outbound",
          outcome: category
            ? `sent via RingCentral (route: ${category})`
            : "sent via RingCentral (bulk)",
          timestamp: Date.now(),
          author: current_user || "Bulk SMS",
        };
        const existingNotes = Array.isArray(entity.notes) ? entity.notes : [];
        await supabase
          .from(tableName)
          .update({ notes: [...existingNotes, smsNote] })
          .eq("id", entity.id);

        results.push({ id: entity.id, name: fullName(entity), status: "sent" });
      } catch (err) {
        console.error(`[bulk-sms] Failed for ${fullName(entity)}:`, err);
        results.push({ id: entity.id, name: fullName(entity), status: "failed", reason: (err as Error).message });
      }

      // Rate limiting: 3s between sends. RingCentral's SMS group caps us at
      // 40 requests / 60s per extension — at 3s spacing we send 20/min, well
      // under the limit with 2× headroom. Auth isn't a concern here: bulk-sms
      // runs in a single isolate, so the access-token fetch above is cached
      // for the rest of the loop. Slower than the prior 200ms (which blew
      // past the rate limit) but reliability is the priority.
      await new Promise((r) => setTimeout(r, 3000));
    }

    const summary = {
      sent: results.filter((r) => r.status === "sent").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    };

    console.log(
      `[bulk-sms] Complete (entity: ${entityType}${category ? `, route: ${category}` : ""}): ${summary.sent} sent, ${summary.skipped} skipped, ${summary.failed} failed`,
    );

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[bulk-sms] Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: `Unexpected error: ${(err as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
