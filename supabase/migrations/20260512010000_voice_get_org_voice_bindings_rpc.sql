-- Voice / CTI Phase 1 PR 3 — get_org_voice_bindings RPC.
--
-- Returns the staff (admin + member) memberships for the caller's
-- org with email and display_name resolved. Powers the Voice & Calls
-- admin panel's extension-binding table.
--
-- Why an RPC: the binding table needs to show "email + role + RC
-- extension" for each staff user in the org. That's a join across
--   public.org_memberships  (user_id, role, ringcentral_extension_id)
--   auth.users              (email)        — not readable from PostgREST
--   public.team_members     (display_name) — optional, by email
-- and the auth.users half can't be done from the client. A SECURITY
-- DEFINER function with an `is_admin()` gate bridges it cleanly.
--
-- Auth posture (RLS_GOTCHAS-compliant):
--   - STABLE SECURITY DEFINER with a locked search_path — same
--     pattern as public.is_admin() / public.is_staff() (see
--     docs/RLS_GOTCHAS.md "The pattern to follow"). The body's
--     inner SELECT against auth.users + org_memberships bypasses
--     RLS for the lookup; the policy-recursion detector is not
--     tripped because no policy on those tables references this
--     function.
--   - Gated to admins inside the body via public.is_admin().
--     Non-admins receive an empty result set.
--   - org scope is enforced by reading auth.jwt() ->> 'org_id'
--     and filtering org_memberships.org_id on that value. Missing
--     claim → no rows. Matches the fail-closed posture locked in
--     Phase B2b.
--
-- Rollback: see _rollback/20260512010000_*.

CREATE OR REPLACE FUNCTION public.get_org_voice_bindings()
RETURNS TABLE (
  user_id                  uuid,
  email                    text,
  display_name             text,
  role                     text,
  ringcentral_extension_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    om.user_id,
    u.email::text                       AS email,
    tm.display_name                     AS display_name,
    om.role                             AS role,
    om.ringcentral_extension_id         AS ringcentral_extension_id
  FROM public.org_memberships om
  JOIN auth.users u ON u.id = om.user_id
  LEFT JOIN public.team_members tm ON lower(tm.email) = lower(u.email::text)
  WHERE om.org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
    AND om.role IN ('admin', 'member')
    AND public.is_admin()
  ORDER BY
    CASE om.role WHEN 'admin' THEN 0 ELSE 1 END,
    u.email;
$$;

GRANT EXECUTE ON FUNCTION public.get_org_voice_bindings() TO authenticated;

DO $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_org_voice_bindings'
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'get_org_voice_bindings RPC missing after migration';
  END IF;
END
$$;
