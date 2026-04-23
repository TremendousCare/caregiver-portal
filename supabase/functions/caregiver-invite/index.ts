// ─── Caregiver Invite ───
// Three actions:
//   1. "send"            — staff-only. Send a magic-link invite. Kept
//                          for backward compatibility with caregivers
//                          who were already onboarded this way. New
//                          invites should use "create_with_password".
//   2. "create_password" — staff-only. Create an auth user with an
//                          admin-supplied password and link it to the
//                          caregiver record. No email is sent; the admin
//                          shares the credentials with the caregiver
//                          directly. This is the preferred flow for
//                          new invites because email magic links have
//                          proven slow/unreliable.
//   3. "link"            — called by the caregiver PWA on first login.
//                          Matches the authenticated email to a
//                          caregivers row and populates
//                          caregivers.user_id so subsequent sessions
//                          can see their own data via RLS.
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
const CAREGIVER_APP_URL = Deno.env.get("CAREGIVER_APP_URL") ?? "https://portal.tremendouscareca.com/care";

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

  // Email-sending strategy:
  //   * New user  → auth.admin.inviteUserByEmail(email, ...) — this is
  //     the only admin-side call that *reliably* triggers an email via
  //     Supabase's SMTP. generateLink({type:'invite'}) creates the user
  //     but does NOT always send the email in newer SDK versions.
  //   * Existing user → we can't re-invite (inviteUserByEmail errors on
  //     already-registered), and admin.generateLink({type:'magiclink'})
  //     returns a link without sending email. For Phase 1 we tell the
  //     admin "ask the caregiver to sign in at /care themselves" — the
  //     client-side signInWithOtp call on the login page DOES send the
  //     email. This keeps the edge function honest and avoids silent
  //     "invited but no email arrived" states.

  let newUserId: string | null = null;

  if (!cg.user_id) {
    const { data: invited, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { caregiver_id: cg.id },
      redirectTo: CAREGIVER_APP_URL,
    });
    if (invErr) {
      // "User already registered" is the common case when we've sent an
      // invite before (the auth user was created by a prior buggy call).
      // Surface a useful message instead of the raw error.
      const msg = (invErr.message || "").toLowerCase();
      if (msg.includes("already") || msg.includes("registered") || invErr.status === 422) {
        return jsonResponse({
          success: true,
          email,
          user_linked: !!cg.user_id,
          already_registered: true,
          message: "This email already has a login. Ask the caregiver to open /care and enter their email — they'll get a magic link automatically.",
        });
      }
      console.error("[caregiver-invite] inviteUserByEmail error:", invErr);
      return jsonResponse({ error: invErr.message || "Failed to send invite." }, 500);
    }
    newUserId = invited?.user?.id ?? null;
  } else {
    // Already linked — send a magic link. generateLink doesn't auto-send,
    // so tell the admin to have the caregiver sign in themselves.
    return jsonResponse({
      success: true,
      email,
      user_linked: true,
      already_linked: true,
      message: "This caregiver already has app access. Ask them to open /care and enter their email — they'll get a magic link automatically.",
    });
  }

  // Link the new auth user to the caregiver record so they land in /care
  // already linked after clicking the email.
  if (newUserId) {
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

// ─── Action: staff creates an auth user with a known password ───
// No email is sent. Admin hands the caregiver their email + password
// out-of-band (SMS, phone, in person). This is the replacement for
// the magic-link flow for all new caregivers.
async function handleCreateWithPassword(req: Request, body: Record<string, unknown>) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization." }, 401);
  const check = await assertStaff(authHeader);
  if (!check.ok) return jsonResponse({ error: check.error }, check.status);

  const { caregiver_id, password } = body ?? {};
  if (!caregiver_id) return jsonResponse({ error: "Missing caregiver_id." }, 400);
  if (typeof password !== "string" || password.length < 10) {
    return jsonResponse({ error: "Password must be at least 10 characters." }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cg, error: cgErr } = await admin
    .from("caregivers")
    .select("id, email, first_name, last_name, user_id")
    .eq("id", caregiver_id)
    .maybeSingle();
  if (cgErr || !cg) return jsonResponse({ error: "Caregiver not found." }, 404);
  if (!cg.email) return jsonResponse({ error: "Caregiver has no email on file." }, 400);
  if (cg.user_id) {
    return jsonResponse({
      error: "This caregiver already has a login. To reset the password, have them use the 'Forgot password?' link on the sign-in page.",
    }, 409);
  }

  const email = cg.email.toLowerCase();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { caregiver_id: cg.id, invited_by: "admin" },
  });
  if (createErr) {
    const msg = (createErr.message || "").toLowerCase();
    if (msg.includes("already") || msg.includes("registered") || createErr.status === 422) {
      return jsonResponse({
        error: "An account already exists for this email. Ask the caregiver to use 'Forgot password?' to reset it.",
      }, 409);
    }
    console.error("[caregiver-invite] createUser error:", createErr);
    return jsonResponse({ error: createErr.message || "Failed to create login." }, 500);
  }

  const newUserId = created?.user?.id;
  if (!newUserId) {
    return jsonResponse({ error: "Auth user creation returned no id." }, 500);
  }

  const { error: updErr } = await admin
    .from("caregivers")
    .update({ user_id: newUserId })
    .eq("id", cg.id);
  if (updErr) {
    console.error("[caregiver-invite] link update error after create:", updErr);
    return jsonResponse({ error: "Login created but could not link to caregiver record." }, 500);
  }

  try {
    await admin.from("events").insert({
      event_type: "caregiver_invite_sent",
      entity_type: "caregiver",
      entity_id: cg.id,
      actor: "system:caregiver-invite",
      payload: { email, method: "password" },
    });
  } catch (_) {
    // Non-fatal
  }

  return jsonResponse({
    success: true,
    email,
    user_linked: true,
    method: "password",
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
    if (action === "create_password") return await handleCreateWithPassword(req, body);
    if (action === "link") return await handleLink(req);
    return jsonResponse({ error: "Unknown action. Pass { action: 'send' | 'create_password' | 'link' } in the body." }, 400);
  } catch (err) {
    console.error("[caregiver-invite] unhandled error:", err);
    return jsonResponse({ error: (err as Error).message || "Internal server error." }, 500);
  }
});
