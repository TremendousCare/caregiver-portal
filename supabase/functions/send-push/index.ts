// ─── send-push (self-test) ───
// Sends a Web Push notification to the CALLING caregiver's own subscribed
// devices. Used by the PWA to confirm the pipeline works right after a
// caregiver opts in ("Reminders are on"). Self-scoped: a caregiver can
// only ever push to their own subscriptions, so it's safe to expose.
//
// Request: POST  Authorization: Bearer <caregiver JWT>
//   body (optional): { title, body, url }
// Response: { ok, sent, expired }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { configureVapid, sendToSubscription } from "../_shared/push/sendWebPush.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required." }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization." }, 401);

  if (!configureVapid()) {
    return json({ error: "Push isn't configured yet." }, 500);
  }

  // Resolve the calling caregiver from their JWT.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not authenticated." }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: cg } = await admin
    .from("caregivers")
    .select("id")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (!cg) return json({ error: "No caregiver linked to this login." }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { body = {}; }

  const payload = {
    title: (body.title as string) || "Reminders are on",
    body: (body.body as string) || "You'll get a notification before each shift.",
    url: (body.url as string) || "/care",
    tag: "push-test",
  };

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("caregiver_id", cg.id)
    .is("disabled_at", null);

  if (!subs || subs.length === 0) return json({ ok: true, sent: 0, expired: 0 });

  let sent = 0;
  let expired = 0;
  for (const sub of subs) {
    const res = await sendToSubscription(sub, payload);
    if (res.ok) {
      sent += 1;
    } else if (res.expired) {
      expired += 1;
      await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("id", sub.id);
    }
  }

  return json({ ok: true, sent, expired });
});
