-- ════════════════════════════════════════════════════════════════════════════
-- Care Coordinator — Change-of-Condition Detector sweep (pg_cron schedule)
-- ════════════════════════════════════════════════════════════════════════════
-- Invokes the care-coordinator-sweep edge function every 4 hours. The function
-- is a no-op unless the care-coordinator agent row has config.enabled = true,
-- so scheduling this while the feature is OFF is safe: it wakes, sees the flag
-- is off, and returns immediately.
--
-- Mirrors the shift-reminders / automation-cron pattern: pg_cron calls the
-- edge function via net.http_post using the stored project URL + publishable
-- key from the vault. Idempotent: unschedule any prior job of the same name
-- before (re)scheduling.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_project_url text;
  v_publishable_key text;
begin
  select decrypted_secret into v_project_url
    from vault.decrypted_secrets where name = 'project_url';

  select decrypted_secret into v_publishable_key
    from vault.decrypted_secrets where name = 'publishable_key';

  if v_project_url is null or v_publishable_key is null then
    raise notice 'Skipping care-coordinator-sweep cron scheduling: vault secrets missing.';
    return;
  end if;

  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'care-coordinator-sweep';

  -- Every 4 hours, on the hour.
  perform cron.schedule(
    'care-coordinator-sweep',
    '0 */4 * * *',
    format(
      $job$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{}'::jsonb
      );
      $job$,
      v_project_url || '/functions/v1/care-coordinator-sweep',
      v_publishable_key
    )
  );
end $$;
