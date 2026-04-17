
-- Store project URL in Vault for pg_cron to use
SELECT vault.create_secret(
  'https://zocrnurvazyxdpyqimgj.supabase.co',
  'project_url'
);

-- Store anon key in Vault for pg_cron to use
SELECT vault.create_secret(
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpvY3JudXJ2YXp5eGRweXFpbWdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2NjkzNzEsImV4cCI6MjA4NjI0NTM3MX0.Bi5KaGaigTuVD0f9DluMo01jt9Mbli4LZVC6X3MhIpQ',
  'publishable_key'
);

-- Schedule automation-cron to run every 30 minutes
SELECT cron.schedule(
  'automation-cron-job',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1) || '/functions/v1/automation-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('time', now()::text),
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);
