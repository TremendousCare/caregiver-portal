-- ═══════════════════════════════════════════════════════════════
-- get_route_ringcentral_jwt RPC — Step 5 of role-based SMS routing
--
-- Purpose:
--   Add a service-role-only function that the bulk-sms edge function
--   calls to fetch a route's phone number + decrypted RingCentral JWT
--   from Supabase Vault in a single round-trip.
--
-- Returns one row per matching route:
--   sms_from_number TEXT  — the configured phone number (may be null)
--   jwt             TEXT  — the decrypted JWT from vault (may be null)
--
--   Returns no rows if the route does not exist or is inactive.
--
-- Security:
--   - SECURITY DEFINER: the function runs with owner privileges,
--     so the caller does not need direct access to vault.secrets.
--   - EXECUTE is REVOKEd from PUBLIC, authenticated, and anon. Only
--     the service_role (= edge functions) can call this. Regular
--     users, admins, and the frontend all get a permission error.
--
-- Safety:
--   Purely additive. No existing tables, functions, or policies are
--   modified. Safe to roll back with DROP FUNCTION.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_route_ringcentral_jwt(p_category TEXT)
RETURNS TABLE (
  sms_from_number TEXT,
  jwt             TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_phone        TEXT;
  v_secret_name  TEXT;
  v_jwt          TEXT;
BEGIN
  -- Look up the route. Only active routes are considered.
  SELECT cr.sms_from_number, cr.sms_vault_secret_name
    INTO v_phone, v_secret_name
  FROM public.communication_routes cr
  WHERE cr.category = p_category AND cr.is_active = true;

  -- Route not found (or inactive): return zero rows.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Route exists but no JWT reference set: return phone, null JWT.
  -- Caller decides how to handle (typically: hard-fail with a helpful
  -- "JWT not configured" error).
  IF v_secret_name IS NULL THEN
    RETURN QUERY SELECT v_phone, NULL::TEXT;
    RETURN;
  END IF;

  -- Fetch the decrypted JWT from vault. vault.decrypted_secrets is a
  -- privileged view that only works under SECURITY DEFINER like this.
  SELECT vds.decrypted_secret INTO v_jwt
  FROM vault.decrypted_secrets vds
  WHERE vds.name = v_secret_name;

  RETURN QUERY SELECT v_phone, v_jwt;
END;
$$;

-- ─── Permission lockdown ────────────────────────────────────
-- Only the service_role (used by edge functions) may execute this.
-- This is the key security boundary that keeps JWTs out of reach
-- of the frontend, even for admin users.

REVOKE EXECUTE ON FUNCTION public.get_route_ringcentral_jwt(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_route_ringcentral_jwt(TEXT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.get_route_ringcentral_jwt(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_route_ringcentral_jwt(TEXT) TO service_role;
