// ─── Assessment transcription — shared submit op + reconcile policy ──
//
// Used by:
//   - assessment-transcribe/index.ts           (user kicks off a transcript)
//   - assessment-transcribe-reconcile/index.ts (cron retries stuck rows)
//
// Centralizing the "mint signed URL → submit to Deepgram → stamp the
// assessment row" sequence here means the interactive path and the cron
// path can never drift. The reconcile DECISION (submit / retry / give up)
// is a pure function with no I/O so it is fully unit-tested.

import { submitDeepgramAsync } from "../helpers/deepgram.ts";

export const AUDIO_BUCKET = "assessment-audio";

// Signed-URL TTL handed to Deepgram. Must comfortably exceed Deepgram's
// fetch + transcription time for a long (30–60 min) assessment. 1 hour.
export const SIGNED_URL_TTL_SECONDS = 3600;

// Reconciliation thresholds.
export const RECONCILE = {
  // An 'uploaded' row should have been submitted by the frontend almost
  // immediately; if it's still 'uploaded' after this long, the submit
  // call was lost — pick it up.
  uploadedGraceMinutes: 2,
  // A 'transcribing' row whose callback hasn't landed within this window
  // is considered stuck (lost callback / dropped Deepgram job).
  stuckMinutes: 15,
  // Hard cap on submit attempts before we mark the row 'failed'.
  maxAttempts: 3,
};

export type ReconcileAction = "submit" | "resubmit" | "fail" | "wait" | "resolve" | "skip";

export interface ReconcileRow {
  status: string;
  updated_at: string;
  transcribe_attempts: number;
  hasTranscription: boolean;
}

// Pure decision: given an in-flight assessment row and the current time,
// what should the reconciler do? No DB access — see the worker for the
// side effects each action maps to.
export function decideReconcileAction(
  row: ReconcileRow,
  nowMs: number,
  cfg = RECONCILE,
): ReconcileAction {
  // A transcript already exists. If the status never got flipped (callback
  // wrote the row but the status update lost the race), heal it; otherwise
  // there is nothing to do.
  if (row.hasTranscription) {
    return row.status === "transcribed" ? "skip" : "resolve";
  }

  const ageMinutes = (nowMs - Date.parse(row.updated_at)) / 60000;
  const attempts = Number.isFinite(row.transcribe_attempts) ? row.transcribe_attempts : 0;

  if (row.status === "uploaded") {
    if (attempts >= cfg.maxAttempts && ageMinutes >= cfg.stuckMinutes) return "fail";
    if (ageMinutes >= cfg.uploadedGraceMinutes) return "submit";
    return "wait";
  }

  if (row.status === "transcribing") {
    if (ageMinutes < cfg.stuckMinutes) return "wait";
    if (attempts < cfg.maxAttempts) return "resubmit";
    return "fail";
  }

  // 'recording', 'transcribed', 'failed', or anything unexpected.
  return "skip";
}

export interface SubmitResult {
  ok: boolean;
  requestId?: string | null;
  error?: string;
}

// Mint a signed URL for the assessment's audio and submit it to Deepgram
// in async-callback mode, then stamp the assessment row (status →
// 'transcribing', attempts++, dg_request_id). On any failure the row is
// marked 'failed' with a human-readable error_message so the UI can show
// it and offer a retry. Returns a structured result; never throws.
export async function submitAssessmentForTranscription(args: {
  supabase: any; // service-role client
  assessment: { id: string; org_id: string; audio_path: string | null; transcribe_attempts: number };
  apiKey: string;
  callbackBaseUrl: string; // e.g. `${SUPABASE_URL}/functions/v1/deepgram-callback`
  callbackSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<SubmitResult> {
  const { supabase, assessment, apiKey, callbackBaseUrl, callbackSecret } = args;

  if (!assessment.audio_path) {
    await markFailed(supabase, assessment.id, assessment.org_id, "Assessment has no audio_path to transcribe");
    return { ok: false, error: "missing_audio_path" };
  }

  // Signed URL (service-role mint — the assessment_audio_service_role
  // policy lets the functions read any org's object).
  const { data: signed, error: signErr } = await supabase.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(assessment.audio_path, SIGNED_URL_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    const msg = `Could not sign audio URL: ${signErr?.message ?? "no URL returned"}`;
    await markFailed(supabase, assessment.id, assessment.org_id, msg);
    return { ok: false, error: msg };
  }

  // Callback carries a shared secret + the ids we need to correlate the
  // result, all as query params Deepgram preserves verbatim.
  const cbParams = new URLSearchParams({
    token: callbackSecret,
    assessment_id: assessment.id,
    org_id: assessment.org_id,
  });
  const callbackUrl = `${callbackBaseUrl}?${cbParams.toString()}`;

  const submit = await submitDeepgramAsync({
    apiKey,
    audioUrl: signed.signedUrl,
    callbackUrl,
    fetchImpl: args.fetchImpl,
  });

  if (!submit.ok) {
    await markFailed(supabase, assessment.id, assessment.org_id, submit.error ?? "Deepgram submit failed");
    return { ok: false, error: submit.error };
  }

  await supabase
    .from("assessments")
    .update({
      status: "transcribing",
      transcribe_attempts: (assessment.transcribe_attempts ?? 0) + 1,
      dg_request_id: submit.requestId,
      error_message: null,
    })
    .eq("id", assessment.id)
    .eq("org_id", assessment.org_id);

  return { ok: true, requestId: submit.requestId };
}

export async function markFailed(
  supabase: any,
  assessmentId: string,
  orgId: string,
  message: string,
): Promise<void> {
  await supabase
    .from("assessments")
    .update({ status: "failed", error_message: message.slice(0, 1000) })
    .eq("id", assessmentId)
    .eq("org_id", orgId);
}
