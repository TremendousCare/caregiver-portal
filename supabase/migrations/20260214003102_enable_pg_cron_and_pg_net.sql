
-- Enable pg_cron for scheduled automation jobs
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Enable pg_net for HTTP calls from pg_cron to Edge Functions
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
