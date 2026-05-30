-- ─────────────────────────────────────────────────────────────────
-- ringcentral_token_cache: cross-isolate cache for RingCentral OAuth
-- access tokens.
--
-- Incident context: call transcription AND the live communications panel
-- both froze on 2026-05-29 ~22:24 UTC even though the transcription
-- provider was correctly set to 'whisper'. Root cause: the RC access-token
-- cache in _shared/helpers/ringcentral.ts is an in-memory Map, which only
-- lives for the duration of a single Edge Function isolate. Under
-- concurrent load (every profile open fires get-communications, plus the
-- per-minute post-call-processor cron) each cold-start isolate minted its
-- own /restapi/oauth/token. RingCentral throttles that endpoint hard
-- (CMN-301 "Request rate exceeded", ~5 mints / 60s per app), so the
-- extension got parked in penalty and every subsequent token mint failed
-- -- taking transcription and get-communications down together.
--
-- Fix: persist minted tokens here so every isolate reuses one token for
-- its full ~1h lifetime instead of minting per request. Keyed by a
-- SHA-256 hash of the JWT assertion (never the raw JWT) so distinct
-- extensions / orgs get distinct rows without storing the secret itself.
--
-- Security: access tokens are short-lived bearer secrets. RLS is enabled
-- with NO policies, so only the service role (which bypasses RLS and is
-- what Edge Functions use) can read or write. No client role can ever see
-- a cached token.
--
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS, no destructive ops.
-- The table stays tiny -- one row per distinct JWT, upserted on each mint.
--
-- Multi-tenancy: org_id is included per the SaaS-retrofit prime directive
-- (every new table gets org_id). Nullable at creation; the cache keys on
-- the JWT hash today, and org_id can be backfilled when per-org RC apps
-- land in Phase C.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ringcentral_token_cache (
  jwt_hash     text PRIMARY KEY,
  access_token text NOT NULL,
  expires_at   timestamptz NOT NULL,
  org_id       uuid REFERENCES public.organizations(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ringcentral_token_cache ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS but still needs table-level privileges granted.
GRANT ALL ON public.ringcentral_token_cache TO service_role;

COMMENT ON TABLE public.ringcentral_token_cache IS
  'Cross-isolate cache of RingCentral OAuth access tokens, keyed by SHA-256 of the JWT assertion. Read/written only by Edge Functions via the service role to stay under RingCentral''s CMN-301 auth rate limit (~5 mints/60s per app). Tokens expire ~1h; rows are upserted on mint. RLS enabled with no policies = service-role-only access.';
