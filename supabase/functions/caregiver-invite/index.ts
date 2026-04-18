// ─── Caregiver Invite ───
// Two actions:
//   1. "send"  — staff-only. Send a magic-link invite to a caregiver.
//                If they already have an auth account, we just resend
//                the magic link. Otherwise we create the auth user.
//   2. "link"  — called by the caregiver PWA on first login. Matches
//                the authenticated email to a caregivers row and
//                populates caregivers.user_id so subsequent sessions
//                can see their own data via RLS.
//
// Why separate "link" rather than a DB trigger? Triggers on auth.users
// require service-role access and are painful to maintain. A simple
// edge function called once on first PWA load is clearer and easier
// to change.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The magic link lands the caregiver on this URL.
const CAREGIVER_APP_URL = Deno.env.get("CAREGIVER_APP_URL") ?? "https://caregiver-portal.vercel.app/care";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function assertStaff(authHeader: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error } = await userClient.auth.getUser();
  if (error || !userData?.user?.email) return { ok: false, error: "Not authenticated.", status: 401 };

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("email", userData.user.email.toLowerCase())
    .maybeSingle();
  if (!roleRow || !["admin", "member"].includes(roleRow.role)) {
    return { ok: false, error: "Staff access required.", status: 403 };
  }
  return { ok: true };
}

// ─── Action: staff sends magic-link invite ───
async function handleSend(req: Request, body: Record<string, unknown>) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization." }, 401);
  const check = await assertStaff(authHeader);
  if (!check.ok) return jsonResponse({ error: check.error }, check.status);

  const { caregiver_id } = body ?? {};
  if (!caregiver_id) return jsonResponse({ error: "Missing caregiver_id." }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cg, error: cgErr } = await admin
    .from("caregivers")
    .select("id, email, first_name, last_name, user_id")
    .eq("id", caregiver_id)
    .maybeSingle();
  if (cgErr || !cg) return jsonResponse({ error: "Caregiver not found." }, 404);
  if (!cg.email) return jsonResponse({ error: "Caregiver has no email on file." }, 400);

  const email = cg.email.toLowerCase();

  // Generate a magic link. If the user exists, Supabase returns a
  // "login" link; if not, it creates the user and returns a "signup"
  // link. Either way the caregiver gets an email.
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: cg.user_id ? "magiclink" : "invite",
    email,
    options: { redirectTo: CAREGIVER_APP_URL },
  });
  if (linkErr) {
    console.error("[caregiver-invite] generateLink error:", linkErr);
    return jsonResponse({ error: linkErr.message }, 500);
  }

  // If this was an invite (new user), Supabase creates the auth row —
  // we can link it to the caregiver record immediately so they land
  // straight into /care after clicking the link.
  const newUserId = link?.user?.id;
  if (newUserId && !cg.user_id) {
    await admin
      .from("caregivers")
      .update({ user_id: newUserId })
      .eq("id", cg.id);
  }

  // Fire-and-forget event log.
  try {
    await admin.from("events").insert({
      event_type: "caregiver_invite_sent",
      entity_type: "caregiver",
      entity_id: cg.id,
      actor: "system:caregiver-invite",
      payload: { email, method: "magic_link" },
    });
  } catch (_) {
    // Non-fatal
  }

  return jsonResponse({
    success: true,
    email,
    user_linked: !!(newUserId || cg.user_id),
  });
}

// ─── Action: caregiver self-links on first login ───
// Called by the PWA when a newly-authenticated user has no linked
// caregiver record. Matches by email (case-insensitive) and sets
// caregivers.user_id = auth.uid(). Idempotent.
async function handleLink(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization." }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user?.email) {
    return jsonResponse({ error: "Not authenticated." }, 401);
  }
  const uid = userData.user.id;
  const email = userData.user.email.toLowerCase();

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Already linked?
  const { data: existing } = await admin
    .from("caregivers")
    .select("id")
    .eq("user_id", uid)
    .maybeSingle();
  if (existing) {
    return jsonResponse({ success: true, caregiver_id: existing.id, already_linked: true });
  }

  // Find by email (case-insensitive match).
  const { data: cg } = await admin
    .from("caregivers")
    .select("id, user_id")
    .ilike("email", email)
    .maybeSingle();
  if (!cg) {
    return jsonResponse({ error: "No caregiver record found for this email." }, 404);
  }
  if (cg.user_id && cg.user_id !== uid) {
    return jsonResponse({ error: "This caregiver is already linked to a different account." }, 409);
  }

  const { error: updErr } = await admin
    .from("caregivers")
    .update({ user_id: uid })
    .eq("id", cg.id);
  if (updErr) {
    console.error("[caregiver-invite] link update error:", updErr);
    return jsonResponse({ error: "Failed to link account." }, 500);
  }

  try {
    await admin.from("events").insert({
      event_type: "caregiver_linked",
      entity_type: "caregiver",
      entity_id: cg.id,
      actor: `caregiver:${cg.id}`,
      payload: { email },
    });
  } catch (_) {
    // Non-fatal
  }

  return jsonResponse({ success: true, caregiver_id: cg.id });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST required." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action;
    if (action === "send") return await handleSend(req, body);
    if (action === "link") return await handleLink(req);
    return jsonResponse({ error: "Unknown action. Pass { action: 'send' | 'link' } in the body." }, 400);
  } catch (err) {
    console.error("[caregiver-invite] unhandled error:", err);
    return jsonResponse({ error: (err as Error).message || "Internal server error." }, 500);
  }
});
