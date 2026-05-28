-- ═══════════════════════════════════════════════════════════════
-- Executive Task Management — Phase 1 PR 1, Migration 2 of 4
--
-- staff_members: the team directory the exec module needs to
-- anchor lifecycle tasks (30/60/90 check-ins, anniversary reviews,
-- license-renewal reminders) to specific people with hire dates.
--
-- Why a new table and not org_memberships:
--   org_memberships is auth metadata (user_id + role + org_id). It
--   does not have hire_date, role_title, manager, end_date, or
--   inactive-vs-active tracking. Conflating HR data into the auth
--   table makes both messier and complicates the eventual SSO/SCIM
--   path.
--
-- Why a new table and not user_roles:
--   user_roles is a flat email → role map for RLS gating. Adding
--   HR columns there pollutes a security-critical surface.
--
-- Linkage to user_roles / org_memberships:
--   staff_members.email is the join key. It can exist for someone
--   who has not yet been issued a portal login (a new hire we want
--   to start the 30-day clock on before their first sign-in), and
--   conversely user_roles can have rows without a staff_members
--   counterpart (e.g. founders who don't want a HR record). This
--   is by design — the exec module only generates lifecycle tasks
--   for people who have a staff_members row.
--
-- RLS posture:
--   - SELECT: any staff (admin/member/owner) — the team list is
--     not sensitive and gets surfaced in pickers, assignee menus,
--     org chart views.
--   - INSERT/UPDATE/DELETE: owners only — HR-grade data, edits
--     should be deliberate.
--
-- Backfill: Kevin + Blerta only, with a 2020-01-01 placeholder
-- hire date. They edit to the correct date through the UI in
-- Phase 3. Chris and others get added by an owner through the UI;
-- we do not bulk-create rows from user_roles because we don't know
-- their hire dates.
--
-- Multi-tenancy discipline: org_id NOT NULL with FK + RLS scoping
-- per the CLAUDE.md prime directives, even though the SaaS retrofit
-- is paused.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1. staff_members table
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
  email           text NOT NULL,
  first_name      text NOT NULL,
  last_name       text,
  role_title      text,
  manager_email   text,
  hire_date       date NOT NULL,
  end_date        date,
  active          boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email),
  -- end_date must come after hire_date when present
  CHECK (end_date IS NULL OR end_date >= hire_date)
);

-- Hot paths:
--   • "list everyone on the team"           → idx_staff_members_org_active
--   • "lifecycle task generator scan"       → idx_staff_members_hire_date
--     (filters active members whose hire_date matches a + offset
--     calculation for each template — keeping it composite avoids a
--     second index for the common active=true filter)
CREATE INDEX IF NOT EXISTS idx_staff_members_org_active
  ON public.staff_members (org_id, active)
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_staff_members_hire_date
  ON public.staff_members (org_id, hire_date)
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_staff_members_manager
  ON public.staff_members (org_id, manager_email)
  WHERE manager_email IS NOT NULL;

DROP TRIGGER IF EXISTS staff_members_touch_updated_at ON public.staff_members;
CREATE TRIGGER staff_members_touch_updated_at
  BEFORE UPDATE ON public.staff_members
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 2. RLS — staff read, owner write
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.staff_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_members_staff_select ON public.staff_members;
DROP POLICY IF EXISTS staff_members_owner_insert ON public.staff_members;
DROP POLICY IF EXISTS staff_members_owner_update ON public.staff_members;
DROP POLICY IF EXISTS staff_members_owner_delete ON public.staff_members;

CREATE POLICY staff_members_staff_select ON public.staff_members
  FOR SELECT TO authenticated
  USING (public.is_staff() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

CREATE POLICY staff_members_owner_insert ON public.staff_members
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

CREATE POLICY staff_members_owner_update ON public.staff_members
  FOR UPDATE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid)
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

CREATE POLICY staff_members_owner_delete ON public.staff_members
  FOR DELETE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

-- ────────────────────────────────────────────────────────────────────
-- 3. Seed Kevin + Blerta
-- ────────────────────────────────────────────────────────────────────
-- Placeholder hire_date = 2020-01-01 (they edit to actual dates in
-- the UI before turning on any lifecycle templates). ON CONFLICT
-- DO NOTHING so re-running the migration after they've edited
-- doesn't clobber their corrections.
--
-- Email uses the lower-cased work address as the canonical key, so
-- assignment menus elsewhere can join on lower(email) → user_roles
-- predictably.

INSERT INTO public.staff_members
  (org_id, email, first_name, last_name, role_title, hire_date, active, notes)
SELECT
  public.default_org_id(),
  'kevinnash@tremendouscareca.com',
  'Kevin', 'Nash', 'Owner',
  '2020-01-01'::date,
  true,
  'Auto-seeded by exec_staff_members migration; edit hire_date through Settings → Staff.'
WHERE public.default_org_id() IS NOT NULL
ON CONFLICT (org_id, email) DO NOTHING;

INSERT INTO public.staff_members
  (org_id, email, first_name, last_name, role_title, hire_date, active, notes)
SELECT
  public.default_org_id(),
  'blertanash@tremendouscareca.com',
  'Blerta', 'Nash', 'Owner',
  '2020-01-01'::date,
  true,
  'Auto-seeded by exec_staff_members migration; edit hire_date through Settings → Staff.'
WHERE public.default_org_id() IS NOT NULL
ON CONFLICT (org_id, email) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- 4. Sanity check
-- ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seed_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'staff_members'
  ) THEN
    RAISE EXCEPTION 'exec_staff_members: staff_members table missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'staff_members' AND p.polname = 'staff_members_owner_insert'
  ) THEN
    RAISE EXCEPTION 'exec_staff_members: owner_insert policy missing after migration';
  END IF;

  IF public.default_org_id() IS NOT NULL THEN
    SELECT count(*) INTO v_seed_count
      FROM public.staff_members
     WHERE org_id = public.default_org_id()
       AND lower(email) IN ('kevinnash@tremendouscareca.com',
                            'blertanash@tremendouscareca.com');
    IF v_seed_count < 2 THEN
      RAISE NOTICE
        'exec_staff_members: only % seeded staff (kevin/blerta) — expected 2',
        v_seed_count;
    END IF;
  END IF;
END
$$;
