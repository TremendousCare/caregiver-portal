import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  RouteResult,
  RouteRow,
  summarizeRouteResults,
} from "./subscribe-helpers.ts";

// ─── Environment Variables ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RC_CLIENT_ID = Deno.env.get("RINGCENTRAL_CLIENT_ID");
const RC_CLIENT_SECRET = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");
const RC_JWT_TOKEN = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
const RC_API_URL = "https://platform.ringcentral.com";

// ─── CORS Headers ───
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, validation-token",
};

// ─── Supabase Client (service role) ───
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Phone Number Normalization ───
function normalizePhoneNumber(phone: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Strip a phone to its last 10 digits for fuzzy matching */
function phoneDigits(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

// ─── Get RingCentral Access Token ───
async function getRingCentralAccessTokenWithJwt(jwt: string): Promise<string> {
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

// Resolve the JWT to use for subscribing a given route.
// Per-route vault secret wins; otherwise fall back to the global env JWT
// so the historical main-line behavior keeps working with zero config.
async function getJwtForRoute(category: string): Promise<string> {
  const { data, error } = await supabase.rpc("get_route_ringcentral_jwt", {
    p_category: category,
  });
  if (!error && Array.isArray(data) && data.length > 0 && data[0]?.jwt) {
    return data[0].jwt as string;
  }
  if (!RC_JWT_TOKEN) {
    throw new Error(
      `No per-route JWT for "${category}" and RINGCENTRAL_JWT_TOKEN env var is missing`,
    );
  }
  return RC_JWT_TOKEN;
}

// ─── Caregiver Phase Helper ───
function getCaregiverPhase(cg: Record<string, unknown>): string {
  if (cg.phase_override) return cg.phase_override as string;
  // Default logic: check phase_timestamps for latest phase
  const timestamps = (cg.phase_timestamps || {}) as Record<string, number>;
  const phases = ["intake", "interview", "onboarding", "verification", "orientation"];
  let latest = "intake";
  let latestTime = 0;
  for (const p of phases) {
    if (timestamps[p] && timestamps[p] > latestTime) {
      latest = p;
      latestTime = timestamps[p];
    }
  }
  return latest;
}

function getClientPhase(cl: Record<string, unknown>): string {
  return (cl.phase as string) || "new_lead";
}

// ─── Match Phone Number to Caregiver/Client ───
async function matchPhoneToEntities(
  senderPhone: string
): Promise<Array<{ entity_type: string; entity: Record<string, unknown> }>> {
  const matches: Array<{ entity_type: string; entity: Record<string, unknown> }> = [];
  const digits = phoneDigits(senderPhone);
  if (digits.length < 10) return matches;

  // Search caregivers
  const { data: caregivers } = await supabase
    .from("caregivers")
    .select("id, first_name, last_name, phone, email, notes, phase_override, phase_timestamps, tasks, archived")
    .eq("archived", false);

  if (caregivers) {
    for (const cg of caregivers) {
      if (cg.phone && phoneDigits(cg.phone) === digits) {
        matches.push({ entity_type: "caregiver", entity: cg });
      }
    }
  }

  // Search clients
  const { data: clients } = await supabase
    .from("clients")
    .select("id, first_name, last_name, phone, email, notes, phase, phase_timestamps, tasks, archived")
    .eq("archived", false);

  if (clients) {
    for (const cl of clients) {
      if (cl.phone && phoneDigits(cl.phone) === digits) {
        matches.push({ entity_type: "client", entity: cl });
      }
    }
  }

  return matches;
}

// ─── Log Note on Entity ───
async function logInboundNote(
  entityType: string,
  entity: Record<string, unknown>,
  messageText: string,
  senderPhone: string
): Promise<void> {
  const tableName = entityType === "client" ? "clients" : "caregivers";
  const currentNotes = Array.isArray(entity.notes) ? entity.notes : [];

  const note = {
    text: messageText,
    type: "text",
    direction: "inbound",
    source: "ringcentral",
    timestamp: Date.now(),
    author: "SMS Webhook",
    outcome: `Received from ${senderPhone}`,
  };

  await supabase
    .from(tableName)
    .update({ notes: [...currentNotes, note] })
    .eq("id", entity.id);
}

// ─── Fire Automation Rules (server-side) ───
async function fireInboundSmsAutomations(
  entityType: string,
  entity: Record<string, unknown>,
  messageText: string,
  senderPhone: string,
  rcMessageId: string
): Promise<void> {
  const { data: rules } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("trigger_type", "inbound_sms")
    .eq("enabled", true);

  if (!rules || rules.length === 0) return;

  // Filter by entity_type if the rule specifies one
  const applicableRules = rules.filter((r) => {
    if (r.entity_type && r.entity_type !== entityType) return false;
    return true;
  });

  const phase =
    entityType === "client"
      ? getClientPhase(entity)
      : getCaregiverPhase(entity);

  for (const rule of applicableRules) {
    const conds = rule.conditions || {};

    // Phase filter
    if (conds.phase && phase !== conds.phase) continue;

    // Keyword filter (case-insensitive)
    if (conds.keyword) {
      if (!messageText.toLowerCase().includes(conds.keyword.toLowerCase())) {
        continue;
      }
    }

    // Build payload for execute-automation (snake_case)
    const entityPayload = {
      id: entity.id,
      first_name: entity.first_name || "",
      last_name: entity.last_name || "",
      phone: entity.phone || "",
      email: entity.email || "",
      phase,
    };

    const triggerContext = {
      message_text: messageText,
      sender_number: senderPhone,
      rc_message_id: rcMessageId,
    };

    // Fire-and-forget (don't await — prevents timeout)
    fetch(`${SUPABASE_URL}/functions/v1/execute-automation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        rule_id: rule.id,
        caregiver_id: entity.id,
        entity_type: entityType,
        action_type: rule.action_type,
        message_template: rule.message_template,
        action_config: rule.action_config,
        rule_name: rule.name,
        caregiver: entityPayload,
        trigger_context: triggerContext,
      }),
    }).catch((err) =>
      console.error(`Automation fire error for rule ${rule.id}:`, err)
    );
  }
}

// ─── Handle Webhook Subscription (admin action) ───
//
// Iterates over every active row in `communication_routes` and ensures
// each one has a live RingCentral webhook subscription. Renews existing
// subscriptions where possible; creates new ones where renewal fails
// (404 / expired) or the route has never been subscribed.
//
// Each route uses its own JWT (per-route vault secret → fall back to
// RINGCENTRAL_JWT_TOKEN env var). The resulting subscription is scoped
// to that JWT's extension, which is what gives us per-number inbound
// SMS coverage without any handler-level changes.

async function subscribeOneRoute(
  route: RouteRow,
  webhookUrl: string,
): Promise<RouteResult> {
  try {
    const jwt = await getJwtForRoute(route.category);
    const accessToken = await getRingCentralAccessTokenWithJwt(jwt);

    // ── Try to renew an existing subscription ──
    if (route.subscription_id) {
      const renewResp = await fetch(
        `${RC_API_URL}/restapi/v1.0/subscription/${route.subscription_id}/renew`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (renewResp.ok) {
        const renewData = await renewResp.json();
        await supabase
          .from("communication_routes")
          .update({
            subscription_id: renewData.id,
            subscription_expires_at: renewData.expirationTime,
            subscription_last_error: null,
            subscription_synced_at: new Date().toISOString(),
          })
          .eq("category", route.category);
        return {
          category: route.category,
          label: route.label,
          action: "renewed",
          subscription_id: renewData.id,
          expires_at: renewData.expirationTime,
        };
      }
      // Fall through to create-new on any renew failure (404 / expired / etc.)
    }

    // ── Create a new subscription ──
    const subResp = await fetch(`${RC_API_URL}/restapi/v1.0/subscription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        eventFilters: [
          "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS",
        ],
        deliveryMode: {
          transportType: "WebHook",
          address: webhookUrl,
        },
        expiresIn: 630720000, // RC will cap this at its max (~7 days)
      }),
    });

    if (!subResp.ok) {
      const errText = await subResp.text();
      throw new Error(`RC subscription create failed (${subResp.status}): ${errText}`);
    }

    const subData = await subResp.json();
    await supabase
      .from("communication_routes")
      .update({
        subscription_id: subData.id,
        subscription_expires_at: subData.expirationTime,
        subscription_last_error: null,
        subscription_synced_at: new Date().toISOString(),
      })
      .eq("category", route.category);

    return {
      category: route.category,
      label: route.label,
      action: "created",
      subscription_id: subData.id,
      expires_at: subData.expirationTime,
    };
  } catch (err) {
    const message = (err as Error).message || String(err);
    await supabase
      .from("communication_routes")
      .update({
        subscription_last_error: message,
        subscription_synced_at: new Date().toISOString(),
      })
      .eq("category", route.category);
    return {
      category: route.category,
      label: route.label,
      action: "failed",
      error: message,
    };
  }
}

async function handleSubscribe(): Promise<Response> {
  try {
    const webhookUrl = `${SUPABASE_URL}/functions/v1/ringcentral-webhook`;

    const { data: routes, error: routesErr } = await supabase
      .from("communication_routes")
      .select("category, label, subscription_id")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (routesErr) {
      throw new Error(`Failed to load communication_routes: ${routesErr.message}`);
    }

    if (!routes || routes.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "No active communication_routes found. Add at least one active route before subscribing.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Subscribe routes serially: keeps error attribution clear and avoids
    // any RC rate-limit surprises on accounts with many extensions.
    const results: RouteResult[] = [];
    for (const route of routes as RouteRow[]) {
      results.push(await subscribeOneRoute(route, webhookUrl));
    }

    // Write aggregate summary so the legacy Admin UI can read a single row.
    const summary = summarizeRouteResults(results);
    await supabase.from("app_settings").upsert(
      {
        key: "ringcentral_webhook_subscription",
        value: summary,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );

    const anyFailed = results.some((r) => r.action === "failed");
    return new Response(
      JSON.stringify({
        success: !anyFailed,
        routes: results,
        summary: {
          total: results.length,
          subscribed: results.filter((r) => r.action !== "failed").length,
          failed: results.filter((r) => r.action === "failed").length,
        },
      }),
      {
        status: anyFailed ? 207 : 200, // 207 Multi-Status when some routes failed
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
}

// ─── Handle Inbound SMS Webhook ───
async function handleInboundSms(body: Record<string, unknown>): Promise<Response> {
  // Extract message details from RingCentral notification
  // RC instant message notification format:
  // { uuid, event, timestamp, subscriptionId, body: { id, from: { phoneNumber }, to: [...], subject, direction, ... } }
  const msgBody = (body.body || body) as Record<string, unknown>;
  const rcMessageId = String(msgBody.id || "");
  const from = (msgBody.from || {}) as Record<string, unknown>;
  const senderPhone = String(from.phoneNumber || "");
  const toArray = (msgBody.to || []) as Array<Record<string, unknown>>;
  const toPhone = toArray.length > 0 ? String(toArray[0].phoneNumber || "") : "";
  const messageText = String(msgBody.subject || msgBody.text || "");
  const direction = String(msgBody.direction || "").toLowerCase();

  // Only process inbound SMS
  if (direction !== "inbound") {
    return new Response(
      JSON.stringify({ skipped: true, reason: "Not an inbound message" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!rcMessageId || !senderPhone) {
    return new Response(
      JSON.stringify({ skipped: true, reason: "Missing message ID or sender phone" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // ─── Dedup Check ───
  const { data: existing } = await supabase
    .from("inbound_sms_log")
    .select("id")
    .eq("rc_message_id", rcMessageId)
    .limit(1);

  if (existing && existing.length > 0) {
    return new Response(
      JSON.stringify({ skipped: true, reason: "Duplicate message" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // ─── Match Phone to Entities ───
  const matches = await matchPhoneToEntities(senderPhone);

  // ─── Log Note on Matched Entities ───
  for (const match of matches) {
    await logInboundNote(match.entity_type, match.entity, messageText, senderPhone);
  }

  // ─── Insert Dedup Record ───
  // If matched multiple entities, log the first one as primary
  const primaryMatch = matches.length > 0 ? matches[0] : null;
  await supabase.from("inbound_sms_log").insert({
    rc_message_id: rcMessageId,
    from_phone: senderPhone,
    to_phone: toPhone,
    message_text: messageText,
    matched_entity_type: primaryMatch?.entity_type || null,
    matched_entity_id: primaryMatch ? String(primaryMatch.entity.id) : null,
    automation_fired: matches.length > 0,
  });

  // ─── Fire Automations (async, fire-and-forget) ───
  for (const match of matches) {
    fireInboundSmsAutomations(
      match.entity_type,
      match.entity,
      messageText,
      senderPhone,
      rcMessageId
    ).catch((err) =>
      console.error(`Automation error for ${match.entity_type} ${match.entity.id}:`, err)
    );
  }

  // ─── Queue for AI Routing (fire-and-forget) ───
  // The message-router cron will classify intent, draft responses,
  // and create ai_suggestions based on autonomy config.
  supabase
    .from("message_routing_queue")
    .insert({
      channel: "sms",
      external_message_id: rcMessageId,
      sender_identifier: senderPhone,
      recipient_identifier: toPhone,
      message_text: messageText,
      matched_entity_type: primaryMatch?.entity_type || null,
      matched_entity_id: primaryMatch ? String(primaryMatch.entity.id) : null,
      matched_entity_name: primaryMatch
        ? `${primaryMatch.entity.first_name} ${primaryMatch.entity.last_name}`.trim()
        : null,
    })
    .then(() => {})
    .catch((err: any) => console.error("Message routing queue insert error:", err));

  return new Response(
    JSON.stringify({
      success: true,
      matched: matches.length,
      entities: matches.map((m) => ({
        type: m.entity_type,
        id: m.entity.id,
        name: `${m.entity.first_name} ${m.entity.last_name}`,
      })),
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// ─── Main Handler ───
Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ─── Validation Token (RingCentral webhook registration challenge) ───
  const validationToken = req.headers.get("validation-token") || req.headers.get("Validation-Token");
  if (validationToken) {
    return new Response("", {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Validation-Token": validationToken,
      },
    });
  }

  // ─── Route: Subscribe action (admin UI) ───
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "subscribe") {
    return handleSubscribe();
  }

  // ─── Route: Inbound SMS webhook (default) ───
  try {
    const body = await req.json();
    return handleInboundSms(body);
  } catch (err) {
    console.error("ringcentral-webhook error:", err);
    return new Response(
      JSON.stringify({ error: `Internal error: ${err.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
