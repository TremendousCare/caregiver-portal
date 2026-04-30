-- Phase B2a — Membership integrity.
--
-- Phase A (PR #186, shipped 2026-04-23) created `org_memberships` and ran a
-- one-time backfill of every then-existing user. Since that date, four new
-- users have been created via flows that do not insert into org_memberships:
-- the caregiver invite path, the staff invite path, and Supabase's built-in
-- signup. Their JWTs therefore carry no `org_id` claim. The Phase B2 RLS
-- policies (next PR) are additive and so do not lock those users out today,
-- but the strict enforcement that ships in Phase B5 would.
--
-- This migration:
--   1. Re-runs Phase A's two backfill queries (idempotent via ON CONFLICT)
--      so any orphan staff or PWA caregiver picks up the correct role.
--   2. Catches any remaining orphan auth.users rows with role='caregiver'
--      as the least-privileged default.
--   3. Installs an AFTER INSERT trigger on auth.users so every future user
--      automatically gets a membership in Tremendous Care.
--
-- Phase E will replace the trigger with the self-serve onboarding flow
-- (which creates the org + membership in a single transaction) and drop
-- the per-table org_id defaults. Until then, this trigger and
-- public.default_org_id() are the single-tenant safety net.

-- ── 1. Backfill known staff (mirrors Phase A) ────────────────────────────
INSERT INTO public.org_memberships (org_id, user_id, role)
SELECT public.default_org_id(), u.id, ur.role
FROM public.user_roles ur
JOIN auth.users u ON lower(u.email) = lower(ur.email)
WHERE ur.role IN ('admin', 'member')
  AND u.deleted_at IS NULL
ON CONFLICT (org_id, user_id) DO NOTHING;

-- ── 2. Backfill known caregivers (mirrors Phase A) ───────────────────────
-- Skip if the user already has any membership row (staff already inserted
-- above). The unique constraint is (org_id, user_id), so re-inserting with
-- role='caregiver' would silently bypass the staff role; the EXISTS check
-- prevents that.
INSERT INTO public.org_memberships (org_id, user_id, role)
SELECT public.default_org_id(), c.user_id, 'caregiver'
FROM public.caregivers c
WHERE c.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.org_memberships m WHERE m.user_id = c.user_id
  )
ON CONFLICT (org_id, user_id) DO NOTHING;

-- ── 3. Catch remaining orphans with the least-privileged default ─────────
-- Any active auth.users row that is neither in user_roles nor linked to a
-- caregivers row gets role='caregiver'. If they later turn out to be staff,
-- a manual UPDATE on org_memberships reclassifies them.
INSERT INTO public.org_memberships (org_id, user_id, role)
SELECT public.default_org_id(), u.id, 'caregiver'
FROM auth.users u
WHERE u.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.org_memberships m WHERE m.user_id = u.id
  )
ON CONFLICT (org_id, user_id) DO NOTHING;

-- ── 4. Auto-membership trigger ───────────────────────────────────────────
-- Fires AFTER INSERT on auth.users. Determines the role by checking
-- user_roles by email; falls back to 'caregiver' (least privilege) if no
-- match. Idempotent via ON CONFLICT, so a re-fire on a user with an
-- existing membership is a no-op.
--
-- SECURITY DEFINER + locked search_path: the trigger runs as the function
-- owner so it can write to public.org_memberships from the auth schema's
-- transaction context. search_path is pinned to defeat search_path-based
-- privilege escalation (CVE-2018-1058 class).
CREATE OR REPLACE FUNCTION public.handle_new_user_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_org  uuid;
BEGIN
  v_org := public.default_org_id();
  IF v_org IS NULL THEN
    -- Tremendous Care org missing; nothing safe to do. Don't block signup.
    RETURN NEW;
  END IF;

  -- New email may be NULL on certain auth flows (phone-only, etc.); the
  -- COALESCE keeps the lookup harmless in that case.
  SELECT ur.role
    INTO v_role
  FROM public.user_roles ur
  WHERE lower(ur.email) = lower(COALESCE(NEW.email, ''))
    AND ur.role IN ('admin', 'member')
  LIMIT 1;

  INSERT INTO public.org_memberships (org_id, user_id, role)
  VALUES (v_org, NEW.id, COALESCE(v_role, 'caregiver'))
  ON CONFLICT (org_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Allow the auth admin role to invoke the function. Without this grant the
-- trigger would error on insert because supabase_auth_admin owns auth.users.
GRANT EXECUTE ON FUNCTION public.handle_new_user_membership() TO supabase_auth_admin;

DROP TRIGGER IF EXISTS on_auth_user_created_membership ON auth.users;
CREATE TRIGGER on_auth_user_created_membership
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_membership();

-- ── 5. Sanity check ──────────────────────────────────────────────────────
-- Aborts the transaction if any active auth.users row still has no
-- membership after this migration runs. Partial state is impossible.
DO $$
DECLARE
  v_orphans int;
BEGIN
  SELECT count(*)
    INTO v_orphans
  FROM auth.users u
  WHERE u.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.org_memberships m WHERE m.user_id = u.id
    );

  IF v_orphans > 0 THEN
    RAISE EXCEPTION
      'Phase B2a sanity check failed: % active auth.users rows still have no membership.', v_orphans;
  END IF;
END $$;
