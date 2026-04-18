-- ═══════════════════════════════════════════════════════════════
-- Caregiver Portal — Phase 1, Step 1: Schema (additive only)
--
-- Lays the foundation for the caregiver-facing PWA:
--   1. Link a caregiver record to a Supabase auth user
--   2. Store geocoded coordinates for each client (for geofencing)
--   3. Create a clock_events audit log for clock in / clock out
--   4. Two helper functions used by RLS policies in a later migration
--
-- This migration does NOT change any existing RLS policies. Staff
-- access is untouched. The caregiver-facing app is not yet wired up.
-- A follow-up migration will rewrite RLS policies once the frontend
-- and invite flow are in place.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. caregivers.user_id ──────────────────────────────────────
-- Links a caregiver row to their Supabase auth account. Nullable
-- because existing caregivers don't have logins yet and many never
-- will (terminated, never onboarded, etc.). UNIQUE so one auth
-- account can only map to one caregiver.

ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_caregivers_user_id_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_caregivers_user_id_unique
      ON caregivers (user_id)
      WHERE user_id IS NOT NULL;
  END IF;
END $$;


-- ── 2. clients geocoding columns ───────────────────────────────
-- Populated by the geocode-client edge function when a client's
-- address is saved. All nullable so existing clients continue to
-- work until they're backfilled.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS latitude          numeric(10, 7),
  ADD COLUMN IF NOT EXISTS longitude         numeric(10, 7),
  ADD COLUMN IF NOT EXISTS geofence_radius_m integer DEFAULT 150,
  -- 150m default. Admin can widen/narrow per client from the UI.
  ADD COLUMN IF NOT EXISTS geocoded_at       timestamptz;
  -- NULL until first successful geocode. Re-geocode when address changes.


-- ── 3. clock_events ────────────────────────────────────────────
-- Append-only audit log of every clock-in and clock-out. The
-- server-side caregiver-clock edge function writes these rows
-- after verifying the caregiver is within the client's geofence
-- (or recording an explicit override reason). We do NOT trust
-- client-reported distance — the edge function recomputes it.

CREATE TABLE IF NOT EXISTS clock_events (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id                  uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  caregiver_id              text NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  event_type                text NOT NULL CHECK (event_type IN ('in', 'out')),
  occurred_at               timestamptz NOT NULL DEFAULT now(),
  -- Caregiver-reported location at the time of the event
  latitude                  numeric(10, 7),
  longitude                 numeric(10, 7),
  accuracy_m                numeric(8, 2),
  -- Server-computed distance from client's geocoded address (meters)
  distance_from_client_m    numeric(10, 2),
  geofence_passed           boolean,
  -- Set if the caregiver self-overrode a geofence failure
  override_reason           text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clock_events_shift
  ON clock_events (shift_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_clock_events_caregiver
  ON clock_events (caregiver_id, occurred_at DESC);

-- For the admin "geofence failures to review" list
CREATE INDEX IF NOT EXISTS idx_clock_events_override
  ON clock_events (occurred_at DESC)
  WHERE override_reason IS NOT NULL;

ALTER TABLE clock_events ENABLE ROW LEVEL SECURITY;

-- Follow the existing permissive pattern until the RLS migration
-- lands. Staff need full access; caregivers can't reach this table
-- yet because they don't have logins yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'clock_events_all' AND tablename = 'clock_events'
  ) THEN
    CREATE POLICY clock_events_all ON clock_events
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;


-- ── 4. Helper functions for RLS ────────────────────────────────
-- Defined now so edge functions and the follow-up RLS migration
-- can both rely on them. SECURITY DEFINER lets the functions bypass
-- RLS when reading user_roles / caregivers to answer the question
-- "is this user staff?" / "which caregiver is this user?".

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE email = lower((auth.jwt() ->> 'email'))
      AND role IN ('admin', 'member')
  );
$$;

CREATE OR REPLACE FUNCTION public.current_user_caregiver_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM caregivers WHERE user_id = auth.uid() LIMIT 1;
$$;

-- Both helpers are safe to expose to the authenticated role. They
-- read only the caller's own context via auth.jwt() / auth.uid().
GRANT EXECUTE ON FUNCTION public.is_staff()                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_caregiver_id()  TO authenticated;
