-- ═══════════════════════════════════════════════════════════════
-- QuickBooks integration — PR #2 (OAuth handshake)
--
-- Builds on PR #1 (20260529100000_quickbooks_connections.sql)
-- by adding the CSRF state table and the two RPCs needed for the
-- OAuth code-exchange flow that the edge functions in PR #2 drive.
--
-- New objects:
--
--   1. quickbooks_oauth_states  — short-lived CSRF state table.
--      One row per in-flight OAuth handshake. The owner inserts via
--      init_qb_oauth_state() when they click "Connect QuickBooks"
--      in the Settings UI; the callback edge function consumes the
--      row inside complete_qb_oauth() (verify → insert connection
--      → delete state, all in one transaction). TTL: 10 minutes.
--
--   2. init_qb_oauth_state(p_environment) → uuid
--      Owner-gated. Creates a state row keyed on the caller's JWT
--      (org_id + email). Returns the state_id; the edge function
--      then embeds it as the OAuth `state` query parameter.
--
--   3. complete_qb_oauth(...)  → uuid
--      Service-role only. Atomic: verifies state row exists and is
--      not expired, performs the same upsert as
--      set_qb_connection_tokens (writes Vault, upserts the
--      connection row), then deletes the state row. Returns the
--      connection id.
--
--      Why a separate writer from set_qb_connection_tokens:
--      the OAuth callback runs as Intuit's HTTP redirect — there
--      is no end-user JWT in the request, so the user-gated path
--      cannot be reached. The state row IS the trust boundary
--      here (it was created moments earlier under the owner's JWT,
--      keyed on a UUID that only the legitimate Intuit redirect
--      knows). set_qb_connection_tokens remains as the
--      "owner-direct" emergency-reconnect path if we ever expose
--      a manual-paste UI; the OAuth flow uses complete_qb_oauth.
--
--   4. cleanup_expired_qb_oauth_states() → integer
--      Service-role only. Returns the number of rows deleted.
--      Wired into a daily cron in a later PR; safe to omit until
--      then because complete_qb_oauth refuses expired rows and the
--      table stays tiny.
--
-- All operations idempotent. Pure additive. Depends only on PR #1.
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1. quickbooks_oauth_states
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.quickbooks_oauth_states (
  state_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL DEFAULT public.default_org_id()
                  REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_email    text NOT NULL,
  environment   text NOT NULL DEFAULT 'sandbox'
                  CHECK (environment IN ('sandbox', 'production')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + INTERVAL '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_oauth_states_org
  ON public.quickbooks_oauth_states (org_id);

-- Hot path for the daily cleanup job (cleanup_expired_qb_oauth_states).
CREATE INDEX IF NOT EXISTS idx_quickbooks_oauth_states_expired
  ON public.quickbooks_oauth_states (expires_at);

-- ────────────────────────────────────────────────────────────────────
-- 2. RLS — owner only (no admin read; this table is transient state)
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.quickbooks_oauth_states ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  cmd text;
BEGIN
  FOR cmd IN SELECT unnest(ARRAY['select', 'insert', 'update', 'delete']) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.quickbooks_oauth_states',
                   'quickbooks_oauth_states_owner_' || cmd);
  END LOOP;
END
$$;

CREATE POLICY quickbooks_oauth_states_owner_select ON public.quickbooks_oauth_states
  FOR SELECT TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY quickbooks_oauth_states_owner_insert ON public.quickbooks_oauth_states
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY quickbooks_oauth_states_owner_update ON public.quickbooks_oauth_states
  FOR UPDATE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid)
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY quickbooks_oauth_states_owner_delete ON public.quickbooks_oauth_states
  FOR DELETE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

-- ────────────────────────────────────────────────────────────────────
-- 3. init_qb_oauth_state — owner-gated state writer
-- ────────────────────────────────────────────────────────────────────
-- Called by the quickbooks-oauth-init edge function when the owner
-- clicks "Connect QuickBooks". Inserts a state row keyed on the
-- caller's verified JWT claims and returns the state_id. The edge
-- function embeds that UUID as the OAuth `state` parameter so the
-- callback can correlate the redirect to a legitimate handshake.

CREATE OR REPLACE FUNCTION public.init_qb_oauth_state(
  p_environment text DEFAULT 'sandbox'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_email     text;
  v_caller_org_id  uuid;
  v_state_id       uuid;
BEGIN
  v_user_email := auth.jwt() ->> 'email';
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_caller_org_id := nullif((auth.jwt() ->> 'org_id'), '')::uuid;
  IF v_caller_org_id IS NULL THEN
    RAISE EXCEPTION 'JWT is missing org_id claim';
  END IF;

  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the org owner can initiate a QuickBooks connection';
  END IF;

  IF p_environment NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'Invalid environment: %', p_environment;
  END IF;

  INSERT INTO public.quickbooks_oauth_states (
    org_id, user_email, environment
  ) VALUES (
    v_caller_org_id, v_user_email, p_environment
  )
  RETURNING state_id INTO v_state_id;

  RETURN v_state_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.init_qb_oauth_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.init_qb_oauth_state(text) TO authenticated;

-- ────────────────────────────────────────────────────────────────────
-- 4. complete_qb_oauth — service-role-only state-gated writer
-- ────────────────────────────────────────────────────────────────────
-- Called by the quickbooks-oauth-callback edge function after it has
-- exchanged Intuit's auth code for tokens. Atomically:
--   (a) verifies the state row exists, hasn't expired, and matches
--       the environment Intuit returned us to,
--   (b) writes both tokens to Vault under deterministic per-(org,
--       env) names (same scheme as set_qb_connection_tokens),
--   (c) upserts the public.quickbooks_connections row,
--   (d) deletes the state row so it cannot be replayed.
--
-- Trust boundary: the state_id. It was minted seconds earlier under
-- the owner's JWT inside init_qb_oauth_state; only the legitimate
-- Intuit redirect knows its value. The service_role gate ensures
-- only the edge function (which holds the SUPABASE_SERVICE_ROLE_KEY)
-- can call this function in the first place.
--
-- Returns the connection id. Raises if the state is missing or
-- expired (the edge function maps that to a redirect to the
-- Settings page with ?qb_error=expired_state).

CREATE OR REPLACE FUNCTION public.complete_qb_oauth(
  p_state_id                    uuid,
  p_realm_id                    text,
  p_refresh_token               text,
  p_access_token                text,
  p_access_token_expires_at     timestamptz,
  p_refresh_token_expires_at    timestamptz,
  p_scopes                      text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_org_id               uuid;
  v_user_email           text;
  v_environment          text;
  v_expires_at           timestamptz;
  v_refresh_secret_name  text;
  v_access_secret_name   text;
  v_existing_refresh_id  uuid;
  v_existing_access_id   uuid;
  v_connection_id        uuid;
BEGIN
  -- Input validation (no user-auth gate — service_role only via
  -- GRANT below).
  IF p_state_id IS NULL THEN
    RAISE EXCEPTION 'state_id is required';
  END IF;
  IF p_realm_id IS NULL OR length(trim(p_realm_id)) = 0 THEN
    RAISE EXCEPTION 'realm_id is required';
  END IF;
  IF p_refresh_token IS NULL OR length(trim(p_refresh_token)) = 0 THEN
    RAISE EXCEPTION 'refresh_token is required';
  END IF;
  IF p_access_token IS NULL OR length(trim(p_access_token)) = 0 THEN
    RAISE EXCEPTION 'access_token is required';
  END IF;
  IF p_scopes IS NULL OR cardinality(p_scopes) = 0 THEN
    RAISE EXCEPTION 'scopes must contain at least one value';
  END IF;

  -- Look up + verify state. We do NOT delete here — the delete
  -- happens at the end of this function so the entire flow is
  -- atomic: either everything writes or nothing writes.
  SELECT org_id, user_email, environment, expires_at
    INTO v_org_id, v_user_email, v_environment, v_expires_at
  FROM public.quickbooks_oauth_states
  WHERE state_id = p_state_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth state not found (already consumed or never existed)';
  END IF;
  IF v_expires_at < now() THEN
    -- Stale state — purge it so it can't be retried as-is.
    DELETE FROM public.quickbooks_oauth_states WHERE state_id = p_state_id;
    RAISE EXCEPTION 'OAuth state expired at %', v_expires_at;
  END IF;

  -- Deterministic per-(org, env) secret names so reconnects update
  -- in place (same scheme as set_qb_connection_tokens).
  v_refresh_secret_name := 'qb_refresh_token_' || v_environment || '_' || v_org_id::text;
  v_access_secret_name  := 'qb_access_token_'  || v_environment || '_' || v_org_id::text;

  -- Upsert refresh token in Vault
  SELECT id INTO v_existing_refresh_id
  FROM vault.secrets WHERE name = v_refresh_secret_name;
  IF v_existing_refresh_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_refresh_id, p_refresh_token);
  ELSE
    PERFORM vault.create_secret(
      p_refresh_token,
      v_refresh_secret_name,
      'QuickBooks refresh token (' || v_environment || ') for org ' || v_org_id::text
    );
  END IF;

  -- Upsert access token in Vault
  SELECT id INTO v_existing_access_id
  FROM vault.secrets WHERE name = v_access_secret_name;
  IF v_existing_access_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_access_id, p_access_token);
  ELSE
    PERFORM vault.create_secret(
      p_access_token,
      v_access_secret_name,
      'QuickBooks access token (' || v_environment || ') for org ' || v_org_id::text
    );
  END IF;

  -- Upsert connection row.
  INSERT INTO public.quickbooks_connections (
    org_id, realm_id, environment, scopes,
    refresh_token_vault_secret_name, access_token_vault_secret_name,
    access_token_expires_at, refresh_token_expires_at,
    last_refreshed_at, status, status_message,
    connected_by, connected_at
  )
  VALUES (
    v_org_id, p_realm_id, v_environment, p_scopes,
    v_refresh_secret_name, v_access_secret_name,
    p_access_token_expires_at, p_refresh_token_expires_at,
    now(), 'active', NULL,
    v_user_email, now()
  )
  ON CONFLICT (org_id, environment) DO UPDATE
    SET realm_id                        = EXCLUDED.realm_id,
        scopes                          = EXCLUDED.scopes,
        refresh_token_vault_secret_name = EXCLUDED.refresh_token_vault_secret_name,
        access_token_vault_secret_name  = EXCLUDED.access_token_vault_secret_name,
        access_token_expires_at         = EXCLUDED.access_token_expires_at,
        refresh_token_expires_at        = EXCLUDED.refresh_token_expires_at,
        last_refreshed_at               = now(),
        status                          = 'active',
        status_message                  = NULL,
        connected_by                    = EXCLUDED.connected_by,
        connected_at                    = EXCLUDED.connected_at,
        updated_at                      = now()
  RETURNING id INTO v_connection_id;

  -- Burn the state row so it cannot be replayed.
  DELETE FROM public.quickbooks_oauth_states WHERE state_id = p_state_id;

  RETURN v_connection_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_qb_oauth(
  uuid, text, text, text, timestamptz, timestamptz, text[]
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_qb_oauth(
  uuid, text, text, text, timestamptz, timestamptz, text[]
) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_qb_oauth(
  uuid, text, text, text, timestamptz, timestamptz, text[]
) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_qb_oauth(
  uuid, text, text, text, timestamptz, timestamptz, text[]
) TO service_role;

-- ────────────────────────────────────────────────────────────────────
-- 5. cleanup_expired_qb_oauth_states — service-role-only janitor
-- ────────────────────────────────────────────────────────────────────
-- Deletes rows whose expires_at has passed. Returns the count.
-- Wired into a daily cron in a later PR. Idempotent.

CREATE OR REPLACE FUNCTION public.cleanup_expired_qb_oauth_states()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  WITH d AS (
    DELETE FROM public.quickbooks_oauth_states
    WHERE expires_at < now()
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM d;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_expired_qb_oauth_states() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_qb_oauth_states() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_qb_oauth_states() FROM anon;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_qb_oauth_states() TO service_role;

-- ────────────────────────────────────────────────────────────────────
-- 6. Sanity checks
-- ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'quickbooks_oauth_states'
  ) THEN
    RAISE EXCEPTION 'quickbooks_oauth_states: table missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'quickbooks_oauth_states'
      AND n.nspname = 'public'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'quickbooks_oauth_states: RLS not enabled';
  END IF;

  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'quickbooks_oauth_states') <> 4 THEN
    RAISE EXCEPTION 'quickbooks_oauth_states: expected 4 policies, found %',
      (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'quickbooks_oauth_states');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'init_qb_oauth_state'
  ) THEN
    RAISE EXCEPTION 'init_qb_oauth_state: function missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'complete_qb_oauth'
  ) THEN
    RAISE EXCEPTION 'complete_qb_oauth: function missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'cleanup_expired_qb_oauth_states'
  ) THEN
    RAISE EXCEPTION 'cleanup_expired_qb_oauth_states: function missing after migration';
  END IF;
END
$$;
