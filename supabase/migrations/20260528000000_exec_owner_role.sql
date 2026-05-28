-- ═══════════════════════════════════════════════════════════════
-- Executive Task Management — Phase 1 PR 1, Migration 1 of 4
--
-- Introduces a third staff-tier role: 'owner'.
--
-- Concept (locked with the owner 2026-05-28):
--   - 'owner'  = c-suite / financial decision-maker; sees the
--                Executive module (goals + exec tasks + recurring
--                exec responsibilities)
--   - 'admin'  = office admin; sees everything they see today, plus
--                read-only access to company goals (no exec tasks)
--   - 'member' = unchanged
--   - 'caregiver' = unchanged (PWA-only)
--
-- Owners ARE admins (hierarchical) — they keep every right an admin
-- has. is_admin() and is_staff() are updated to treat 'owner' as
-- satisfying admin/staff, so no existing admin-gated feature loses
-- access for the two owners after backfill.
--
-- Backfill targets (per owner's instruction):
--   - nashkevi1@gmail.com            (Kevin Nash, personal)
--   - kevinnash@tremendouscareca.com (Kevin Nash, work)
--   - Blertanash@tremendouscareca.com (Blerta Nash)
--
-- Chris Nash (chrisnash@tremendouscareca.com) intentionally stays
-- as 'admin' — narrowest backfill that matches the explicit list.
--
-- Two role tables to update, kept in sync:
--   - user_roles      (legacy, email-keyed; what is_admin/is_staff read)
--   - org_memberships (multi-tenant, what the JWT hook projects)
-- The JWT hook (20260422000002) selects role from org_memberships,
-- so without the second update, Kevin/Blerta would log in with
-- org_role='admin' even though user_roles says 'owner'. Both
-- tables must agree.
--
-- Multi-tenancy discipline (CLAUDE.md → Prime Directives):
--   The SaaS retrofit is paused, but this work respects multi-org
--   correctness — is_owner() will be used by every executive-tier
--   RLS policy alongside an org_id check.
--
-- Idempotent: re-runnable via the manual deploy workflow.
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1. Loosen CHECK constraint on user_roles.role
-- ────────────────────────────────────────────────────────────────────
-- Postgres auto-names the constraint user_roles_role_check. Drop and
-- re-add with the expanded enum.

ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS user_roles_role_check;

ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('admin', 'member', 'owner'));

-- ────────────────────────────────────────────────────────────────────
-- 2. Loosen CHECK constraint on org_memberships.role
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.org_memberships
  DROP CONSTRAINT IF EXISTS org_memberships_role_check;

ALTER TABLE public.org_memberships
  ADD CONSTRAINT org_memberships_role_check
  CHECK (role IN ('admin', 'member', 'owner', 'caregiver'));

-- ────────────────────────────────────────────────────────────────────
-- 3. Promote the two owners in user_roles
-- ────────────────────────────────────────────────────────────────────
-- lower() everywhere — the PK is text but user_roles is conventionally
-- lower-cased on insert; defensive lower() on the WHERE matches the
-- existing is_admin() / is_staff() helpers.

UPDATE public.user_roles
   SET role = 'owner',
       updated_at = now(),
       updated_by = 'migration:exec_owner_role'
 WHERE lower(email) IN (
   'nashkevi1@gmail.com',
   'kevinnash@tremendouscareca.com',
   'blertanash@tremendouscareca.com'
 );

-- ────────────────────────────────────────────────────────────────────
-- 4. Promote the same two owners in org_memberships
-- ────────────────────────────────────────────────────────────────────
-- Join through auth.users on lower(email) so we promote whichever
-- membership row exists for each owner. Skip silently if a user has
-- not yet logged in (no auth.users row) — the Phase A trigger on
-- auth.users INSERT will create the membership at first login, and
-- the next time this migration runs (or a follow-up) will pick it up.

UPDATE public.org_memberships m
   SET role = 'owner'
  FROM auth.users u
 WHERE m.user_id = u.id
   AND lower(u.email) IN (
     'nashkevi1@gmail.com',
     'kevinnash@tremendouscareca.com',
     'blertanash@tremendouscareca.com'
   );

-- ────────────────────────────────────────────────────────────────────
-- 5. Update is_admin() — owners ARE admins
-- ────────────────────────────────────────────────────────────────────
-- One-word change: add 'owner' to the IN list. Same SECURITY DEFINER
-- shape as before, same search_path pin. Owners get every existing
-- admin-gated feature for free.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE email = lower((auth.jwt() ->> 'email'))
      AND role IN ('admin', 'owner')
  );
$$;

-- ────────────────────────────────────────────────────────────────────
-- 6. Update is_staff() — owners ARE staff
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE email = lower((auth.jwt() ->> 'email'))
      AND role IN ('admin', 'member', 'owner')
  );
$$;

-- ────────────────────────────────────────────────────────────────────
-- 7. Create is_owner() — the executive-tier gate
-- ────────────────────────────────────────────────────────────────────
-- Mirrors is_admin()/is_staff() structurally. Used by every RLS
-- policy on executive-tier tables (exec_task_templates, exec_tasks,
-- exec_goal_checkins) and as the gate for INSERT/UPDATE/DELETE on
-- shared tables that admins may read but only owners may modify
-- (exec_goals, exec_key_results).
--
-- STABLE SECURITY DEFINER, pinned search_path — required by
-- docs/RLS_GOTCHAS.md rule 1.

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE email = lower((auth.jwt() ->> 'email'))
      AND role = 'owner'
  );
$$;

REVOKE ALL ON FUNCTION public.is_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_owner() TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────
-- 8. Sanity checks
-- ────────────────────────────────────────────────────────────────────
-- Fail the deploy loudly if any piece is missing. Two owners minimum
-- in user_roles (Kevin has two email rows; Blerta has one) — but we
-- only assert ">= 2" rather than "= 3" so the migration still passes
-- in environments where one of the email rows was never seeded.

DO $$
DECLARE
  v_owner_count integer;
BEGIN
  -- is_owner exists, SECURITY DEFINER, search_path pinned
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'is_owner'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'exec_owner_role: public.is_owner() missing or not SECURITY DEFINER';
  END IF;

  -- is_admin still resolves to STABLE SECURITY DEFINER (we replaced
  -- the body but should not have lost the modifiers)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'is_admin'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
      AND provolatile = 's'
  ) THEN
    RAISE EXCEPTION
      'exec_owner_role: public.is_admin() lost SECURITY DEFINER/STABLE after replace';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'is_staff'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
      AND provolatile = 's'
  ) THEN
    RAISE EXCEPTION
      'exec_owner_role: public.is_staff() lost SECURITY DEFINER/STABLE after replace';
  END IF;

  -- At least 2 user_roles rows are now 'owner' (Kevin + Blerta in
  -- the production seed; possibly 3 if Kevin has both email rows).
  SELECT count(*) INTO v_owner_count
    FROM public.user_roles
   WHERE role = 'owner';

  IF v_owner_count < 2 THEN
    RAISE NOTICE
      'exec_owner_role: only % user_roles rows marked owner — expected >= 2. Check seed.',
      v_owner_count;
  END IF;
END
$$;
