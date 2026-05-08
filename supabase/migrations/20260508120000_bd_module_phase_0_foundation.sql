-- BD Module Phase 0 — foundation schema.
--
-- Adds the data model for the new business development module:
--   - bd_accounts: referral source organizations (hospitals, SNFs, ALFs,
--     professional offices) that the BD rep cultivates.
--   - bd_account_contacts: people at those accounts (discharge planners,
--     case managers, principals, etc).
--   - bd_activities: visit, call, email, drop-off, event, and
--     referral-received entries. Activities will also be mirrored onto
--     the events bus from the application layer (Phase 1) so the AI
--     context layer sees them.
--   - bd_referrals: first-class referral records linking an account +
--     contact to a client lead, with conversion outcomes (assessment
--     scheduled, SOC, lost) and loss reasons for funnel analytics.
--   - bd_goals: per-rep weekly/monthly targets for visits, referrals,
--     and starts of care. Effective-dated so the trajectory is data,
--     not code.
--   - bd_trello_import_staging: temp landing zone for the Trello board
--     import. Idempotent — re-running the import upserts by external
--     id without re-fetching from Trello.
--
-- Phase 0 is schema-only: tables exist, RLS enforced, but no UI or
-- writes from the application yet. Phase 1 wires the import script and
-- the rep's mobile surfaces. See docs/BD_MODULE.md for full scope and
-- the three-horizon roadmap.
--
-- Tenant isolation:
--   Per the SaaS retrofit Phase B locked decisions
--   (docs/SAAS_RETROFIT.md → "Decisions locked", PR #237), every new
--   table:
--     1. Has org_id uuid NOT NULL DEFAULT public.default_org_id()
--        REFERENCES organizations(id).
--     2. Has an index on org_id.
--     3. Carries four permissive `tenant_isolation_<table>_<command>`
--        policies. Predicate is fail-closed:
--        org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
--     4. Carries a `service_role_full_access_<table>` policy so cron
--        jobs and the Trello import edge function can write via the
--        service role.
--
-- Production safety: all CREATE / ALTER / CREATE POLICY statements are
-- guarded with IF NOT EXISTS or DROP ... IF EXISTS so the deploy
-- workflow (`supabase db push --include-all`) can replay this migration
-- safely. No data is touched on existing tables. Rollback at
-- _rollback/20260508120000_bd_module_phase_0_foundation_down.sql.
--
-- Plan reference:
--   docs/BD_MODULE.md (this is the Phase 0 migration in that doc)
--   CLAUDE.md → "Strategic Context: Becoming Multi-Tenant SaaS"

-- ─────────────────────────────────────────────────────────────────
-- 1. bd_accounts
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bd_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL DEFAULT public.default_org_id()
                          REFERENCES organizations(id) ON DELETE RESTRICT,
  name                  text NOT NULL,
  account_type          text NOT NULL
                          CHECK (account_type IN ('facility', 'professional')),
  -- Subtype is constrained but extensible; lookup tables can land
  -- later if values stabilize. 'other' is the catch-all for the
  -- import classifier when it's unsure.
  facility_subtype      text
                          CHECK (facility_subtype IS NULL OR facility_subtype IN (
                            'hospital', 'snf', 'alf', 'independent_living',
                            'memory_care', 'rehab', 'hospice', 'home_health',
                            'other'
                          )),
  professional_subtype  text
                          CHECK (professional_subtype IS NULL OR professional_subtype IN (
                            'gcm', 'attorney', 'financial_planner',
                            'physician', 'social_worker', 'other'
                          )),
  -- Address & geocoding. lat/lng populated by Google Places lookup
  -- when seeded; nullable because Trello-imported accounts may lack
  -- complete addresses.
  address               text,
  city                  text,
  state                 text,
  zip                   text,
  lat                   numeric(9,6),
  lng                   numeric(9,6),
  phone                 text,
  website               text,
  notes                 text,
  is_active             boolean NOT NULL DEFAULT true,
  -- Out-of-territory accounts are still tracked but excluded from
  -- cold-list and goal calculations (when territory is enabled).
  -- BD_MODULE.md round 5: territory deferred — default false for now.
  out_of_territory      boolean NOT NULL DEFAULT false,
  -- Provenance markers — null when manually created.
  trello_card_id        text,
  google_places_id      text,
  -- Helper for the briefing engine. Recomputed when activities are
  -- written; stored to avoid recalculating in every query.
  last_activity_at      timestamptz,
  -- Owner curation override for the A/B/C tier surfaced in the rep's
  -- main view. NULL = let the briefing engine compute from recency
  -- and signal density.
  tier_override         text
                          CHECK (tier_override IS NULL OR tier_override IN ('A', 'B', 'C')),
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bd_accounts_org
  ON bd_accounts (org_id);

CREATE INDEX IF NOT EXISTS idx_bd_accounts_org_active
  ON bd_accounts (org_id, is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_bd_accounts_org_last_activity
  ON bd_accounts (org_id, last_activity_at DESC NULLS LAST);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bd_accounts_org_trello_card
  ON bd_accounts (org_id, trello_card_id)
  WHERE trello_card_id IS NOT NULL;

ALTER TABLE bd_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_bd_accounts_select" ON bd_accounts;
CREATE POLICY "tenant_isolation_bd_accounts_select"
  ON bd_accounts FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_accounts_insert" ON bd_accounts;
CREATE POLICY "tenant_isolation_bd_accounts_insert"
  ON bd_accounts FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_accounts_update" ON bd_accounts;
CREATE POLICY "tenant_isolation_bd_accounts_update"
  ON bd_accounts FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_accounts_delete" ON bd_accounts;
CREATE POLICY "tenant_isolation_bd_accounts_delete"
  ON bd_accounts FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "service_role_full_access_bd_accounts" ON bd_accounts;
CREATE POLICY "service_role_full_access_bd_accounts"
  ON bd_accounts FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────
-- 2. bd_account_contacts
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bd_account_contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL DEFAULT public.default_org_id()
                      REFERENCES organizations(id) ON DELETE RESTRICT,
  account_id        uuid NOT NULL REFERENCES bd_accounts(id) ON DELETE CASCADE,
  name              text NOT NULL,
  title             text,
  -- Role taxonomy: facility-side discharge roles + professional-side.
  -- 'other' is the catch-all; lookup table can land later.
  role              text
                      CHECK (role IS NULL OR role IN (
                        'discharge_planner', 'case_manager', 'social_worker',
                        'admissions', 'ed_director', 'administrator',
                        'principal', 'physician', 'gcm', 'attorney',
                        'financial_planner', 'office_manager', 'other'
                      )),
  email             text,
  phone_mobile      text,
  phone_office      text,
  notes             text,
  birthday          date,
  is_primary        boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  -- Provenance — Trello cards may identify members or be free-text
  -- mentions. The import classifier writes whichever is available.
  trello_member_id  text,
  last_activity_at  timestamptz,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bd_account_contacts_org
  ON bd_account_contacts (org_id);

CREATE INDEX IF NOT EXISTS idx_bd_account_contacts_account
  ON bd_account_contacts (account_id);

CREATE INDEX IF NOT EXISTS idx_bd_account_contacts_org_role
  ON bd_account_contacts (org_id, role)
  WHERE role IS NOT NULL;

ALTER TABLE bd_account_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_bd_account_contacts_select" ON bd_account_contacts;
CREATE POLICY "tenant_isolation_bd_account_contacts_select"
  ON bd_account_contacts FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_account_contacts_insert" ON bd_account_contacts;
CREATE POLICY "tenant_isolation_bd_account_contacts_insert"
  ON bd_account_contacts FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_account_contacts_update" ON bd_account_contacts;
CREATE POLICY "tenant_isolation_bd_account_contacts_update"
  ON bd_account_contacts FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_account_contacts_delete" ON bd_account_contacts;
CREATE POLICY "tenant_isolation_bd_account_contacts_delete"
  ON bd_account_contacts FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "service_role_full_access_bd_account_contacts" ON bd_account_contacts;
CREATE POLICY "service_role_full_access_bd_account_contacts"
  ON bd_account_contacts FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────
-- 3. bd_activities
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bd_activities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL DEFAULT public.default_org_id()
                          REFERENCES organizations(id) ON DELETE RESTRICT,
  account_id            uuid NOT NULL REFERENCES bd_accounts(id) ON DELETE CASCADE,
  contact_id            uuid REFERENCES bd_account_contacts(id) ON DELETE SET NULL,
  activity_type         text NOT NULL
                          CHECK (activity_type IN (
                            'visit', 'call', 'email', 'sms', 'drop_off',
                            'event', 'referral_received', 'note'
                          )),
  occurred_at           timestamptz NOT NULL,
  duration_minutes      int CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  -- Spend tracking for Anti-Kickback compliance. Cents to avoid float
  -- rounding. spend_category null when spend_cents = 0.
  spend_cents           int NOT NULL DEFAULT 0 CHECK (spend_cents >= 0),
  spend_category        text
                          CHECK (spend_category IS NULL OR spend_category IN (
                            'meal', 'gift', 'swag', 'event', 'other'
                          )),
  notes                 text,
  voice_memo_url        text,
  voice_memo_transcript text,
  photos                jsonb NOT NULL DEFAULT '[]'::jsonb,
  gps_lat               numeric(9,6),
  gps_lng               numeric(9,6),
  -- Where this row came from. 'manual' = rep typed it; 'voice_memo' =
  -- transcribed; 'email_auto' = O365 inbox sync; 'calendar_sync' =
  -- Microsoft Bookings; 'trello_import' = imported from the Trello
  -- board (with the original card date as occurred_at).
  source                text NOT NULL DEFAULT 'manual'
                          CHECK (source IN (
                            'manual', 'voice_memo', 'email_auto',
                            'calendar_sync', 'trello_import'
                          )),
  -- Dedup keys. trello_action_id is the Trello action UUID; null when
  -- not from Trello. Email message ID for email_auto. Calendar event
  -- ID for calendar_sync. Globally unique across the table when
  -- present.
  trello_action_id      text,
  external_message_id   text,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bd_activities_org
  ON bd_activities (org_id);

CREATE INDEX IF NOT EXISTS idx_bd_activities_account_occurred
  ON bd_activities (account_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_bd_activities_org_occurred
  ON bd_activities (org_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_bd_activities_contact_occurred
  ON bd_activities (contact_id, occurred_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bd_activities_trello_action
  ON bd_activities (trello_action_id)
  WHERE trello_action_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bd_activities_external_message
  ON bd_activities (external_message_id)
  WHERE external_message_id IS NOT NULL;

ALTER TABLE bd_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_bd_activities_select" ON bd_activities;
CREATE POLICY "tenant_isolation_bd_activities_select"
  ON bd_activities FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_activities_insert" ON bd_activities;
CREATE POLICY "tenant_isolation_bd_activities_insert"
  ON bd_activities FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_activities_update" ON bd_activities;
CREATE POLICY "tenant_isolation_bd_activities_update"
  ON bd_activities FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_activities_delete" ON bd_activities;
CREATE POLICY "tenant_isolation_bd_activities_delete"
  ON bd_activities FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "service_role_full_access_bd_activities" ON bd_activities;
CREATE POLICY "service_role_full_access_bd_activities"
  ON bd_activities FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────
-- 4. bd_referrals
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bd_referrals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL DEFAULT public.default_org_id()
                          REFERENCES organizations(id) ON DELETE RESTRICT,
  account_id            uuid NOT NULL REFERENCES bd_accounts(id) ON DELETE RESTRICT,
  contact_id            uuid REFERENCES bd_account_contacts(id) ON DELETE SET NULL,
  -- client_id is text to match clients.id (also text). Nullable because
  -- a referral may be logged before the corresponding client lead is
  -- created in the clients table; the application backfills this when
  -- the client record is created.
  client_id             text REFERENCES clients(id) ON DELETE SET NULL,
  referred_at           timestamptz NOT NULL DEFAULT now(),
  -- Initial info captured from the referrer before client record
  -- exists. Promoted to the clients row at creation time.
  prospective_name      text,
  prospective_phone     text,
  prospective_notes     text,
  status                text NOT NULL DEFAULT 'new'
                          CHECK (status IN (
                            'new', 'assessment_scheduled',
                            'assessment_complete', 'soc', 'lost'
                          )),
  -- Loss-reason analytics. Required when status = 'lost'; null
  -- otherwise. Free-text detail captures specifics for AI analysis.
  loss_reason           text
                          CHECK (loss_reason IS NULL OR loss_reason IN (
                            'insurance_denied', 'chose_other_agency',
                            'patient_passed', 'did_not_qualify',
                            'lost_contact', 'cost', 'other'
                          )),
  loss_reason_detail    text,
  -- Role-based handoff for future intake/care-coordinator split.
  -- Default 'bd_rep' today; flip to 'care_coordinator' or
  -- 'intake_coordinator' when the role is added without code change.
  assigned_to           text NOT NULL DEFAULT 'bd_rep',
  -- Timeline markers for the funnel report.
  assessment_scheduled_at timestamptz,
  assessment_completed_at timestamptz,
  soc_at                  timestamptz,
  lost_at                 timestamptz,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Loss-reason / lost_at consistency. We allow status = 'lost' AND
  -- loss_reason still null (rep hasn't entered the why yet) to avoid
  -- blocking the status change. The funnel report flags lost-without-
  -- reason as a UI prompt.
  CONSTRAINT bd_referrals_lost_at_when_lost CHECK (
    (status = 'lost') = (lost_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_bd_referrals_org
  ON bd_referrals (org_id);

CREATE INDEX IF NOT EXISTS idx_bd_referrals_account_referred
  ON bd_referrals (account_id, referred_at DESC);

CREATE INDEX IF NOT EXISTS idx_bd_referrals_org_status
  ON bd_referrals (org_id, status);

CREATE INDEX IF NOT EXISTS idx_bd_referrals_client
  ON bd_referrals (client_id)
  WHERE client_id IS NOT NULL;

ALTER TABLE bd_referrals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_bd_referrals_select" ON bd_referrals;
CREATE POLICY "tenant_isolation_bd_referrals_select"
  ON bd_referrals FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_referrals_insert" ON bd_referrals;
CREATE POLICY "tenant_isolation_bd_referrals_insert"
  ON bd_referrals FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_referrals_update" ON bd_referrals;
CREATE POLICY "tenant_isolation_bd_referrals_update"
  ON bd_referrals FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_referrals_delete" ON bd_referrals;
CREATE POLICY "tenant_isolation_bd_referrals_delete"
  ON bd_referrals FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "service_role_full_access_bd_referrals" ON bd_referrals;
CREATE POLICY "service_role_full_access_bd_referrals"
  ON bd_referrals FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────
-- 5. bd_goals
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bd_goals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL DEFAULT public.default_org_id()
                        REFERENCES organizations(id) ON DELETE RESTRICT,
  -- Per-rep goal. Email matches team_members.email; not a hard FK
  -- because goals can outlive a team member's row. Application layer
  -- enforces existence at write time.
  assignee_email      text NOT NULL,
  period              text NOT NULL CHECK (period IN ('weekly', 'monthly')),
  visits_target       int CHECK (visits_target IS NULL OR visits_target >= 0),
  referrals_target    int CHECK (referrals_target IS NULL OR referrals_target >= 0),
  soc_target          int CHECK (soc_target IS NULL OR soc_target >= 0),
  effective_from      date NOT NULL,
  effective_to        date,
  notes               text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bd_goals_effective_range CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);

CREATE INDEX IF NOT EXISTS idx_bd_goals_org_assignee
  ON bd_goals (org_id, assignee_email);

CREATE INDEX IF NOT EXISTS idx_bd_goals_org_effective
  ON bd_goals (org_id, effective_from DESC);

ALTER TABLE bd_goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_bd_goals_select" ON bd_goals;
CREATE POLICY "tenant_isolation_bd_goals_select"
  ON bd_goals FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_goals_insert" ON bd_goals;
CREATE POLICY "tenant_isolation_bd_goals_insert"
  ON bd_goals FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_goals_update" ON bd_goals;
CREATE POLICY "tenant_isolation_bd_goals_update"
  ON bd_goals FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_goals_delete" ON bd_goals;
CREATE POLICY "tenant_isolation_bd_goals_delete"
  ON bd_goals FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "service_role_full_access_bd_goals" ON bd_goals;
CREATE POLICY "service_role_full_access_bd_goals"
  ON bd_goals FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────
-- 6. bd_trello_import_staging
-- ─────────────────────────────────────────────────────────────────
--
-- Raw Trello payloads land here before the AI extraction pass. Each
-- row is one Trello card or action keyed by its native Trello id.
-- Idempotent on (org_id, kind, trello_id) — re-running the import
-- upserts without re-fetching. Once stratification is approved by
-- the owner, downstream loaders write into bd_accounts /
-- bd_account_contacts / bd_activities and mark the staging row
-- processed_at = now(). Untouched records can sit indefinitely; a
-- future cleanup migration can drop the table once the import is
-- fully complete.

CREATE TABLE IF NOT EXISTS bd_trello_import_staging (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL DEFAULT public.default_org_id()
                        REFERENCES organizations(id) ON DELETE RESTRICT,
  kind                text NOT NULL CHECK (kind IN ('board', 'list', 'card', 'action', 'member')),
  trello_id           text NOT NULL,
  trello_board_id     text,
  raw_payload         jsonb NOT NULL,
  -- AI-extracted structured view of this row. Null until the
  -- extractor runs; populated by the import pipeline.
  extracted_payload   jsonb,
  proposed_tier       text CHECK (proposed_tier IS NULL OR proposed_tier IN ('A', 'B', 'C')),
  -- Loaders set this when the row has been promoted into the
  -- live tables (bd_accounts / bd_activities / bd_account_contacts).
  processed_at        timestamptz,
  -- Free-form note from the owner during the review pass — e.g.
  -- "this is actually personal, skip" or "merge with X".
  reviewer_note       text,
  reviewer_decision   text CHECK (reviewer_decision IS NULL OR reviewer_decision IN (
                        'accept', 'skip', 'merge', 'reclassify'
                      )),
  reviewed_at         timestamptz,
  reviewed_by         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bd_trello_import_staging_unique
    UNIQUE (org_id, kind, trello_id)
);

CREATE INDEX IF NOT EXISTS idx_bd_trello_import_staging_org_kind
  ON bd_trello_import_staging (org_id, kind);

CREATE INDEX IF NOT EXISTS idx_bd_trello_import_staging_unprocessed
  ON bd_trello_import_staging (org_id)
  WHERE processed_at IS NULL;

ALTER TABLE bd_trello_import_staging ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_bd_trello_import_staging_select" ON bd_trello_import_staging;
CREATE POLICY "tenant_isolation_bd_trello_import_staging_select"
  ON bd_trello_import_staging FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_trello_import_staging_insert" ON bd_trello_import_staging;
CREATE POLICY "tenant_isolation_bd_trello_import_staging_insert"
  ON bd_trello_import_staging FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_trello_import_staging_update" ON bd_trello_import_staging;
CREATE POLICY "tenant_isolation_bd_trello_import_staging_update"
  ON bd_trello_import_staging FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_trello_import_staging_delete" ON bd_trello_import_staging;
CREATE POLICY "tenant_isolation_bd_trello_import_staging_delete"
  ON bd_trello_import_staging FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "service_role_full_access_bd_trello_import_staging" ON bd_trello_import_staging;
CREATE POLICY "service_role_full_access_bd_trello_import_staging"
  ON bd_trello_import_staging FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────
-- 7. updated_at triggers
-- ─────────────────────────────────────────────────────────────────
--
-- Keep updated_at fresh on UPDATE without requiring callers to set it.
-- Reuses the existing public.touch_updated_at() function (defined in
-- 20260419010000_care_plan_schema.sql); guarded with DROP TRIGGER
-- IF EXISTS so re-running this migration is safe.

DROP TRIGGER IF EXISTS bd_accounts_set_updated_at ON bd_accounts;
CREATE TRIGGER bd_accounts_set_updated_at
  BEFORE UPDATE ON bd_accounts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS bd_account_contacts_set_updated_at ON bd_account_contacts;
CREATE TRIGGER bd_account_contacts_set_updated_at
  BEFORE UPDATE ON bd_account_contacts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS bd_activities_set_updated_at ON bd_activities;
CREATE TRIGGER bd_activities_set_updated_at
  BEFORE UPDATE ON bd_activities
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS bd_referrals_set_updated_at ON bd_referrals;
CREATE TRIGGER bd_referrals_set_updated_at
  BEFORE UPDATE ON bd_referrals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS bd_goals_set_updated_at ON bd_goals;
CREATE TRIGGER bd_goals_set_updated_at
  BEFORE UPDATE ON bd_goals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS bd_trello_import_staging_set_updated_at ON bd_trello_import_staging;
CREATE TRIGGER bd_trello_import_staging_set_updated_at
  BEFORE UPDATE ON bd_trello_import_staging
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
