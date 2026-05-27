// ─── Shared transcription operation ──────────────────────────────────────────
//
// Single source of truth for "produce a transcript for a recording id".
// Used by:
//   - call-transcription/index.ts (HTTP endpoint, UI + ai-chat callers)
//   - post-call-processor/index.ts (per-minute cron walking pending rows)
//
// Both callers used to duplicate this logic; the cron also fetched it over
// HTTP from call-transcription, which fanned out into one cold-start +
// /oauth/token per recording when the batch was hot. Centralizing here lets
// the cron mint ONE RC access token at the top of the tick and reuse it
// for every recording in the batch, and makes the provider switch
// (RingSense native vs OpenAI Whisper) explicit and testable.
//
// Provider routing is decided by the caller (post-call-processor reads
// communication_voice_config.transcription_provider per org; the HTTP
// endpoint reads it for the default org). This op just executes the
// chosen path.

import { fetchRingSenseInsights } from "../helpers/ringcentral.ts";

export type TranscriptionProvider = "ringcentral_native" | "whisper" | "both";

export type TranscribeResult = {
  transcript: string;
  duration_seconds: number | null;
  language: string | null;
  source: "cache" | "ringcentral_native" | "whisper";
};

export type TranscribeRecordingOpts = {
  supabase: any;
  recordingId: string;
  rcAccessToken: string;
  provider: TranscriptionProvider;
  // OpenAI key is only needed when the resolved path actually calls
  // Whisper. Passed in so this module reads no env vars directly and is
  // trivially mockable. Tests can omit it for the ringcentral_native path.
  openaiApiKey?: string | null;
};

const RC_API_URL = "https://platform.ringcentral.com";
const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

// Return value semantics:
//   - TranscribeResult              → transcript is ready (either from
//                                     cache or freshly fetched). Already
//                                     persisted to call_transcriptions.
//   - null                          → soft "not yet available" — the
//                                     RingSense pipeline hasn't produced
//                                     a transcript yet, or the recording
//                                     contains no speech. Callers should
//                                     leave the pending pool alone and
//                                     retry on the next cron tick.
//   - throws                        → hard failure (auth scope missing,
//                                     RC down, Whisper API key missing
//                                     when whisper is required, etc.).
//                                     Caller surfaces the error.
export async function transcribeRecording(
  opts: TranscribeRecordingOpts,
): Promise<TranscribeResult | null> {
  const { supabase, recordingId, rcAccessToken, provider } = opts;

  // ── 1. Cache check ────────────────────────────────────────────────────
  // call_transcriptions PK = recording_id. A hit means we've already
  // produced a transcript for this recording (regardless of provider)
  // and downstream consumers can use it as-is.
  const { data: cached } = await supabase
    .from("call_transcriptions")
    .select("transcript, duration_seconds, language")
    .eq("recording_id", recordingId)
    .maybeSingle();

  if (cached?.transcript) {
    return {
      transcript: cached.transcript,
      duration_seconds: cached.duration_seconds ?? null,
      language: cached.language ?? null,
      source: "cache",
    };
  }

  // ── 2. Resolve provider order ─────────────────────────────────────────
  // 'both' means: prefer native, fall back to whisper when native is
  // unavailable. We expand it here so each provider has a single try
  // semantics downstream.
  const order: Array<"ringcentral_native" | "whisper"> =
    provider === "ringcentral_native"
      ? ["ringcentral_native"]
      : provider === "whisper"
        ? ["whisper"]
        : ["ringcentral_native", "whisper"];

  let nativeReturnedNull = false;

  for (const path of order) {
    if (path === "ringcentral_native") {
      // null = transcript not ready yet (or no insights). For 'both',
      // fall through to whisper. For 'ringcentral_native', surface the
      // null so the caller's soft-failure path triggers.
      const insights = await fetchRingSenseInsights(
        rcAccessToken,
        recordingId,
      );
      if (insights) {
        await cacheTranscript(supabase, recordingId, insights);
        return { ...insights, source: "ringcentral_native" };
      }
      nativeReturnedNull = true;
      continue;
    }

    if (path === "whisper") {
      if (!opts.openaiApiKey) {
        throw new Error(
          "Whisper transcription path requires an OpenAI API key; none provided.",
        );
      }
      const whisper = await transcribeViaWhisper(
        rcAccessToken,
        recordingId,
        opts.openaiApiKey,
      );
      if (!whisper) return null;
      await cacheTranscript(supabase, recordingId, whisper);
      return { ...whisper, source: "whisper" };
    }
  }

  // 'ringcentral_native' alone, returned null → soft-fail.
  // 'both' that fell through after a null native → only reached here if
  // whisper was unreachable, which is unexpected; treat as soft-fail too.
  void nativeReturnedNull;
  return null;
}

async function cacheTranscript(
  supabase: any,
  recordingId: string,
  payload: {
    transcript: string;
    duration_seconds: number | null;
    language: string | null;
  },
): Promise<void> {
  const { error } = await supabase
    .from("call_transcriptions")
    .insert({
      recording_id: recordingId,
      transcript: payload.transcript,
      duration_seconds: payload.duration_seconds,
      // The column was created with NOT NULL on language in the original
      // migration — coerce to a sentinel rather than letting an insert
      // throw. 'unknown' is the convention used elsewhere in the codebase.
      language: payload.language || "unknown",
    });
  // Cache write failures are non-fatal: the caller still got their
  // transcript and can use it. Log so we notice if this becomes chronic.
  if (error) {
    console.warn(
      `[transcribeRecording] cache insert failed for recording ${recordingId}:`,
      error.message || error,
    );
  }
}

// Whisper path: download recording audio from RC, post to OpenAI Whisper,
// return parsed result. Returns null when RC reports the recording is
// gone (404) so callers can treat it the same as RingSense's not-ready
// path. Throws on other failures (RC 5xx, Whisper auth/quota issues).
async function transcribeViaWhisper(
  rcAccessToken: string,
  recordingId: string,
  openaiApiKey: string,
): Promise<{
  transcript: string;
  duration_seconds: number | null;
  language: string | null;
} | null> {
  const rcUrl =
    `${RC_API_URL}/restapi/v1.0/account/~/recording/` +
    `${encodeURIComponent(recordingId)}/content`;
  const rcResp = await fetch(rcUrl, {
    headers: { Authorization: `Bearer ${rcAccessToken}` },
  });

  if (rcResp.status === 404) return null;
  if (!rcResp.ok) {
    const errText = await rcResp.text().catch(() => "");
    throw new Error(`RC recording download failed (${rcResp.status}): ${errText}`);
  }

  const audioBlob = await rcResp.blob();
  const contentType = rcResp.headers.get("Content-Type") || "audio/mpeg";
  const extension = contentType.includes("wav")
    ? "wav"
    : contentType.includes("ogg")
      ? "ogg"
      : "mp3";

  const formData = new FormData();
  formData.append("file", audioBlob, `recording.${extension}`);
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");

  const whisperResp = await fetch(WHISPER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiApiKey}` },
    body: formData,
  });

  if (!whisperResp.ok) {
    const errText = await whisperResp.text().catch(() => "");
    throw new Error(`Whisper API failed (${whisperResp.status}): ${errText}`);
  }

  const data = await whisperResp.json();
  const transcript = typeof data.text === "string" ? data.text : "";
  if (!transcript) return null;

  const duration_seconds =
    typeof data.duration === "number" ? Math.round(data.duration) : null;
  const language = typeof data.language === "string" ? data.language : null;
  return { transcript, duration_seconds, language };
}

// Look up the org's transcription_provider preference. Falls back to the
// schema default ('ringcentral_native') if no row exists for that org —
// keeps the function safe in edge cases like a brand-new org where the
// admin hasn't visited the voice settings page yet.
export async function resolveTranscriptionProvider(
  supabase: any,
  orgId: string | null | undefined,
): Promise<TranscriptionProvider> {
  if (!orgId) return "ringcentral_native";
  const { data, error } = await supabase
    .from("communication_voice_config")
    .select("transcription_provider")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error || !data?.transcription_provider) return "ringcentral_native";
  const v = data.transcription_provider;
  if (v === "ringcentral_native" || v === "whisper" || v === "both") return v;
  return "ringcentral_native";
}
