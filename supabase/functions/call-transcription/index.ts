import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Environment Variables ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RC_CLIENT_ID = Deno.env.get("RINGCENTRAL_CLIENT_ID");
const RC_CLIENT_SECRET = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");
const RC_JWT_TOKEN = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
const RC_API_URL = "https://platform.ringcentral.com";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── RC Auth (same pattern as call-recording) ───

async function getRingCentralAccessToken(): Promise<string> {
  if (!RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_JWT_TOKEN) {
    throw new Error("RingCentral credentials not configured");
  }
  const response = await fetch(`${RC_API_URL}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: RC_JWT_TOKEN,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`RingCentral auth failed: ${error}`);
  }
  const data = await response.json();
  return data.access_token;
}

// ─── Main Handler ───
// Transcribes a RingCentral call recording via OpenAI Whisper API.
// Caches results in call_transcriptions table.
//
// Usage: GET /call-transcription?recordingId=123456&token=<supabase_jwt>

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const recordingId = url.searchParams.get("recordingId");
    const token = url.searchParams.get("token");

    // ── Validate inputs ──

    if (!recordingId) {
      return new Response(
        JSON.stringify({ error: "recordingId query parameter is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!/^\d+$/.test(recordingId)) {
      return new Response(
        JSON.stringify({ error: "Invalid recordingId format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Authentication required (token parameter)" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Validate auth ──
    // Accept either a Supabase user JWT or the service role key (for internal Edge Function calls)

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (token === SUPABASE_SERVICE_ROLE_KEY) {
      // Internal call from ai-chat or other Edge Functions — trusted
      console.log("[call-transcription] Authenticated via service role key");
    } else {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired authentication token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // ── Check cache first ──

    const { data: cached } = await supabase
      .from("call_transcriptions")
      .select("transcript, duration_seconds, language")
      .eq("recording_id", recordingId)
      .single();

    if (cached) {
      console.log(`[call-transcription] Cache hit for recording ${recordingId}`);
      return new Response(
        JSON.stringify({
          transcript: cached.transcript,
          duration_seconds: cached.duration_seconds,
          language: cached.language,
          cached: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Download recording from RingCentral ──

    if (!OPENAI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "OpenAI API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[call-transcription] Cache miss — downloading recording ${recordingId} from RC`);
    const rcAccessToken = await getRingCentralAccessToken();
    const rcUrl = `${RC_API_URL}/restapi/v1.0/account/~/recording/${recordingId}/content`;

    const rcResponse = await fetch(rcUrl, {
      headers: { Authorization: `Bearer ${rcAccessToken}` },
    });

    if (!rcResponse.ok) {
      const errText = await rcResponse.text().catch(() => "Unknown error");
      console.error(`[call-transcription] RC fetch failed (${rcResponse.status}):`, errText);
      return new Response(
        JSON.stringify({ error: "Recording not found or unavailable" }),
        {
          status: rcResponse.status === 404 ? 404 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── Send to Whisper API ──

    const audioBlob = await rcResponse.blob();
    const contentType = rcResponse.headers.get("Content-Type") || "audio/mpeg";
    const extension = contentType.includes("wav") ? "wav" : contentType.includes("ogg") ? "ogg" : "mp3";

    console.log(`[call-transcription] Sending ${audioBlob.size} bytes to Whisper API`);

    const formData = new FormData();
    formData.append("file", audioBlob, `recording.${extension}`);
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");

    const whisperResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!whisperResponse.ok) {
      const errText = await whisperResponse.text().catch(() => "Unknown error");
      console.error(`[call-transcription] Whisper API failed (${whisperResponse.status}):`, errText);
      return new Response(
        JSON.stringify({ error: "Transcription service failed. Please try again." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const whisperData = await whisperResponse.json();
    const transcript = whisperData.text || "";
    const durationSeconds = whisperData.duration ? Math.round(whisperData.duration) : null;
    const language = whisperData.language || "en";

    console.log(`[call-transcription] Whisper returned ${transcript.length} chars, ${durationSeconds}s, lang=${language}`);

    // ── Cache the result ──

    const { error: insertError } = await supabase
      .from("call_transcriptions")
      .insert({
        recording_id: recordingId,
        transcript,
        duration_seconds: durationSeconds,
        language,
      });

    if (insertError) {
      console.error("[call-transcription] Cache insert failed:", insertError);
      // Don't fail the request — we still have the transcript
    }

    return new Response(
      JSON.stringify({
        transcript,
        duration_seconds: durationSeconds,
        language,
        cached: false,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[call-transcription] Error:", err);
    return new Response(
      JSON.stringify({ error: `Transcription failed: ${(err as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
