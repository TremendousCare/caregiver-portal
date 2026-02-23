import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ═══════════════════════════════════════════════════════════════
// Client Intake Webhook v9 — Queue-based intake endpoint
//
// Receives POST from WordPress (Forminator/CF7), Google Ads,
// Meta lead ads, or any external source. Validates an API key,
// INSERTs raw payload into intake_queue, and returns 200.
//
// All field mapping, dedup, record creation, and automations
// are handled asynchronously by the intake-processor function.
//
// Deploy: npx supabase functions deploy client-intake-webhook --no-verify-jwt
// ═══════════════════════════════════════════════════════════════

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ─── API Key Validation ─────────────────────────────────────

interface ApiKeyResult {
  valid: boolean;
  source?: string;
  label?: string;
  entity_type?: string;
}

async function validateApiKey(
  supabase: any,
  apiKey: string | null
): Promise<ApiKeyResult> {
  if (!apiKey) return { valid: false };

  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "intake_webhook_keys")
    .single();

  if (!data?.value || !Array.isArray(data.value)) return { valid: false };

  const match = data.value.find(
    (entry: any) => entry.key === apiKey && entry.enabled !== false
  );

  if (!match) return { valid: false };
  return {
    valid: true,
    source: match.source,
    label: match.label,
    entity_type: match.entity_type,
  };
}

// ─── Main Handler ───────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const url = new URL(req.url);

  // ── GET: Health check + Meta webhook verification ──
  if (req.method === "GET") {
    // Meta webhook verification
    const hubMode = url.searchParams.get("hub.mode");
    const hubVerifyToken = url.searchParams.get("hub.verify_token");
    const hubChallenge = url.searchParams.get("hub.challenge");

    if (hubMode === "subscribe" && hubVerifyToken && hubChallenge) {
      const keyResult = await validateApiKey(supabase, hubVerifyToken);
      if (keyResult.valid) {
        return new Response(hubChallenge, {
          status: 200,
          headers: corsHeaders,
        });
      }
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }

    return new Response(
      JSON.stringify({ status: "ok", service: "client-intake-webhook", version: 9 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // ── POST: Intake submission ──
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Parse body (JSON, form-urlencoded, or multipart)
    let body: Record<string, any>;
    try {
      const contentType = req.headers.get("content-type") || "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const formData = await req.formData();
        body = {};
        formData.forEach((value, key) => { body[key] = value; });
      } else if (contentType.includes("multipart/form-data")) {
        const formData = await req.formData();
        body = {};
        formData.forEach((value, key) => {
          if (typeof value === "string") body[key] = value;
        });
      } else {
        const text = await req.text();
        if (!text || text.trim() === "") {
          // Empty body — Forminator test ping or health check
          return new Response(
            JSON.stringify({ status: "ok", message: "Webhook is active. Send form data to create records." }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        body = JSON.parse(text);
      }
    } catch {
      return new Response(
        JSON.stringify({ error: "Could not parse request body. Send JSON or form-urlencoded data.", code: "INVALID_BODY" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Empty object — test ping from Forminator or similar
    if (!body || Object.keys(body).length === 0) {
      return new Response(
        JSON.stringify({ status: "ok", message: "Webhook is active. Send form data to create records." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract API key (header > query param > body field)
    const apiKey =
      req.headers.get("x-api-key") ||
      url.searchParams.get("api_key") ||
      body.api_key ||
      null;

    // Validate API key
    const keyResult = await validateApiKey(supabase, apiKey);
    if (!keyResult.valid) {
      return new Response(
        JSON.stringify({ error: "Invalid or missing API key", code: "INVALID_API_KEY" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Determine entity_type from API key config (default 'client' for backward compat)
    const entityType = keyResult.entity_type || "client";
    const source = keyResult.source || "webhook";

    // Queue the raw payload for async processing
    const { error: queueErr } = await supabase.from("intake_queue").insert({
      source,
      entity_type: entityType,
      raw_payload: body,
      api_key_label: keyResult.label || null,
      status: "pending",
    });

    if (queueErr) {
      console.error("Queue insert error:", queueErr);
      return new Response(
        JSON.stringify({ error: "Failed to queue submission", code: "QUEUE_ERROR" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Submission received and queued for processing",
        source,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response(
      JSON.stringify({
        error: `Internal error: ${err.message || "Unknown"}`,
        code: "INTERNAL_ERROR",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
