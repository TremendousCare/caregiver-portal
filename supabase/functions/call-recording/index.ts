import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Environment Variables ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RC_CLIENT_ID = Deno.env.get("RINGCENTRAL_CLIENT_ID");
const RC_CLIENT_SECRET = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");
const RC_JWT_TOKEN = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
const RC_API_URL = "https://platform.ringcentral.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── RC Auth (same pattern as bulk-sms) ───

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
