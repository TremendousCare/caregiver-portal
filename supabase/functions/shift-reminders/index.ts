// ─── shift-reminders (cron) ───
// Runs every 15 min (pg_cron). Finds shifts starting within the next
// ~75 minutes that haven't been reminded yet, and sends a Web Push
// reminder to each assigned caregiver's subscribed devices.
//
// Dedupe: shifts.reminder_sent_at is stamped once a caregiver has at
// least one subscription we attempted, so a shift is reminded at most
// once. Expired subscriptions (404/410) are disabled in place.
//
// Invoked by pg_cron via net.http_post with the project's publishable
// key (gateway-auth model, same as the other background jobs). A present
// Authorization header is required so an unauthenticated direct hit is
// rejected; the gateway enforces the actual JWT verification.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { configureVapid, sendToSubscription } from "../_shared/push/sendWebPush.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const WINDOW_MINUTES = 75;

function clientName(client: { first_name?: string; last_name?: string } | null): string {
  if (!client) return "your client";
  const n = `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim();
  return n || "your client";
}

function reminderPayload(name: string, startTime: string, shiftId: string) {
  const minutesUntil = Math.round((Date.parse(startTime) - Date.now()) / 60000);
  const when = minutesUntil <= 0
    ? " now"
    : minutesUntil < 60
      ? ` in ${minutesUntil} min`
      : ` at ${new Date(startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  return {
    title: "Upcoming shift",
    body: `Shift with ${name}${when}.`,
    url: `/care/shifts/${shiftId}`,
    tag: `shift-${shiftId}`,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!req.headers.get("Authorization")) return json({ error: "Missing Authorization." }, 401);

  if (!configureVapid()) {
    return json({ error: "VAPID keys not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)." }, 500);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const nowIso = new Date().toISOString();
  const untilIso = new Date(Date.now() + WINDOW_MINUTES * 60000).toISOString();

  const { data: shifts, error: shiftErr } = await admin
    .from("shifts")
    .select("id, client_id, assigned_caregiver_id, start_time, status, reminder_sent_at")
    .in("status", ["assigned", "confirmed"])
    .is("reminder_sent_at", null)
    .not("assigned_caregiver_id", "is", null)
    .gte("start_time", nowIso)
    .lte("start_time", untilIso)
    .order("start_time", { ascending: true });

  if (shiftErr) return json({ error: shiftErr.message }, 500);
  if (!shifts || shifts.length === 0) return json({ ok: true, shifts: 0, sent: 0 });

  let sent = 0;
  let remindedShifts = 0;
  let expired = 0;

  for (const shift of shifts) {
    // Subscriptions for the assigned caregiver (skip disabled ones).
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("caregiver_id", shift.assigned_caregiver_id)
      .is("disabled_at", null);

    if (!subs || subs.length === 0) continue; // leave reminder_sent_at null

    const { data: client } = await admin
      .from("clients")
      .select("first_name, last_name")
      .eq("id", shift.client_id)
      .maybeSingle();

    const payload = reminderPayload(clientName(client), shift.start_time, shift.id);

    for (const sub of subs) {
      const res = await sendToSubscription(sub, payload);
      if (res.ok) {
        sent += 1;
      } else if (res.expired) {
        expired += 1;
        await admin
          .from("push_subscriptions")
          .update({ disabled_at: new Date().toISOString() })
          .eq("id", sub.id);
      }
    }

    await admin.from("shifts").update({ reminder_sent_at: new Date().toISOString() }).eq("id", shift.id);
    remindedShifts += 1;
  }

  return json({ ok: true, shifts: shifts.length, reminded: remindedShifts, sent, expired });
});
