-- ═══════════════════════════════════════════════════════════════
-- Email Accounts & Routing — Multi-Mailbox Foundation
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Email Accounts Table ──

CREATE TABLE IF NOT EXISTS email_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label           TEXT NOT NULL,
  email_address   TEXT NOT NULL UNIQUE,
  role            TEXT NOT NULL DEFAULT 'general',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. Email Routing Table ──

CREATE TABLE IF NOT EXISTS email_routing (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name     TEXT NOT NULL,
  email_account_id  UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  filter_rules      JSONB NOT NULL DEFAULT '{}',
  enabled           BOOLEAN NOT NULL DEFAULT true,
  last_checked_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (function_name, email_account_id)
);

-- ── 3. Indexes ──

CREATE INDEX IF NOT EXISTS idx_email_accounts_enabled
  ON email_accounts (enabled) WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_email_routing_function
  ON email_routing (function_name) WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_email_routing_account
  ON email_routing (email_account_id);

-- ── 4. RLS — service_role only ──

ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_routing ENABLE ROW LEVEL SECURITY;

-- ── 5. Seed Data ──

DO $$
DECLARE
  tas_id UUID;
  tas_email TEXT;
BEGIN
  SELECT value INTO tas_email
  FROM app_settings
  WHERE key = 'outlook_mailbox'
  LIMIT 1;

  IF tas_email IS NULL OR tas_email = '' THEN
    tas_email := 'UPDATE_ME@tremendouscare.com';
  END IF;

  tas_email := TRIM(BOTH '"' FROM tas_email);

  INSERT INTO email_accounts (id, label, email_address, role, enabled)
  VALUES (
    gen_random_uuid(),
    'Talent Acquisition Specialist',
    tas_email,
    'talent_acquisition',
    true
  )
  ON CONFLICT (email_address) DO NOTHING
  RETURNING id INTO tas_id;

  IF tas_id IS NULL THEN
    SELECT id INTO tas_id FROM email_accounts WHERE email_address = tas_email;
  END IF;

  IF tas_id IS NOT NULL THEN
    INSERT INTO email_routing (function_name, email_account_id, filter_rules, enabled)
    VALUES (
      'indeed_parsing',
      tas_id,
      '{"sender_contains": "indeed.com"}'::jsonb,
      true
    )
    ON CONFLICT (function_name, email_account_id) DO NOTHING;

    INSERT INTO email_routing (function_name, email_account_id, filter_rules, enabled)
    VALUES (
      'communications',
      tas_id,
      '{}'::jsonb,
      true
    )
    ON CONFLICT (function_name, email_account_id) DO NOTHING;
  END IF;
END $$;

-- ── 6. pg_cron — check for Indeed emails every 5 minutes ──

SELECT cron.schedule(
  'indeed-email-parser',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1) || '/functions/v1/indeed-email-parser',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $$
);
