-- Promotes Emergency Contacts and Responsible Parties from
-- care_plan_versions.data JSONB to first-class, queryable tables.
--
-- Office-coordinator feedback (Juliana, 2026-05-22):
--   #6 — "Add a dedicated Emergency Contact section during client setup
--         with clearly labeled contact hierarchy (Primary, Secondary,
--         Additional)."
--   #7 — "During initial client setup, include an option to immediately
--         assign a Responsible Party and designate them as the main
--         point of contact for scheduling, billing, and care
--         communication."
--
-- Today both lives only inside `care_plan_versions.data` JSONB
-- (src/features/care-plans/sections.js: rpPrimary_*, rpSecondary_*,
-- emergencyContacts). That means:
--   • office staff has to build a care plan before any emergency
--     contact is on file — operationally unsafe
--   • the same data is re-keyed at intake and again in the care plan
--     editor (the "duplicate entry" complaint)
--   • outbound SMS / billing flows cannot query for the right phone
--     number without unpacking JSONB
--
-- This migration creates the tables only. AddClient.jsx writes to them
-- starting in the same PR. A follow-up PR will:
--   (a) reconcile the care plan editor to read from these tables
--   (b) backfill any existing JSONB emergency contacts / RPs into the
--       new tables for existing clients
--   (c) deprecate the JSONB fields once parity is verified
--
-- Multi-tenancy compliance (CLAUDE.md → Prime Directives):
--   • Both tables carry NOT NULL org_id DEFAULT public.default_org_id()
--     REFERENCES public.organizations(id) ON DELETE CASCADE.
--   • RLS policies gate on public.is_staff() + tenant org match — no
--     inline EXISTS subqueries (docs/RLS_GOTCHAS.md).
--   • Pure additive: no DROP, no DELETE, no column type changes.
--
-- Idempotency: every CREATE / DROP POLICY uses IF [NOT] EXISTS so the
-- Deploy Database Migrations workflow can re-run this safely.

-- ────────────────────────────────────────────────────────────────────
-- 1. client_emergency_contacts
-- ────────────────────────────────────────────────────────────────────
-- One row per emergency contact (non-RP family/friends/neighbors who
-- can help in a pinch). `priority` is the call order: 1 = first to
-- ring, 2 = second, etc. The (client_id, priority) index keeps
-- queries cheap. The office surfaces these in call order on the
-- client detail page.

CREATE TABLE IF NOT EXISTS public.client_emergency_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id       text NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  priority        integer NOT NULL DEFAULT 1
                    CHECK (priority >= 1),
  name            text NOT NULL,
  relationship    text,
  phone           text NOT NULL,
  alt_phone       text,
  email           text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_emergency_contacts_client
  ON public.client_emergency_contacts (client_id, priority);
CREATE INDEX IF NOT EXISTS idx_client_emergency_contacts_org
  ON public.client_emergency_contacts (org_id);

DROP TRIGGER IF EXISTS client_emergency_contacts_touch_updated_at
  ON public.client_emergency_contacts;
CREATE TRIGGER client_emergency_contacts_touch_updated_at
  BEFORE UPDATE ON public.client_emergency_contacts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 2. client_responsible_parties
-- ────────────────────────────────────────────────────────────────────
-- One row per responsible party. `rank` is 'primary' or 'secondary';
-- the UNIQUE (client_id, rank) constraint enforces "one primary, one
-- secondary" per client (matches the existing rpPrimary_* /
-- rpSecondary_* convention in sections.js).
--
-- `contact_for` mirrors the existing MULTISELECT in sections.js
-- (Care concerns, Care decisions, Billing, Scheduling, Other) — kept
-- as a text[] rather than a CHECK so the office can extend the
-- options later without a migration.
--
-- `is_main_point_of_contact` formalises feedback item #7: "designate
-- them as the main point of contact for scheduling, billing, and care
-- communication." A partial unique index ensures only one RP per
-- client can hold the flag at a time.

CREATE TABLE IF NOT EXISTS public.client_responsible_parties (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      uuid NOT NULL DEFAULT public.default_org_id()
                                REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id                   text NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  rank                        text NOT NULL
                                CHECK (rank IN ('primary', 'secondary')),
  name                        text NOT NULL,
  relationship                text,
  phone                       text,
  email                       text,
  contact_for                 text[] NOT NULL DEFAULT '{}'::text[],
  hipaa_on_file               boolean NOT NULL DEFAULT false,
  financial_poa               boolean NOT NULL DEFAULT false,
  healthcare_poa              boolean NOT NULL DEFAULT false,
  is_main_point_of_contact    boolean NOT NULL DEFAULT false,
  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, rank)
);

CREATE INDEX IF NOT EXISTS idx_client_responsible_parties_client
  ON public.client_responsible_parties (client_id);
CREATE INDEX IF NOT EXISTS idx_client_responsible_parties_org
  ON public.client_responsible_parties (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_main_point_of_contact
  ON public.client_responsible_parties (client_id)
  WHERE is_main_point_of_contact;

DROP TRIGGER IF EXISTS client_responsible_parties_touch_updated_at
  ON public.client_responsible_parties;
CREATE TRIGGER client_responsible_parties_touch_updated_at
  BEFORE UPDATE ON public.client_responsible_parties
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 3. RLS — staff full CRUD, org-scoped
-- ────────────────────────────────────────────────────────────────────
-- Office staff (admin OR member) need full CRUD because emergency
-- contacts and responsible parties are captured during client intake,
-- which is a member-role workflow today (the parent `clients` table
-- itself is currently `auth.role() = 'authenticated'`-permissive, so
-- gating contacts on admin-only would be a regression that breaks
-- intake for member-role users — including most of the office team).
--
-- Caregivers (the third role) must NOT see contact details directly;
-- they consume them through curated client profile views that already
-- filter by current_user_caregiver_id() upstream.
--
-- The public.is_staff() helper is SECURITY DEFINER and will not trip
-- the policy-recursion detector (docs/RLS_GOTCHAS.md).

ALTER TABLE public.client_emergency_contacts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_responsible_parties   ENABLE ROW LEVEL SECURITY;

-- client_emergency_contacts -------------------------------------------------

DROP POLICY IF EXISTS client_emergency_contacts_staff_select
  ON public.client_emergency_contacts;
CREATE POLICY client_emergency_contacts_staff_select
  ON public.client_emergency_contacts
  FOR SELECT
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

DROP POLICY IF EXISTS client_emergency_contacts_staff_insert
  ON public.client_emergency_contacts;
CREATE POLICY client_emergency_contacts_staff_insert
  ON public.client_emergency_contacts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

DROP POLICY IF EXISTS client_emergency_contacts_staff_update
  ON public.client_emergency_contacts;
CREATE POLICY client_emergency_contacts_staff_update
  ON public.client_emergency_contacts
  FOR UPDATE
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  )
  WITH CHECK (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

DROP POLICY IF EXISTS client_emergency_contacts_staff_delete
  ON public.client_emergency_contacts;
CREATE POLICY client_emergency_contacts_staff_delete
  ON public.client_emergency_contacts
  FOR DELETE
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

-- client_responsible_parties ------------------------------------------------

DROP POLICY IF EXISTS client_responsible_parties_staff_select
  ON public.client_responsible_parties;
CREATE POLICY client_responsible_parties_staff_select
  ON public.client_responsible_parties
  FOR SELECT
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

DROP POLICY IF EXISTS client_responsible_parties_staff_insert
  ON public.client_responsible_parties;
CREATE POLICY client_responsible_parties_staff_insert
  ON public.client_responsible_parties
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

DROP POLICY IF EXISTS client_responsible_parties_staff_update
  ON public.client_responsible_parties;
CREATE POLICY client_responsible_parties_staff_update
  ON public.client_responsible_parties
  FOR UPDATE
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  )
  WITH CHECK (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

DROP POLICY IF EXISTS client_responsible_parties_staff_delete
  ON public.client_responsible_parties;
CREATE POLICY client_responsible_parties_staff_delete
  ON public.client_responsible_parties
  FOR DELETE
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

-- ────────────────────────────────────────────────────────────────────
-- 4. Realtime
-- ────────────────────────────────────────────────────────────────────
-- The intake form does not need realtime, but the client detail page
-- (rendered after intake redirects) reloads contacts from the table,
-- and the broader portal benefits from instant updates when office
-- staff edits a phone number on one tab and a caregiver looks it up
-- on another. Both tables are tiny, so the realtime cost is trivial.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'client_emergency_contacts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.client_emergency_contacts;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'client_responsible_parties'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.client_responsible_parties;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- 5. Sanity check
-- ────────────────────────────────────────────────────────────────────
-- Fail loudly if a future hand-edit drops one of the tables. Catches
-- accidental DROP TABLE in a future PR (e.g. someone consolidates
-- contacts and removes the wrong one).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('client_emergency_contacts', 'client_responsible_parties')
    GROUP BY table_schema
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'client contacts migration: one or both target tables missing after migration';
  END IF;
END $$;
