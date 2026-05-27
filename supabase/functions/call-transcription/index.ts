import { createClient } from "jsr:@supabase/supabase-js@2";
import { getRingCentralAccessToken } from "../_shared/helpers/ringcentral.ts";
import {
  resolveTranscriptionProvider,
  transcribeRecording,
} from "../_shared/operations/transcribeRecording.ts";

// ─── Environment Variables ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? null;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── Main Handler ───
// HTTP endpoint for fetching a transcript for a recordingId. Used by the
// UI (client/caregiver activity log), ai-chat (get_call_transcription
// tool), and historically by post-call-processor (now bypassed in favor
// of an in-process shared op).
//
// Provider routing — RingSense (native, license-included, free) vs
// OpenAI Whisper (paid) — is decided by the org's
// communication_voice_config.transcription_provider column, NOT
// hardcoded. The default in the schema is 'ringcentral_native'.
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
    // Accept either a Supabase user JWT or the service role key (the
    // service role is used for trusted internal Edge Function callers
    // such as ai-chat — see ai-chat/tools/communication.ts).
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    let callerOrgId: string | null = null;
    if (token === SUPABASE_SERVICE_ROLE_KEY) {
      console.log("[call-transcription] Authenticated via service role key");
    } else {
      const { data: { user }, error: authError } =
        await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired authentication token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // org_id lives on the user JWT claims as added by the access-token
      // hook (Phase A of the SaaS retrofit). When present we scope the
      // provider lookup to that org; otherwise we fall back to the
      // schema default inside resolveTranscriptionProvider.
      callerOrgId =
        (user.app_metadata as any)?.org_id ||
        (user.user_metadata as any)?.org_id ||
        null;
    }

    // Resolve the provider per the org's voice config. For service-role
    // callers (ai-chat, etc.) we don't have an org claim, so we look up
    // the call_session by recording_id to find its org. If that lookup
    // fails we default to 'ringcentral_native'.
    if (!callerOrgId) {
      const { data: session } = await supabase
        .from("call_sessions")
        .select("org_id")
        .eq("recording_id", recordingId)
        .maybeSingle();
      callerOrgId = session?.org_id ?? null;
    }
    const provider = await resolveTranscriptionProvider(supabase, callerOrgId);

    // Mint a cached RC access token (shared helper, ~1h TTL).
    const rcAccessToken = await getRingCentralAccessToken();

    const result = await transcribeRecording({
      supabase,
      recordingId,
      rcAccessToken,
      provider,
      openaiApiKey: OPENAI_API_KEY,
    });

    if (!result) {
      // Soft "not ready yet" — surface as 202 Accepted with an empty body
      // so the UI can render "transcript pending" without treating this
      // as a hard error. ai-chat / post-call-processor treat 200 with
      // empty transcript the same as a 4xx and retry later.
      return new Response(
        JSON.stringify({
          transcript: "",
          duration_seconds: null,
          language: null,
          cached: false,
          status: "not_ready",
        }),
        { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        transcript: result.transcript,
        duration_seconds: result.duration_seconds,
        language: result.language,
        cached: result.source === "cache",
        source: result.source,
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
