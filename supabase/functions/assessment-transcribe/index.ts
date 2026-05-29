// ─── assessment-transcribe ────────────────────────────────────────
//
// In-home assessment transcription — PR 2.
//
// Called by the frontend (PR 3) after a staff member records or uploads
// an assessment's audio to the `assessment-audio` bucket and inserts the
// `assessments` row (status 'uploaded'). This function mints a signed URL
// for that audio and submits it to Deepgram in async-callback mode; the
// transcript lands later via the `deepgram-callback` function.
//
// Auth: the deploy workflow ships every function with --no-verify-jwt,
// so we do our own check here — decode the caller's portal JWT for the
// org_id claim, confirm the Supabase session is real, and require a
// staff role (admin / member / owner), mirroring public.is_staff().
//
// Env vars (set in Supabase project secrets — see PR 2 description):
//   DEEPGRAM_API_KEY          — Deepgram API key (Token auth)
//   DEEPGRAM_CALLBACK_SECRET  — shared secret embedded in the callback URL
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY (standard)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { submitAssessmentForTranscription } from "../_shared/operations/assessmentTranscription.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY") ?? "";
const DEEPGRAM_CALLBACK_SECRET = Deno.env.get("DEEPGRAM_CALLBACK_SECRET") ?? "";

const STAFF_ROLES = new Set(["admin", "member", "owner"]);

const ALLOWED_ORIGINS = [
  "https://caregiver-portal.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

interface AuthCtx { orgId: string; userEmail: string | null; }

async function authenticate(
  authHeader: string | null,
): Promise<{ ok: true; ctx: AuthCtx } | { ok: false; status: number; error: string }> {
  if (!authHeader) return { ok: false, status: 401, error: "Missing Authorization header." };
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, error: "Malformed JWT." };
  let payload: Record<string, unknown>;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    payload = JSON.parse(atob(padded));
  } catch {
    return { ok: false, status: 401, error: "Invalid JWT payload." };
  }
  const orgId = typeof payload.org_id === "string" ? payload.org_id : null;
  if (!orgId) return { ok: false, status: 403, error: "JWT is missing org_id claim." };

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return { ok: false, status: 401, error: "Not authenticated." };
  return { ok: true, ctx: { orgId, userEmail: userData.user.email ?? null } };
}

async function assertStaff(
  supabase: ReturnType<typeof createClient>,
  email: string | null,
): Promise<boolean> {
  if (!email) return false;
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  return !!data && STAFF_ROLES.has((data as { role: string }).role);
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST required." }, cors);

  if (!DEEPGRAM_API_KEY) return json(500, { error: "DEEPGRAM_API_KEY not configured." }, cors);
  if (!DEEPGRAM_CALLBACK_SECRET) return json(500, { error: "DEEPGRAM_CALLBACK_SECRET not configured." }, cors);

  const auth = await authenticate(req.headers.get("Authorization"));
  if (!auth.ok) return json(auth.status, { error: auth.error }, cors);
  const { orgId, userEmail } = auth.ctx;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (!(await assertStaff(admin, userEmail))) {
    return json(403, { error: "Staff access required." }, cors);
  }

  let body: { assessment_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body must be valid JSON." }, cors);
  }
  const assessmentId = typeof body.assessment_id === "string" ? body.assessment_id : null;
  if (!assessmentId) return json(400, { error: "assessment_id is required." }, cors);

  // Load org-scoped. Service-role read; org_id match enforces tenancy.
  const { data: row, error: loadErr } = await admin
    .from("assessments")
    .select("id, org_id, status, audio_path, transcribe_attempts")
    .eq("id", assessmentId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (loadErr) return json(500, { error: `Assessment lookup failed: ${loadErr.message}` }, cors);
  if (!row) return json(404, { error: "Assessment not found." }, cors);

  const assessment = row as {
    id: string; org_id: string; status: string;
    audio_path: string | null; transcribe_attempts: number;
  };

  if (assessment.status === "transcribed") {
    return json(409, { error: "Assessment is already transcribed.", code: "already_transcribed" }, cors);
  }
  if (!assessment.audio_path) {
    return json(422, { error: "Assessment has no uploaded audio yet.", code: "no_audio" }, cors);
  }

  const result = await submitAssessmentForTranscription({
    supabase: admin,
    assessment,
    apiKey: DEEPGRAM_API_KEY,
    callbackBaseUrl: `${SUPABASE_URL}/functions/v1/deepgram-callback`,
    callbackSecret: DEEPGRAM_CALLBACK_SECRET,
  });

  if (!result.ok) {
    return json(502, { error: result.error ?? "Failed to submit to Deepgram.", code: "submit_failed" }, cors);
  }

  return json(202, {
    ok: true,
    assessment_id: assessment.id,
    status: "transcribing",
    dg_request_id: result.requestId ?? null,
  }, cors);
});
