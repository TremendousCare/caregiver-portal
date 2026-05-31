-- ════════════════════════════════════════════════════════════════════════════
-- Care Coordinator — Outcome Attribution (pg_cron schedule)
-- ════════════════════════════════════════════════════════════════════════════
-- Invokes care-outcome-attribution daily (06:30 UTC). The function correlates
-- client_health_events with the care_signals that preceded them and links
-- readmissions to their prior discharge. It is idempotent and a no-op when
-- there are no recent events, so scheduling it is safe regardless of whether
-- the detector feature flag is on.
--
-- Mirrors shift-reminders / automation-cron: net.http_post via the stored
-- project URL + publishable key from the vault. Idempotent scheduling.
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
    raise notice 'Skipping care-outcome-attribution cron scheduling: vault secrets missing.';
    return;
  end if;

  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'care-outcome-attribution';

  -- Daily at 06:30 UTC.
  perform cron.schedule(
    'care-outcome-attribution',
    '30 6 * * *',
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
      v_project_url || '/functions/v1/care-outcome-attribution',
      v_publishable_key
    )
  );
end $$;
