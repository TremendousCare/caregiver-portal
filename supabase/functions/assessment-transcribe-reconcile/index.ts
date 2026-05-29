// ─── assessment-transcribe-reconcile ──────────────────────────────
//
// Cron-invoked safety net (every 5 min, see migration
// 20260603000000) for the assessment transcription pipeline. Deepgram's
// async callback is the happy path; this worker recovers the unhappy
// ones:
//
//   - 'uploaded' rows whose initial assessment-transcribe call was lost
//     (never submitted) → submit.
//   - 'transcribing' rows whose callback never arrived within the stuck
//     window → re-submit, up to maxAttempts.
//   - rows past maxAttempts → mark 'failed' so the UI stops spinning.
//   - rows where a transcript exists but the status didn't flip → heal.
//
// Idempotent and bounded: decisions come from the pure
// decideReconcileAction(); the partial index idx_assessments_in_flight
// keeps the scan cheap.
//
// Auth: --no-verify-jwt (cron posts the publishable key). We accept any
// JWT-shaped bearer or the service-role key, matching bd-transcribe.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  decideReconcileAction,
  markFailed,
  submitAssessmentForTranscription,
  RECONCILE,
  type ReconcileAction,
} from "../_shared/operations/assessmentTranscription.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY") ?? "";
const DEEPGRAM_CALLBACK_SECRET = Deno.env.get("DEEPGRAM_CALLBACK_SECRET") ?? "";

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BATCH_LIMIT = 50;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function authorized(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return false;
  const token = m[1];
  return token === SUPABASE_SERVICE_ROLE_KEY || JWT_SHAPE.test(token);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST required." });
  if (!authorized(req)) return json(401, { error: "Bearer token required." });
  if (!DEEPGRAM_API_KEY || !DEEPGRAM_CALLBACK_SECRET) {
    return json(500, { error: "Deepgram env vars not configured." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const nowMs = Date.now();

  // In-flight rows (matches idx_assessments_in_flight).
  const { data: rows, error } = await supabase
    .from("assessments")
    .select("id, org_id, status, audio_path, transcribe_attempts, updated_at")
    .in("status", ["uploaded", "transcribing"])
    .order("updated_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) return json(500, { error: `Scan failed: ${error.message}` });

  const batch = (rows ?? []) as Array<{
    id: string; org_id: string; status: string;
    audio_path: string | null; transcribe_attempts: number; updated_at: string;
  }>;

  // Which of these already have a transcript row? One query, not N.
  let withTranscript = new Set<string>();
  if (batch.length > 0) {
    const { data: tx } = await supabase
      .from("assessment_transcriptions")
      .select("assessment_id")
      .in("assessment_id", batch.map((r) => r.id));
    withTranscript = new Set((tx ?? []).map((t: { assessment_id: string }) => t.assessment_id));
  }

  const tally: Record<ReconcileAction, number> = {
    submit: 0, resubmit: 0, fail: 0, wait: 0, resolve: 0, skip: 0,
  };

  for (const row of batch) {
    const action = decideReconcileAction(
      {
        status: row.status,
        updated_at: row.updated_at,
        transcribe_attempts: row.transcribe_attempts ?? 0,
        hasTranscription: withTranscript.has(row.id),
      },
      nowMs,
      RECONCILE,
    );
    tally[action]++;

    if (action === "submit" || action === "resubmit") {
      await submitAssessmentForTranscription({
        supabase,
        assessment: row,
        apiKey: DEEPGRAM_API_KEY,
        callbackBaseUrl: `${SUPABASE_URL}/functions/v1/deepgram-callback`,
        callbackSecret: DEEPGRAM_CALLBACK_SECRET,
      });
    } else if (action === "fail") {
      await markFailed(
        supabase, row.id, row.org_id,
        `Transcription did not complete after ${RECONCILE.maxAttempts} attempts.`,
      );
    } else if (action === "resolve") {
      // Transcript exists but status never flipped — heal it.
      await supabase
        .from("assessments")
        .update({ status: "transcribed", error_message: null })
        .eq("id", row.id)
        .eq("org_id", row.org_id);
    }
  }

  return json(200, { ok: true, scanned: batch.length, actions: tally });
});
