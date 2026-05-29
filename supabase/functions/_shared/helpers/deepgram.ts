// ─── Deepgram pre-recorded transcription helper ───────────────────
//
// Single source of truth for the Deepgram protocol used by the
// in-home assessment transcription pipeline:
//   - assessment-transcribe      → submitDeepgramAsync (kick off)
//   - deepgram-callback          → parseDeepgramCallback (ingest)
//   - assessment-transcribe-reconcile → submitDeepgramAsync (retry)
//
// Design mirrors _shared/operations/transcribeRecording.ts: this module
// reads NO env vars (the API key is always passed in) and keeps the
// URL-building and payload-parsing as pure functions so they are
// trivially unit-testable from vitest without a live Deepgram account.
//
// Why async callback rather than a blocking request: an in-home
// assessment recording can run 30–60 minutes. A synchronous
// /v1/listen call would hold the edge function (and the user's
// browser request) open for the entire transcription. Deepgram's
// callback mode returns a request_id immediately and POSTs the result
// to our deepgram-callback function when it finishes.
//
// Model: nova-3-medical — Deepgram's healthcare-tuned model, the right
// fit for clinical assessment vocabulary (medications, diagnoses, ADLs).

export const DG_LISTEN_URL = "https://api.deepgram.com/v1/listen";
export const DG_MODEL = "nova-3-medical";
export const DG_LANGUAGE = "en";

export interface DeepgramListenOptions {
  model?: string;
  language?: string;
}

// Build the /v1/listen query string. Diarization + utterances give us
// speaker-segmented turns (caregiver/coordinator vs. client/family);
// smart_format + punctuate + paragraphs make the transcript readable
// and ready for the PR 4 care-plan extraction step.
export function buildListenUrl(
  callbackUrl: string,
  opts: DeepgramListenOptions = {},
): string {
  const params = new URLSearchParams({
    model: opts.model ?? DG_MODEL,
    language: opts.language ?? DG_LANGUAGE,
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    utterances: "true",
    paragraphs: "true",
    callback: callbackUrl,
  });
  return `${DG_LISTEN_URL}?${params.toString()}`;
}

export interface DeepgramSubmitResult {
  ok: boolean;
  requestId: string | null;
  status: number;
  error?: string;
}

// Kick off an async transcription. Deepgram fetches the audio from the
// (time-limited, signed) `audioUrl` itself, so we never stream bytes
// through the edge function. Returns the request_id Deepgram echoes
// back immediately; the transcript itself arrives later at the callback.
export async function submitDeepgramAsync(args: {
  apiKey: string;
  audioUrl: string;
  callbackUrl: string;
  model?: string;
  language?: string;
  fetchImpl?: typeof fetch;
}): Promise<DeepgramSubmitResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const url = buildListenUrl(args.callbackUrl, {
    model: args.model,
    language: args.language,
  });

  let resp: Response;
  try {
    resp = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: args.audioUrl }),
    });
  } catch (e) {
    return { ok: false, requestId: null, status: 0, error: `Deepgram unreachable: ${(e as Error).message}` };
  }

  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    return {
      ok: false,
      requestId: null,
      status: resp.status,
      error: `Deepgram returned ${resp.status}: ${text.slice(0, 300)}`,
    };
  }

  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // A 2xx with a non-JSON body is unexpected but not fatal — the
    // request was accepted; we just don't have the id to store.
    return { ok: true, requestId: null, status: resp.status };
  }
  const requestId = data?.request_id ?? data?.metadata?.request_id ?? null;
  return { ok: true, requestId, status: resp.status };
}

export interface DiarizedUtterance {
  speaker: number | null;
  text: string;
  start: number | null;
  end: number | null;
  confidence: number | null;
}

export interface ParsedTranscription {
  ok: true;
  requestId: string | null;
  transcript: string;
  confidence: number | null;
  durationSeconds: number | null;
  language: string | null;
  utterances: DiarizedUtterance[];
}

export interface ParseError {
  ok: false;
  error: string;
  requestId: string | null;
}

// Normalize Deepgram's results.utterances[] into the speaker-tagged
// turn shape we store in assessment_transcriptions.transcript_json.
// Returns [] when utterances are absent (feature off / empty audio).
export function normalizeUtterances(payload: any): DiarizedUtterance[] {
  const raw = payload?.results?.utterances;
  if (!Array.isArray(raw)) return [];
  return raw.map((u: any) => ({
    speaker: typeof u?.speaker === "number" ? u.speaker : null,
    text: typeof u?.transcript === "string" ? u.transcript : "",
    start: typeof u?.start === "number" ? u.start : null,
    end: typeof u?.end === "number" ? u.end : null,
    confidence: typeof u?.confidence === "number" ? u.confidence : null,
  }));
}

// Parse a Deepgram callback body into the fields we persist. Returns an
// `ok: false` discriminated result (never throws) for the two failure
// shapes Deepgram can deliver: an explicit error object, or a payload
// with no transcription alternatives (e.g. the audio had no speech).
export function parseDeepgramCallback(payload: any): ParsedTranscription | ParseError {
  const requestId = payload?.metadata?.request_id ?? payload?.request_id ?? null;

  // Explicit error callback.
  const errMsg = payload?.err_msg ?? payload?.error ?? payload?.err_code;
  if (errMsg) {
    return { ok: false, error: String(errMsg), requestId };
  }

  const alt = payload?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt || typeof alt.transcript !== "string") {
    return { ok: false, error: "Deepgram callback contained no transcription alternatives", requestId };
  }

  const durationRaw = payload?.metadata?.duration;
  const detectedLang = payload?.results?.channels?.[0]?.detected_language;

  return {
    ok: true,
    requestId,
    transcript: alt.transcript,
    confidence: typeof alt.confidence === "number" ? alt.confidence : null,
    durationSeconds: typeof durationRaw === "number" ? Math.round(durationRaw) : null,
    language: typeof detectedLang === "string" ? detectedLang : null,
    utterances: normalizeUtterances(payload),
  };
}
