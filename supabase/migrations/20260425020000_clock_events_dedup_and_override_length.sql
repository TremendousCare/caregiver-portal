-- ═══════════════════════════════════════════════════════════════
-- clock_events — duplicate prevention + override length cap
--
-- Two additive safety constraints on clock_events:
--
--   1. UNIQUE (shift_id, event_type) so a caregiver can't record two
--      clock-ins or two clock-outs for the same shift, even under a
--      fast double-tap on the PWA or a race between the caregiver app
--      and a manual-entry insert from office staff. Today this is
--      prevented only by the status transition check in the edge
--      function — adding a DB-level constraint closes the race window.
--
--   2. CHECK on override_reason length (≤ 250 chars). The PWA enforces
--      a 5-char minimum but had no maximum; an unbounded textarea is
--      an abuse vector and clutters the admin override review surface.
--
-- Both are additive and idempotent. We sanity-check for existing
-- duplicates first so the migration aborts loudly with a helpful
-- message rather than failing on the index creation itself.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT shift_id, event_type
      FROM clock_events
     GROUP BY shift_id, event_type
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot create unique index idx_clock_events_shift_event_unique: % duplicate (shift_id, event_type) groups exist in clock_events. Reconcile duplicates before re-running this migration.',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clock_events_shift_event_unique
  ON clock_events (shift_id, event_type);

ALTER TABLE clock_events
  DROP CONSTRAINT IF EXISTS clock_events_override_reason_length;
ALTER TABLE clock_events
  ADD CONSTRAINT clock_events_override_reason_length
  CHECK (override_reason IS NULL OR char_length(override_reason) <= 250);
