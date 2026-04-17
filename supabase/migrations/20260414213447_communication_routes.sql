-- ═══════════════════════════════════════════════════════════════
-- Communication Routes — Phase 2 of role-based communication routing
-- See supabase/migrations/20260414_communication_routes.sql for full docs
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS communication_routes (
  category                TEXT PRIMARY KEY,
  label                   TEXT NOT NULL,
  description             TEXT,

  sms_from_number         TEXT,
  sms_vault_secret_name   TEXT,

  email_from_address      TEXT,
  email_from_name         TEXT,

  is_default              BOOLEAN NOT NULL DEFAULT false,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  sort_order              INTEGER NOT NULL DEFAULT 100,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by              TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_communication_routes_default
  ON communication_routes (is_default)
  WHERE is_default = true;

CREATE INDEX IF NOT EXISTS idx_communication_routes_active
  ON communication_routes (is_active)
  WHERE is_active = true;

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

CREATE OR REPLACE FUNCTION set_route_ringcentral_jwt(
  p_category TEXT,
  p_jwt      TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_user_email   TEXT;
  v_secret_name  TEXT;
  v_existing_id  UUID;
BEGIN
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

  IF NOT EXISTS (
    SELECT 1 FROM public.communication_routes WHERE category = p_category
  ) THEN
    RAISE EXCEPTION 'Communication route "%" does not exist', p_category;
  END IF;

  IF p_jwt IS NULL OR length(trim(p_jwt)) = 0 THEN
    RAISE EXCEPTION 'JWT cannot be empty';
  END IF;

  v_secret_name := 'ringcentral_jwt_' || p_category;

  SELECT id INTO v_existing_id
  FROM vault.secrets
  WHERE name = v_secret_name;

  IF v_existing_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_id, p_jwt);
  ELSE
    PERFORM vault.create_secret(
      p_jwt,
      v_secret_name,
      'RingCentral JWT for communication route: ' || p_category
    );
  END IF;

  UPDATE public.communication_routes
  SET sms_vault_secret_name = v_secret_name,
      updated_at = NOW(),
      updated_by = v_user_email
  WHERE category = p_category;

  RETURN v_secret_name;
END;
$$;

GRANT EXECUTE ON FUNCTION set_route_ringcentral_jwt(TEXT, TEXT) TO authenticated;

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

  SELECT sms_vault_secret_name INTO v_secret_name
  FROM public.communication_routes
  WHERE category = p_category;

  IF v_secret_name IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE name = v_secret_name;
  END IF;

  UPDATE public.communication_routes
  SET sms_vault_secret_name = NULL,
      updated_at = NOW(),
      updated_by = v_user_email
  WHERE category = p_category;
END;
$$;

GRANT EXECUTE ON FUNCTION clear_route_ringcentral_jwt(TEXT) TO authenticated;

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
