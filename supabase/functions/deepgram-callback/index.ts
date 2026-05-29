// ─── deepgram-callback ────────────────────────────────────────────
//
// Public webhook that Deepgram POSTs the finished transcript to (the
// callback URL submitted by assessment-transcribe). The deploy workflow
// ships every function with --no-verify-jwt, so this endpoint is
// reachable without a Supabase JWT — exactly what we need for an
// external callback. We authenticate it ourselves via a shared secret
// carried in the callback URL's `token` query param (Deepgram preserves
// the query string verbatim).
//
// Correlation: the callback URL also carries assessment_id + org_id, so
// we don't depend on Deepgram echoing custom fields — we know precisely
// which org-scoped assessment this result belongs to.
//
// Idempotent: the transcript row is upserted on the UNIQUE(assessment_id)
// constraint, so a duplicate or reconcile-driven re-submit callback just
// overwrites with the latest result.
//
// Env vars:
//   DEEPGRAM_CALLBACK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseDeepgramCallback, DG_MODEL, DG_LANGUAGE } from "../_shared/helpers/deepgram.ts";
import { markFailed } from "../_shared/operations/assessmentTranscription.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEEPGRAM_CALLBACK_SECRET = Deno.env.get("DEEPGRAM_CALLBACK_SECRET") ?? "";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Constant-time-ish secret compare (avoid trivial early-exit timing).
function secretMatches(provided: string | null): boolean {
  if (!DEEPGRAM_CALLBACK_SECRET || !provided) return false;
  if (provided.length !== DEEPGRAM_CALLBACK_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ DEEPGRAM_CALLBACK_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

// Fire-and-forget timeline event (never blocks/throws the response path).
async function logAssessmentEvent(
  supabase: any,
  eventType: string,
  clientId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await supabase.from("events").insert({
      event_type: eventType,
      entity_type: clientId ? "client" : null,
      entity_id: clientId,
      actor: "system:deepgram",
      payload,
    });
  } catch (e) {
    console.error("[deepgram-callback] event log failed:", (e as Error).message);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST required." });

  const url = new URL(req.url);
  if (!secretMatches(url.searchParams.get("token"))) {
    return json(401, { error: "Invalid callback token." });
  }
  const assessmentId = url.searchParams.get("assessment_id");
  const orgId = url.searchParams.get("org_id");
  if (!assessmentId || !orgId) {
    return json(400, { error: "assessment_id and org_id query params are required." });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Body must be valid JSON." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const parsed = parseDeepgramCallback(payload);

  // Fetch the client_id for the timeline event (best-effort).
  const { data: assessmentRow } = await supabase
    .from("assessments")
    .select("client_id")
    .eq("id", assessmentId)
    .eq("org_id", orgId)
    .maybeSingle();
  const clientId = (assessmentRow as { client_id: string | null } | null)?.client_id ?? null;

  if (!parsed.ok) {
    // Deepgram error / no-speech: record the failure but still 200 so
    // Deepgram doesn't retry the callback forever.
    await markFailed(supabase, assessmentId, orgId, `Transcription failed: ${parsed.error}`);
    await logAssessmentEvent(supabase, "assessment_transcription_failed", clientId, {
      assessment_id: assessmentId,
      error: parsed.error,
      dg_request_id: parsed.requestId,
    });
    return json(200, { ok: false, recorded: "failed", error: parsed.error });
  }

  // Upsert the transcript (idempotent on UNIQUE assessment_id).
  const { error: txErr } = await supabase
    .from("assessment_transcriptions")
    .upsert({
      assessment_id: assessmentId,
      org_id: orgId,
      transcript: parsed.transcript,
      transcript_json: { utterances: parsed.utterances },
      provider: "deepgram",
      model: DG_MODEL,
      language: parsed.language ?? DG_LANGUAGE,
      confidence: parsed.confidence,
      dg_request_id: parsed.requestId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "assessment_id" });

  if (txErr) {
    console.error("[deepgram-callback] transcript upsert failed:", txErr.message);
    return json(500, { error: `Transcript persist failed: ${txErr.message}` });
  }

  await supabase
    .from("assessments")
    .update({
      status: "transcribed",
      duration_seconds: parsed.durationSeconds,
      dg_request_id: parsed.requestId,
      error_message: null,
    })
    .eq("id", assessmentId)
    .eq("org_id", orgId);

  await logAssessmentEvent(supabase, "assessment_transcribed", clientId, {
    assessment_id: assessmentId,
    duration_seconds: parsed.durationSeconds,
    utterance_count: parsed.utterances.length,
    dg_request_id: parsed.requestId,
  });

  return json(200, { ok: true, assessment_id: assessmentId });
});
