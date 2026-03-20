-- ── Real-time message routing trigger ──
-- Fires pg_net.http_post() on every INSERT into message_routing_queue,
-- invoking message-router immediately instead of waiting for the 2-min cron.
-- The cron remains as a safety-net fallback.

-- Ensure pg_net is available (it's pre-installed on Supabase but needs enabling)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Trigger function: invoke message-router via pg_net
CREATE OR REPLACE FUNCTION notify_message_router()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/message-router',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach trigger (fires once per statement, not per row, to avoid
-- hammering message-router when multiple messages arrive simultaneously)
CREATE TRIGGER trg_message_routing_notify
  AFTER INSERT ON message_routing_queue
  FOR EACH STATEMENT
  EXECUTE FUNCTION notify_message_router();

-- Reduce cron frequency from every 2 min to every 5 min (safety-net only)
SELECT cron.unschedule('process-message-routing');

SELECT cron.schedule(
  'process-message-routing',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1) || '/functions/v1/message-router',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $$
);
