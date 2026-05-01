// ─── Microsoft 365 Bookings — Inbound Webhook ───────────────────────────────
// Receives Microsoft Graph change notifications when an appointment in a
// Bookings business is created/updated/deleted, fetches the appointment
// back from Graph (notifications don't include payload by design — they
// just point at the resource), matches the customer to a caregiver, and
// upserts the row into `caregiver_interviews`.
//
// Two request shapes are handled:
//
//   1. Subscription validation. When we POST /subscriptions to Graph,
//      Graph immediately POSTs back to this URL with a `validationToken`
//      query parameter. We must echo it as plain text within 10s or the
//      subscription is rejected. No body to parse, no work to do.
//
//   2. Change notification. Graph POSTs a JSON body shaped as
//        { "value": [ { subscriptionId, clientState, changeType,
//                       resource, resourceData: { id } }, ... ] }
//      For each entry: validate clientState against bookings_subscriptions,
//      fetch the appointment from Graph, normalize, match, upsert.
//
// Security: clientState is the only thing standing between this endpoint
// and a forger. We compare against the stored value for that
// subscriptionId — mismatch → silently drop (avoid leaking subscription
// existence). Service role bypass + RLS is what keeps cross-tenant
// pollution impossible at the DB layer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  matchCustomerToCaregiver,
  normalizeGraphAppointment,
  parseGraphNotifications,
  type GraphAppointment,
} from "../_shared/helpers/bookings.ts";

// ─── Env / clients ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH = "https://graph.microsoft.com/v1.0";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Microsoft Graph Auth ───
// Same client-credentials flow as bookings-integration. Kept inline
// here rather than shared because Deno edge functions can't easily
// share state across cold starts and the helper is tiny.

async function getGraphToken(): Promise<string> {
  const tenantId = Deno.env.get("MICROSOFT_TENANT_ID");
  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
  const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Missing MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`Microsoft token error: ${resp.status} - ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.access_token as string;
}

async function fetchGraphAppointment(
  token: string,
  businessId: string,
  appointmentId: string,
): Promise<GraphAppointment | null> {
  const url = `${GRAPH}/solutions/bookingBusinesses/${encodeURIComponent(
    businessId,
  )}/appointments/${encodeURIComponent(appointmentId)}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  // 404 means the appointment was deleted/cancelled hard. We still want
  // to mark it cancelled in our mirror so the UI reflects reality.
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(
      `Graph appointment fetch failed: ${resp.status} - ${await resp.text()}`,
    );
  }
  return (await resp.json()) as GraphAppointment;
}

// ─── Mirror an appointment into caregiver_interviews ───
//
// 1. Resolve subscription → org_id + business_id
// 2. Fetch appointment from Graph (or treat 404 as deletion)
// 3. Normalize and match to a caregiver in that org
// 4. Upsert into caregiver_interviews
//
// All DB writes are scoped to the subscription's org_id so a forged
// notification for the wrong tenant is impossible (the JOIN is what
// pins it).

async function mirrorAppointment(
  subscriptionRow: {
    id: string;
    org_id: string;
    business_id: string;
    client_state: string | null;
  },
  appointmentId: string,
  changeType: string,
): Promise<{ status: string; reason?: string }> {
  // ── Hard-delete short-circuit ──
  // Graph emits changeType "deleted" without giving us a final payload.
  // Mark the local mirror cancelled if we have it; ignore if we don't.
  if (changeType === "deleted") {
    const { error } = await supabase
      .from("caregiver_interviews")
      .update({ status: "cancelled" })
      .eq("org_id", subscriptionRow.org_id)
      .eq("graph_appointment_id", appointmentId);
    if (error) {
      console.error("caregiver_interviews delete-mark error:", error);
      return { status: "error", reason: error.message };
    }
    return { status: "cancelled" };
  }

  // ── Fetch from Graph ──
  const token = await getGraphToken();
  const graph = await fetchGraphAppointment(
    token,
    subscriptionRow.business_id,
    appointmentId,
  );

  if (!graph) {
    // Appointment is gone server-side. Treat the same as a deleted event.
    const { error } = await supabase
      .from("caregiver_interviews")
      .update({ status: "cancelled" })
      .eq("org_id", subscriptionRow.org_id)
      .eq("graph_appointment_id", appointmentId);
    if (error) {
      console.error("caregiver_interviews 404-mark error:", error);
      return { status: "error", reason: error.message };
    }
    return { status: "cancelled_404" };
  }

  // ── Normalize ──
  const normalized = normalizeGraphAppointment(graph);
  if (!normalized.graph_appointment_id) {
    return { status: "skipped", reason: "missing graph appointment id" };
  }

  // ── Match to caregiver in this org ──
  // Matches by phone primary, email fallback. Pulls only org-scoped,
  // non-archived caregivers — keeps the candidate list small and stays
  // safe at multi-org scale.
  const { data: caregivers, error: cgErr } = await supabase
    .from("caregivers")
    .select("id, first_name, last_name, phone, email")
    .eq("org_id", subscriptionRow.org_id)
    .eq("archived", false);

  if (cgErr) {
    console.error("caregivers lookup error:", cgErr);
    // Fall through with empty list — we still mirror the appointment as
    // unmatched so the booking is visible to admins.
  }

  const { caregiver, matchMethod } = matchCustomerToCaregiver(
    {
      phone: normalized.customer_phone,
      email: normalized.customer_email,
    },
    caregivers || [],
  );

  // ── Upsert ──
  // ON CONFLICT (org_id, graph_appointment_id) keeps the row stable
  // across re-notifications and reschedules.
  const row = {
    org_id: subscriptionRow.org_id,
    graph_appointment_id: normalized.graph_appointment_id,
    business_id: subscriptionRow.business_id,
    service_id: normalized.service_id,
    service_name: normalized.service_name,
    staff_member_ids: normalized.staff_member_ids,
    caregiver_id: caregiver ? caregiver.id : null,
    match_method: matchMethod,
    start_at: normalized.start_at,
    end_at: normalized.end_at,
    status: normalized.status,
    customer_name: normalized.customer_name,
    customer_email: normalized.customer_email,
    customer_phone: normalized.customer_phone,
    customer_notes: normalized.customer_notes,
    join_web_url: normalized.join_web_url,
    raw_payload: graph as unknown as Record<string, unknown>,
  };

  const { error: upsertErr } = await supabase
    .from("caregiver_interviews")
    .upsert(row, { onConflict: "org_id,graph_appointment_id" });

  if (upsertErr) {
    console.error("caregiver_interviews upsert error:", upsertErr);
    return { status: "error", reason: upsertErr.message };
  }

  return {
    status: caregiver ? `mirrored_${matchMethod}` : "mirrored_unmatched",
  };
}

// ─── Notification handler ───
//
// One request from Graph can carry multiple notifications. We process
// them serially: keeps error attribution clean and avoids hammering
// Graph with parallel fetches in tight bursts. Per-notification errors
// are logged but don't fail the whole request — Graph retries on 5xx,
// and we'd rather mirror N-1 of N appointments than zero.

async function handleNotifications(
  body: Record<string, any>,
): Promise<Response> {
  const notifications = parseGraphNotifications(body);

  if (notifications.length === 0) {
    return new Response(
      JSON.stringify({ skipped: true, reason: "no notifications" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const results: Array<Record<string, unknown>> = [];

  for (const notif of notifications) {
    // Resolve the subscription → org_id binding. clientState is checked
    // here; mismatch silently drops.
    const { data: sub } = await supabase
      .from("bookings_subscriptions")
      .select("id, org_id, business_id, client_state")
      .eq("subscription_id", notif.subscriptionId)
      .maybeSingle();

    if (!sub) {
      results.push({
        subscriptionId: notif.subscriptionId,
        status: "skipped",
        reason: "unknown subscription",
      });
      continue;
    }

    if (sub.client_state && sub.client_state !== notif.clientState) {
      // Don't echo "wrong client state" back to the caller. Just drop.
      results.push({
        subscriptionId: notif.subscriptionId,
        status: "skipped",
        reason: "client_state mismatch",
      });
      continue;
    }

    try {
      const result = await mirrorAppointment(
        sub,
        notif.appointmentId,
        notif.changeType,
      );
      results.push({
        subscriptionId: notif.subscriptionId,
        appointmentId: notif.appointmentId,
        changeType: notif.changeType,
        ...result,
      });
    } catch (err) {
      const message = (err as Error).message || String(err);
      console.error("mirrorAppointment error:", message);
      results.push({
        subscriptionId: notif.subscriptionId,
        appointmentId: notif.appointmentId,
        status: "error",
        reason: message,
      });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Request handler ───
//
// Two-shape entry point. Subscription validation MUST respond with
// plain-text body containing the validation token within ~10s. Any
// extra latency (e.g., reading Supabase) risks Microsoft rejecting the
// subscription — so the validation path runs before we touch the DB.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Subscription validation echo (Microsoft Graph subscription handshake).
  // Graph sends both query-string and header variants depending on API
  // version. Accept either.
  const url = new URL(req.url);
  const validationToken =
    url.searchParams.get("validationToken") ||
    req.headers.get("validationtoken") ||
    req.headers.get("validation-token");

  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: `Bad JSON: ${(err as Error).message}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    return await handleNotifications(body);
  } catch (err) {
    console.error("bookings-webhook error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
