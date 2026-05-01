-- Rollback for Bookings Step 3 v2 — undo the pivot to polling.
-- Brings the system back to the post-Step-3-v1 state (webhook
-- architecture, daily renew cron). Lives outside the migrations
-- folder, NOT auto-applied. Run manually via psql only if the pivot
-- must be reverted.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260505010000_bookings_step3_v2_pivot_to_polling_down.sql
--
-- Note: this restores the bookings_subscriptions schema but does NOT
-- recreate any Graph subscriptions — those never existed in production
-- (Graph rejected every subscribe call). The renew cron will start
-- failing again the moment it runs. Use this only as part of a wider
-- revert that also restores the webhook code.

BEGIN;

-- 1. Unschedule the polling cron.
DO $$
BEGIN
  PERFORM cron.unschedule('poll-bookings-appointments')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'poll-bookings-appointments'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2. Recreate bookings_subscriptions exactly as Step 3 v1 created it.
CREATE TABLE IF NOT EXISTS public.bookings_subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT
                          DEFAULT public.default_org_id(),
  business_id           text NOT NULL,
  subscription_id       text,
  expires_at            timestamptz,
  notification_url      text,
  client_state          text,
  last_renewed_at       timestamptz,
  last_synced_at        timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_subscriptions_unique_business UNIQUE (org_id, business_id)
);

CREATE INDEX IF NOT EXISTS idx_bookings_subscriptions_org
  ON public.bookings_subscriptions (org_id);

CREATE INDEX IF NOT EXISTS idx_bookings_subscriptions_expiring
  ON public.bookings_subscriptions (expires_at)
  WHERE subscription_id IS NOT NULL;

ALTER TABLE public.bookings_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_bookings_subscriptions" ON public.bookings_subscriptions;
CREATE POLICY "tenant_isolation_bookings_subscriptions"
  ON public.bookings_subscriptions FOR ALL
  TO authenticated
  USING      (((SELECT auth.jwt()) ->> 'org_id')::uuid = org_id)
  WITH CHECK (((SELECT auth.jwt()) ->> 'org_id')::uuid = org_id);

DROP POLICY IF EXISTS "service_role_full_access_bookings_subscriptions" ON public.bookings_subscriptions;
CREATE POLICY "service_role_full_access_bookings_subscriptions"
  ON public.bookings_subscriptions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_bookings_subscriptions_updated_at ON public.bookings_subscriptions;
CREATE TRIGGER trg_bookings_subscriptions_updated_at
  BEFORE UPDATE ON public.bookings_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. Reschedule the daily renewal cron.
DO $$
BEGIN
  PERFORM cron.unschedule('renew-bookings-graph-subscriptions')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'renew-bookings-graph-subscriptions'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'renew-bookings-graph-subscriptions',
  '30 5 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/bookings-integration',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('action', 'renew_subscriptions'),
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);

COMMIT;
