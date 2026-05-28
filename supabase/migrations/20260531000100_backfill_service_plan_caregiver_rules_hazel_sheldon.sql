-- One-time backfill: regular-caregiver rules for two long-tenured clients.
--
-- Hazel Zigner and Sheldon Leachman were onboarded in September 2025 — before
-- service_plan_caregiver_rules existed (20260514000000) and before the
-- service_plans org_id fix (20260531000000) that unblocks the Regular
-- caregivers grid. Their service plans already carry recurrence patterns and
-- their shifts already encode a stable caregiver per day, but no persistent
-- rules exist, so the service-plan-extend-ongoing cron would materialize
-- future shifts as 'open' and the office had to reassign by hand.
--
-- This seeds rules ONLY for assignments with a clear, consistent history
-- (a single caregiver covering that day across the client's shifts, confirmed
-- on upcoming shifts where data exists). Blocks that were never consistently
-- staffed are intentionally left out and will be set by the office in the
-- now-working grid rather than guessed at:
--   • Sheldon — "Weekday Mid Shift 3pm-10pm" (only one historical assignment)
--   • Sheldon — "Weekday Night Shift 10pm-6am" (mixed caregivers, no upcoming)
--   • Sheldon — "Weekday Night Shift Pt 2 12am-6am" (never assigned)
--   • Sheldon — "Weekend Day Shift Sunday 6am-7:30pm" (never assigned)
--   • Sheldon — "Weekend Night Shift Sunday Pt 2 12am-6am" (never assigned)
--
-- Seeding a rule primes future shift generation; it does NOT retro-assign
-- past shifts and does NOT change plan status. Turning a plan "Ongoing"
-- (Sheldon) or reactivating an ended plan (Hazel) remains a deliberate office
-- action in the UI — the cron only pre-assigns from rules once the plan is
-- is_ongoing AND status='active'.
--
-- effective_from is the plan's start_date (open-ended effective_to), so the
-- rule is "active today" for the cron's most-recent-rule lookup.
--
-- Idempotent: each rule is inserted only when no rule already exists for that
-- (service_plan_id, day_of_week). Re-running is a no-op. Non-destructive: it
-- never updates or deletes an existing rule, and skips any plan that has been
-- removed. Rollback identifies its rows by the created_by tag.

INSERT INTO public.service_plan_caregiver_rules
  (org_id, service_plan_id, day_of_week, caregiver_id, effective_from, created_by, notes)
SELECT
  public.default_org_id(),
  v.service_plan_id::uuid,
  v.day_of_week::smallint,
  v.caregiver_id,
  COALESCE(sp.start_date, CURRENT_DATE),
  'system:backfill-20260531',
  'Backfilled from existing shift assignments (plan predates the recurring-caregiver feature).'
FROM (
  VALUES
    -- ── Hazel Zigner ──────────────────────────────────────────────
    -- Weekday Schedule 8:30am-2:30pm — Elizabeth Nicasio, Mon-Fri
    ('7fb42d06-012a-4405-a743-659a39135394', 1, '440d7f70-d42c-4880-9331-ec642485909d'),
    ('7fb42d06-012a-4405-a743-659a39135394', 2, '440d7f70-d42c-4880-9331-ec642485909d'),
    ('7fb42d06-012a-4405-a743-659a39135394', 3, '440d7f70-d42c-4880-9331-ec642485909d'),
    ('7fb42d06-012a-4405-a743-659a39135394', 4, '440d7f70-d42c-4880-9331-ec642485909d'),
    ('7fb42d06-012a-4405-a743-659a39135394', 5, '440d7f70-d42c-4880-9331-ec642485909d'),

    -- ── Sheldon Leachman ──────────────────────────────────────────
    -- Weekday Day Shift 6am-3pm — Ciara Hinojoza, Mon-Fri
    ('d570ee63-c387-4c86-be25-eb4fcf4cd9bd', 1, 'b9c3944d-1c14-4af9-9dcd-f6fb23670aad'),
    ('d570ee63-c387-4c86-be25-eb4fcf4cd9bd', 2, 'b9c3944d-1c14-4af9-9dcd-f6fb23670aad'),
    ('d570ee63-c387-4c86-be25-eb4fcf4cd9bd', 3, 'b9c3944d-1c14-4af9-9dcd-f6fb23670aad'),
    ('d570ee63-c387-4c86-be25-eb4fcf4cd9bd', 4, 'b9c3944d-1c14-4af9-9dcd-f6fb23670aad'),
    ('d570ee63-c387-4c86-be25-eb4fcf4cd9bd', 5, 'b9c3944d-1c14-4af9-9dcd-f6fb23670aad'),
    -- Weekend Day Shift Saturday 6am-6pm — Leslie Porcayo, Sat
    ('fcd7cec5-00e7-4058-ae2e-a8552c6f4db6', 6, 'b2b37e5f-84a0-4e41-a8cb-93bf741cfdc2'),
    -- Weekend Night Shift Saturday 6pm-11:59pm — Michael Atomre, Sat
    ('313d7055-17a2-4d0e-9a79-ca4356a59401', 6, '34596b08-02cf-430a-b8f7-eba393370191'),
    -- Weekend Night Shift Sunday 7:30pm-11:59pm — Michael Atomre, Sun
    ('b43fd58d-b042-488e-b953-583b84390917', 0, '34596b08-02cf-430a-b8f7-eba393370191')
) AS v(service_plan_id, day_of_week, caregiver_id)
JOIN public.service_plans sp ON sp.id = v.service_plan_id::uuid
WHERE NOT EXISTS (
  SELECT 1
  FROM public.service_plan_caregiver_rules r
  WHERE r.service_plan_id = v.service_plan_id::uuid
    AND r.day_of_week = v.day_of_week::smallint
);
