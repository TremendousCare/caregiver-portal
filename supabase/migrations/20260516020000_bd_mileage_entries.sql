-- BD Module — bd_mileage_entries (per-rep IRS-substantiated mileage log)
--
-- Adds the data model for the BD portal's mileage tracker. A rep
-- driving to a referral source can log the trip — odometer readings
-- or a manually entered mile count — plus the business purpose, the
-- date, and (optionally) a link to the bd_account / bd_activity that
-- explains *why* they were on the road. Each entry captures the
-- reimbursement rate in effect *at submit time* so a future rate
-- change doesn't retroactively reprice old trips.
--
-- v1 scope (this migration):
--   * Schema only. UI ships in the same PR but does not write any
--     approval/reimbursement state — only `draft` and `submitted`
--     statuses are exercised. The forward-compat statuses
--     ('approved', 'rejected', 'paid') and the approver/paid columns
--     exist so the next PR (admin approval queue) is purely additive
--     application logic without another migration.
--   * Reps see only their own entries (RLS pattern mirrors
--     bd_account_stars: personal-private, single-leaf predicate).
--     Admin visibility for the approval queue ships in a follow-up
--     PR alongside the is_bd_admin() helper.
--
-- Tenant isolation:
--   Per the SaaS retrofit Phase B locked decisions
--   (docs/SAAS_RETROFIT.md → "Decisions locked", PRs #218 / #236 /
--   #237). Every new table:
--     1. org_id uuid NOT NULL DEFAULT public.default_org_id()
--        REFERENCES organizations(id).
--     2. Index on org_id.
--     3. Permissive `tenant_isolation_<table>_<command>` policies
--        with the strict / fail-closed predicate
--        org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid.
--     4. A `service_role_full_access_<table>` policy so cron jobs,
--        backfills, and admin tooling can write via service_role.
--
-- RLS posture:
--   Personal-private (same as bd_account_stars). SELECT / INSERT /
--   UPDATE / DELETE all require `user_id = auth.uid()` AND the
--   org_id match. The single-leaf predicate avoids the recursion
--   class of bug documented in docs/RLS_GOTCHAS.md — there are no
--   subqueries into other tables.
--
-- Production safety: pure additive. CREATE TABLE IF NOT EXISTS,
-- every index guarded with IF NOT EXISTS, every policy DROP-then-
-- CREATE so re-running this migration via the deploy workflow
-- (`supabase db push --include-all`) is safe. No data is touched on
-- existing tables. Rollback at
-- _rollback/20260516020000_bd_mileage_entries_down.sql.

CREATE TABLE IF NOT EXISTS bd_mileage_entries (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant + ownership.
  org_id                  uuid NOT NULL DEFAULT public.default_org_id()
                            REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- When the trip happened. trip_date is the IRS-substantiation
  -- field (Pub 463: "date of trip"). started_at / ended_at are
  -- optional precise timestamps for trips where the rep tapped a
  -- start / stop button; nullable so the simple "I drove 12 miles
  -- today" case stays one-tap.
  trip_date               date NOT NULL,
  started_at              timestamptz,
  ended_at                timestamptz,

  -- Distance. `miles` is the source of truth for reimbursement —
  -- the rep can either enter odometer readings (preferred for audit)
  -- or just type a mile count. `source` records which path was
  -- used so a future admin report can flag low-confidence entries.
  odometer_start          integer CHECK (odometer_start IS NULL OR odometer_start >= 0),
  odometer_end            integer CHECK (odometer_end IS NULL OR odometer_end >= 0),
  miles                   numeric(7,2) NOT NULL CHECK (miles >= 0 AND miles < 10000),
  source                  text NOT NULL DEFAULT 'manual'
                            CHECK (source IN ('odometer', 'manual', 'gps_estimate')),

  -- Locations. Free-text fields are the IRS-required "from / to"
  -- description. Coords are optional audit evidence captured by
  -- the form's geolocation prompt.
  start_location          text,
  end_location            text,
  start_lat               numeric(9,6),
  start_lng               numeric(9,6),
  end_lat                 numeric(9,6),
  end_lng                 numeric(9,6),

  -- Business purpose & linkage. Purpose is required per IRS Pub 463.
  -- account_id / activity_id are nullable: office-to-office trips,
  -- multi-stop days, and pre-activity-log entries all have no row
  -- to link to.
  purpose                 text NOT NULL CHECK (length(trim(purpose)) > 0),
  is_round_trip           boolean NOT NULL DEFAULT false,
  account_id              uuid REFERENCES bd_accounts(id) ON DELETE SET NULL,
  activity_id             uuid REFERENCES bd_activities(id) ON DELETE SET NULL,

  -- Money. Rate is captured per-entry so a future IRS rate change
  -- (or a per-org override in organizations.settings.mileage) does
  -- not retroactively reprice prior trips. reimbursement_cents is
  -- computed at submit time on the client; storing it (rather than
  -- using GENERATED ALWAYS) sidesteps Postgres immutability checks
  -- on numeric casts and keeps the value frozen alongside the rate.
  rate_cents_per_mile     integer NOT NULL CHECK (rate_cents_per_mile >= 0 AND rate_cents_per_mile <= 1000),
  reimbursement_cents     integer NOT NULL CHECK (reimbursement_cents >= 0),

  -- Forward-compat workflow. Only 'draft' and 'submitted' are
  -- exercised by v1. The approval / reject / paid states ship in
  -- the admin-approval PR without another migration.
  status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','submitted','approved','rejected','paid')),
  submitted_at            timestamptz,
  approved_at             timestamptz,
  approved_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rejected_reason         text,
  paid_at                 timestamptz,
  paid_reference          text,

  -- Optional photo evidence (Supabase Storage path). Forward-compat;
  -- v1 UI does not write these.
  odometer_start_photo    text,
  odometer_end_photo      text,

  notes                   text,

  -- Provenance.
  created_by              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bd_mileage_odometer_consistent
    CHECK (odometer_start IS NULL OR odometer_end IS NULL OR odometer_end >= odometer_start)
);

-- Primary listing query: "my entries this month, newest first."
CREATE INDEX IF NOT EXISTS idx_bd_mileage_entries_org_user_date
  ON bd_mileage_entries (org_id, user_id, trip_date DESC);

-- Tenant-isolation index, mirroring every other bd_* table.
CREATE INDEX IF NOT EXISTS idx_bd_mileage_entries_org
  ON bd_mileage_entries (org_id);

-- Future admin approval queue: "submitted, not yet paid." Partial
-- index keeps it tiny — paid entries are the steady-state majority.
CREATE INDEX IF NOT EXISTS idx_bd_mileage_entries_org_status
  ON bd_mileage_entries (org_id, status)
  WHERE status <> 'paid';

-- Look up mileage attached to a specific activity (reverse link
-- from the bd_activities side, when we surface "this visit has a
-- mileage entry").
CREATE INDEX IF NOT EXISTS idx_bd_mileage_entries_activity
  ON bd_mileage_entries (activity_id)
  WHERE activity_id IS NOT NULL;

-- Per-account history: "how many miles did the team drive to
-- Hoag this quarter?" Useful for the account profile + cost-per-
-- referral analytics in a later phase.
CREATE INDEX IF NOT EXISTS idx_bd_mileage_entries_account_date
  ON bd_mileage_entries (account_id, trip_date DESC)
  WHERE account_id IS NOT NULL;

ALTER TABLE bd_mileage_entries ENABLE ROW LEVEL SECURITY;

-- Personal-private RLS: a rep sees / writes only their own rows.
-- Single-leaf predicates only (jwt + auth.uid()) — no subqueries
-- into other tables, so the recursion-detector class of bugs in
-- docs/RLS_GOTCHAS.md cannot apply.

DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_select" ON bd_mileage_entries;
CREATE POLICY "tenant_isolation_bd_mileage_entries_select"
  ON bd_mileage_entries FOR SELECT
  TO authenticated
  USING (
    org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_insert" ON bd_mileage_entries;
CREATE POLICY "tenant_isolation_bd_mileage_entries_insert"
  ON bd_mileage_entries FOR INSERT
  TO authenticated
  WITH CHECK (
    org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_update" ON bd_mileage_entries;
CREATE POLICY "tenant_isolation_bd_mileage_entries_update"
  ON bd_mileage_entries FOR UPDATE
  TO authenticated
  USING (
    org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND user_id = (SELECT auth.uid())
  )
  WITH CHECK (
    org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_delete" ON bd_mileage_entries;
CREATE POLICY "tenant_isolation_bd_mileage_entries_delete"
  ON bd_mileage_entries FOR DELETE
  TO authenticated
  USING (
    org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "service_role_full_access_bd_mileage_entries" ON bd_mileage_entries;
CREATE POLICY "service_role_full_access_bd_mileage_entries"
  ON bd_mileage_entries FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- updated_at maintenance. Reuses public.touch_updated_at() (defined
-- in 20260508120000_bd_module_phase_0_foundation.sql).
DROP TRIGGER IF EXISTS bd_mileage_entries_set_updated_at ON bd_mileage_entries;
CREATE TRIGGER bd_mileage_entries_set_updated_at
  BEFORE UPDATE ON bd_mileage_entries
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE bd_mileage_entries IS
  'Per-rep mileage log for the BD portal. One row = one trip. '
  'Captures the IRS-substantiation fields (date, purpose, miles, '
  'odometer / endpoints) plus the rate-in-effect-at-submit-time so '
  'historical reimbursement totals are stable across rate changes. '
  'RLS is personal-private: reps see only their own entries. Admin '
  'visibility ships in the approval-queue follow-up PR.';

COMMENT ON COLUMN bd_mileage_entries.miles IS
  'Source of truth for reimbursement. Either derived from the '
  'odometer_start / odometer_end pair or entered manually. For '
  'round-trip entries this is the *total* miles driven (not the '
  'one-way distance); is_round_trip is informational.';

COMMENT ON COLUMN bd_mileage_entries.rate_cents_per_mile IS
  'Reimbursement rate in cents per mile, captured at submit time. '
  'Default in the application layer reads '
  'organizations.settings.mileage.default_rate_cents_per_mile and '
  'falls back to the IRS standard mileage rate. A future change to '
  'the org default does not reprice prior entries.';
