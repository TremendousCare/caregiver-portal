-- ═══════════════════════════════════════════════════════════════
-- Scheduling Phase 1: Foundation Schema
--
-- Tables created:
--   1. care_plans             — client care contracts (what's needed)
--   2. shifts                 — individual shift instances (the atomic unit)
--   3. caregiver_availability — structured weekly + one-off availability
--   4. caregiver_assignments  — ongoing caregiver↔client relationships
--                               (primary / backup / float)
--   5. shift_offers           — broadcast shift offers tracking
--                               (created now, unused until Phase 5)
--
-- This migration is purely additive:
--   - No changes to existing tables
--   - No data migration
--   - All tables start empty
--   - Foreign keys reference caregivers.id and clients.id (both TEXT)
--
-- See the Scheduling Feature Plan for the full phase rollout.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. care_plans ──────────────────────────────────────────────
-- The "contract" between a client and the agency. Describes what
-- care is needed. A client can have multiple plans. Plans are
-- optional — ad-hoc shifts can exist without a plan.

CREATE TABLE IF NOT EXISTS care_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title               text,
  service_type        text,
  -- Freeform description of care type (e.g. "personal care + companion +
  -- light housekeeping"). Not constrained so the team can write whatever
  -- matches the care plan review conversation.
  hours_per_week      numeric(6,2),
  preferred_times     jsonb DEFAULT '{}'::jsonb,
  -- Freeform notes about preferred scheduling, reserved for structured
  -- data in Phase 7 when we start generating recurring shifts.
  recurrence_pattern  jsonb,
  start_date          date,
  end_date            date,
  -- NULL end_date = ongoing
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  notes               text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_care_plans_client
  ON care_plans (client_id);

CREATE INDEX IF NOT EXISTS idx_care_plans_status_active
  ON care_plans (status)
  WHERE status = 'active';


-- ── 2. shifts ──────────────────────────────────────────────────
-- Individual shift instances. This is the atomic unit of scheduling
-- and the hottest table — every calendar view reads from here.
-- A shift may belong to a care_plan (recurring) or be ad-hoc (null).

CREATE TABLE IF NOT EXISTS shifts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_plan_id          uuid REFERENCES care_plans(id) ON DELETE SET NULL,
  client_id             text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  assigned_caregiver_id text REFERENCES caregivers(id) ON DELETE SET NULL,
  -- NULL = open (no caregiver yet)
  start_time            timestamptz NOT NULL,
  end_time              timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN (
                            'open', 'offered', 'assigned', 'confirmed',
                            'in_progress', 'completed', 'cancelled', 'no_show'
                          )),
  -- Recurrence linkage (Phase 7)
  recurrence_group_id   uuid,
  recurrence_rule       jsonb,
  -- Location (copied from client at creation so historical reports don't
  -- break if the client later moves)
  location_address      text,
  -- Shift-level rate tracking. Stored per shift because rates can vary
  -- shift-to-shift and client-to-client.
  hourly_rate           numeric(10,2),
  -- What the caregiver gets paid
  billable_rate         numeric(10,2),
  -- What the client is charged
  mileage               numeric(6,2),
  -- For reimbursement
  required_skills       text[] DEFAULT '{}',
  -- Freeform skill tags like {"Hoyer lift", "dementia care"}
  instructions          text,
  -- Specific tasks / shift plan for the caregiver
  notes                 text,
  -- Internal team notes
  -- Cancellation tracking
  cancel_reason         text,
  -- Freeform so the team can add new reasons without schema changes
  cancelled_at          timestamptz,
  cancelled_by          text,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shifts_time_order CHECK (end_time > start_time)
);

-- Calendar queries: "show me shifts in this date range"
CREATE INDEX IF NOT EXISTS idx_shifts_start_time
  ON shifts (start_time);

-- Caregiver's schedule + conflict detection
CREATE INDEX IF NOT EXISTS idx_shifts_caregiver_time
  ON shifts (assigned_caregiver_id, start_time)
  WHERE assigned_caregiver_id IS NOT NULL;

-- Client's schedule
CREATE INDEX IF NOT EXISTS idx_shifts_client_time
  ON shifts (client_id, start_time);

-- Open shifts board: "show me unfilled shifts upcoming"
CREATE INDEX IF NOT EXISTS idx_shifts_status_time
  ON shifts (status, start_time)
  WHERE status IN ('open', 'offered');

-- Care plan rollup
CREATE INDEX IF NOT EXISTS idx_shifts_care_plan
  ON shifts (care_plan_id)
  WHERE care_plan_id IS NOT NULL;

-- Recurring series editing
CREATE INDEX IF NOT EXISTS idx_shifts_recurrence_group
  ON shifts (recurrence_group_id)
  WHERE recurrence_group_id IS NOT NULL;


-- ── 3. caregiver_availability ──────────────────────────────────
-- Two usage modes in one table:
--   a) Recurring weekly:  day_of_week + start_time + end_time
--      (+ optional effective_from/effective_until for versioning)
--   b) One-off dates:     start_date + end_date (+ optional times)
--      Used for vacation, sick days, appointments
-- Type can be 'available' (explicit availability) or 'unavailable'
-- (explicit block). Unavailable entries override available ones.

CREATE TABLE IF NOT EXISTS caregiver_availability (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id        text NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  type                text NOT NULL DEFAULT 'available'
                        CHECK (type IN ('available', 'unavailable')),
  -- Recurring mode
  day_of_week         smallint CHECK (day_of_week BETWEEN 0 AND 6),
  -- 0=Sunday, 6=Saturday; NULL for one-off entries
  start_time          time,
  end_time            time,
  -- One-off mode
  start_date          date,
  end_date            date,
  -- Effective window for recurring entries
  effective_from      date,
  effective_until     date,
  reason              text,
  notes               text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Either it's a recurring weekly pattern (day_of_week set) OR a date range (start_date set)
  CONSTRAINT availability_mode_required CHECK (
    day_of_week IS NOT NULL OR start_date IS NOT NULL
  ),
  -- Recurring entries need times
  CONSTRAINT availability_recurring_needs_times CHECK (
    day_of_week IS NULL OR (start_time IS NOT NULL AND end_time IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_availability_caregiver
  ON caregiver_availability (caregiver_id);

CREATE INDEX IF NOT EXISTS idx_availability_caregiver_dow
  ON caregiver_availability (caregiver_id, day_of_week)
  WHERE day_of_week IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_availability_caregiver_date
  ON caregiver_availability (caregiver_id, start_date)
  WHERE start_date IS NOT NULL;


-- ── 4. caregiver_assignments ───────────────────────────────────
-- Ongoing caregiver↔client relationships. Separate from individual
-- shifts so we can answer "who is Mrs. Johnson's primary caregiver?"
-- without scanning the shift history. A caregiver can have multiple
-- active assignments (multi-client support).
--
-- Roles:
--   primary  — the main caregiver for this client
--   backup   — steps in when primary isn't available
--   float    — rotating, no dedicated assignment preference

CREATE TABLE IF NOT EXISTS caregiver_assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id        text NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  client_id           text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  care_plan_id        uuid REFERENCES care_plans(id) ON DELETE SET NULL,
  role                text NOT NULL DEFAULT 'primary'
                        CHECK (role IN ('primary', 'backup', 'float')),
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'ended')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  end_reason          text,
  notes               text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assignments_caregiver
  ON caregiver_assignments (caregiver_id, status);

CREATE INDEX IF NOT EXISTS idx_assignments_client
  ON caregiver_assignments (client_id, status);

CREATE INDEX IF NOT EXISTS idx_assignments_care_plan
  ON caregiver_assignments (care_plan_id)
  WHERE care_plan_id IS NOT NULL;


-- ── 5. shift_offers ────────────────────────────────────────────
-- Tracks each broadcast SMS sent to a caregiver about an open shift.
-- When you broadcast to 5 caregivers, that's 5 rows here. When one
-- is assigned, their row → 'assigned' and the others → 'expired'.
-- Used by Phase 5 (broadcast workflow) and feeds Phase 8 AI learning
-- (acceptance rate per caregiver, response time, etc.).
-- Created now, unused until Phase 5.

CREATE TABLE IF NOT EXISTS shift_offers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id            uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  caregiver_id        text NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'sent'
                        CHECK (status IN (
                          'sent', 'accepted', 'declined', 'expired', 'assigned'
                        )),
  sent_at             timestamptz NOT NULL DEFAULT now(),
  responded_at        timestamptz,
  response_text       text,
  message_sid         text,
  -- RingCentral outbound message identifier for delivery tracking
  expires_at          timestamptz,
  notes               text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shift_offers_shift
  ON shift_offers (shift_id);

CREATE INDEX IF NOT EXISTS idx_shift_offers_caregiver
  ON shift_offers (caregiver_id, status);

CREATE INDEX IF NOT EXISTS idx_shift_offers_recent
  ON shift_offers (caregiver_id, sent_at DESC);


-- ── Row-Level Security ─────────────────────────────────────────
-- All scheduling tables follow the existing pattern: authenticated
-- users get full access. Matches caregivers, clients, events,
-- context_memory, and action_outcomes.

ALTER TABLE care_plans             ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE caregiver_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE caregiver_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_offers           ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'care_plans_all' AND tablename = 'care_plans') THEN
    CREATE POLICY care_plans_all ON care_plans FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'shifts_all' AND tablename = 'shifts') THEN
    CREATE POLICY shifts_all ON shifts FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'caregiver_availability_all' AND tablename = 'caregiver_availability') THEN
    CREATE POLICY caregiver_availability_all ON caregiver_availability FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'caregiver_assignments_all' AND tablename = 'caregiver_assignments') THEN
    CREATE POLICY caregiver_assignments_all ON caregiver_assignments FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'shift_offers_all' AND tablename = 'shift_offers') THEN
    CREATE POLICY shift_offers_all ON shift_offers FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;


-- ── Realtime ───────────────────────────────────────────────────
-- shifts and shift_offers need realtime so the calendar and broadcast
-- drawer update live across the team without page refreshes.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'shifts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE shifts;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'shift_offers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE shift_offers;
  END IF;
END $$;
