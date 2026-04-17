-- ═══════════════════════════════════════════════════════════════
-- Per-route RingCentral webhook subscriptions (dashboard-applied copy)
--
-- HISTORICAL RECORD — DO NOT RE-APPLY.
--
-- This migration was applied directly via the Supabase dashboard on
-- 2026-04-17 at 20:37:31 UTC, before the `Deploy Database Migrations`
-- GitHub Actions workflow existed. The SQL below is an exact copy
-- of what was executed at that time. Its logical content is
-- identical to `20260417000000_route_webhook_subscriptions.sql`
-- (PR #134) — the only reason both files exist is that this version
-- was applied manually and recorded in `schema_migrations` before
-- the canonical migration ran through CI.
--
-- This file exists purely to keep `supabase/migrations/` in sync
-- with the production `schema_migrations` table and prevent
-- "drift" warnings. Supabase will skip re-applying it because the
-- version is already recorded remotely.
--
-- Going forward: schema changes MUST be added as a migration file
-- on a feature branch, merged via PR, and applied through the
-- `Deploy Database Migrations` workflow. Never run schema SQL
-- directly in the dashboard.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE communication_routes
  ADD COLUMN IF NOT EXISTS subscription_id          TEXT,
  ADD COLUMN IF NOT EXISTS subscription_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_last_error  TEXT,
  ADD COLUMN IF NOT EXISTS subscription_synced_at   TIMESTAMPTZ;

COMMENT ON COLUMN communication_routes.subscription_id IS
  'RingCentral webhook subscription ID for this route''s extension. Renewed daily by pg_cron.';
COMMENT ON COLUMN communication_routes.subscription_expires_at IS
  'When the current RC webhook subscription expires. Renewal cron runs well before this.';
COMMENT ON COLUMN communication_routes.subscription_last_error IS
  'Last error message from a failed subscribe/renew attempt. NULL when healthy.';
COMMENT ON COLUMN communication_routes.subscription_synced_at IS
  'Last time the subscribe/renew loop attempted this route (success or failure).';

DO $$
BEGIN
  PERFORM cron.unschedule('renew-ringcentral-webhook-subscriptions')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'renew-ringcentral-webhook-subscriptions'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'renew-ringcentral-webhook-subscriptions',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/ringcentral-webhook?action=subscribe',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);
