-- ═══════════════════════════════════════════════════════════════
-- QuickBooks integration — PR #3 (token refresh cron)
--
-- Registers a 30-minute pg_cron job that POSTs to the new
-- quickbooks-token-refresh edge function. The function:
--
--   • lists every quickbooks_connections row whose access token
--     expires in the next 15 min (or whose status='error' from a
--     prior tick — those self-heal),
--   • reads the current refresh token via the service-role
--     get_qb_connection RPC,
--   • calls Intuit's /oauth2/v1/tokens with
--     grant_type=refresh_token,
--   • persists the NEW access AND refresh tokens via the
--     refresh_qb_connection_tokens RPC (Intuit rotates refresh
--     tokens on every refresh — failure to store the new one
--     bricks the connection at 100 days),
--   • marks status='reauth_required' if Intuit returns 401 /
--     invalid_grant (refresh token revoked or already rotated) or
--     if the refresh token's own 100-day window has lapsed.
--
-- Why every 30 min and not every hour: Intuit access tokens have a
-- 1-hour TTL. The cron's REFRESH_WINDOW_MS is 15 min, so a 30-min
-- cadence guarantees we get at least one — usually two — refresh
-- attempts inside the valid window even if one tick fails.
--
-- pg_cron job inventory after this migration ships:
--    1. automation-cron-job                  (every 30 min)
--    2. outcome-analyzer                     (every 4h)
--    3. payroll-generate-timesheets          (Mondays 13:00 UTC)
--    4. poll-bookings-appointments           (every 5 min)
--    5. service-plan-extend-ongoing          (Mondays 14:00 UTC)
--    6. dispatch-lead-notifications          (every 5 min)
--    7. dispatch-task-notifications          (every 5 min)
--    8. exec-tasks-generate                  (daily 10:00 UTC)
--    9. dispatch-exec-task-notifications     (every 15 min)
--   10. quickbooks-token-refresh             (every 30 min)  ← this one
--
-- Idempotent: cron.schedule overwrites by job name.
-- ═══════════════════════════════════════════════════════════════

SELECT cron.schedule(
  'quickbooks-token-refresh',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/quickbooks-token-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('triggered_at', now()::text),
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'quickbooks-token-refresh'
  ) THEN
    RAISE EXCEPTION
      'quickbooks_token_refresh_cron: job not registered after schedule()';
  END IF;
END
$$;
