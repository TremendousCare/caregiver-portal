-- ═══════════════════════════════════════════════════════════════
-- Unified Intake Queue — Task 1
-- Table: intake_queue
-- Purpose: Universal landing zone for inbound data from any
-- external source (Indeed, website forms, API partners, manual
-- CSV imports, etc.). Records arrive as raw JSONB payloads and
-- sit in 'pending' status until the intake-processor Edge
-- Function normalises them into caregivers/clients rows.
-- A pg_cron job fires every 2 minutes to trigger processing.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Intake Queue Table ──

CREATE TABLE IF NOT EXISTS intake_queue (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        TEXT NOT NULL,
  -- origin identifier, e.g. 'indeed', 'website', 'csv_import'
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('client', 'caregiver')),
  raw_payload   JSONB NOT NULL,
  api_key_label TEXT,
  -- which API key was used (for audit / rate-limit tracking)
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processed', 'error', 'duplicate')),
  error_detail  TEXT,
  result_id     TEXT,
  -- ID of the caregiver/client row created on success
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);


-- ── 2. Indexes ──

-- For the processor: grab oldest pending rows first
CREATE INDEX IF NOT EXISTS idx_intake_queue_pending
  ON intake_queue (created_at ASC)
  WHERE status = 'pending';

-- For admin UI / debugging: most recent rows first
CREATE INDEX IF NOT EXISTS idx_intake_queue_recent
  ON intake_queue (created_at DESC);


-- ── 3. RLS — service_role only (no browser access) ──
-- This table is written by Edge Functions (service_role) and
-- read only from the admin dashboard via server-side calls.
-- No authenticated-user policy is created intentionally.

ALTER TABLE intake_queue ENABLE ROW LEVEL SECURITY;

-- No policies = only service_role (bypasses RLS) can access.
-- If an admin UI is added later, create a SELECT-only policy
-- for authenticated users at that time.


-- ── 4. pg_cron — process intake queue every 2 minutes ──
-- Follows the same vault-secret pattern as automation-cron.

SELECT cron.schedule(
  'process-intake-queue',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1) || '/functions/v1/intake-processor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $$
);
