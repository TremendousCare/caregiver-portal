
-- ── 1. pg_cron job: expire stale suggestions every 30 minutes ──
SELECT cron.schedule(
  'expire-stale-suggestions',
  '*/30 * * * *',
  $$
    UPDATE ai_suggestions
    SET status = 'expired', resolved_at = now()
    WHERE status = 'pending'
      AND expires_at < now();
  $$
);

-- ── 2. Trigger: when a caregiver's board_status or employment_status changes
--    to a non-pipeline status, expire their pending suggestions ──

CREATE OR REPLACE FUNCTION expire_suggestions_on_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW.board_status IN ('deployed', 'active', 'reserve') OR
    NEW.archived = true OR
    (NEW.employment_status IS NOT NULL AND NEW.employment_status != 'onboarding')
  ) THEN
    UPDATE ai_suggestions
    SET status = 'expired', resolved_at = now()
    WHERE entity_id = NEW.id::text
      AND status = 'pending';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_expire_suggestions_on_status ON caregivers;
CREATE TRIGGER trg_expire_suggestions_on_status
  AFTER UPDATE OF board_status, archived, employment_status ON caregivers
  FOR EACH ROW
  EXECUTE FUNCTION expire_suggestions_on_status_change();
