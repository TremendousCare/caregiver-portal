-- Phase A — Auth foundation: custom access token hook.
-- Injects org_id, org_slug, org_role claims into every issued JWT
-- by reading the user's deterministic first membership.
--
-- MANUAL STEP AFTER MIGRATION:
--   Supabase Dashboard → Authentication → Hooks → Custom Access
--   Token Hook → enable and select public.custom_access_token_hook.
--   Without this step the function exists but is not called on
--   token issuance.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_claims  jsonb;
  v_org_id  uuid;
  v_slug    text;
  v_role    text;
BEGIN
  v_user_id := (event ->> 'user_id')::uuid;
  v_claims  := COALESCE(event -> 'claims', '{}'::jsonb);

  IF v_user_id IS NULL THEN
    RETURN event;
  END IF;

  -- Deterministic: first membership by created_at, tie-break on id.
  SELECT m.org_id, o.slug, m.role
    INTO v_org_id, v_slug, v_role
  FROM public.org_memberships m
  JOIN public.organizations   o ON o.id = m.org_id
  WHERE m.user_id = v_user_id
  ORDER BY m.created_at ASC, m.id ASC
  LIMIT 1;

  IF v_org_id IS NOT NULL THEN
    v_claims := v_claims
      || jsonb_build_object('org_id',   v_org_id::text)
      || jsonb_build_object('org_slug', v_slug)
      || jsonb_build_object('org_role', v_role);
  END IF;

  RETURN jsonb_set(event, '{claims}', v_claims);
END;
$$;

-- Lock down. Only supabase_auth_admin may execute the hook.
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM anon;
GRANT  EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;

-- supabase_auth_admin needs USAGE on the schema to reach the function
-- and the tables below. The EXECUTE grant above is meaningless without
-- it; without this line the hook can fail at runtime with
-- "permission denied for schema public" once the manual Dashboard
-- toggle enables it. Matches Supabase's documented hook pattern.
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;

-- The hook reads these tables as the auth admin; ensure access.
GRANT SELECT ON public.organizations   TO supabase_auth_admin;
GRANT SELECT ON public.org_memberships TO supabase_auth_admin;
