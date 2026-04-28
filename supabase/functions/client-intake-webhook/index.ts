import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ═══════════════════════════════════════════════════════════════
// Client Intake Webhook v10 — Queue-based intake endpoint
//
// Receives POST from WordPress (Forminator/CF7), Google Ads,
// Meta lead ads, or any external source. Validates either an
// API key (header/query/body) OR a Meta App Secret HMAC signature
// (X-Hub-Signature-256), then INSERTs raw payload into intake_queue
// and returns 200.
//
// All field mapping, dedup, record creation, and automations
// are handled asynchronously by the intake-processor function.
// For Meta Lead Ads, the processor fetches the actual lead via
// Graph API using FACEBOOK_PAGE_ACCESS_TOKEN.
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

// ─── Meta (Facebook) Signature Verification ─────────────────
// Meta signs every webhook POST with HMAC-SHA256 over the raw body
// using the App Secret. The signature is sent as
//   X-Hub-Signature-256: sha256=<hex>
// Reference: https://developers.facebook.com/docs/graph-api/webhooks/getting-started

async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const appSecret = Deno.env.get("FACEBOOK_APP_SECRET");
  if (!appSecret) {
    console.error("FACEBOOK_APP_SECRET not set — cannot verify Meta webhook");
    return false;
  }
  const expected = signatureHeader.slice("sha256=".length).toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );
  const actual = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
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
      JSON.stringify({ status: "ok", service: "client-intake-webhook", version: 10 }),
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
    // ── Meta (Facebook) Lead Ads branch ──
    // Detected by presence of X-Hub-Signature-256 header. We read the
    // raw body, verify the HMAC, parse it, and queue one entry per
    // leadgen change. The processor will fetch field data via Graph API.
    const metaSig = req.headers.get("x-hub-signature-256");
    if (metaSig) {
      const rawBody = await req.text();
      const valid = await verifyMetaSignature(rawBody, metaSig);
      if (!valid) {
        console.warn("Meta signature verification failed");
        return new Response(
          JSON.stringify({ error: "Invalid Meta signature", code: "INVALID_SIGNATURE" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let metaBody: any;
      try {
        metaBody = JSON.parse(rawBody);
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid Meta JSON body", code: "INVALID_BODY" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const entries = Array.isArray(metaBody?.entry) ? metaBody.entry : [];
      let queued = 0;
      for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
          if (change?.field !== "leadgen" || !change?.value) continue;
          const value = change.value;
          // Preserve the page_id from the entry so we can route in the future
          const payload = {
            ...value,
            page_id: value.page_id || entry.id || null,
          };
          const { error: queueErr } = await supabase
            .from("intake_queue")
            .insert({
              source: "facebook_lead_ads",
              entity_type: "client",
              raw_payload: payload,
              api_key_label: "Meta Lead Ads",
              status: "pending",
            });
          if (queueErr) {
            console.error("Meta leadgen queue insert error:", queueErr);
          } else {
            queued++;
          }
        }
      }

      // Per Meta docs, always respond 200 to acknowledge receipt
      return new Response(
        JSON.stringify({ status: "ok", queued }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
