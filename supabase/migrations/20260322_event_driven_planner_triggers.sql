-- ═══════════════════════════════════════════════════════════════
-- Event-Driven Planner Triggers (Phase 4B)
--
-- Creates 4 Postgres triggers that invoke ai-planner in single-entity
-- mode when specific events occur. Uses the same pg_net pattern as
-- message-router (20260320_realtime_message_routing.sql).
--
-- Trigger A: DocuSign completed → suggest next onboarding step
-- Trigger B: No-response detected → suggest follow-up
-- Trigger C: New application → suggest first contact
-- Trigger D: Phase change → suggest phase-specific actions
-- ═══════════════════════════════════════════════════════════════

-- ─── Trigger A: DocuSign Completed ───
-- Fires when docusign_envelopes.status changes to 'completed'

CREATE OR REPLACE FUNCTION notify_planner_docusign_completed()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
    PERFORM net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
             || '/functions/v1/ai-planner',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
      ),
      body := jsonb_build_object(
        'entity_id', NEW.caregiver_id,
        'entity_type', 'caregiver',
        'trigger_reason', 'DocuSign envelope completed — all documents signed. Consider scheduling orientation or advancing to next phase.'
      ),
      timeout_milliseconds := 5000
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_planner_docusign_completed
  AFTER UPDATE ON docusign_envelopes
  FOR EACH ROW
  EXECUTE FUNCTION notify_planner_docusign_completed();


-- ─── Trigger B: No-Response Detected ───
-- Fires when outcome-analyzer marks an action as 'no_response'

CREATE OR REPLACE FUNCTION notify_planner_no_response()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.outcome_type = 'no_response' AND OLD.outcome_type IS NULL THEN
    PERFORM net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
             || '/functions/v1/ai-planner',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
      ),
      body := jsonb_build_object(
        'entity_id', NEW.entity_id,
        'entity_type', COALESCE(NEW.entity_type, 'caregiver'),
        'trigger_reason', 'No response detected to ' || REPLACE(NEW.action_type, '_', ' ') || ' after ' ||
          EXTRACT(DAY FROM (NOW() - NEW.created_at))::text || ' days. Consider a follow-up via a different channel.'
      ),
      timeout_milliseconds := 5000
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_planner_no_response
  AFTER UPDATE ON action_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION notify_planner_no_response();


-- ─── Trigger C: New Application ───
-- Fires when a new caregiver is inserted with intake phase

CREATE OR REPLACE FUNCTION notify_planner_new_application()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.phase_timestamps IS NOT NULL
     AND (NEW.phase_timestamps->>'intake') IS NOT NULL THEN
    PERFORM net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
             || '/functions/v1/ai-planner',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
      ),
      body := jsonb_build_object(
        'entity_id', NEW.id,
        'entity_type', 'caregiver',
        'trigger_reason', 'New caregiver application received — first contact within 24 hours is critical for conversion. Send a welcome message.'
      ),
      timeout_milliseconds := 5000
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_planner_new_application
  AFTER INSERT ON caregivers
  FOR EACH ROW
  EXECUTE FUNCTION notify_planner_new_application();


-- ─── Trigger D: Phase Change ───
-- Fires when a new phase key is added to phase_timestamps

CREATE OR REPLACE FUNCTION notify_planner_phase_change()
RETURNS TRIGGER AS $$
DECLARE
  old_keys text[];
  new_keys text[];
  new_phase text;
  k text;
BEGIN
  -- Skip if phase_timestamps didn't meaningfully change
  IF OLD.phase_timestamps IS NOT DISTINCT FROM NEW.phase_timestamps THEN
    RETURN NEW;
  END IF;

  -- Get keys from old and new
  SELECT array_agg(key) INTO old_keys
    FROM jsonb_object_keys(COALESCE(OLD.phase_timestamps, '{}'::jsonb)) AS key;

  SELECT array_agg(key) INTO new_keys
    FROM jsonb_object_keys(COALESCE(NEW.phase_timestamps, '{}'::jsonb)) AS key;

  -- Find the first key in new that isn't in old
  IF new_keys IS NOT NULL THEN
    FOREACH k IN ARRAY new_keys LOOP
      IF old_keys IS NULL OR NOT (k = ANY(old_keys)) THEN
        new_phase := k;
        EXIT; -- take the first new phase
      END IF;
    END LOOP;
  END IF;

  -- Only fire if a genuinely new phase was added
  IF new_phase IS NOT NULL THEN
    PERFORM net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
             || '/functions/v1/ai-planner',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
      ),
      body := jsonb_build_object(
        'entity_id', NEW.id,
        'entity_type', 'caregiver',
        'trigger_reason', 'Phase changed to ' || REPLACE(new_phase, '_', ' ') || '. Review tasks and next steps for this phase.'
      ),
      timeout_milliseconds := 5000
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_planner_phase_change
  AFTER UPDATE OF phase_timestamps ON caregivers
  FOR EACH ROW
  EXECUTE FUNCTION notify_planner_phase_change();
