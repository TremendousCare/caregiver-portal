// ─── Environment & Constants ───

export const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

export const RC_CLIENT_ID = Deno.env.get("RINGCENTRAL_CLIENT_ID");
export const RC_CLIENT_SECRET = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");
export const RC_JWT_TOKEN = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
export const RC_FROM_NUMBER = Deno.env.get("RINGCENTRAL_FROM_NUMBER");
export const RC_API_URL = "https://platform.ringcentral.com";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

export const CLAUDE_MODEL = "claude-sonnet-4-5-20250929";
export const MAX_TOKENS = 4096;
export const MAX_ITERATIONS = 5;

// Retry config for transient Claude API errors (429, 529, 500, 503)
export const MAX_RETRIES = 2;
export const RETRY_BASE_DELAY_MS = 1000; // 1s, 2s exponential backoff
