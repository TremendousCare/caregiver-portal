-- ═══════════════════════════════════════════════════════════════
-- QuickBooks Online integration — PR #1 of N (foundation)
--
-- Stores per-org QuickBooks Online OAuth connections. One row per
-- (org_id, environment) — an org can have a sandbox connection and a
-- production connection live at the same time during testing.
--
-- Token storage follows the communication_routes + Vault pattern
-- (migrations 20260414213447 and 20260414221401). The table itself
-- holds non-sensitive bookkeeping (realm_id, scopes, expiry stamps,
-- status) and *references* into vault.secrets by name. The actual
-- refresh and access tokens never sit in a regular table — they live
-- encrypted in vault.secrets and are read only by service-role edge
-- functions via the get_qb_connection() RPC below.
--
-- Why two tokens stored, not one:
--   • access_token  — 1-hour TTL, used on every QB API call
--   • refresh_token — 100-day sliding window, used to mint new
--                     access tokens. Rotates on every refresh per
--                     Intuit's OAuth 2.0 spec — the new refresh
--                     token MUST be written back atomically with
--                     the new access token, or the connection is
--                     dead.
--
-- Visibility (locked with owner 2026-05-29):
--   • owner — full R/W (only owner connects/disconnects QuickBooks)
--   • admin — SELECT only (sees connection status for analytics UI)
--   • member/caregiver — no access
--
-- RLS: every policy uses public.is_owner() / public.is_admin()
-- (STABLE SECURITY DEFINER per docs/RLS_GOTCHAS.md) plus an org_id
-- JWT check. No inline EXISTS.
--
-- This PR ships:
--   1. quickbooks_connections table (additive — no existing table
--      touched)
--   2. RLS policies (owner R/W, admin R, scoped to org)
--   3. set_qb_connection_tokens() — owner-gated writer that upserts
--      a row AND writes both tokens to Vault in one transaction.
--      Called from the OAuth callback edge function in PR #2.
--   4. refresh_qb_connection_tokens() — service-role-only rotator
--      that updates token columns and Vault secrets in place
--      without touching the connected_by / connected_at audit
--      fields. Called by the token-refresh cron (PR #3).
--   5. get_qb_connection() — service_role-only reader that returns
--      the connection row plus decrypted tokens. Edge functions only.
--   6. clear_qb_connection() — owner-gated disconnect. Deletes Vault
--      secrets and the row.
--
-- All operations are idempotent. Pure additive. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1. quickbooks_connections
-- ────────────────────────────────────────────────────────────────────
-- One row per (org, environment). realm_id is QuickBooks' identifier
-- for the connected Company File — it stays constant for a given
-- company across token refreshes. status drives the Settings UI badge
-- and is updated by the token-refresh cron in PR #3.

CREATE TABLE IF NOT EXISTS public.quickbooks_connections (
  id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                              uuid NOT NULL DEFAULT public.default_org_id()
                                        REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Intuit identifiers
  realm_id                            text NOT NULL,
  environment                         text NOT NULL DEFAULT 'sandbox'
                                        CHECK (environment IN ('sandbox', 'production')),

  -- What the user granted at consent time. Stored as text[] so we can
  -- detect mid-flight scope additions (e.g. adding Payments scope
  -- later) without a migration.
  scopes                              text[] NOT NULL DEFAULT ARRAY[]::text[]
                                        CHECK (cardinality(scopes) > 0),

  -- Vault references. NEVER the raw tokens. NOT NULL because a
  -- connection without tokens is non-functional — if we're
  -- disconnecting we delete the row.
  refresh_token_vault_secret_name     text NOT NULL,
  access_token_vault_secret_name      text NOT NULL,

  -- Expiry tracking. Used by the refresh cron (PR #3) to refresh
  -- proactively before access_token_expires_at, and to warn the
  -- owner before refresh_token_expires_at if the connection has been
  -- idle for ~90 days (100-day Intuit window minus buffer).
  access_token_expires_at             timestamptz NOT NULL,
  refresh_token_expires_at            timestamptz NOT NULL,
  last_refreshed_at                   timestamptz NOT NULL DEFAULT now(),

  -- Sync bookkeeping (populated by PR #4's sync function).
  last_sync_at                        timestamptz,

  -- Operational status. 'active' is the happy path. 'reauth_required'
  -- is set when the refresh token lapsed and the user must reconnect.
  -- 'error' is set transiently by the refresh cron when QB returns a
  -- non-401 failure; 'disconnected' is set by clear_qb_connection
  -- immediately before the row is deleted (kept briefly for audit).
  status                              text NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active', 'error',
                                                          'reauth_required',
                                                          'disconnected')),
  status_message                      text,

  -- Audit
  connected_by                        text NOT NULL,
  connected_at                        timestamptz NOT NULL DEFAULT now(),
  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now(),

  -- One live connection per (org, environment). Reconnecting replaces
  -- the row via set_qb_connection_tokens (ON CONFLICT below).
  CONSTRAINT quickbooks_connections_one_per_env UNIQUE (org_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_connections_org
  ON public.quickbooks_connections (org_id);

-- Hot path for the refresh cron: "which connections need refreshing
-- in the next hour?"
CREATE INDEX IF NOT EXISTS idx_quickbooks_connections_refresh_due
  ON public.quickbooks_connections (access_token_expires_at)
  WHERE status = 'active';

-- Hot path for the warn-before-expiry cron: "which connections will
-- lose their refresh token soon?"
CREATE INDEX IF NOT EXISTS idx_quickbooks_connections_reauth_due
  ON public.quickbooks_connections (refresh_token_expires_at)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS quickbooks_connections_touch_updated_at
  ON public.quickbooks_connections;
CREATE TRIGGER quickbooks_connections_touch_updated_at
  BEFORE UPDATE ON public.quickbooks_connections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 2. RLS — owner R/W, admin R
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.quickbooks_connections ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  cmd text;
BEGIN
  FOR cmd IN SELECT unnest(ARRAY['select', 'insert', 'update', 'delete']) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.quickbooks_connections',
                   'quickbooks_connections_owner_' || cmd);
  END LOOP;
  EXECUTE 'DROP POLICY IF EXISTS quickbooks_connections_admin_select '
       || 'ON public.quickbooks_connections';
END
$$;

-- Owner — full R/W
CREATE POLICY quickbooks_connections_owner_select ON public.quickbooks_connections
  FOR SELECT TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY quickbooks_connections_owner_insert ON public.quickbooks_connections
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY quickbooks_connections_owner_update ON public.quickbooks_connections
  FOR UPDATE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid)
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY quickbooks_connections_owner_delete ON public.quickbooks_connections
  FOR DELETE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

-- Admin — SELECT only (sees status + last_sync_at to render the
-- analytics-page connection badge; cannot rotate or revoke).
CREATE POLICY quickbooks_connections_admin_select ON public.quickbooks_connections
  FOR SELECT TO authenticated
  USING (public.is_admin() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

-- ────────────────────────────────────────────────────────────────────
-- 3. set_qb_connection_tokens — owner-gated writer (OAuth callback)
-- ────────────────────────────────────────────────────────────────────
-- Called from the OAuth callback edge function (PR #2) when the
-- owner clicks "Connect QuickBooks" and completes Intuit's consent
-- flow. NOT called by the refresh cron — that path uses
-- refresh_qb_connection_tokens (section 3b below).
--
-- Atomically:
--   (a) upserts the quickbooks_connections row keyed by
--       (org_id, environment),
--   (b) creates or updates the two Vault secrets,
--   (c) records who initiated and when.
--
-- ON CONFLICT — reconnecting (e.g. owner re-grants after revoking
-- in Intuit's console, or adds a new scope) replaces vault entries
-- in-place via vault.update_secret rather than creating a second
-- secret with the same name (Vault names are unique). connected_by
-- and connected_at are overwritten because a reconnect IS a fresh
-- authorization by a (possibly different) owner.
--
-- Returns the connection id.

CREATE OR REPLACE FUNCTION public.set_qb_connection_tokens(
  p_org_id                      uuid,
  p_environment                 text,
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
  v_user_email           text;
  v_caller_org_id        uuid;
  v_refresh_secret_name  text;
  v_access_secret_name   text;
  v_existing_refresh_id  uuid;
  v_existing_access_id   uuid;
  v_connection_id        uuid;
BEGIN
  -- Auth gate
  v_user_email := auth.jwt() ->> 'email';
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- The connecting user must belong to the org they're connecting.
  -- We don't trust p_org_id from the client; the JWT is the source
  -- of truth.
  v_caller_org_id := nullif((auth.jwt() ->> 'org_id'), '')::uuid;
  IF v_caller_org_id IS NULL OR v_caller_org_id <> p_org_id THEN
    RAISE EXCEPTION 'Cannot set QuickBooks tokens for another org';
  END IF;

  -- Only owners can connect QuickBooks.
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the org owner can connect QuickBooks';
  END IF;

  -- Input validation
  IF p_environment NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'Invalid environment: %', p_environment;
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

  -- Deterministic per-(org, env) secret names so reconnects update
  -- rather than accumulate.
  v_refresh_secret_name := 'qb_refresh_token_' || p_environment || '_' || p_org_id::text;
  v_access_secret_name  := 'qb_access_token_'  || p_environment || '_' || p_org_id::text;

  -- Upsert refresh token
  SELECT id INTO v_existing_refresh_id
  FROM vault.secrets WHERE name = v_refresh_secret_name;
  IF v_existing_refresh_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_refresh_id, p_refresh_token);
  ELSE
    PERFORM vault.create_secret(
      p_refresh_token,
      v_refresh_secret_name,
      'QuickBooks refresh token (' || p_environment || ') for org ' || p_org_id::text
    );
  END IF;

  -- Upsert access token
  SELECT id INTO v_existing_access_id
  FROM vault.secrets WHERE name = v_access_secret_name;
  IF v_existing_access_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_access_id, p_access_token);
  ELSE
    PERFORM vault.create_secret(
      p_access_token,
      v_access_secret_name,
      'QuickBooks access token (' || p_environment || ') for org ' || p_org_id::text
    );
  END IF;

  -- Upsert connection row. ON CONFLICT (org_id, environment) is
  -- guaranteed by the UNIQUE constraint above.
  INSERT INTO public.quickbooks_connections (
    org_id, realm_id, environment, scopes,
    refresh_token_vault_secret_name, access_token_vault_secret_name,
    access_token_expires_at, refresh_token_expires_at,
    last_refreshed_at, status, status_message,
    connected_by, connected_at
  )
  VALUES (
    p_org_id, p_realm_id, p_environment, p_scopes,
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

  RETURN v_connection_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_qb_connection_tokens(
  uuid, text, text, text, text, timestamptz, timestamptz, text[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_qb_connection_tokens(
  uuid, text, text, text, text, timestamptz, timestamptz, text[]
) TO authenticated;
-- NOT granted to service_role. The token-refresh cron uses
-- refresh_qb_connection_tokens (below), which is a separate
-- service-role-only function that updates token fields in place
-- without touching the connected_by / connected_at audit columns
-- and without requiring a user JWT context. Granting this function
-- to service_role would be misleading: its body still gates on
-- auth.jwt()->>'email' and public.is_owner(), so a service-role
-- call would raise 'Authentication required' before doing any work.

-- ────────────────────────────────────────────────────────────────────
-- 3b. refresh_qb_connection_tokens — service-role-only rotator
-- ────────────────────────────────────────────────────────────────────
-- Called by the token-refresh cron (PR #3) when an access token
-- nears expiry. The cron pulls the list of connections needing
-- refresh, calls Intuit's /oauth2/v1/tokens endpoint with the stored
-- refresh_token, and receives back a NEW access_token AND a NEW
-- refresh_token — Intuit rotates the refresh token on every refresh
-- per its OAuth 2.0 spec. Failing to store the new refresh_token
-- bricks the connection at the 100-day mark.
--
-- Why a separate function and not a service_role branch inside
-- set_qb_connection_tokens:
--   • This path must NEVER overwrite connected_by / connected_at —
--     those record the human who first authorized; the cron is not
--     a re-authorization.
--   • The signature is narrower: no realm_id, no scopes — neither
--     can change at refresh time.
--   • One function, one responsibility. The set_/refresh_/clear_
--     split mirrors the natural state transitions of an OAuth
--     connection.
--
-- Operates only on an EXISTING connection. Returns true if updated,
-- false if no matching row was found (cron can then mark the
-- connection 'reauth_required' via a separate UPDATE).

CREATE OR REPLACE FUNCTION public.refresh_qb_connection_tokens(
  p_org_id                      uuid,
  p_environment                 text,
  p_refresh_token               text,
  p_access_token                text,
  p_access_token_expires_at     timestamptz,
  p_refresh_token_expires_at    timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_refresh_name        text;
  v_access_name         text;
  v_existing_refresh_id uuid;
  v_existing_access_id  uuid;
BEGIN
  -- Input validation (no user-auth gate — service_role only via
  -- GRANT below).
  IF p_environment NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'Invalid environment: %', p_environment;
  END IF;
  IF p_refresh_token IS NULL OR length(trim(p_refresh_token)) = 0 THEN
    RAISE EXCEPTION 'refresh_token is required';
  END IF;
  IF p_access_token IS NULL OR length(trim(p_access_token)) = 0 THEN
    RAISE EXCEPTION 'access_token is required';
  END IF;

  SELECT refresh_token_vault_secret_name, access_token_vault_secret_name
    INTO v_refresh_name, v_access_name
  FROM public.quickbooks_connections
  WHERE org_id = p_org_id AND environment = p_environment;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Rotate Vault secrets in place. The rows must exist — they were
  -- created by set_qb_connection_tokens at initial connect. If a
  -- prior run partially failed and one is missing, fall back to
  -- create_secret so we self-heal rather than crash the cron.
  SELECT id INTO v_existing_refresh_id
  FROM vault.secrets WHERE name = v_refresh_name;
  IF v_existing_refresh_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_refresh_id, p_refresh_token);
  ELSE
    PERFORM vault.create_secret(
      p_refresh_token,
      v_refresh_name,
      'QuickBooks refresh token (' || p_environment || ') for org ' || p_org_id::text
    );
  END IF;

  SELECT id INTO v_existing_access_id
  FROM vault.secrets WHERE name = v_access_name;
  IF v_existing_access_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_access_id, p_access_token);
  ELSE
    PERFORM vault.create_secret(
      p_access_token,
      v_access_name,
      'QuickBooks access token (' || p_environment || ') for org ' || p_org_id::text
    );
  END IF;

  -- Update only the rotation-relevant columns. connected_by and
  -- connected_at are intentionally untouched — they record the
  -- human authorization, not the cron rotation.
  UPDATE public.quickbooks_connections
  SET access_token_expires_at  = p_access_token_expires_at,
      refresh_token_expires_at = p_refresh_token_expires_at,
      last_refreshed_at        = now(),
      status                   = 'active',
      status_message           = NULL,
      updated_at               = now()
  WHERE org_id = p_org_id AND environment = p_environment;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refresh_qb_connection_tokens(
  uuid, text, text, text, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refresh_qb_connection_tokens(
  uuid, text, text, text, timestamptz, timestamptz
) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_qb_connection_tokens(
  uuid, text, text, text, timestamptz, timestamptz
) FROM anon;
GRANT EXECUTE ON FUNCTION public.refresh_qb_connection_tokens(
  uuid, text, text, text, timestamptz, timestamptz
) TO service_role;

-- ────────────────────────────────────────────────────────────────────
-- 4. get_qb_connection — service_role-only reader
-- ────────────────────────────────────────────────────────────────────
-- Returns the connection row plus decrypted tokens. Service-role
-- only — edge functions read tokens to call Intuit's API; no
-- authenticated user should ever see a raw token.

CREATE OR REPLACE FUNCTION public.get_qb_connection(
  p_org_id      uuid,
  p_environment text DEFAULT 'production'
)
RETURNS TABLE (
  id                        uuid,
  realm_id                  text,
  environment               text,
  scopes                    text[],
  refresh_token             text,
  access_token              text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  last_refreshed_at         timestamptz,
  last_sync_at              timestamptz,
  status                    text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_refresh_name text;
  v_access_name  text;
  v_refresh_val  text;
  v_access_val   text;
BEGIN
  SELECT qc.refresh_token_vault_secret_name,
         qc.access_token_vault_secret_name
    INTO v_refresh_name, v_access_name
  FROM public.quickbooks_connections qc
  WHERE qc.org_id = p_org_id AND qc.environment = p_environment;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT vds.decrypted_secret INTO v_refresh_val
  FROM vault.decrypted_secrets vds WHERE vds.name = v_refresh_name;

  SELECT vds.decrypted_secret INTO v_access_val
  FROM vault.decrypted_secrets vds WHERE vds.name = v_access_name;

  RETURN QUERY
  SELECT qc.id,
         qc.realm_id,
         qc.environment,
         qc.scopes,
         v_refresh_val,
         v_access_val,
         qc.access_token_expires_at,
         qc.refresh_token_expires_at,
         qc.last_refreshed_at,
         qc.last_sync_at,
         qc.status
  FROM public.quickbooks_connections qc
  WHERE qc.org_id = p_org_id AND qc.environment = p_environment;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_qb_connection(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_qb_connection(uuid, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.get_qb_connection(uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_qb_connection(uuid, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────
-- 5. clear_qb_connection — owner-gated disconnect
-- ────────────────────────────────────────────────────────────────────
-- Deletes the Vault secrets and the connection row. Owner only.
-- Returns true if a connection was deleted, false if none existed.

CREATE OR REPLACE FUNCTION public.clear_qb_connection(
  p_org_id      uuid,
  p_environment text DEFAULT 'production'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_user_email     text;
  v_caller_org_id  uuid;
  v_refresh_name   text;
  v_access_name    text;
BEGIN
  v_user_email := auth.jwt() ->> 'email';
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_caller_org_id := nullif((auth.jwt() ->> 'org_id'), '')::uuid;
  IF v_caller_org_id IS NULL OR v_caller_org_id <> p_org_id THEN
    RAISE EXCEPTION 'Cannot clear QuickBooks tokens for another org';
  END IF;

  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the org owner can disconnect QuickBooks';
  END IF;

  SELECT refresh_token_vault_secret_name, access_token_vault_secret_name
    INTO v_refresh_name, v_access_name
  FROM public.quickbooks_connections
  WHERE org_id = p_org_id AND environment = p_environment;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_refresh_name IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE name = v_refresh_name;
  END IF;
  IF v_access_name IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE name = v_access_name;
  END IF;

  DELETE FROM public.quickbooks_connections
  WHERE org_id = p_org_id AND environment = p_environment;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.clear_qb_connection(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_qb_connection(uuid, text) TO authenticated;

-- ────────────────────────────────────────────────────────────────────
-- 6. Sanity checks
-- ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'quickbooks_connections'
  ) THEN
    RAISE EXCEPTION 'quickbooks_connections: table missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'quickbooks_connections'
      AND n.nspname = 'public'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'quickbooks_connections: RLS not enabled';
  END IF;

  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'quickbooks_connections') <> 5 THEN
    RAISE EXCEPTION 'quickbooks_connections: expected 5 policies, found %',
      (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'quickbooks_connections');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'set_qb_connection_tokens'
  ) THEN
    RAISE EXCEPTION 'set_qb_connection_tokens: function missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'refresh_qb_connection_tokens'
  ) THEN
    RAISE EXCEPTION 'refresh_qb_connection_tokens: function missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_qb_connection'
  ) THEN
    RAISE EXCEPTION 'get_qb_connection: function missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'clear_qb_connection'
  ) THEN
    RAISE EXCEPTION 'clear_qb_connection: function missing after migration';
  END IF;
END
$$;
