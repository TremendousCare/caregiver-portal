-- Phase 1.6.1 — upsert_call_taxonomy_row_v1 RPC.
--
-- Sole write path into `call_taxonomy` from the admin Settings UI.
-- One RPC covers create + edit + archive — the UPSERT key is
-- (org_id, axis, slug). The UI never deletes rows; archive happens
-- by passing `p_is_active := false`.
--
-- Behaviour:
--   * Admin-only via `public.is_admin()` (same SECURITY DEFINER helper
--     used by the toggle_agent_flag_v1 and upsert_ai_suggestion_grade
--     RPCs).
--   * Tenant isolation via the JWT `org_id` claim — every write is
--     stamped with the caller's org. Cross-tenant writes are
--     impossible regardless of slug collision.
--   * Validates axis at the RPC layer in addition to the CHECK so
--     callers get a clear 22023 error instead of a constraint
--     violation message.
--   * Returns the resulting row's id so the UI can refetch
--     authoritatively.
--
-- Granted to `authenticated` so the React Settings page can call it;
-- the admin gate inside is what restricts the call. Service role can
-- bypass for migrations + ad-hoc.

CREATE OR REPLACE FUNCTION public.upsert_call_taxonomy_row_v1(
  p_axis        text,
  p_slug        text,
  p_label       text,
  p_description text    DEFAULT NULL,
  p_sort_order  integer DEFAULT 0,
  p_is_active   boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_email text;
  v_jwt_org_id  uuid;
  v_actor       text;
  v_row_id      uuid;
BEGIN
  -- 1. Admin-only.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied: not an admin' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate inputs.
  IF p_axis IS NULL OR p_axis NOT IN ('call_type', 'red_flag') THEN
    RAISE EXCEPTION 'invalid axis: %', p_axis USING ERRCODE = '22023';
  END IF;
  IF p_slug IS NULL OR length(p_slug) = 0 THEN
    RAISE EXCEPTION 'p_slug is required' USING ERRCODE = '22023';
  END IF;
  IF p_label IS NULL OR length(p_label) = 0 THEN
    RAISE EXCEPTION 'p_label is required' USING ERRCODE = '22023';
  END IF;
  IF p_sort_order IS NULL THEN
    RAISE EXCEPTION 'p_sort_order is required' USING ERRCODE = '22023';
  END IF;

  -- 3. Resolve the caller's org from the JWT.
  v_jwt_org_id := nullif(auth.jwt() ->> 'org_id', '')::uuid;
  IF v_jwt_org_id IS NULL THEN
    RAISE EXCEPTION 'JWT missing org_id claim' USING ERRCODE = '42501';
  END IF;

  -- 4. Identify the actor.
  v_actor_email := lower((auth.jwt() ->> 'email'));
  v_actor       := 'user:' || coalesce(v_actor_email, 'unknown');

  -- 5. UPSERT on the natural key. created_by stays put on update;
  --    updated_by reflects whoever just touched the row.
  INSERT INTO public.call_taxonomy (
    org_id, axis, slug, label, description, sort_order, is_active,
    created_by, updated_by
  ) VALUES (
    v_jwt_org_id, p_axis, p_slug, p_label,
    nullif(p_description, ''),
    p_sort_order,
    p_is_active,
    v_actor, v_actor
  )
  ON CONFLICT (org_id, axis, slug) DO UPDATE
    SET label       = EXCLUDED.label,
        description = EXCLUDED.description,
        sort_order  = EXCLUDED.sort_order,
        is_active   = EXCLUDED.is_active,
        updated_by  = EXCLUDED.updated_by
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.upsert_call_taxonomy_row_v1(
  text, text, text, text, integer, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_call_taxonomy_row_v1(
  text, text, text, text, integer, boolean
) TO authenticated;

-- Sanity check: confirm the function landed and is SECURITY DEFINER.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'upsert_call_taxonomy_row_v1'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'public.upsert_call_taxonomy_row_v1 missing or not SECURITY DEFINER after migration';
  END IF;
END
$$;

COMMENT ON FUNCTION public.upsert_call_taxonomy_row_v1(text, text, text, text, integer, boolean) IS
  'Phase 1.6.1: admin-only UPSERT into call_taxonomy. Conflict key '
  '(org_id, axis, slug). Archive by passing p_is_active := false.';
