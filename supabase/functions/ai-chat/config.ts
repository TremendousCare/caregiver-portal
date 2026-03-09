// ─── Environment & Constants ───

export const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

export const RC_CLIENT_ID = Deno.env.get("RINGCENTRAL_CLIENT_ID");
export const RC_CLIENT_SECRET = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");
export const RC_JWT_TOKEN = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
export const RC_FROM_NUMBER = Deno.env.get("RINGCENTRAL_FROM_NUMBER");
export const RC_API_URL = "https://platform.ringcentral.com";

// Allowed origins for CORS — production domain + local dev
const ALLOWED_ORIGINS = [
  "https://caregiver-portal.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

export function getCorsHeaders(request?: Request): Record<string, string> {
  const origin = request?.headers?.get("origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

// Legacy export for backwards compatibility during migration
export const corsHeaders = {
  "Access-Control-Allow-Origin": "https://caregiver-portal.vercel.app",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

export const CLAUDE_MODEL = "claude-sonnet-4-5-20250929";
export const MAX_TOKENS = 4096;
export const MAX_ITERATIONS = 5;

// Retry config for transient Claude API errors (429, 529, 500, 503)
export const MAX_RETRIES = 2;
export const RETRY_BASE_DELAY_MS = 1000; // 1s, 2s exponential backoff

// Rate limiting
export const RATE_LIMIT_MAX_REQUESTS = 60; // per window
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Anon key for JWT verification (used to create user-context client)
export const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_ANON_KEY_SECRET");

// Re-export pure constants from constants.ts (keeps backwards compatibility)
export { CAREGIVER_PHASES, CAREGIVER_PHASE_LABELS, CLIENT_PHASE_LABELS, CLIENT_PHASES } from "./constants.ts";
export type { CaregiverPhase, ClientPhase } from "./constants.ts";
