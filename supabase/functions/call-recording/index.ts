import { createClient } from "jsr:@supabase/supabase-js@2";
import { getRingCentralAccessToken } from "../_shared/helpers/ringcentral.ts";

// ─── Environment Variables ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RC_API_URL = "https://platform.ringcentral.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// RingCentral auth flows through the shared cached helper. The previous
// local copy did a fresh /oauth/token POST on every invocation, which
// drained the per-extension 5 req/60s auth bucket whenever staff played
// back several recordings in quick succession.

// ─── Main Handler ───
// Serves as an authenticated proxy between the browser <audio> element
// and RingCentral's recording content API.
//
// Usage: GET /call-recording?recordingId=123456&token=<supabase_jwt>
//
// The token param is required because <audio src="..."> cannot send
// custom Authorization headers. We validate the token manually against
// Supabase auth to ensure only authenticated portal users can access
// recordings.

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

    // Only allow numeric recording IDs (prevent path traversal)
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

    // ── Validate Supabase auth token ──

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired authentication token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Fetch recording from RingCentral ──

    const accessToken = await getRingCentralAccessToken();
    const rcUrl = `${RC_API_URL}/restapi/v1.0/account/~/recording/${recordingId}/content`;

    const rcResponse = await fetch(rcUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!rcResponse.ok) {
      const errText = await rcResponse.text().catch(() => "Unknown error");
      console.error(`[call-recording] RC fetch failed (${rcResponse.status}):`, errText);
      return new Response(
        JSON.stringify({ error: "Recording not found or unavailable" }),
        {
          status: rcResponse.status === 404 ? 404 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── Stream audio back to browser ──

    const contentType = rcResponse.headers.get("Content-Type") || "audio/mpeg";
    const contentLength = rcResponse.headers.get("Content-Length");

    const responseHeaders: Record<string, string> = {
      ...corsHeaders,
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600", // 1-hour cache for repeated plays
    };

    if (contentLength) {
      responseHeaders["Content-Length"] = contentLength;
    }

    return new Response(rcResponse.body, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("[call-recording] Error:", err);
    return new Response(
      JSON.stringify({ error: `Failed to fetch recording: ${(err as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
