-- ═══════════════════════════════════════════════════════════════
-- Communication Routes — Phase 2 of role-based communication routing
--
-- Purpose:
--   Create a `communication_routes` table that maps a "category of
--   outreach" (e.g. 'onboarding', 'scheduling', 'general') to a
--   specific sending identity — phone number, email address, and a
--   reference to the RingCentral JWT stored in Supabase Vault.
--
--   This table is PURELY DATA. Nothing in the app reads from it yet;
--   it will be wired into the bulk-sms edge function in Step 5 (next
--   week, separate PR). Until then, all SMS continues to use the
--   global ringcentral_from_number + RINGCENTRAL_JWT_TOKEN env var,
--   exactly as it does today.
--
-- Security model for JWTs:
--   - JWTs themselves live in `vault.secrets` (encrypted at rest).
--   - This table stores ONLY the *name* of the vault secret, which
--     is a non-sensitive reference string (e.g. 'ringcentral_jwt_
--     onboarding'). A name string alone grants no access to anything.
--   - Admins set/rotate JWTs via the `set_route_ringcentral_jwt`
--     RPC below. The RPC runs with SECURITY DEFINER so the caller
--     never needs direct write access to vault.secrets.
--   - The frontend CANNOT read JWT values at all — vault.secrets is
--     not exposed via PostgREST. The UI shows only "configured /
--     not configured" status based on whether the name is set.
--
-- Safety notes:
--   - Purely additive. No existing tables or code touched.
--   - Seeds three placeholder routes: general, onboarding, scheduling.
--     All start with null config — admin fills in via UI.
--   - Rollback: DROP TABLE communication_routes CASCADE; plus
--     DROP FUNCTION set_route_ringcentral_jwt, clear_route_ringcentral_jwt;
-- ═══════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════
-- 1. communication_routes table
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS communication_routes (
  category                TEXT PRIMARY KEY,
  label                   TEXT NOT NULL,
  description             TEXT,

  -- SMS sending config
  sms_from_number         TEXT,
  sms_vault_secret_name   TEXT,  -- reference to vault.secrets.name, not the JWT itself

  -- Email sending config (used in Step 7)
  email_from_address      TEXT,
  email_from_name         TEXT,

  -- Metadata
  is_default              BOOLEAN NOT NULL DEFAULT false,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  sort_order              INTEGER NOT NULL DEFAULT 100,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by              TEXT
);

-- Only one default route may exist at a time (Step 5 fallback target)
CREATE UNIQUE INDEX IF NOT EXISTS idx_communication_routes_default
  ON communication_routes (is_default)
  WHERE is_default = true;

-- Fast lookup of active routes (used by future edge function)
CREATE INDEX IF NOT EXISTS idx_communication_routes_active
  ON communication_routes (is_active)
  WHERE is_active = true;


-- ══════════════════════════════════════════════
-- 2. Row Level Security
--
-- Read:  any authenticated user (the UI and edge functions read this)
-- Write: admins only (as defined in user_roles)
--
-- Note: writing `sms_vault_secret_name` directly via this policy is
-- allowed, but it's just a reference string and grants no secret
-- access. The actual JWT write path goes through the RPC below.
-- ══════════════════════════════════════════════

ALTER TABLE communication_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read communication_routes"
  ON communication_routes FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can insert communication_routes"
  ON communication_routes FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE email = auth.jwt() ->> 'email' AND role = 'admin'
    )
  );

CREATE POLICY "Admins can update communication_routes"
  ON communication_routes FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE email = auth.jwt() ->> 'email' AND role = 'admin'
    )
  );

CREATE POLICY "Admins can delete communication_routes"
  ON communication_routes FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE email = auth.jwt() ->> 'email' AND role = 'admin'
    )
  );


-- ══════════════════════════════════════════════
-- 3. set_route_ringcentral_jwt RPC
--
-- Admin-only function to store or rotate a RingCentral JWT for a
-- route. Stores the JWT in Supabase Vault (encrypted at rest) and
-- updates the route row with the vault secret name reference.
--
-- Usage from the frontend (via supabase.rpc):
--   const { data, error } = await supabase.rpc(
--     'set_route_ringcentral_jwt',
--     { p_category: 'onboarding', p_jwt: '<long jwt string>' }
--   );
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION set_route_ringcentral_jwt(
  p_category TEXT,
  p_jwt      TEXT
)
RETURNS TEXT  -- returns the vault secret name on success
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_user_email   TEXT;
  v_secret_name  TEXT;
  v_existing_id  UUID;
BEGIN
  -- Admin check — only admins may set sending credentials
  v_user_email := auth.jwt() ->> 'email';
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE email = v_user_email AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can set route credentials';
  END IF;

  -- Route must exist first (created via INSERT through the UI)
  IF NOT EXISTS (
    SELECT 1 FROM public.communication_routes WHERE category = p_category
  ) THEN
    RAISE EXCEPTION 'Communication route "%" does not exist', p_category;
  END IF;

  -- JWT must be non-empty
  IF p_jwt IS NULL OR length(trim(p_jwt)) = 0 THEN
    RAISE EXCEPTION 'JWT cannot be empty';
  END IF;

  -- Deterministic secret name so we can look it up for rotations
  v_secret_name := 'ringcentral_jwt_' || p_category;

  -- Does a vault secret with this name already exist?
  SELECT id INTO v_existing_id
  FROM vault.secrets
  WHERE name = v_secret_name;

  IF v_existing_id IS NOT NULL THEN
    -- Rotation: update existing secret in place
    PERFORM vault.update_secret(v_existing_id, p_jwt);
  ELSE
    -- First time: create a new secret
    PERFORM vault.create_secret(
      p_jwt,
      v_secret_name,
      'RingCentral JWT for communication route: ' || p_category
    );
  END IF;

  -- Store the secret name reference on the route row
  UPDATE public.communication_routes
  SET sms_vault_secret_name = v_secret_name,
      updated_at = NOW(),
      updated_by = v_user_email
  WHERE category = p_category;

  RETURN v_secret_name;
END;
$$;

GRANT EXECUTE ON FUNCTION set_route_ringcentral_jwt(TEXT, TEXT) TO authenticated;


-- ══════════════════════════════════════════════
-- 4. clear_route_ringcentral_jwt RPC
--
-- Admin-only function to remove a route's JWT entirely. Deletes
-- the vault secret and nulls the reference on the route row.
-- Used when an employee leaves or when rotating to a different
-- phone number owner.
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION clear_route_ringcentral_jwt(
  p_category TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_user_email  TEXT;
  v_secret_name TEXT;
BEGIN
  v_user_email := auth.jwt() ->> 'email';
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE email = v_user_email AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can clear route credentials';
  END IF;

  -- Find the existing secret name for this route
  SELECT sms_vault_secret_name INTO v_secret_name
  FROM public.communication_routes
  WHERE category = p_category;

  -- If a secret exists in vault, delete it
  IF v_secret_name IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE name = v_secret_name;
  END IF;

  -- Null out the reference on the route row
  UPDATE public.communication_routes
  SET sms_vault_secret_name = NULL,
      updated_at = NOW(),
      updated_by = v_user_email
  WHERE category = p_category;
END;
$$;

GRANT EXECUTE ON FUNCTION clear_route_ringcentral_jwt(TEXT) TO authenticated;


-- ══════════════════════════════════════════════
-- 5. Seed initial routes
--
-- Three starter routes. All start unconfigured (null number,
-- null vault secret) — the admin fills these in via the UI
-- in Step 4. The `general` route is marked as default so the
-- edge function (Step 5) can use it as a fallback when no
-- category is specified on a send.
-- ══════════════════════════════════════════════

INSERT INTO communication_routes (category, label, description, is_default, sort_order)
VALUES
  ('general',    'General',
                 'Default route used when a send does not specify a category. Acts as the fallback for legacy call sites until they are updated.',
                 true,  10),
  ('onboarding', 'Onboarding (TAS)',
                 'Caregiver application follow-ups, document requests, new-hire communications. Typically routes through the Talent Acquisition Specialist.',
                 false, 20),
  ('scheduling', 'Scheduling (OC)',
                 'Shift scheduling, interview times, availability coordination. Typically routes through the Office Coordinator.',
                 false, 30)
ON CONFLICT (category) DO NOTHING;
