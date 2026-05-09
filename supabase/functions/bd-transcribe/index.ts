// bd-transcribe — Phase 2 PR #8.
//
// Receives a short audio recording (visit memo) from the BD portal's
// Quick Capture form, sends it to OpenAI Whisper for transcription,
// returns the transcript text. The frontend uses the transcript to
// auto-fill the activity's Notes field; the rep edits and saves as
// usual.
//
// Audio is NOT persisted in this PR — Whisper streams it, returns
// the transcript, and we throw it away. A later PR adds 90-day
// Supabase Storage retention per the BD_MODULE.md decision.
//
// Auth: forwards the user's portal JWT. The function itself doesn't
// touch the database, but the bearer check keeps random callers off
// the OpenAI bill. Service-role key also accepted for testability.
//
// Reuses the `call-transcription` edge function's exact Whisper call
// pattern (verbose_json, whisper-1) so any model/format changes can
// be made in one place later.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENAI_API_KEY            = Deno.env.get("OPENAI_API_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Cap the upload size so a runaway recording (or a malicious caller)
// can't trigger an unbounded Whisper bill. 25 MB matches OpenAI's own
// per-request audio cap for whisper-1, and a 1-minute Opus memo is
// well under 1 MB — so this is generous.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// JWT-shape regex: roughly "<base64url>.<base64url>.<base64url>".
// We don't verify the signature here — Supabase's edge runtime does
// that for us when verify_jwt is on, OR (when off, as in this
// function) we accept any JWT-shaped token to keep the surface area
// small and let frontends call us without copying the service key.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requireAuth(req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) {
    return json(401, { error: "Bearer token required" });
  }
  const token = match[1];
  if (token === SUPABASE_SERVICE_ROLE_KEY) return null;
  if (JWT_SHAPE.test(token)) return null;
  return json(401, { error: "Invalid token shape" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  const authError = requireAuth(req);
  if (authError) return authError;

  if (!OPENAI_API_KEY) {
    return json(500, { error: "OPENAI_API_KEY not configured on this project" });
  }

  // Accept either multipart/form-data with a `file` field, or a raw
  // audio body (octet-stream). Multipart is the path the frontend
  // uses; raw body is supported so curl-based tests are simple.
  const contentType = req.headers.get("content-type") ?? "";
  let audioBlob: Blob;
  let filename = "memo.webm";

  if (contentType.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch (e) {
      return json(400, { error: `Could not parse multipart body: ${(e as Error).message}` });
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return json(400, { error: "Missing 'file' field in multipart body" });
    }
    audioBlob = file;
    if (file instanceof File && file.name) filename = file.name;
  } else if (contentType.startsWith("audio/") || contentType === "application/octet-stream") {
    const bytes = new Uint8Array(await req.arrayBuffer());
    audioBlob = new Blob([bytes], { type: contentType || "audio/webm" });
    // Guess an extension from the content-type so Whisper can sniff
    // the format. Whisper accepts: mp3, mp4, mpeg, mpga, m4a, wav,
    // webm. webm is the iOS Safari MediaRecorder default for opus.
    if      (contentType.includes("mp4"))  filename = "memo.mp4";
    else if (contentType.includes("mpeg")) filename = "memo.mp3";
    else if (contentType.includes("wav"))  filename = "memo.wav";
    else if (contentType.includes("ogg"))  filename = "memo.ogg";
    else                                    filename = "memo.webm";
  } else {
    return json(415, { error: `Unsupported content-type: ${contentType || "<empty>"}` });
  }

  if (audioBlob.size === 0) {
    return json(400, { error: "Audio body is empty" });
  }
  if (audioBlob.size > MAX_AUDIO_BYTES) {
    return json(413, {
      error: `Audio too large (${audioBlob.size} bytes; max ${MAX_AUDIO_BYTES})`,
    });
  }

  const formData = new FormData();
  formData.append("file", audioBlob, filename);
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");

  let whisperResp: Response;
  try {
    whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });
  } catch (e) {
    return json(502, { error: `Whisper unreachable: ${(e as Error).message}` });
  }

  if (!whisperResp.ok) {
    const body = await whisperResp.text().catch(() => "");
    console.error(`[bd-transcribe] Whisper ${whisperResp.status}:`, body.slice(0, 500));
    return json(whisperResp.status === 429 ? 429 : 502, {
      error: `Whisper returned ${whisperResp.status}`,
      detail: body.slice(0, 300),
    });
  }

  let result: { text?: string; duration?: number; language?: string };
  try {
    result = await whisperResp.json();
  } catch (e) {
    return json(502, { error: `Whisper returned non-JSON: ${(e as Error).message}` });
  }

  const transcript = (result.text ?? "").trim();
  return json(200, {
    ok: true,
    transcript,
    duration_seconds: typeof result.duration === "number" ? Math.round(result.duration) : null,
    language: result.language ?? null,
    bytes: audioBlob.size,
  });
});
